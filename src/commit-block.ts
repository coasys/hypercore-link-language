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
import { getRuntime } from "./adapters.js";
import { orSetLinkContent } from "./link-hash.js";

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
): HypercoreCommitBlock {
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
): HypercoreCommitBlock {
    return {
        type: "ad4m:PerspectiveDiff",
        seq,
        author,
        timestamp,
        additions: diff.additions,
        removals: diff.removals,
    };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HypercoreCommitBlock {
    type: "ad4m:PerspectiveDiff";
    seq: number;
    author: string;
    timestamp: string;
    additions: LinkExpression[];
    removals: LinkExpression[];
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a commit block to a JSON string for storage in the Hypercore feed.
 */
export function serializeCommitBlock(block: HypercoreCommitBlock): string {
    return JSON.stringify(block);
}

/**
 * Deserialize a JSON string from the Hypercore feed into a commit block.
 *
 * Returns null if the data is not a valid commit block.
 */
export function deserializeCommitBlock(data: string): HypercoreCommitBlock | null {
    try {
        const parsed = JSON.parse(data);
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            parsed.type !== "ad4m:PerspectiveDiff" ||
            typeof parsed.seq !== "number" ||
            typeof parsed.author !== "string" ||
            typeof parsed.timestamp !== "string" ||
            !Array.isArray(parsed.additions) ||
            !Array.isArray(parsed.removals)
        ) {
            return null;
        }
        return parsed as HypercoreCommitBlock;
    } catch {
        return null;
    }
}

/**
 * Canonical string form of a commit block, for content addressing.
 *
 * Includes the FULL content of every link (via the same canonical form the
 * OR-Set uses), not just counts, so two blocks with different links hash
 * differently. Fixed field order for determinism.
 */
export function canonicalBlockContent(block: HypercoreCommitBlock): string {
    return JSON.stringify([
        block.type,
        block.seq,
        block.author,
        block.timestamp,
        block.additions.map(orSetLinkContent),
        block.removals.map(orSetLinkContent),
    ]);
}

/**
 * Compute a real content-address hash of a commit block.
 *
 * Hashes the full canonical content (including every link) with the runtime's
 * content-address hash (AD4M's hash: SHA-256 → CIDv1 → base58btc). Deterministic
 * for identical blocks, distinct for any content difference. An explicit hashFn
 * may be injected for testing without the runtime.
 */
export function computeBlockHash(
    block: HypercoreCommitBlock,
    hashFn?: (data: string) => string,
): string {
    const fn = hashFn ?? getRuntime().hash;
    return fn(canonicalBlockContent(block));
}

/**
 * Extract a PerspectiveDiff from a commit block.
 */
export function blockToDiff(block: HypercoreCommitBlock): {
    additions: LinkExpression[];
    removals: LinkExpression[];
} {
    return {
        additions: block.additions,
        removals: block.removals,
    };
}

/**
 * Validate that a commit block has the correct structure.
 */
export function isValidCommitBlock(block: unknown): block is HypercoreCommitBlock {
    if (typeof block !== "object" || block === null) return false;
    const b = block as Record<string, unknown>;
    return (
        b.type === "ad4m:PerspectiveDiff" &&
        typeof b.seq === "number" &&
        typeof b.author === "string" &&
        typeof b.timestamp === "string" &&
        Array.isArray(b.additions) &&
        Array.isArray(b.removals)
    );
}
