/**
 * # Hypercore Link Language for AD4M
 *
 * Bridge language that syncs Perspectives via Hypercore append-only logs
 * and Hyperswarm P2P networking.
 *
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * Appends links as commit blocks to a Hypercore feed, processes inbound
 * blocks from Hyperswarm replication, and uses Hyperbee B-tree indexes
 * for efficient queries.
 *
 * Hypercore/Hyperbee/Hyperswarm are Node.js libraries with native N-API
 * deps. They cannot run directly in the ALDK's Deno runtime. All
 * Hypercore operations are delegated to the executor via signal-based
 * communication.
 *
 * Spec: hypercore-link-language.md
 */

import {
    defineLanguage,
    agentDid,
    hash,
    languageSettings,
    emitPerspectiveDiff,
} from "@coasys/ad4m-ldk";

import type { PerspectiveDiff, LinkExpression } from "./src/types.js";
import { parseSettings } from "./src/settings.js";
import type { HypercoreSettings } from "./src/settings.js";
import { commitDiff } from "./src/translate.js";
import { linkContentKey } from "./src/translate.pure.js";
import { shouldFederate, linkOriginKey, isPredicateExcluded } from "./src/dual-language.js";
import * as store from "./src/store.js";
import { emitAppend, emitJoinSwarm, emitLeaveSwarm } from "./src/signals.js";
import { sync as doSync, handleInboundSignal, clearBuffer } from "./src/sync.js";
import { initWritersFromSettings } from "./src/membership.js";

// Adapter imports
import { initTransport } from "./src/transport.js";
import { DenoTransport } from "./src/transport-deno.js";
import { initStorage, getStorage } from "./src/storage-interface.js";
import { DenoStorageAdapter } from "./src/storage-deno.js";
import { initSigning } from "./src/signing-interface.js";
import { DenoSigningAdapter } from "./src/signing-deno.js";
import { initRuntime } from "./src/runtime-interface.js";
import { DenoRuntime } from "./src/runtime-deno.js";

// ---------------------------------------------------------------------------
// Template Variables (per Spec §8)
// ---------------------------------------------------------------------------

//!@ad4m-template-variable
const HYPERCORE_KEY = "<to-be-filled>";

//!@ad4m-template-variable
const DISCOVERY_KEY = "<to-be-filled>";

//!@ad4m-template-variable
const BOOTSTRAP_NODES = "<to-be-filled>";

//!@ad4m-template-variable
const NEIGHBOURHOOD_META = "<to-be-filled>";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let settings: HypercoreSettings;
let feedKey: string = "";
let discoveryKey: string = "";
let currentSeq: number = 0;
let configured: boolean = true;

/**
 * Check whether a template variable has been filled in.
 */
function isTemplateVarFilled(value: string): boolean {
    return !!value && value !== "<to-be-filled>";
}

/**
 * Parse bootstrap nodes from the template variable.
 */
function parseBootstrapNodes(): string[] {
    try {
        const parsed = JSON.parse(BOOTSTRAP_NODES);
        if (Array.isArray(parsed)) return parsed;
    } catch { /* ignore */ }
    return [];
}

/**
 * Get the neighbourhood URL.
 */
function neighbourhoodUrl(): string {
    return `neighbourhood://${HYPERCORE_KEY}`;
}

// ---------------------------------------------------------------------------
// Language definition
// ---------------------------------------------------------------------------

