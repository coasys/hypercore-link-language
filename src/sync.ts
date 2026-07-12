/**
 * Sync coordination — folds new ops into the derived link cache, from either
 * the Autobase gateway or legacy executor signals.
 *
 * Two modes:
 * 1. Gateway-based (the real convergence path): sync() asks the gateway for the
 *    incremental diff of ops linearized after our cursor, shaped as a
 *    PerspectiveDiff, and folds it into the local cache. The Autobase-linearized
 *    op-log is authoritative; this cache is derived (Role B).
 * 2. Signal-based (legacy fallback): commit blocks arrive via handleSignal(),
 *    are buffered, and drained on sync().
 *
 * Uses injected interfaces — no ad4m:host imports.
 */

import type { PerspectiveDiff, LinkExpression } from "./types.js";
import { deserializeCommitBlock } from "./commit-block.js";
import { blockToPerspectiveDiff } from "./translate.js";
import * as store from "./store.js";
import type { BlockSignal, PeerSignal } from "./signals.js";
import { getGateway } from "./transport.js";
import { getRuntime } from "./adapters.js";

// ---------------------------------------------------------------------------
// Block buffer (signal-based mode)
// ---------------------------------------------------------------------------

let _blockBuffer: BlockSignal[] = [];

/**
 * Add a block signal to the sync buffer.
 * Called when the executor sends a hypercore:block signal.
 */
export function bufferBlock(block: BlockSignal): void {
    _blockBuffer.push(block);
}

/**
 * Get the current buffer size (for monitoring).
 */
export function getBufferSize(): number {
    return _blockBuffer.length;
}

/**
 * Clear the block buffer (used after sync or for testing).
 */
export function clearBuffer(): void {
    _blockBuffer = [];
}

// ---------------------------------------------------------------------------
// Gateway sync state
// ---------------------------------------------------------------------------

let _gatewayBaseKey: string = "";
/**
 * Cursor: the highest linearized op seq already folded into the cache. A value
 * of -1 means "before genesis", so the next diff folds the entire log.
 */
let _lastSyncedSeq: number = -1;

/**
 * Configure gateway-based sync with the Autobase key. Start the cursor before
 * genesis (-1) so the first sync folds the whole linearized op-log.
 */
export function setGatewaySync(baseKey: string, startSeq: number = -1): void {
    _gatewayBaseKey = baseKey;
    _lastSyncedSeq = startSeq;
}

/**
 * Get the last synced op seq (for gateway mode).
 */
export function getLastSyncedSeq(): number {
    return _lastSyncedSeq;
}

/**
 * Set the last synced op seq (e.g. after a read-your-writes commit).
 */
export function setLastSyncedSeq(seq: number): void {
    _lastSyncedSeq = seq;
}

/**
 * Record the result of a LOCAL commit. Caches the real content-hash revision,
 * but DELIBERATELY does NOT advance the fold cursor.
 *
 * Why not advance: the gateway linearizes every writer into ONE op-log with a
 * single global seq. A commit only appends OUR ops, yet peer ops may already be
 * interleaved BELOW `result.seq` and are not yet folded into our cache.
 * Advancing the cursor to `result.seq` here would make the next
 * `diff?since=seq` skip those peer ops permanently — both agents then freeze at
 * their own links (the observed C1 divergence, A=10/B=10). sync() owns the
 * cursor and advances it only after actually folding. Our own just-committed
 * links are already applied locally and emitted by the commit path, and sync()
 * dedups the echo, so read-your-writes still holds without touching the cursor.
 */
export function noteLocalCommit(result: { revision: string; seq: number }): void {
    if (result.revision) store.setRevision(result.revision);
    // Intentionally no _lastSyncedSeq mutation. See the doc-comment above.
}

// ---------------------------------------------------------------------------
// Shared: process entries into a diff
// ---------------------------------------------------------------------------

function processEntries(entries: { seq: number; data: string }[]): PerspectiveDiff {
    const allAdditions: LinkExpression[] = [];
    const allRemovals: LinkExpression[] = [];

    for (const entry of entries) {
        if (store.isBlockProcessed(entry.seq)) continue;

        const commitBlock = deserializeCommitBlock(entry.data);
        if (!commitBlock) {
            console.log(`[hypercore-link-language] failed to parse block seq=${entry.seq}`);
            continue;
        }

        const diff = blockToPerspectiveDiff(commitBlock);

        // Store links
        for (const addition of diff.additions) {
            store.putLink(addition);
        }
        for (const removal of diff.removals) {
            store.removeLink(removal);
        }

        allAdditions.push(...diff.additions);
        allRemovals.push(...diff.removals);

        // Mark block as processed
        store.setBlockProcessed(entry.seq);
    }

    return { additions: allAdditions, removals: allRemovals };
}

// ---------------------------------------------------------------------------
// Sync (unified)
// ---------------------------------------------------------------------------

/**
 * Fetch the incremental diff of ops linearized after our cursor from the
 * Autobase gateway, fold it into the derived cache, and return it as a
 * PerspectiveDiff. Falls back to draining the legacy signal buffer.
 */
