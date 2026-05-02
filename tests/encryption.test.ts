/**
 * Tests for encryption module.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter } from "../src/storage-interface.js";
import { initStorage } from "../src/storage-interface.js";

import {
    setEncryptionKey,
    getEncryptionKey,
    isEncryptionEnabled,
    clearEncryptionKey,
    prepareBlockForStorage,
    xorEncrypt,
    xorDecrypt,
} from "../src/encryption.js";

// ---------------------------------------------------------------------------
// Mock storage
// ---------------------------------------------------------------------------

class MockStorageAdapter implements StorageAdapter {
    private data = new Map<string, string>();
    get(key: string): string | null { return this.data.get(key) ?? null; }
    put(key: string, value: string): void { this.data.set(key, value); }
    delete(key: string): void { this.data.delete(key); }
    listKeys(prefix?: string): string[] {
        const all = [...this.data.keys()];
        return prefix ? all.filter(k => k.startsWith(prefix)) : all;
    }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe("Encryption", () => {
    beforeEach(() => {
        initStorage(new MockStorageAdapter());
    });

    // -----------------------------------------------------------------------
    // Key management
    // -----------------------------------------------------------------------

    describe("setEncryptionKey", () => {
        it("stores the key", () => {
            setEncryptionKey("aa".repeat(32));
            assert.equal(getEncryptionKey(), "aa".repeat(32));
        });

        it("enables encryption", () => {
            setEncryptionKey("bb".repeat(32));
            assert.ok(isEncryptionEnabled());
        });
    });

    describe("getEncryptionKey", () => {
        it("returns null when no key set", () => {
            assert.equal(getEncryptionKey(), null);
        });
    });

    describe("isEncryptionEnabled", () => {
        it("returns false when no key set", () => {
            assert.equal(isEncryptionEnabled(), false);
        });
    });

    describe("clearEncryptionKey", () => {
        it("removes key and disables encryption", () => {
            setEncryptionKey("cc".repeat(32));
            assert.ok(isEncryptionEnabled());

            clearEncryptionKey();
            assert.equal(getEncryptionKey(), null);
            assert.equal(isEncryptionEnabled(), false);
        });
    });

    // -----------------------------------------------------------------------
    // prepareBlockForStorage
    // -----------------------------------------------------------------------

    describe("prepareBlockForStorage", () => {
        it("returns encrypt=false when disabled", () => {
            const result = prepareBlockForStorage("test data");
            assert.equal(result.encrypt, false);
            assert.equal(result.keyHex, null);
            assert.equal(result.data, "test data");
        });

        it("returns encrypt=true when enabled", () => {
            setEncryptionKey("dd".repeat(32));
            const result = prepareBlockForStorage("test data");
            assert.equal(result.encrypt, true);
            assert.equal(result.keyHex, "dd".repeat(32));
        });
    });

    // -----------------------------------------------------------------------
    // XOR encryption/decryption
    // -----------------------------------------------------------------------

    describe("xorEncrypt / xorDecrypt", () => {
        it("round-trips correctly", () => {
            const data = "Hello, Hypercore!";
            const key = "abcdef0123456789".repeat(4);

            const encrypted = xorEncrypt(data, key);
            assert.notEqual(encrypted, data);

            const decrypted = xorDecrypt(encrypted, key);
            assert.equal(decrypted, data);
        });

        it("produces different output for different keys", () => {
            const data = "test data";
            const key1 = "aa".repeat(32);
            const key2 = "bb".repeat(32);

            const enc1 = xorEncrypt(data, key1);
            const enc2 = xorEncrypt(data, key2);
            assert.notEqual(enc1, enc2);
        });

        it("handles empty string", () => {
            const key = "aa".repeat(32);
            const encrypted = xorEncrypt("", key);
            assert.equal(encrypted, "");
            const decrypted = xorDecrypt(encrypted, key);
            assert.equal(decrypted, "");
        });

        it("handles unicode content", () => {
            const data = "こんにちは世界 🌍";
            const key = "ff".repeat(32);

            const encrypted = xorEncrypt(data, key);
            const decrypted = xorDecrypt(encrypted, key);
            assert.equal(decrypted, data);
        });
    });
});
