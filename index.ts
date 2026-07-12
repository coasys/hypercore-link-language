/**
 * # Hypercore Link Language for AD4M
 *
 * Bridge language that syncs Perspectives via a Hypercore **Autobase** —
 * a multi-writer, deterministically-linearized log — over Hyperswarm.
 *
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * ## Convergence model (honours AD4M's perspective-sync contract)
 *
 * The authoritative substrate (Role A) is an Autobase, owned by a sidecar
 * Node.js process (the hypercore-gateway) because native Hypercore/Autobase/
 * Hyperswarm cannot run inside the Language's Deno/WASM sandbox. Each agent
 * writes its own PerspectiveDiff ops (add/remove, keyed by the link's content
 * hash) to its own input feed; Autobase linearizes all writers into one DAG.
 *
 * - `currentRevision()` returns the Autobase **linearized Merkle head hash** —
 *   a real content hash, deterministic and identical across converged replicas.
 *   It is NEVER a sequence number.
 * - Removals are first-class ops carrying the ORIGINAL link's OR-Set hash, so an
 *   observed-remove converges against the exact add across replicas.
 * - The linearized op-log is authoritative; the local KV store is a derived
 *   read cache (Role B), rebuilt by folding gateway diffs.
 *
 * Two operating modes:
 *
 * 1. **Gateway mode** (the real convergence path): talks to the sidecar over
 *    httpFetch(). Set HYPERCORE_GATEWAY_URL to enable.
 *
 * 2. **Signal mode** (legacy fallback): diff blocks are relayed via executor
 *    signals into a local buffer. No native multi-writer linearization.
 *
 * Spec: SPEC_LINK_LANGUAGE_DIFFDAG_CONVERGENCE.md
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
import { shouldFederate, linkOriginKey, isPredicateExcluded } from "./src/translate.js";
import * as store from "./src/store.js";
import { orSetLinkHash } from "./src/link-hash.js";
import { emitAppend, emitJoinSwarm, emitLeaveSwarm } from "./src/signals.js";
import { sync as doSync, handleInboundSignal, clearBuffer, setGatewaySync, setLastSyncedSeq } from "./src/sync.js";
import { initWritersFromSettings, listWriterKeys } from "./src/membership.js";
import type { HashedLink } from "./src/transport.js";
import {
    initTelepresence,
    resetTelepresence,
    setOnlineStatus as tpSetOnlineStatus,
    getOnlineAgents as tpGetOnlineAgents,
    sendSignal as tpSendSignal,
    sendBroadcast as tpSendBroadcast,
    registerSignalCallback as tpRegisterSignalCallback,
    pollInbox,
} from "./src/telepresence.js";

// Adapter imports
import { initTransport, initGateway, getGateway } from "./src/transport.js";
import { initStorage, getStorage, initSigning, initRuntime } from "./src/adapters.js";
import { DenoTransport, DenoStorageAdapter, DenoSigningAdapter, DenoRuntime } from "./src/adapters-deno.js";

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
/** The Autobase key — the neighbourhood's stable identifier (hex). */
let baseKey: string = "";
let discoveryKey: string = "";
/** Highest linearized op seq we have folded into the local cache. */
let sinceSeq: number = -1;
/** Local append counter for the legacy signal protocol (NOT a revision). */
let legacySeq: number = 0;
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

        // Check for gateway mode first — the real Autobase convergence path.
        const gatewayUrl = HYPERCORE_GATEWAY_URL;
        if (isTemplateVarFilled(gatewayUrl)) {
            initGateway(gatewayUrl);
            gatewayMode = true;
            console.log(`[hypercore-link-language] init: gateway mode, url=${gatewayUrl}`);

            // Verify gateway connectivity
            try {
                const health = await getGateway()!.health();
                console.log(`[hypercore-link-language] gateway health: ${health.status}, bases: ${health.bases}`);
            } catch (err) {
                console.error(`[hypercore-link-language] gateway health check failed:`, err);
                console.warn(`[hypercore-link-language] will retry gateway on first operation`);
            }

            // Open (or create) the Autobase for this neighbourhood. HYPERCORE_KEY
            // is the Autobase key; "auto" / unfilled means create a fresh base.
            // Widened to string: the template variable is rewritten at publish
            // time, so its literal type is not meaningful here.
            const requestedKey: string = HYPERCORE_KEY || "";
            const openKey = (requestedKey === "auto" || !isTemplateVarFilled(requestedKey))
                ? undefined
                : requestedKey;
            try {
                const base = await getGateway()!.openBase(openKey);
                baseKey = base.key;
                discoveryKey = base.discoveryKey;
                console.log(
                    `[hypercore-link-language] base ${openKey ? "opened" : "created"}: ` +
                    `${baseKey.substring(0, 16)}... writable=${base.writable} ` +
                    `localWriter=${base.localWriterKey.substring(0, 16)}...`,
                );
            } catch (err) {
                console.error(`[hypercore-link-language] failed to open base:`, err);
                configured = false;
                return;
            }

            // Authorise any peer input feeds we know about (from settings), so
            // their ops linearize into our base. Best-effort: a peer we cannot
            // yet authorise simply won't converge until it is added.
            if (settings.multiWriter.enabled) {
                for (const writerKey of listWriterKeys()) {
                    try {
                        await getGateway()!.addWriter(baseKey, writerKey);
                        console.log(`[hypercore-link-language] authorised writer ${writerKey.substring(0, 16)}...`);
                    } catch (err) {
                        console.warn(`[hypercore-link-language] addWriter ${writerKey.substring(0, 16)}... failed:`, err);
                    }
                }
            }

            // Join Hyperswarm and replicate unless publish-only.
            if (settings.syncMode !== "publish-only") {
                try {
                    const bootstrap = [...parseBootstrapNodes(), ...settings.swarm.bootstrap];
                    await getGateway()!.startReplication(baseKey, bootstrap.length > 0 ? bootstrap : undefined);
                    console.log(`[hypercore-link-language] replication started`);
                } catch (err) {
                    console.warn(`[hypercore-link-language] replication start failed:`, err);
                }
            }

            configured = true;

            // The linearized op-log is authoritative; the local KV is a derived
            // cache. Start the sync cursor before genesis so the first sync()
            // folds the entire current log into the cache.
            sinceSeq = -1;
            setGatewaySync(baseKey, sinceSeq);

            // Initialize telepresence with gateway URL
            initTelepresence(gatewayUrl, myDid, baseKey);

            console.log(`[hypercore-link-language] init complete: did=${myDid}, base=${baseKey.substring(0, 16)}...`);
            return;
        }

        // Legacy signal-based mode
        baseKey = HYPERCORE_KEY || "";
        discoveryKey = DISCOVERY_KEY || "";

        // Guard: if critical template vars are unfilled, run in unconfigured mode
        if (!isTemplateVarFilled(baseKey) || !isTemplateVarFilled(discoveryKey)) {
            configured = false;
            console.warn(
                "[hypercore-link-language] init: template variables not filled — running in unconfigured mode. "
                + `HYPERCORE_KEY=${JSON.stringify(baseKey)}, DISCOVERY_KEY=${JSON.stringify(discoveryKey)}`
            );
            return;
        }

        configured = true;
        console.log(`[hypercore-link-language] init: signal mode, did=${myDid}, base=${baseKey.substring(0, 16)}...`);
        console.log(`[hypercore-link-language] sync mode: ${settings.syncMode}`);
        console.log(`[hypercore-link-language] multi-writer: ${settings.multiWriter.enabled}`);

        // Initialize known writers from settings
        if (settings.multiWriter.enabled && settings.multiWriter.writerKeys.length > 0) {
            const count = initWritersFromSettings(settings.multiWriter.writerKeys, myDid);
            console.log(`[hypercore-link-language] initialized ${count} writers from settings`);
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
        if (gatewayMode && configured && baseKey) {
            // Stop replication gracefully
            try {
                await getGateway()!.stopReplication(baseKey);
            } catch { /* ignore */ }
        } else if (configured && discoveryKey) {
            // Legacy: leave Hyperswarm
            emitLeaveSwarm(discoveryKey);
        }
        resetTelepresence();
        myDid = "";
        sinceSeq = -1;
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

            // 5. Gateway mode: commit the diff as OR-Set add/remove ops to the
            //    Autobase. Each op is keyed by the link's content hash (AD4M's
            //    own content-address hash), computed identically by the gateway,
            //    so all agents share one OR-Set keyspace. A removal carries the
            //    ORIGINAL link's hash, so an observed-remove converges against
            //    the exact add across replicas.
            if (gatewayMode) {
                const gateway = getGateway();
                if (!gateway) {
                    console.error("[hypercore-link-language] gateway not available for commit");
                    emitPerspectiveDiff(diff);
                    return "";
                }

                // Filter additions/removals through shouldCommit, wrapping each
                // surviving link with its OR-Set hash.
                const additions: HashedLink[] = [];
                const removals: HashedLink[] = [];
                for (const link of diff.additions) {
                    const h = orSetLinkHash(link, hash);
                    if (shouldCommit(h, link)) additions.push({ link, hash: h });
                }
                for (const link of diff.removals) {
                    const h = orSetLinkHash(link, hash);
                    if (shouldCommit(h, link)) removals.push({ link, hash: h });
                }

                if (additions.length === 0 && removals.length === 0) {
                    emitPerspectiveDiff(diff);
                    return "";
                }

                try {
                    const result = await gateway.commit(baseKey, additions, removals);
                    // Read-your-writes: advance the fold cursor past our own ops
                    // so sync() does not re-emit them, and cache the REAL
                    // content-hash revision the gateway returned.
                    if (result.seq >= 0) {
                        sinceSeq = result.seq;
                        setLastSyncedSeq(sinceSeq);
                    }
                    store.setRevision(result.revision);
                    console.log(
                        `[hypercore-link-language] committed ${additions.length} add / ` +
                        `${removals.length} remove → revision=${result.revision.substring(0, 12)}... seq=${result.seq}`,
                    );
                    emitPerspectiveDiff(diff);
                    return result.revision;
                } catch (err) {
                    console.error(`[hypercore-link-language] gateway commit failed:`, err);
                    emitPerspectiveDiff(diff);
                    return "";
                }
            }

            // 6. Legacy signal mode: build and serialize the commit block, then
            //    relay it via an executor append signal. This path has no
            //    Autobase, so it cannot produce a convergent content-hash
            //    revision — legacySeq is only the local append counter for the
            //    signal protocol and is deliberately NOT reported as a revision.
            const result = commitDiff(diff, {
                seq: legacySeq,
                author: myDid,
                hashFn: hash,
                shouldCommit,
            });

            if (result) {
                emitAppend(baseKey, result.serialized, legacySeq);
                legacySeq++;
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
            const diff = await doSync();

            // Poll telepresence inbox for incoming signals during sync cycle
            if (gatewayMode) {
                try {
                    await pollInbox();
                } catch (err) {
                    // Non-fatal: inbox polling failure should not break sync
                    console.warn(`[hypercore-link-language] inbox poll error:`, err);
                }
            }

            return diff;
        },

        async render() {
            // Prefer the gateway's authoritative folded link set (Role A); the
            // local KV is only a derived cache. Fall back to the cache if the
            // gateway is unreachable.
            if (gatewayMode && configured && baseKey) {
                const gateway = getGateway();
                if (gateway) {
                    try {
                        const { links } = await gateway.links(baseKey);
                        return { links: links as LinkExpression[] };
                    } catch (err) {
                        console.warn(`[hypercore-link-language] render: gateway links failed, using cache:`, err);
                    }
                }
            }
            return store.allLinks();
        },

        async currentRevision() {
            // The real content-hash revision is the Autobase linearized Merkle
            // head, fetched from the gateway. It is deterministic and identical
            // across converged replicas — never a sequence number. The cached
            // value (last commit's revision) is only a fallback when offline.
            if (gatewayMode && configured && baseKey) {
                const gateway = getGateway();
                if (gateway) {
                    try {
                        const { revision } = await gateway.revision(baseKey);
                        if (revision) {
                            store.setRevision(revision);
                            return revision;
                        }
                    } catch (err) {
                        console.warn(`[hypercore-link-language] currentRevision: gateway revision failed, using cache:`, err);
                    }
                }
            }
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

    // -----------------------------------------------------------------------
    // telepresence
    // -----------------------------------------------------------------------
    telepresence: {
        async setOnlineStatus(status: unknown): Promise<void> {
            return tpSetOnlineStatus(status);
        },

        async getOnlineAgents(): Promise<unknown[]> {
            return tpGetOnlineAgents();
        },

        async sendSignal(remoteDid: string, payload: unknown): Promise<object> {
            return tpSendSignal(remoteDid, payload);
        },

        async sendBroadcast(payload: unknown): Promise<object> {
            return tpSendBroadcast(payload);
        },

        async registerSignalCallback(callback: any): Promise<void> {
            return tpRegisterSignalCallback(callback);
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
    telepresenceSetOnlineStatus,
    telepresenceGetOnlineAgents,
    telepresenceSendSignal,
    telepresenceSendBroadcast,
    telepresenceRegisterSignalCallback,
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
        const { deserializeCommitBlock } = await import("./src/commit-block.js");
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
