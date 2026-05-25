/**
 * Tests for dual-language deduplication.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    shouldFederate,
    linkOriginKey,
    isPredicateExcluded,
    dualLinkContentKey as linkContentKey,
    linkContentHash,
} from "../src/translate.js";

import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLinkExpression(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "literal://hello",
            target: "literal://world",
            predicate: "sioc://content_of",
        },
        proof: {
            signature: "abc123",
            key: "key123",
        },
        ...overrides,
    };
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

// ---------------------------------------------------------------------------
// linkOriginKey
// ---------------------------------------------------------------------------

describe("linkOriginKey", () => {
    it("generates correct format", () => {
        assert.equal(linkOriginKey("abc123"), "link-origin/abc123");
    });
});

// ---------------------------------------------------------------------------
// shouldFederate
// ---------------------------------------------------------------------------

describe("shouldFederate", () => {
    it("federates new local commits (no origin stored)", () => {
        const result = shouldFederate("hash1", () => null);
        assert.equal(result, true);
    });

    it("federates native-origin links", () => {
        const result = shouldFederate("hash1", (key) => {
            return key === "link-origin/hash1" ? "native" : null;
        });
        assert.equal(result, true);
    });

    it("federates dual-origin links", () => {
        const result = shouldFederate("hash1", (key) => {
            return key === "link-origin/hash1" ? "dual" : null;
        });
        assert.equal(result, true);
    });

    it("blocks hypercore-origin links", () => {
        const result = shouldFederate("hash1", (key) => {
            return key === "link-origin/hash1" ? "hypercore" : null;
        });
        assert.equal(result, false);
    });
});

// ---------------------------------------------------------------------------
// isPredicateExcluded
// ---------------------------------------------------------------------------

describe("isPredicateExcluded", () => {
    it("returns true for excluded predicates", () => {
        assert.ok(isPredicateExcluded("system://internal", ["system://internal"]));
    });

    it("returns false for non-excluded predicates", () => {
        assert.equal(isPredicateExcluded("sioc://content_of", ["system://internal"]), false);
    });

    it("returns false for empty exclude list", () => {
        assert.equal(isPredicateExcluded("sioc://content_of", []), false);
    });
});

// ---------------------------------------------------------------------------
// linkContentKey
// ---------------------------------------------------------------------------

describe("linkContentKey (dual-language)", () => {
    it("is deterministic", () => {
        const link = makeLinkExpression();
        assert.equal(linkContentKey(link), linkContentKey(link));
    });

    it("uses only triple fields (source, predicate, target)", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({ author: "different-author" });
        // Same triple, different author → same content key
        assert.equal(linkContentKey(link1), linkContentKey(link2));
    });

    it("differs for different triples", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "different", target: "different", predicate: "different" },
        });
        assert.notEqual(linkContentKey(link1), linkContentKey(link2));
    });
});

// ---------------------------------------------------------------------------
// linkContentHash
// ---------------------------------------------------------------------------

describe("linkContentHash", () => {
    it("produces deterministic hash", () => {
        const link = makeLinkExpression();
        assert.equal(linkContentHash(link, simpleHash), linkContentHash(link, simpleHash));
    });

    it("same triple → same hash regardless of author", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({ author: "different" });
        assert.equal(linkContentHash(link1, simpleHash), linkContentHash(link2, simpleHash));
    });
});
