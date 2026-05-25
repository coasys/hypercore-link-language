/**
 * Link ↔ commit block translation layer.
 *
 * Uses injected interfaces — no ad4m:host imports.
 *
 * Spec §2.3: Append-Only Log Structure.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import type { HypercoreCommitBlock } from "./commit-block.js";
import { buildCommitBlock, buildCommitBlockWithTimestamp } from "./commit-block.js";
import { serializeCommitBlock, deserializeCommitBlock } from "./commit-block.js";

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

// ---------------------------------------------------------------------------
// SDNA / Subject Class pattern detection (was sdna.ts)
// ---------------------------------------------------------------------------

export interface DetectedPattern {
    type: "chat-message" | "reply" | "content" | "mention" | "reaction" | "collection" | "unknown";
    contentUri?: string;
    parentUri?: string;
    channelUri?: string;
    mentionedAgent?: string;
    collectionUri?: string;
}

const _HC_CHAT_PREDICATES = new Set([
    "flux://has_message",
    "sioc://content_of",
]);

const _HC_REPLY_PREDICATES = new Set([
    "flux://has_reply",
    "sioc://reply_of",
]);

const _HC_REACTION_PREDICATES = new Set([
    "flux://has_reaction",
    "emoji://reaction",
]);

const _HC_COLLECTION_PREDICATES = new Set([
    "rdf://has_member",
    "flux://has_item",
]);

export function detectPattern(
    link: LinkExpression,
    chatPredicates?: string[],
): DetectedPattern {
    const predicate = link.data.predicate || "";
    const source = link.data.source || "";
    const target = link.data.target || "";

    const chatPreds = chatPredicates
        ? new Set([..._HC_CHAT_PREDICATES, ...chatPredicates])
        : _HC_CHAT_PREDICATES;

    if (predicate && chatPreds.has(predicate)) {
        return { type: "chat-message", contentUri: target, channelUri: source };
    }
    if (_HC_REPLY_PREDICATES.has(predicate)) {
        return { type: "reply", contentUri: target, parentUri: source };
    }
    if (predicate && predicate.toLowerCase().includes("mention")) {
        return { type: "mention", mentionedAgent: target };
    }
    if (_HC_REACTION_PREDICATES.has(predicate)) {
        return { type: "reaction", contentUri: target };
    }
    if (_HC_COLLECTION_PREDICATES.has(predicate)) {
        return { type: "collection", collectionUri: source, contentUri: target };
    }
    return { type: "unknown" };
}

export function isSocialPattern(pattern: DetectedPattern): boolean {
    return pattern.type === "chat-message" ||
        pattern.type === "reply" ||
        pattern.type === "reaction";
}

// ---------------------------------------------------------------------------
// Dual-language deduplication (was dual-language.ts)
// ---------------------------------------------------------------------------

export type LinkOrigin = "hypercore" | "native" | "dual";

export function linkOriginKey(linkHash: string): string {
    return `link-origin/${linkHash}`;
}

export function shouldFederate(
    linkHash: string,
    getOrigin: (key: string) => string | null,
): boolean {
    const origin = getOrigin(linkOriginKey(linkHash));
    if (origin === null) return true;
    return origin !== "hypercore";
}

export function isPredicateExcluded(
    predicate: string,
    excludePredicates: string[],
): boolean {
    return excludePredicates.includes(predicate);
}

/**
 * Triple-only content key for deduplication (excludes author/timestamp).
 * Use linkContentKey() for full identity hashing.
 */
export function dualLinkContentKey(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
    });
}

export function linkContentHash(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    return hashFn(dualLinkContentKey(link));
}
