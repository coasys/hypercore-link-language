/**
 * Writer key management for multi-writer Autobase.
 *
 * Manages the set of known writer feed keys for Autobase's input feeds.
 * Uses injected interfaces — no ad4m:host imports.
 *
 * Spec §6: Multi-Writer with Autobase.
 */

import { getStorage } from "./storage-interface.js";
import { isValidWriterKey, writerKeyStorageKey, WRITER_KEYS_PREFIX } from "./membership.pure.js";

// Re-export pure functions
export { isValidWriterKey, writerKeyStorageKey, WRITER_KEYS_PREFIX } from "./membership.pure.js";

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
