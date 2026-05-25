/**
 * Local link store — wraps the storage adapter KV API to maintain
 * a link store with indexes.
 *
 * Key scheme mirrors the Hyperbee index format from index-keys.pure.ts
 * but uses the storage adapter KV for the local (in-Language) cache.
 *
 * Uses injected interfaces — no ad4m:host imports.
 */

import type { StorageAdapter } from "./adapters.js";
import { getStorage } from "./adapters.js";
import { getRuntime } from "./adapters.js";
import type { LinkExpression, PerspectiveDiff, Perspective } from "./types.js";

let _hashFn: ((data: string) => string) | null = null;

/**
 * Initialize the store module.
 */
export function initStore(hashFn?: (data: string) => string): void {
    _hashFn = hashFn ?? null;
}

function getHashFn(): (data: string) => string {
    if (_hashFn) return _hashFn;
    return getRuntime().hash;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function linkKey(linkHash: string): string {
    return `links/${linkHash}`;
}

function sourceIndexKey(source: string, linkHash: string): string {
    return `links-by-source/${source}/${linkHash}`;
}

function targetIndexKey(target: string, linkHash: string): string {
    return `links-by-target/${target}/${linkHash}`;
}

function predIndexKey(predicate: string, linkHash: string): string {
    return `links-by-pred/${predicate}/${linkHash}`;
}

function authorIndexKey(author: string, linkHash: string): string {
    return `links-by-author/${author}/${linkHash}`;
}

function peerKey(pubkey: string): string {
    return `peers/${pubkey}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash for a LinkExpression.
 */
export function hashLink(link: LinkExpression): string {
    const content = JSON.stringify({
        source: link.data.source,
        predicate: link.data.predicate,
        target: link.data.target,
        author: link.author,
        timestamp: link.timestamp,
    });
    return getHashFn()(content);
}

/**
 * Store a single LinkExpression and update all indexes.
 */
export function putLink(link: LinkExpression): string {
    const h = hashLink(link);
    const storage = getStorage();
    storage.put(linkKey(h), JSON.stringify(link));

    const source = link.data.source || "";
    const target = link.data.target || "";
    const predicate = link.data.predicate || "";
    const author = link.author || "";

    if (source) storage.put(sourceIndexKey(source, h), h);
    if (target) storage.put(targetIndexKey(target, h), h);
    if (predicate) storage.put(predIndexKey(predicate, h), h);
    if (author) storage.put(authorIndexKey(author, h), h);

    return h;
}

/**
 * Remove a LinkExpression and its index entries.
 */
export function removeLink(link: LinkExpression): void {
    const h = hashLink(link);
    const storage = getStorage();
    storage.delete(linkKey(h));

    const source = link.data.source || "";
    const target = link.data.target || "";
    const predicate = link.data.predicate || "";
    const author = link.author || "";

    if (source) storage.delete(sourceIndexKey(source, h));
    if (target) storage.delete(targetIndexKey(target, h));
    if (predicate) storage.delete(predIndexKey(predicate, h));
    if (author) storage.delete(authorIndexKey(author, h));
}

/**
 * Retrieve a link by its hash.
 */
export function getLink(linkHash: string): LinkExpression | null {
    const raw = getStorage().get(linkKey(linkHash));
    if (!raw) return null;
    return JSON.parse(raw) as LinkExpression;
}

/**
 * Apply a full PerspectiveDiff to the store.
 */
export function applyDiff(diff: PerspectiveDiff): void {
    for (const addition of diff.additions) {
        putLink(addition);
    }
    for (const removal of diff.removals) {
        removeLink(removal);
    }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface LinkQuery {
    source?: string;
    target?: string;
    predicate?: string;
    author?: string;
}

/**
 * Query links by pattern.
 */
export function queryLinks(query: LinkQuery): LinkExpression[] {
    const { source, target, predicate, author } = query;
    const storage = getStorage();

    let candidateHashes: string[];

    if (source) {
        const keys = storage.listKeys(`links-by-source/${source}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else if (target) {
        const keys = storage.listKeys(`links-by-target/${target}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else if (predicate) {
        const keys = storage.listKeys(`links-by-pred/${predicate}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else if (author) {
        const keys = storage.listKeys(`links-by-author/${author}/`);
        candidateHashes = keys.map((k: string) => {
            const raw = storage.get(k);
            return raw || "";
        }).filter(Boolean);
    } else {
        const keys = storage.listKeys("links/");
        candidateHashes = keys.map((k: string) => k.replace("links/", ""));
    }

    const results: LinkExpression[] = [];
    const seen = new Set<string>();

    for (const h of candidateHashes) {
        if (seen.has(h)) continue;
        seen.add(h);

        const link = getLink(h);
        if (!link) continue;

        if (source && link.data.source !== source) continue;
        if (target && link.data.target !== target) continue;
        if (predicate && link.data.predicate !== predicate) continue;
        if (author && link.author !== author) continue;

        results.push(link);
    }

    return results;
}

/**
 * Return all links in the store.
 */
export function allLinks(): Perspective {
    const keys = getStorage().listKeys("links/");
    const links: LinkExpression[] = [];

    for (const key of keys) {
        const raw = getStorage().get(key);
        if (raw) {
            links.push(JSON.parse(raw) as LinkExpression);
        }
    }

    return { links };
}

// ---------------------------------------------------------------------------
// Block tracking
// ---------------------------------------------------------------------------

/**
 * Store a mapping between a block sequence number and its processed state.
 */
export function setBlockProcessed(seq: number): void {
    getStorage().put(`block:processed:${seq}`, "1");
}

/**
 * Check if a block sequence has been processed.
 */
export function isBlockProcessed(seq: number): boolean {
    return getStorage().get(`block:processed:${seq}`) !== null;
}

// ---------------------------------------------------------------------------
// Revision tracking
// ---------------------------------------------------------------------------

const REVISION_KEY = "revision";

export function getRevision(): string | null {
    return getStorage().get(REVISION_KEY);
}

export function setRevision(rev: string): void {
    getStorage().put(REVISION_KEY, rev);
}

// ---------------------------------------------------------------------------
// Seen blocks (deduplication)
// ---------------------------------------------------------------------------

/**
 * Check if a block has been seen before (by content hash).
 */
export function hasSeenBlock(blockHash: string): boolean {
    return getStorage().get(`block:seen:${blockHash}`) !== null;
}

/**
 * Mark a block as seen.
 */
export function markBlockSeen(blockHash: string): void {
    getStorage().put(`block:seen:${blockHash}`, "1");
}

// ---------------------------------------------------------------------------
// Peer management
// ---------------------------------------------------------------------------

export function setPeer(peerKey_: string, metadata: Record<string, unknown> = {}): void {
    getStorage().put(peerKey(peerKey_), JSON.stringify(metadata));
}

export function removePeer(peerKey_: string): void {
    getStorage().delete(peerKey(peerKey_));
}

export function listPeers(prefix: string = "peers/"): string[] {
    const keys = getStorage().listKeys(prefix);
    return keys.map((k: string) => k.replace(prefix, ""));
}

export function getPeerMetadata(peerKey_: string): Record<string, unknown> | null {
    const raw = getStorage().get(peerKey(peerKey_));
    if (!raw) return null;
    return JSON.parse(raw);
}