const language = defineLanguage({
    name: "@hexafield/hypercore-link-language",
    version: "0.1.0",

    isPublic: true,

    async init() {
        // Initialize adapters
        initRuntime(new DenoRuntime());
        initStorage(new DenoStorageAdapter());
        initTransport(new DenoTransport());
        initSigning(new DenoSigningAdapter());
        store.initStore();

        myDid = agentDid();
        settings = parseSettings(languageSettings());
        feedKey = HYPERCORE_KEY || "";
        discoveryKey = DISCOVERY_KEY || "";

        // Guard: if critical template vars are unfilled, run in unconfigured mode
        if (!isTemplateVarFilled(feedKey) || !isTemplateVarFilled(discoveryKey)) {
            configured = false;
            console.warn(
                "[hypercore-link-language] init: template variables not filled — running in unconfigured mode. "
                + `HYPERCORE_KEY=${JSON.stringify(feedKey)}, DISCOVERY_KEY=${JSON.stringify(discoveryKey)}`
            );
            return;
        }

        configured = true;
        console.log(`[hypercore-link-language] init: did=${myDid}, feed=${feedKey.substring(0, 16)}...`);
        console.log(`[hypercore-link-language] sync mode: ${settings.syncMode}`);
        console.log(`[hypercore-link-language] multi-writer: ${settings.multiWriter.enabled}`);

        // Initialize known writers from settings
        if (settings.multiWriter.enabled && settings.multiWriter.writerKeys.length > 0) {
            const count = initWritersFromSettings(settings.multiWriter.writerKeys, myDid);
            console.log(`[hypercore-link-language] initialized ${count} writers from settings`);
        }

        // Restore current sequence from revision
        const rev = store.getRevision();
        if (rev) {
            currentSeq = parseInt(rev, 10) + 1;
        }

        // Join Hyperswarm if not in publish-only mode
        if (settings.syncMode !== "publish-only" && discoveryKey) {
            const bootstrapNodes = [
                ...parseBootstrapNodes(),
                ...settings.swarm.bootstrap,
            ];
            emitJoinSwarm(
                discoveryKey,
                bootstrapNodes.length > 0 ? bootstrapNodes : undefined,
                settings.swarm.maxPeers,
            );
        }
    },

    async teardown() {
        // Leave Hyperswarm
        if (configured && discoveryKey) {
            emitLeaveSwarm(discoveryKey);
        }
        myDid = "";
        currentSeq = 0;
        console.log("[hypercore-link-language] teardown");
    },

    interactions() {
        return [];
    },

    // -----------------------------------------------------------------------
    // perspective-commit
    // -----------------------------------------------------------------------
    commit: {
        async commit(diff: PerspectiveDiff) {
            // Guard: if not configured, store locally but skip federation
            if (!configured) {
                store.applyDiff(diff);
                emitPerspectiveDiff(diff);
                return "";
            }

            // 1. Store links locally
            store.applyDiff(diff);

            // 2. Skip outbound in subscribe-only mode
            if (settings.syncMode === "subscribe-only") {
                emitPerspectiveDiff(diff);
                return "";
            }

            // 3. Build federation filter using dual-language origin tracking
            const shouldCommit = (linkHash: string, link: LinkExpression): boolean => {
                // Dual-language echo prevention
                if (settings.dualLanguage.enabled) {
                    if (!shouldFederate(linkHash, (key) => getStorage().get(key))) {
                        return false;
                    }
                    // Check predicate exclusions
                    const pred = link.data.predicate || "";
                    if (isPredicateExcluded(pred, settings.dualLanguage.excludePredicates)) {
                        return false;
                    }
                }
                return true;
            };

            // 4. Track origins for new native commits
            if (settings.dualLanguage.enabled) {
                for (const link of diff.additions) {
                    const h = store.hashLink(link);
                    const originKey = linkOriginKey(h);
                    const storage = getStorage();
                    const existing = storage.get(originKey);
                    if (existing === "hypercore") {
                        storage.put(originKey, "dual");
                    } else if (!existing) {
                        storage.put(originKey, "native");
                    }
                }
            }

            // 5. Build and serialize the commit block
            const result = commitDiff(diff, {
                seq: currentSeq,
                author: myDid,
                hashFn: hash,
                shouldCommit,
            });

            // 6. Append to feed via signal delegation
            if (result) {
                emitAppend(feedKey, result.serialized, currentSeq);
                currentSeq++;
                store.setRevision((currentSeq - 1).toString());
            }

            // 7. Emit the perspective diff for local subscribers
            emitPerspectiveDiff(diff);

            return "";
        },
    },

    // -----------------------------------------------------------------------
    // perspective-sync
    // -----------------------------------------------------------------------
    sync: {
        async sync() {
            if (!configured || settings.syncMode === "publish-only") {
                return { additions: [], removals: [] };
            }
            return doSync();
        },

        async render() {
            return store.allLinks();
        },

        async currentRevision() {
            return store.getRevision() || "";
        },
    },

    // -----------------------------------------------------------------------
    // perspective-query
    // -----------------------------------------------------------------------
    query: {
        supportedKinds() {
            return ["link-pattern"];
        },

        async run(req: { kind: string; payload: unknown }) {
            if (req.kind !== "link-pattern") {
                return { kind: "error", payload: `Unsupported query kind: ${req.kind}` };
            }
            const pattern = req.payload as { source?: string; target?: string; predicate?: string; author?: string };
            const links = store.queryLinks(pattern);
            return { kind: "links", payload: links };
        },
    },

    // -----------------------------------------------------------------------
    // peers
    // -----------------------------------------------------------------------
    peers: {
        setLocal(agents: string[]) {
            for (const did of agents) {
                store.setPeer(did, { local: true });
            }
        },

        async remote() {
            return store.listPeers("peers/");
        },
    },
});

