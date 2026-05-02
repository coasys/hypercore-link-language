/**
 * Pure writer key validation for Autobase membership.
 *
 * Zero runtime deps. All functions are deterministic and testable.
 *
 * Spec §6: Multi-Writer with Autobase.
 */

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
