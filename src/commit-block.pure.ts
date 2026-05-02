/**
 * Pure commit block serialization/deserialization.
 *
 * Zero runtime deps. All functions are deterministic and testable.
 *
 * Spec §2.3: Append-Only Log Structure.
 */

import type { LinkExpression } from "./types.js";

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
 * Compute a deterministic hash of a commit block for content addressing.
 *
 * Uses a simple string-based hash since the actual content-address hash
 * is provided by the runtime adapter. This function produces a
 * deterministic input string for hashing.
 */
export function computeBlockHash(block: HypercoreCommitBlock): string {
    return JSON.stringify({
        type: block.type,
        seq: block.seq,
        author: block.author,
        timestamp: block.timestamp,
        additionCount: block.additions.length,
        removalCount: block.removals.length,
    });
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