export async function sync(): Promise<PerspectiveDiff> {
    const gateway = getGateway();

    // Gateway mode: the Autobase-linearized op-log is authoritative. Ask for the
    // diff since our cursor; the gateway returns ops (already merged/folded by
    // Autobase) shaped as a PerspectiveDiff plus the max linearized op seq.
    if (gateway && _gatewayBaseKey) {
        try {
            const result = await gateway.diff(_gatewayBaseKey, _lastSyncedSeq);

            // Cache the real content-hash revision the gateway reports.
            if (result.revision) store.setRevision(result.revision);

            const rawAdditions = (result.additions || []) as LinkExpression[];
            const rawRemovals = (result.removals || []) as LinkExpression[];

            // Advance the cursor even on empty diffs (seq is monotonic). Sound
            // here because we fold every op up to result.seq below before the
            // next sync reads from the advanced cursor.
            if (typeof result.seq === "number" && result.seq > _lastSyncedSeq) {
                _lastSyncedSeq = result.seq;
            }

            // Fold into the derived cache (Role B mirror of the linearized log),
            // keeping only the GENUINELY-NEW delta. Because commit() does not
            // advance the cursor past interleaved peer ops, a sync re-reads our
            // own just-committed links; those already sit in the cache and fold
            // to nothing, so we never re-emit our own links. Peer links are new
            // and surface exactly once.
            const additions: LinkExpression[] = [];
            for (const link of rawAdditions) {
                const isNew = store.getLink(store.hashLink(link)) === null;
                store.putLink(link);
                if (isNew) additions.push(link);
            }
            const removals: LinkExpression[] = [];
            for (const link of rawRemovals) {
                const wasPresent = store.getLink(store.hashLink(link)) !== null;
                store.removeLink(link);
                if (wasPresent) removals.push(link);
            }

            const delta: PerspectiveDiff = { additions, removals };

            // The executor DISCARDS sync()'s return value: inbound folds become
            // queryable in the perspective ONLY via the emitPerspectiveDiff host
            // channel. Surface the delta through the runtime adapter so peer
            // links actually reach the executor's perspective.
            if (additions.length > 0 || removals.length > 0) {
                getRuntime().emitPerspectiveDiff(delta);
            }

            return delta;
        } catch (err) {
            console.error(`[hypercore-link-language] gateway sync error:`, err);
            // Fall through to signal-based sync as fallback
        }
    }

    // Signal-based mode: drain the buffer
    return syncFromBuffer();
}

/**
 * Signal-based sync: drain the block buffer.
 * This is the original sync path, kept for backward compatibility.
 */
export function syncFromBuffer(): PerspectiveDiff {
    // Drain the buffer
    const blocks = _blockBuffer;
    _blockBuffer = [];

    if (blocks.length === 0) {
        return { additions: [], removals: [] };
    }

    // Deduplicate by sequence number + feed key
    const uniqueBlocks: BlockSignal[] = [];
    const seenKeys = new Set<string>();

    for (const block of blocks) {
        const dedupeKey = `${block.feedKey}:${block.seq}`;
        if (!seenKeys.has(dedupeKey) && !store.isBlockProcessed(block.seq)) {
            seenKeys.add(dedupeKey);
            uniqueBlocks.push(block);
        }
    }

    if (uniqueBlocks.length === 0) {
        return { additions: [], removals: [] };
    }

    // Sort by sequence number for consistent ordering
    uniqueBlocks.sort((a, b) => a.seq - b.seq);

    const entries = uniqueBlocks.map(b => ({ seq: b.seq, data: b.data }));
    const diff = processEntries(entries);

    // Update revision to latest sequence
    const latestSeq = Math.max(...uniqueBlocks.map(b => b.seq));
    store.setRevision(latestSeq.toString());

    // Track peers from signal metadata
    for (const blockSignal of uniqueBlocks) {
        if (blockSignal.remote && blockSignal.author) {
            store.setPeer(blockSignal.author, {
                lastSeen: Date.now(),
                feedKey: blockSignal.feedKey,
            });
        }
    }

    return diff;
}

// ---------------------------------------------------------------------------
// Inbound signal handler (signal-based mode, unchanged)
// ---------------------------------------------------------------------------

/**
 * Process a single inbound signal from the executor.
 *
 * Routes to the appropriate handler based on signal type.
 */
export function handleInboundSignal(
    signal: unknown,
): {
    kind: "block";
    block: BlockSignal;
} | {
    kind: "peer";
    peer: PeerSignal;
} | {
    kind: "ignored";
    reason: string;
} {
    if (typeof signal !== "object" || signal === null) {
        return { kind: "ignored", reason: "not an object" };
    }

    const s = signal as Record<string, unknown>;

    if (s.type === "hypercore:block") {
        const blockSignal = s as unknown as BlockSignal;
        bufferBlock(blockSignal);
        return { kind: "block", block: blockSignal };
    }

    if (s.type === "hyperswarm:peer") {
        const peerSignal = s as unknown as PeerSignal;
        if (peerSignal.action === "connected") {
            store.setPeer(peerSignal.peerKey, {
                connectedAt: Date.now(),
                feedKey: peerSignal.feedKey,
            });
        } else if (peerSignal.action === "disconnected") {
            store.removePeer(peerSignal.peerKey);
        }
        return { kind: "peer", peer: peerSignal };
    }

    return { kind: "ignored", reason: `unknown signal type: ${s.type}` };
}
