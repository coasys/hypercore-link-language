/**
 * Hyperbee index key generation — wraps pure key functions with
 * storage adapter integration.
 *
 * Uses injected interfaces — no ad4m:host imports.
 *
 * Spec §7: Hyperbee Indexing.
 */

import type { LinkExpression } from "./types.js";

/**
 * Generate all index entries for a LinkExpression.
 *
 * @param link - The link to index
 * @param linkHash - Precomputed hash of the link
 * @param enabledFields - Which fields to index
 * @returns Array of [key, value] pairs for the storage adapter
 */
export function indexEntriesForLink(
    link: LinkExpression,
    linkHash: string,
    enabledFields: IndexField[],
): Array<[key: string, value: string]> {
    return allIndexKeys(
        linkHash,
        link.data.source || "",
        link.data.target || "",
        link.data.predicate || "",
        link.author,
        link.timestamp,
        enabledFields,
    );
}

/**
 * Generate all index keys to delete for a LinkExpression removal.
 */
export function indexKeysForDeletion(
    link: LinkExpression,
    linkHash: string,
    enabledFields: IndexField[],
): string[] {
    return allIndexKeysForDeletion(
        linkHash,
        link.data.source || "",
        link.data.target || "",
        link.data.predicate || "",
        link.author,
        link.timestamp,
        enabledFields,
    );
}

// ---------------------------------------------------------------------------
// Primary key (stores the full link)
// ---------------------------------------------------------------------------

/**
 * Generate the primary storage key for a link by its hash.
 */
export function hashKey(hash: string): string {
    return `link:hash:${hash}`;
}

// ---------------------------------------------------------------------------
// Secondary index keys (store pointers to the hash)
// ---------------------------------------------------------------------------

/**
 * Generate the source index key.
 */
export function sourceKey(source: string, hash: string): string {
    return `link:src:${source}:${hash}`;
}

/**
 * Generate the target index key.
 */
export function targetKey(target: string, hash: string): string {
    return `link:tgt:${target}:${hash}`;
}

/**
 * Generate the predicate index key.
 */
export function predicateKey(predicate: string, hash: string): string {
    return `link:pred:${predicate}:${hash}`;
}

/**
 * Generate the author index key.
 */
export function authorKey(author: string, hash: string): string {
    return `link:auth:${author}:${hash}`;
}

/**
 * Generate the timestamp index key.
 */
export function timestampKey(timestamp: string, hash: string): string {
    return `link:time:${timestamp}:${hash}`;
}

// ---------------------------------------------------------------------------
// Meta keys
// ---------------------------------------------------------------------------

/** Key for tracking the latest commit sequence number. */
export const META_HEAD_KEY = "meta:head";

/** Key for neighbourhood configuration. */
export const META_NEIGHBOURHOOD_KEY = "meta:neighbourhood";

// ---------------------------------------------------------------------------
// Range query prefixes
// ---------------------------------------------------------------------------

/**
 * Generate the prefix for a source range query.
 * All links with a given source have keys in [prefix, prefix\xff).
 */
export function sourcePrefix(source: string): string {
    return `link:src:${source}:`;
}

/**
 * Generate the prefix for a target range query.
 */
export function targetPrefix(target: string): string {
    return `link:tgt:${target}:`;
}

/**
 * Generate the prefix for a predicate range query.
 */
export function predicatePrefix(predicate: string): string {
    return `link:pred:${predicate}:`;
}

/**
 * Generate the prefix for an author range query.
 */
export function authorPrefix(author: string): string {
    return `link:auth:${author}:`;
}

/**
 * Generate the prefix for a timestamp range query.
 */
export function timestampPrefix(timestamp: string): string {
    return `link:time:${timestamp}:`;
}

/** Prefix for all primary link entries. */
export const ALL_LINKS_PREFIX = "link:hash:";

// ---------------------------------------------------------------------------
// Index field list
// ---------------------------------------------------------------------------

/** The set of supported index fields. */
export type IndexField = "source" | "target" | "predicate" | "author" | "timestamp";

/**
 * Generate all index keys for a link given its field values and hash.
 *
 * Returns an array of [key, value] pairs. The primary key stores the
 * full data; secondary keys store the hash as a pointer.
 */
export function allIndexKeys(
    hash: string,
    source: string,
    target: string,
    predicate: string,
    author: string,
    timestamp: string,
    enabledFields: IndexField[],
): Array<[key: string, value: string]> {
    const entries: Array<[string, string]> = [];

    // Primary key is always created
    entries.push([hashKey(hash), hash]);

    // Secondary indexes based on enabled fields
    if (enabledFields.includes("source") && source) {
        entries.push([sourceKey(source, hash), hash]);
    }
    if (enabledFields.includes("target") && target) {
        entries.push([targetKey(target, hash), hash]);
    }
    if (enabledFields.includes("predicate") && predicate) {
        entries.push([predicateKey(predicate, hash), hash]);
    }
    if (enabledFields.includes("author") && author) {
        entries.push([authorKey(author, hash), hash]);
    }
    if (enabledFields.includes("timestamp") && timestamp) {
        entries.push([timestampKey(timestamp, hash), hash]);
    }

    return entries;
}

/**
 * Generate all index keys that should be deleted when a link is removed.
 */
export function allIndexKeysForDeletion(
    hash: string,
    source: string,
    target: string,
    predicate: string,
    author: string,
    timestamp: string,
    enabledFields: IndexField[],
): string[] {
    const keys: string[] = [hashKey(hash)];

    if (enabledFields.includes("source") && source) {
        keys.push(sourceKey(source, hash));
    }
    if (enabledFields.includes("target") && target) {
        keys.push(targetKey(target, hash));
    }
    if (enabledFields.includes("predicate") && predicate) {
        keys.push(predicateKey(predicate, hash));
    }
    if (enabledFields.includes("author") && author) {
        keys.push(authorKey(author, hash));
    }
    if (enabledFields.includes("timestamp") && timestamp) {
        keys.push(timestampKey(timestamp, hash));
    }

    return keys;
}