// ---------------------------------------------------------------------------
// Flat exports (required by the AD4M runtime dispatcher)
// ---------------------------------------------------------------------------

export const {
    name,
    version,
    isPublic,
    init,
    teardown,
    interactions,
    perspectiveCommit,
    perspectiveSyncSync,
    perspectiveSyncRender,
    perspectiveSyncCurrentRevision,
    perspectiveQuerySupportedKinds,
    perspectiveQueryRun,
    peersSetLocal,
    peersRemote,
} = language;

export default language;

// ---------------------------------------------------------------------------
// Callback registration
// ---------------------------------------------------------------------------

let linkCallback: ((diff: PerspectiveDiff) => void) | null = null;
let syncStateChangeCallback: ((state: string) => void) | null = null;

export function linkSyncAddCallback(callback: (diff: PerspectiveDiff) => void): number {
    linkCallback = callback;
    return 1;
}

export function linkSyncRemoveCallback(callback: (diff: PerspectiveDiff) => void): number {
    if (linkCallback === callback) linkCallback = null;
    return 1;
}

export function linkSyncAddSyncStateChangeCallback(callback: (state: string) => void): number {
    syncStateChangeCallback = callback;
    return 1;
}

// ---------------------------------------------------------------------------
// Signal handler
// ---------------------------------------------------------------------------

/**
 * Handle signals emitted by the executor.
 *
 * The executor forwards inbound Hypercore/Hyperswarm events as signals:
 * { type: "hypercore:block", feedKey, seq, data, author, remote }
 * { type: "hyperswarm:peer", action, peerKey, feedKey }
 */
export async function handleSignal(signalData: string): Promise<void> {
    let signal: unknown;
    try {
        signal = JSON.parse(signalData);
    } catch {
        return;
    }

    const result = handleInboundSignal(signal);

    if (result.kind === "block" && linkCallback) {
        // Immediately process the block and notify via callback
        const blockData = result.block.data;
        const { deserializeCommitBlock } = await import("./src/commit-block.pure.js");
        const commitBlock = deserializeCommitBlock(blockData);
        if (commitBlock) {
            const diff: PerspectiveDiff = {
                additions: commitBlock.additions,
                removals: commitBlock.removals,
            };
            if (diff.additions.length > 0 || diff.removals.length > 0) {
                linkCallback(diff);
            }
        }
    }

    if (result.kind === "ignored") {
        console.log(`[hypercore-link-language] signal ignored: ${result.reason}`);
    }
}
