/**
 * Sync coordination — processes new blocks received via signals.
 *
 * Since Hypercore operations are delegated to the executor, sync works by:
 * 1. Accumulating blocks received via handleSignal() between sync() calls
 * 2. On sync(), drain the block buffer
 * 3. Deserialize blocks into commit blocks
 * 4. Translate commit blocks into PerspectiveDiffs
 * 5. Deduplicate and return accumulated diff
 *
 * Uses injected interfaces — no ad4m:host imports.
 */

import type { PerspectiveDiff, LinkExpression } from "./types.js";
import type { HypercoreCommitBlock } from "./commit-block.pure.js";
import { deserializeCommitBlock } from "./commit-block.pure.js";
import { blockToPerspectiveDiff } from "./translate.pure.js";
import * as store from "./store.js";
import type { BlockSignal, PeerSignal } from "./signals.pure.js";

// ---------------------------------------------------------------------------
// Block buffer
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
// Sync
// ---------------------------------------------------------------------------

/**
 * Drain the block buffer, process blocks, store links, return diff.
 *
 * Deduplicates blocks by sequence number to handle potential duplicate
 * delivery from multiple peers.
 */
export function sync(): PerspectiveDiff {
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

    const allAdditions: LinkExpression[] = [];
    const allRemovals: LinkExpression[] = [];

    for (const blockSignal of uniqueBlocks) {
        const commitBlock = deserializeCommitBlock(blockSignal.data);
        if (!commitBlock) {
            console.log(`[hypercore-link-language] failed to parse block seq=${blockSignal.seq}`);
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
        store.setBlockProcessed(blockSignal.seq);

        // Track peer
        if (blockSignal.remote && blockSignal.author) {
            store.setPeer(blockSignal.author, {
                lastSeen: Date.now(),
                feedKey: blockSignal.feedKey,
            });
        }
    }

    // Update revision to latest sequence
    const latestSeq = Math.max(...uniqueBlocks.map(b => b.seq));
    store.setRevision(latestSeq.toString());

    return { additions: allAdditions, removals: allRemovals };
}

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
