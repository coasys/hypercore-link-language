/**
 * Writer key management for multi-writer Autobase.
 *
 * Manages the set of known writer feed keys for Autobase's input feeds.
 * Uses injected interfaces — no ad4m:host imports.
 *
 * Spec §6: Multi-Writer with Autobase.
 */

import { getStorage } from "./adapters.js";

// ---------------------------------------------------------------------------
// Writer key management
// ---------------------------------------------------------------------------

/**
 * Add a writer's feed key to the known writers set.
 *
 * @param feedKey - Hex-encoded feed public key (64 chars)
 * @param agentDid - Associated agent DID
 * @returns true if added, false if invalid or already exists
 */
export function addWriter(feedKey: string, agentDid: string): boolean {
    if (!isValidWriterKey(feedKey)) return false;

    const storage = getStorage();
    const key = writerKeyStorageKey(feedKey);
    const existing = storage.get(key);
    if (existing) return false; // Already registered

    storage.put(key, JSON.stringify({
        feedKey,
        agentDid,
        addedAt: new Date().toISOString(),
    }));

    return true;
}

/**
 * Remove a writer from the known writers set.
 */
export function removeWriter(feedKey: string): boolean {
    if (!isValidWriterKey(feedKey)) return false;

    const storage = getStorage();
    const key = writerKeyStorageKey(feedKey);
    const existing = storage.get(key);
    if (!existing) return false;

    storage.delete(key);
    return true;
}

/**
 * Check if a feed key is a known writer.
 */
export function isKnownWriter(feedKey: string): boolean {
    if (!isValidWriterKey(feedKey)) return false;
    return getStorage().get(writerKeyStorageKey(feedKey)) !== null;
}

/**
 * Get all known writer feed keys.
 */
export function listWriters(): Array<{ feedKey: string; agentDid: string; addedAt: string }> {
    const storage = getStorage();
    const keys = storage.listKeys(WRITER_KEYS_PREFIX);
    const writers: Array<{ feedKey: string; agentDid: string; addedAt: string }> = [];

    for (const key of keys) {
        const raw = storage.get(key);
        if (raw) {
            try {
                writers.push(JSON.parse(raw));
            } catch { /* skip malformed entries */ }
        }
    }

    return writers;
}

/**
 * Get the agent DID associated with a writer feed key.
 */
export function getWriterDid(feedKey: string): string | null {
    if (!isValidWriterKey(feedKey)) return null;

    const raw = getStorage().get(writerKeyStorageKey(feedKey));
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        return parsed.agentDid || null;
    } catch {
        return null;
    }
}

/**
 * Initialize writers from a settings-provided list of feed keys.
 * Used during init() to bootstrap the writer set.
 */
export function initWritersFromSettings(
    writerKeys: string[],
    defaultDid: string,
): number {
    let count = 0;
    for (const key of writerKeys) {
        if (addWriter(key, defaultDid)) {
            count++;
        }
    }
    return count;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Storage key prefix for writer entries. */
export const WRITER_KEYS_PREFIX = "writers/";

/** Expected length of a hex-encoded Ed25519 public key. */
export const FEED_KEY_HEX_LENGTH = 64;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a string is a valid hex-encoded Ed25519 feed key.
 *
 * Valid keys are exactly 64 hex characters (32 bytes).
 */
export function isValidWriterKey(key: string): boolean {
    if (typeof key !== "string") return false;
    if (key.length !== FEED_KEY_HEX_LENGTH) return false;
    return /^[0-9a-fA-F]+$/.test(key);
}

/**
 * Generate the storage key for a writer entry.
 */
export function writerKeyStorageKey(feedKey: string): string {
    return `${WRITER_KEYS_PREFIX}${feedKey}`;
}

/**
 * Normalize a feed key to lowercase hex.
 */
export function normalizeFeedKey(feedKey: string): string {
    return feedKey.toLowerCase();
}

/**
 * Compare two feed keys for equality (case-insensitive).
 */
export function feedKeysEqual(a: string, b: string): boolean {
    return normalizeFeedKey(a) === normalizeFeedKey(b);
}

/**
 * Validate a list of writer keys, returning only the valid ones.
 */
export function filterValidWriterKeys(keys: string[]): string[] {
    return keys.filter(isValidWriterKey);
}
