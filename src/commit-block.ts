/**
 * Hypercore commit block type and construction.
 *
 * Uses injected interfaces — no ad4m:host imports.
 *
 * A commit block represents a single PerspectiveDiff appended to the
 * Hypercore feed. The executor handles actual feed append operations;
 * this module provides the data model and construction logic.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import {
    serializeCommitBlock,
    deserializeCommitBlock,
    computeBlockHash,
} from "./commit-block.pure.js";

// Re-export pure functions for convenience
export {
    serializeCommitBlock,
    deserializeCommitBlock,
    computeBlockHash,
} from "./commit-block.pure.js";

// Re-export the type
export type { HypercoreCommitBlock } from "./commit-block.pure.js";

/**
 * Build a commit block from a PerspectiveDiff.
 *
 * @param diff - The perspective diff to commit
 * @param seq - Sequence number in the feed
 * @param author - DID of the committing agent
 * @returns A fully-formed commit block
 */
export function buildCommitBlock(
    diff: PerspectiveDiff,
    seq: number,
    author: string,
): import("./commit-block.pure.js").HypercoreCommitBlock {
    return {
        type: "ad4m:PerspectiveDiff",
        seq,
        author,
        timestamp: new Date().toISOString(),
        additions: diff.additions,
        removals: diff.removals,
    };
}

/**
 * Build a commit block with an explicit timestamp (for testing/replay).
 */
export function buildCommitBlockWithTimestamp(
    diff: PerspectiveDiff,
    seq: number,
    author: string,
    timestamp: string,
): import("./commit-block.pure.js").HypercoreCommitBlock {
    return {
        type: "ad4m:PerspectiveDiff",
        seq,
        author,
        timestamp,
        additions: diff.additions,
        removals: diff.removals,
    };
}
