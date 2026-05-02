/**
 * Block encryption interface — symmetric key management for encrypted feeds.
 *
 * Hypercore feeds can be encrypted at rest using a shared symmetric key.
 * Only peers with the key can read block contents. The feed structure
 * (block count, sizes) is still visible.
 *
 * Uses injected interfaces — no ad4m:host imports.
 *
 * Spec §11: Encryption.
 */

import { getStorage } from "./storage-interface.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY_STORAGE = "hypercore:encryption:key";
const ENCRYPTION_ENABLED_STORAGE = "hypercore:encryption:enabled";

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/**
 * Store the encryption key for the feed.
 * The key should be a hex-encoded symmetric key.
 */
export function setEncryptionKey(keyHex: string): void {
    getStorage().put(ENCRYPTION_KEY_STORAGE, keyHex);
    getStorage().put(ENCRYPTION_ENABLED_STORAGE, "true");
}

/**
 * Get the stored encryption key.
 */
export function getEncryptionKey(): string | null {
    return getStorage().get(ENCRYPTION_KEY_STORAGE);
}

/**
 * Check if encryption is enabled.
 */
export function isEncryptionEnabled(): boolean {
    return getStorage().get(ENCRYPTION_ENABLED_STORAGE) === "true";
}

/**
 * Remove the encryption key (disables encryption).
 */
export function clearEncryptionKey(): void {
    getStorage().delete(ENCRYPTION_KEY_STORAGE);
    getStorage().delete(ENCRYPTION_ENABLED_STORAGE);
}

// ---------------------------------------------------------------------------
// Block encryption/decryption (placeholder for actual crypto)
//
// In production, the executor handles actual encryption/decryption using
// sodium-native or equivalent. The Language stores the key and tells the
// executor whether to encrypt/decrypt blocks.
//
// The signal protocol communicates encryption state:
// - On append: if encryption enabled, executor encrypts before storing
// - On block receive: executor decrypts before sending to Language
// ---------------------------------------------------------------------------

/**
 * Prepare a block for encrypted storage.
 *
 * Returns the block data and a flag indicating whether encryption
 * should be applied by the executor.
 */
export function prepareBlockForStorage(data: string): {
    data: string;
    encrypt: boolean;
    keyHex: string | null;
} {
    const enabled = isEncryptionEnabled();
    const key = enabled ? getEncryptionKey() : null;

    return {
        data,
        encrypt: enabled && key !== null,
        keyHex: key,
    };
}

/**
 * Simple XOR-based encryption for demonstration purposes.
 * In production, the executor uses sodium-native secretbox.
 *
 * This is used only when the Language needs to handle encryption
 * without executor support (e.g., in tests).
 */
export function xorEncrypt(data: string, keyHex: string): string {
    const keyBytes = hexToBytes(keyHex);
    const dataBytes = new TextEncoder().encode(data);
    const result = new Uint8Array(dataBytes.length);

    for (let i = 0; i < dataBytes.length; i++) {
        result[i] = dataBytes[i] ^ keyBytes[i % keyBytes.length];
    }

    return bytesToHex(result);
}

/**
 * Simple XOR-based decryption (symmetric with encrypt).
 */
export function xorDecrypt(encryptedHex: string, keyHex: string): string {
    const keyBytes = hexToBytes(keyHex);
    const encryptedBytes = hexToBytes(encryptedHex);
    const result = new Uint8Array(encryptedBytes.length);

    for (let i = 0; i < encryptedBytes.length; i++) {
        result[i] = encryptedBytes[i] ^ keyBytes[i % keyBytes.length];
    }

    return new TextDecoder().decode(result);
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}
