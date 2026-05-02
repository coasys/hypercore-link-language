/**
 * # Hypercore Link Language for AD4M
 *
 * Bridge language that syncs Perspectives via Hypercore append-only logs
 * and Hyperswarm P2P networking.
 *
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * Two operating modes:
 *
 * 1. **Gateway mode** (preferred): A sidecar Node.js process (hypercore-gateway)
 *    handles native Hypercore/Hyperswarm operations. This language talks to it
 *    via httpFetch() through the standard AD4M networking API.
 *    Set HYPERCORE_GATEWAY_URL to enable.
 *
 * 2. **Signal mode** (legacy): Hypercore operations are delegated to the executor
 *    via signal-based communication. Requires executor-side Hypercore support.
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
import { sync as doSync, handleInboundSignal, clearBuffer, setGatewaySync, setLastSyncedSeq } from "./src/sync.js";
import { initWritersFromSettings } from "./src/membership.js";
import { serializeCommitBlock } from "./src/commit-block.pure.js";
import { buildCommitBlock } from "./src/commit-block.js";

// Adapter imports
import { initTransport, initGateway, getGateway } from "./src/transport.js";
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

//!@ad4m-template-variable
const HYPERCORE_GATEWAY_URL = "<to-be-filled>";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let settings: HypercoreSettings;
let feedKey: string = "";
let discoveryKey: string = "";
let currentSeq: number = 0;
let configured: boolean = true;
let gatewayMode: boolean = false;

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
    version: "0.2.0",

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

        // Check for gateway mode first
        const gatewayUrl = HYPERCORE_GATEWAY_URL;
        if (isTemplateVarFilled(gatewayUrl)) {
            initGateway(gatewayUrl);
            gatewayMode = true;
            console.log(`[hypercore-link-language] init: gateway mode, url=${gatewayUrl}`);

            // Verify gateway connectivity
            try {
                const health = await getGateway()!.health();
                console.log(`[hypercore-link-language] gateway health: ${health.status}, feeds: ${health.feeds}`);
            } catch (err) {
                console.error(`[hypercore-link-language] gateway health check failed:`, err);
                console.warn(`[hypercore-link-language] will retry gateway on first operation`);
            }

            // Handle feed key: "auto" means create a new feed
            feedKey = HYPERCORE_KEY || "";
            discoveryKey = DISCOVERY_KEY || "";

            if (feedKey === "auto" || !isTemplateVarFilled(feedKey)) {
                try {
                    const feed = await getGateway()!.createFeed();
                    feedKey = feed.key;
                    discoveryKey = feed.discoveryKey;
                    console.log(`[hypercore-link-language] created new feed: ${feedKey.substring(0, 16)}...`);
                } catch (err) {
                    console.error(`[hypercore-link-language] failed to create feed:`, err);
                    configured = false;
                    return;
                }
            }

            // Start replication if discovery key is available
            if (discoveryKey && discoveryKey !== "auto" && settings.syncMode !== "publish-only") {
                try {
                    await getGateway()!.startReplication(feedKey);
                    console.log(`[hypercore-link-language] replication started`);
                } catch (err) {
                    console.warn(`[hypercore-link-language] replication start failed:`, err);
                }
            }

            configured = true;

            // Restore sync cursor from revision
            const rev = store.getRevision();
            if (rev) {
                currentSeq = parseInt(rev, 10) + 1;
            }

            // Set up gateway-based sync
            setGatewaySync(feedKey, currentSeq);

            console.log(`[hypercore-link-language] init complete: did=${myDid}, feed=${feedKey.substring(0, 16)}..., seq=${currentSeq}`);
            return;
        }

        // Legacy signal-based mode
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
        console.log(`[hypercore-link-language] init: signal mode, did=${myDid}, feed=${feedKey.substring(0, 16)}...`);
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
        if (gatewayMode && configured && feedKey) {
            // Stop replication gracefully
            try {
                await getGateway()!.stopReplication(feedKey);
            } catch { /* ignore */ }
        } else if (configured && discoveryKey) {
            // Legacy: leave Hyperswarm
            emitLeaveSwarm(discoveryKey);
        }
        myDid = "";
        currentSeq = 0;
        gatewayMode = false;
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
                if (settings.dualLanguage.enabled) {
                    if (!shouldFederate(linkHash, (key) => getStorage().get(key))) {
                        return false;
                    }
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
                    const originKey_ = linkOriginKey(h);
                    const storage = getStorage();
                    const existing = storage.get(originKey_);
                    if (existing === "hypercore") {
                        storage.put(originKey_, "dual");
                    } else if (!existing) {
                        storage.put(originKey_, "native");
                    }
                }
            }

            // 5. Gateway mode: serialize commit block and POST to gateway
            if (gatewayMode) {
                const gateway = getGateway();
                if (!gateway) {
                    console.error("[hypercore-link-language] gateway not available for commit");
                    emitPerspectiveDiff(diff);
                    return "";
                }

                // Filter additions/removals through shouldCommit
                let additions = diff.additions;
                let removals = diff.removals;

                if (settings.dualLanguage.enabled) {
                    additions = additions.filter(link => {
                        const h = store.hashLink(link);
                        return shouldCommit(h, link);
                    });
                    removals = removals.filter(link => {
                        const h = store.hashLink(link);
                        return shouldCommit(h, link);
                    });
                }

                if (additions.length === 0 && removals.length === 0) {
                    emitPerspectiveDiff(diff);
                    return "";
                }

                // Build the commit block
                const block = buildCommitBlock(
                    { additions, removals },
                    currentSeq,
                    myDid,
                );
                const serialized = serializeCommitBlock(block);

                try {
                    const result = await gateway.append(feedKey, serialized);
                    currentSeq = result.seq + 1;
                    store.setRevision(result.seq.toString());
                    store.setBlockProcessed(result.seq);
                    setLastSyncedSeq(currentSeq);
                    console.log(`[hypercore-link-language] committed block seq=${result.seq} (${result.byteLength} bytes)`);
                } catch (err) {
                    console.error(`[hypercore-link-language] gateway append failed:`, err);
                }

                emitPerspectiveDiff(diff);
                return "";
            }

            // 6. Legacy signal mode: build and serialize the commit block
            const result = commitDiff(diff, {
                seq: currentSeq,
                author: myDid,
                hashFn: hash,
                shouldCommit,
            });

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
// Signal handler (legacy mode — still functional for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Handle signals emitted by the executor.
 *
 * In gateway mode, this is largely unused since sync() fetches from the
 * HTTP API. Kept for backward compatibility with signal-based executors.
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
