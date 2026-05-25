/**
 * Tests for commit block serialization/deserialization.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    serializeCommitBlock,
    deserializeCommitBlock,
    computeBlockHash,
    blockToDiff,
    isValidCommitBlock,
} from "../src/commit-block.js";
import type { HypercoreCommitBlock } from "../src/commit-block.js";
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

function makeCommitBlock(overrides?: Partial<HypercoreCommitBlock>): HypercoreCommitBlock {
    return {
        type: "ad4m:PerspectiveDiff",
        seq: 0,
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        additions: [makeLinkExpression()],
        removals: [],
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// serializeCommitBlock
// ---------------------------------------------------------------------------

describe("serializeCommitBlock", () => {
    it("serializes to valid JSON", () => {
        const block = makeCommitBlock();
        const json = serializeCommitBlock(block);
        assert.ok(json);
        const parsed = JSON.parse(json);
        assert.equal(parsed.type, "ad4m:PerspectiveDiff");
    });

    it("preserves all fields", () => {
        const block = makeCommitBlock({ seq: 42 });
        const json = serializeCommitBlock(block);
        const parsed = JSON.parse(json);
        assert.equal(parsed.seq, 42);
        assert.equal(parsed.author, "did:key:z6MkTest");
        assert.equal(parsed.additions.length, 1);
    });

    it("handles empty additions and removals", () => {
        const block = makeCommitBlock({ additions: [], removals: [] });
        const json = serializeCommitBlock(block);
        const parsed = JSON.parse(json);
        assert.equal(parsed.additions.length, 0);
        assert.equal(parsed.removals.length, 0);
    });

    it("handles multiple additions and removals", () => {
        const block = makeCommitBlock({
            additions: [makeLinkExpression(), makeLinkExpression({ timestamp: "2026-05-02T01:00:00.000Z" })],
            removals: [makeLinkExpression({ timestamp: "2026-05-02T02:00:00.000Z" })],
        });
        const json = serializeCommitBlock(block);
        const parsed = JSON.parse(json);
        assert.equal(parsed.additions.length, 2);
        assert.equal(parsed.removals.length, 1);
    });
});

// ---------------------------------------------------------------------------
// deserializeCommitBlock
// ---------------------------------------------------------------------------

describe("deserializeCommitBlock", () => {
    it("round-trips with serialize", () => {
        const block = makeCommitBlock();
        const json = serializeCommitBlock(block);
        const result = deserializeCommitBlock(json);
        assert.ok(result);
        assert.equal(result!.type, "ad4m:PerspectiveDiff");
        assert.equal(result!.seq, 0);
        assert.equal(result!.author, "did:key:z6MkTest");
        assert.equal(result!.additions.length, 1);
    });

    it("returns null for invalid JSON", () => {
        assert.equal(deserializeCommitBlock("not json"), null);
    });

    it("returns null for wrong type", () => {
        assert.equal(deserializeCommitBlock(JSON.stringify({ type: "wrong" })), null);
    });

    it("returns null for missing seq", () => {
        assert.equal(deserializeCommitBlock(JSON.stringify({
            type: "ad4m:PerspectiveDiff",
            author: "test",
            timestamp: "test",
            additions: [],
            removals: [],
        })), null);
    });

    it("returns null for missing author", () => {
        assert.equal(deserializeCommitBlock(JSON.stringify({
            type: "ad4m:PerspectiveDiff",
            seq: 0,
            timestamp: "test",
            additions: [],
            removals: [],
        })), null);
    });

    it("returns null for non-array additions", () => {
        assert.equal(deserializeCommitBlock(JSON.stringify({
            type: "ad4m:PerspectiveDiff",
            seq: 0,
            author: "test",
            timestamp: "test",
            additions: "not-array",
            removals: [],
        })), null);
    });

    it("returns null for null input", () => {
        assert.equal(deserializeCommitBlock("null"), null);
    });
});

// ---------------------------------------------------------------------------
// computeBlockHash
// ---------------------------------------------------------------------------

describe("computeBlockHash", () => {
    it("produces deterministic output", () => {
        const block = makeCommitBlock();
        assert.equal(computeBlockHash(block), computeBlockHash(block));
    });

    it("differs for different blocks", () => {
        const block1 = makeCommitBlock({ seq: 0 });
        const block2 = makeCommitBlock({ seq: 1 });
        assert.notEqual(computeBlockHash(block1), computeBlockHash(block2));
    });

    it("differs for different authors", () => {
        const block1 = makeCommitBlock({ author: "a" });
        const block2 = makeCommitBlock({ author: "b" });
        assert.notEqual(computeBlockHash(block1), computeBlockHash(block2));
    });
});

// ---------------------------------------------------------------------------
// blockToDiff
// ---------------------------------------------------------------------------

describe("blockToDiff", () => {
    it("extracts additions and removals", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({ timestamp: "2026-05-02T01:00:00.000Z" });
        const block = makeCommitBlock({
            additions: [link1],
            removals: [link2],
        });

        const diff = blockToDiff(block);
        assert.equal(diff.additions.length, 1);
        assert.equal(diff.removals.length, 1);
        assert.equal(diff.additions[0].data.source, "literal://hello");
    });

    it("handles empty block", () => {
        const block = makeCommitBlock({ additions: [], removals: [] });
        const diff = blockToDiff(block);
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });
});

// ---------------------------------------------------------------------------
// isValidCommitBlock
// ---------------------------------------------------------------------------

describe("isValidCommitBlock", () => {
    it("validates correct blocks", () => {
        assert.ok(isValidCommitBlock(makeCommitBlock()));
    });

    it("rejects null", () => {
        assert.equal(isValidCommitBlock(null), false);
    });

    it("rejects non-objects", () => {
        assert.equal(isValidCommitBlock("string"), false);
        assert.equal(isValidCommitBlock(42), false);
    });

    it("rejects wrong type", () => {
        assert.equal(isValidCommitBlock({ ...makeCommitBlock(), type: "wrong" }), false);
    });

    it("rejects non-number seq", () => {
        assert.equal(isValidCommitBlock({ ...makeCommitBlock(), seq: "0" }), false);
    });

    it("rejects non-string author", () => {
        assert.equal(isValidCommitBlock({ ...makeCommitBlock(), author: 42 }), false);
    });

    it("rejects non-array additions", () => {
        assert.equal(isValidCommitBlock({ ...makeCommitBlock(), additions: {} }), false);
    });
});
