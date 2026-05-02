/**
 * Link ↔ commit block translation layer.
 *
 * Uses injected interfaces — no ad4m:host imports.
 *
 * Spec §2.3: Append-Only Log Structure.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import type { HypercoreCommitBlock } from "./commit-block.pure.js";
import { buildCommitBlock, buildCommitBlockWithTimestamp } from "./commit-block.js";
import { serializeCommitBlock, deserializeCommitBlock } from "./commit-block.pure.js";
import {
    linkContentKey,
    blockToPerspectiveDiff,
    blocksToPerspectiveDiff,
    isValidLink,
    verifyRoundTrip,
} from "./translate.pure.js";

// Re-export pure functions
export {
    linkContentKey,
    blockToPerspectiveDiff,
    blocksToPerspectiveDiff,
    isValidLink,
    verifyRoundTrip,
} from "./translate.pure.js";

// ---------------------------------------------------------------------------
// Outbound: PerspectiveDiff → serialized commit block
// ---------------------------------------------------------------------------

export interface CommitOptions {
    /** Current feed sequence number. */
    seq: number;
    /** Committing agent's DID. */
    author: string;
    /** Hash function for content addressing. */
    hashFn: (data: string) => string;
    /** Optional filter: skip links that should not be committed. */
    shouldCommit?: (linkHash: string, link: LinkExpression) => boolean;
}

export interface CommitResult {
    /** The serialized commit block ready for appending to the feed. */
    serialized: string;
    /** The commit block data structure. */
    block: HypercoreCommitBlock;
    /** Hashes of all links in the commit. */
    linkHashes: string[];
}

/**
 * Build and serialize a commit block from a PerspectiveDiff.
 *
 * Filters links through the optional shouldCommit predicate,
 * then constructs and serializes the commit block.
 */
export function commitDiff(
    diff: PerspectiveDiff,
    opts: CommitOptions,
): CommitResult | null {
    // Filter links if a predicate is provided
    let additions = diff.additions;
    let removals = diff.removals;
    const linkHashes: string[] = [];

    if (opts.shouldCommit) {
        additions = additions.filter(link => {
            const h = opts.hashFn(linkContentKey(link));
            const include = opts.shouldCommit!(h, link);
            if (include) linkHashes.push(h);
            return include;
        });
        removals = removals.filter(link => {
            const h = opts.hashFn(linkContentKey(link));
            return opts.shouldCommit!(h, link);
        });
    } else {
        for (const link of additions) {
            linkHashes.push(opts.hashFn(linkContentKey(link)));
        }
    }

    // Skip empty commits
    if (additions.length === 0 && removals.length === 0) {
        return null;
    }

    const block = buildCommitBlock(
        { additions, removals },
        opts.seq,
        opts.author,
    );

    return {
        serialized: serializeCommitBlock(block),
        block,
        linkHashes,
    };
}

/**
 * Build a commit block with an explicit timestamp (for deterministic testing).
 */
export function commitDiffWithTimestamp(
    diff: PerspectiveDiff,
    seq: number,
    author: string,
    timestamp: string,
): CommitResult {
    const block = buildCommitBlockWithTimestamp(diff, seq, author, timestamp);
    return {
        serialized: serializeCommitBlock(block),
        block,
        linkHashes: [],
    };
}

// ---------------------------------------------------------------------------
// Inbound: serialized data → PerspectiveDiff
// ---------------------------------------------------------------------------

/**
 * Process a raw block from the Hypercore feed into a PerspectiveDiff.
 *
 * Returns null if the block cannot be parsed.
 */
export function processBlock(data: string): {
    diff: PerspectiveDiff;
    block: HypercoreCommitBlock;
} | null {
    const block = deserializeCommitBlock(data);
    if (!block) return null;

    return {
        diff: blockToPerspectiveDiff(block),
        block,
    };
}

/**
 * Process multiple raw blocks into a single accumulated PerspectiveDiff.
 */
export function processBlocks(dataArray: string[]): {
    diff: PerspectiveDiff;
    blocks: HypercoreCommitBlock[];
} {
    const blocks: HypercoreCommitBlock[] = [];
    for (const data of dataArray) {
        const block = deserializeCommitBlock(data);
        if (block) blocks.push(block);
    }

    return {
        diff: blocksToPerspectiveDiff(blocks),
        blocks,
    };
}
