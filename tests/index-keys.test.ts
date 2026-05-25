/**
 * Tests for index key generation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    hashKey,
    sourceKey,
    targetKey,
    predicateKey,
    authorKey,
    timestampKey,
    sourcePrefix,
    targetPrefix,
    predicatePrefix,
    authorPrefix,
    timestampPrefix,
    ALL_LINKS_PREFIX,
    META_HEAD_KEY,
    META_NEIGHBOURHOOD_KEY,
    allIndexKeys,
    allIndexKeysForDeletion,
} from "../src/index-keys.js";

import type { IndexField } from "../src/index-keys.js";

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

describe("hashKey", () => {
    it("generates correct format", () => {
        assert.equal(hashKey("abc123"), "link:hash:abc123");
    });
});

describe("sourceKey", () => {
    it("generates correct format", () => {
        assert.equal(sourceKey("literal://hello", "abc123"), "link:src:literal://hello:abc123");
    });
});

describe("targetKey", () => {
    it("generates correct format", () => {
        assert.equal(targetKey("literal://world", "abc123"), "link:tgt:literal://world:abc123");
    });
});

describe("predicateKey", () => {
    it("generates correct format", () => {
        assert.equal(predicateKey("sioc://content_of", "abc123"), "link:pred:sioc://content_of:abc123");
    });
});

describe("authorKey", () => {
    it("generates correct format", () => {
        assert.equal(authorKey("did:key:z6MkTest", "abc123"), "link:auth:did:key:z6MkTest:abc123");
    });
});

describe("timestampKey", () => {
    it("generates correct format", () => {
        assert.equal(timestampKey("2026-05-02T00:00:00Z", "abc123"), "link:time:2026-05-02T00:00:00Z:abc123");
    });
});

// ---------------------------------------------------------------------------
// Range query prefixes
// ---------------------------------------------------------------------------

describe("sourcePrefix", () => {
    it("generates correct prefix", () => {
        assert.equal(sourcePrefix("literal://hello"), "link:src:literal://hello:");
    });
});

describe("targetPrefix", () => {
    it("generates correct prefix", () => {
        assert.equal(targetPrefix("literal://world"), "link:tgt:literal://world:");
    });
});

describe("predicatePrefix", () => {
    it("generates correct prefix", () => {
        assert.equal(predicatePrefix("sioc://content_of"), "link:pred:sioc://content_of:");
    });
});

describe("authorPrefix", () => {
    it("generates correct prefix", () => {
        assert.equal(authorPrefix("did:key:z6MkTest"), "link:auth:did:key:z6MkTest:");
    });
});

describe("timestampPrefix", () => {
    it("generates correct prefix", () => {
        assert.equal(timestampPrefix("2026-05-02"), "link:time:2026-05-02:");
    });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("Constants", () => {
    it("ALL_LINKS_PREFIX is correct", () => {
        assert.equal(ALL_LINKS_PREFIX, "link:hash:");
    });

    it("META_HEAD_KEY is correct", () => {
        assert.equal(META_HEAD_KEY, "meta:head");
    });

    it("META_NEIGHBOURHOOD_KEY is correct", () => {
        assert.equal(META_NEIGHBOURHOOD_KEY, "meta:neighbourhood");
    });
});

// ---------------------------------------------------------------------------
// allIndexKeys
// ---------------------------------------------------------------------------

describe("allIndexKeys", () => {
    it("generates primary key always", () => {
        const keys = allIndexKeys("h1", "src", "tgt", "pred", "auth", "ts", []);
        assert.equal(keys.length, 1);
        assert.equal(keys[0][0], "link:hash:h1");
    });

    it("generates source index when enabled", () => {
        const keys = allIndexKeys("h1", "src", "tgt", "pred", "auth", "ts", ["source"]);
        assert.equal(keys.length, 2);
        assert.ok(keys.some(([k]) => k === "link:src:src:h1"));
    });

    it("generates target index when enabled", () => {
        const keys = allIndexKeys("h1", "src", "tgt", "pred", "auth", "ts", ["target"]);
        assert.ok(keys.some(([k]) => k === "link:tgt:tgt:h1"));
    });

    it("generates predicate index when enabled", () => {
        const keys = allIndexKeys("h1", "src", "tgt", "pred", "auth", "ts", ["predicate"]);
        assert.ok(keys.some(([k]) => k === "link:pred:pred:h1"));
    });

    it("generates author index when enabled", () => {
        const keys = allIndexKeys("h1", "src", "tgt", "pred", "auth", "ts", ["author"]);
        assert.ok(keys.some(([k]) => k === "link:auth:auth:h1"));
    });

    it("generates timestamp index when enabled", () => {
        const keys = allIndexKeys("h1", "src", "tgt", "pred", "auth", "ts", ["timestamp"]);
        assert.ok(keys.some(([k]) => k === "link:time:ts:h1"));
    });

    it("generates all indexes when all fields enabled", () => {
        const fields: IndexField[] = ["source", "target", "predicate", "author", "timestamp"];
        const keys = allIndexKeys("h1", "src", "tgt", "pred", "auth", "ts", fields);
        assert.equal(keys.length, 6); // primary + 5 secondary
    });

    it("skips empty field values", () => {
        const keys = allIndexKeys("h1", "", "tgt", "", "auth", "", ["source", "target", "predicate", "author", "timestamp"]);
        // primary + target + author = 3
        assert.equal(keys.length, 3);
    });
});

// ---------------------------------------------------------------------------
// allIndexKeysForDeletion
// ---------------------------------------------------------------------------

describe("allIndexKeysForDeletion", () => {
    it("generates primary key always", () => {
        const keys = allIndexKeysForDeletion("h1", "src", "tgt", "pred", "auth", "ts", []);
        assert.equal(keys.length, 1);
        assert.equal(keys[0], "link:hash:h1");
    });

    it("generates all deletion keys when fields enabled", () => {
        const fields: IndexField[] = ["source", "target", "predicate", "author", "timestamp"];
        const keys = allIndexKeysForDeletion("h1", "src", "tgt", "pred", "auth", "ts", fields);
        assert.equal(keys.length, 6);
    });

    it("skips empty field values", () => {
        const keys = allIndexKeysForDeletion("h1", "", "", "", "", "", ["source", "target", "predicate", "author"]);
        assert.equal(keys.length, 1); // only primary
    });
});
