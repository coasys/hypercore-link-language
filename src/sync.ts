/**
 * Sync coordination — processes new blocks, from either signals or gateway.
 *
 * Two modes:
 * 1. Signal-based (legacy): blocks arrive via handleSignal(), buffered, drained on sync()
 * 2. Gateway-based: sync() fetches new entries from the HTTP gateway
 *
 * Uses injected interfaces — no ad4m:host imports.
 */

import type { PerspectiveDiff, LinkExpression } from "./types.js";
import type { HypercoreCommitBlock } from "./commit-block.pure.js";
import { deserializeCommitBlock } from "./commit-block.pure.js";
import { blockToPerspectiveDiff } from "./translate.pure.js";
import * as store from "./store.js";
import type { BlockSignal, PeerSignal } from "./signals.pure.js";
import { getGateway } from "./transport.js";
import type { Entry } from "./transport.js";

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

let _gatewayFeedKey: string = "";
let _lastSyncedSeq: number = 0;

/**
 * Configure gateway-based sync with a feed key.
 */
export function setGatewaySync(feedKey: string, startSeq: number = 0): void {
    _gatewayFeedKey = feedKey;
    _lastSyncedSeq = startSeq;
}

/**
 * Get the last synced sequence number (for gateway mode).
 */
export function getLastSyncedSeq(): number {
    return _lastSyncedSeq;
}

/**
 * Set the last synced sequence (e.g. after a commit).
 */
export function setLastSyncedSeq(seq: number): void {
    _lastSyncedSeq = seq;
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
 * Drain the block buffer and/or fetch from gateway, process blocks,
 * store links, return diff.
 */
export async function sync(): Promise<PerspectiveDiff> {
    const gateway = getGateway();

    // Gateway mode: fetch new entries from the HTTP sidecar
    if (gateway && _gatewayFeedKey) {
        try {
            const result = await gateway.sync(_gatewayFeedKey, _lastSyncedSeq);

            if (result.entries.length === 0) {
                return { additions: [], removals: [] };
            }

            const diff = processEntries(result.entries);

            // Update sync cursor
            if (result.entries.length > 0) {
                const maxSeq = Math.max(...result.entries.map(e => e.seq));
                _lastSyncedSeq = maxSeq + 1;
                store.setRevision(maxSeq.toString());
            }

            return diff;
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
