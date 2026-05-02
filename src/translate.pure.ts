/**
 * Pure translation functions: Link ↔ commit block.
 *
 * Zero runtime deps. All functions are deterministic and testable.
 *
 * Spec §2.3: Append-Only Log Structure.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import type { HypercoreCommitBlock } from "./commit-block.pure.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic content key for a LinkExpression.
 * Used as input for content-address hashing.
 */
export function linkContentKey(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source,
        predicate: link.data.predicate,
        target: link.data.target,
        author: link.author,
        timestamp: link.timestamp,
    });
}

/**
 * Verify that a link expression has the minimum required fields.
 */
export function isValidLink(link: LinkExpression): boolean {
    return (
        typeof link.author === "string" &&
        typeof link.timestamp === "string" &&
        typeof link.data === "object" &&
        link.data !== null &&
        typeof link.data.source === "string" &&
        typeof link.data.target === "string" &&
        typeof link.proof === "object" &&
        link.proof !== null
    );
}

// ---------------------------------------------------------------------------
// Outbound: PerspectiveDiff → CommitBlock
// ---------------------------------------------------------------------------

/**
 * Convert a PerspectiveDiff into the body of a commit block.
 *
 * Does not assign seq/author/timestamp — those are added by
 * buildCommitBlock().
 */
export function diffToBlockPayload(diff: PerspectiveDiff): {
    additions: LinkExpression[];
    removals: LinkExpression[];
} {
    return {
        additions: [...diff.additions],
        removals: [...diff.removals],
    };
}

// ---------------------------------------------------------------------------
// Inbound: CommitBlock → PerspectiveDiff
// ---------------------------------------------------------------------------

/**
 * Extract a PerspectiveDiff from a commit block.
 *
 * This is the lossless reverse of building a commit block.
 */
export function blockToPerspectiveDiff(block: HypercoreCommitBlock): PerspectiveDiff {
    return {
        additions: block.additions,
        removals: block.removals,
    };
}

/**
 * Extract links from multiple commit blocks, accumulating into a
 * single PerspectiveDiff.
 */
export function blocksToPerspectiveDiff(blocks: HypercoreCommitBlock[]): PerspectiveDiff {
    const additions: LinkExpression[] = [];
    const removals: LinkExpression[] = [];

    for (const block of blocks) {
        additions.push(...block.additions);
        removals.push(...block.removals);
    }

    return { additions, removals };
}

// ---------------------------------------------------------------------------
// Round-trip verification
// ---------------------------------------------------------------------------

/**
 * Verify that a link survives a round-trip through commit block
 * serialization. Returns true if the link data is preserved.
 */
export function verifyRoundTrip(
    original: LinkExpression,
    recovered: LinkExpression,
): boolean {
    return (
        original.data.source === recovered.data.source &&
        original.data.target === recovered.data.target &&
        original.data.predicate === recovered.data.predicate &&
        original.author === recovered.author &&
        original.timestamp === recovered.timestamp &&
        original.proof.signature === recovered.proof.signature &&
        original.proof.key === recovered.proof.key
    );
}
