/**
 * Dual-language deduplication — origin tracking and federation filtering.
 *
 * When the Hypercore Link Language operates alongside another sync language
 * (e.g. Holochain, ActivityPub), we need to:
 * - Track which links originated from Hypercore vs native
 * - Prevent echo loops (don't re-publish Hypercore-origin links to Hypercore)
 * - Deduplicate links arriving via multiple paths
 *
 * Spec §10.
 *
 * Pure functions — no ad4m:host imports.
 */

import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LinkOrigin = "hypercore" | "native" | "dual";

// ---------------------------------------------------------------------------
// Origin tracking
// ---------------------------------------------------------------------------

/**
 * Build the storage key for tracking a link's origin.
 */
export function linkOriginKey(linkHash: string): string {
    return `link-origin/${linkHash}`;
}

// ---------------------------------------------------------------------------
// Federation filtering
// ---------------------------------------------------------------------------

/**
 * Determine if an outbound link should be committed to Hypercore.
 *
 * Links that originated from Hypercore should NOT be re-committed to avoid
 * echo loops. Only "native" or "dual" origin links should be committed.
 */
export function shouldFederate(
    linkHash: string,
    getOrigin: (key: string) => string | null,
): boolean {
    const origin = getOrigin(linkOriginKey(linkHash));
    if (origin === null) return true; // New local commit — federate
    return origin !== "hypercore"; // Skip if it came from Hypercore
}

/**
 * Check if a predicate should be excluded from federation.
 */
export function isPredicateExcluded(
    predicate: string,
    excludePredicates: string[],
): boolean {
    return excludePredicates.includes(predicate);
}

// ---------------------------------------------------------------------------
// Content deduplication
// ---------------------------------------------------------------------------

/**
 * Compute a canonical content key for dedup comparison.
 * Uses only the triple (source, predicate, target) — author/timestamp excluded.
 */
export function linkContentKey(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
    });
}

/**
 * Compute the content hash of a link for dedup tracking.
 */
export function linkContentHash(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    return hashFn(linkContentKey(link));
}
