/**
 * Tests for membership (writer key management).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    isValidWriterKey,
    writerKeyStorageKey,
    normalizeFeedKey,
    feedKeysEqual,
    filterValidWriterKeys,
    WRITER_KEYS_PREFIX,
    FEED_KEY_HEX_LENGTH,
} from "../src/membership.pure.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("Constants", () => {
    it("WRITER_KEYS_PREFIX is correct", () => {
        assert.equal(WRITER_KEYS_PREFIX, "writers/");
    });

    it("FEED_KEY_HEX_LENGTH is 64", () => {
        assert.equal(FEED_KEY_HEX_LENGTH, 64);
    });
});

// ---------------------------------------------------------------------------
// isValidWriterKey
// ---------------------------------------------------------------------------

describe("isValidWriterKey", () => {
    it("accepts valid 64-char hex key", () => {
        assert.ok(isValidWriterKey("a".repeat(64)));
    });

    it("accepts mixed case hex", () => {
        assert.ok(isValidWriterKey("aAbBcCdDeEfF".repeat(5) + "aAbB"));
    });

    it("rejects short keys", () => {
        assert.equal(isValidWriterKey("a".repeat(63)), false);
    });

    it("rejects long keys", () => {
        assert.equal(isValidWriterKey("a".repeat(65)), false);
    });

    it("rejects non-hex characters", () => {
        assert.equal(isValidWriterKey("g".repeat(64)), false);
    });

    it("rejects empty string", () => {
        assert.equal(isValidWriterKey(""), false);
    });

    it("rejects non-string", () => {
        assert.equal(isValidWriterKey(42 as any), false);
    });
});

// ---------------------------------------------------------------------------
// writerKeyStorageKey
// ---------------------------------------------------------------------------

describe("writerKeyStorageKey", () => {
    it("generates correct format", () => {
        const key = "a".repeat(64);
        assert.equal(writerKeyStorageKey(key), `writers/${key}`);
    });
});

// ---------------------------------------------------------------------------
// normalizeFeedKey
// ---------------------------------------------------------------------------

describe("normalizeFeedKey", () => {
    it("lowercases hex key", () => {
        assert.equal(normalizeFeedKey("AABBCC"), "aabbcc");
    });

    it("preserves already-lowercase", () => {
        assert.equal(normalizeFeedKey("aabbcc"), "aabbcc");
    });
});

// ---------------------------------------------------------------------------
// feedKeysEqual
// ---------------------------------------------------------------------------

describe("feedKeysEqual", () => {
    it("compares case-insensitively", () => {
        assert.ok(feedKeysEqual("AABB", "aabb"));
    });

    it("returns true for identical keys", () => {
        assert.ok(feedKeysEqual("abc", "abc"));
    });

    it("returns false for different keys", () => {
        assert.equal(feedKeysEqual("abc", "def"), false);
    });
});

// ---------------------------------------------------------------------------
// filterValidWriterKeys
// ---------------------------------------------------------------------------

describe("filterValidWriterKeys", () => {
    it("filters valid keys", () => {
        const keys = [
            "a".repeat(64),  // valid
            "short",          // invalid
            "b".repeat(64),  // valid
            "",               // invalid
        ];
        const valid = filterValidWriterKeys(keys);
        assert.equal(valid.length, 2);
    });

    it("returns empty for all invalid", () => {
        assert.deepEqual(filterValidWriterKeys(["short", "invalid"]), []);
    });

    it("returns all for all valid", () => {
        const keys = ["a".repeat(64), "b".repeat(64)];
        assert.equal(filterValidWriterKeys(keys).length, 2);
    });
});
