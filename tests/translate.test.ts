/**
 * Tests for Link ↔ commit block translation (round-trip, pure functions).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    linkContentKey,
    blockToPerspectiveDiff,
    blocksToPerspectiveDiff,
    isValidLink,
    verifyRoundTrip,
    diffToBlockPayload,
} from "../src/translate.pure.js";

import {
    commitDiff,
    commitDiffWithTimestamp,
    processBlock,
    processBlocks,
} from "../src/translate.js";

import {
    serializeCommitBlock,
    deserializeCommitBlock,
} from "../src/commit-block.pure.js";
import type { HypercoreCommitBlock } from "../src/commit-block.pure.js";

import type { LinkExpression, PerspectiveDiff } from "../src/types.js";

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
// linkContentKey
// ---------------------------------------------------------------------------

describe("linkContentKey", () => {
    it("produces deterministic key", () => {
        const link = makeLinkExpression();
        assert.equal(linkContentKey(link), linkContentKey(link));
    });

    it("differs for different links", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "a", target: "b", predicate: "c" },
        });
        assert.notEqual(linkContentKey(link1), linkContentKey(link2));
    });

    it("includes author and timestamp", () => {
        const link = makeLinkExpression();
        const key = linkContentKey(link);
        assert.ok(key.includes("z6MkTest"));
        assert.ok(key.includes("2026-05-02"));
    });
});

// ---------------------------------------------------------------------------
// isValidLink
// ---------------------------------------------------------------------------

describe("isValidLink", () => {
    it("validates correct links", () => {
        assert.ok(isValidLink(makeLinkExpression()));
    });

    it("rejects missing author", () => {
        const link = makeLinkExpression();
        (link as any).author = undefined;
        assert.equal(isValidLink(link), false);
    });

    it("rejects missing data", () => {
        const link = makeLinkExpression();
        (link as any).data = null;
        assert.equal(isValidLink(link), false);
    });

    it("rejects missing proof", () => {
        const link = makeLinkExpression();
        (link as any).proof = null;
        assert.equal(isValidLink(link), false);
    });
});

// ---------------------------------------------------------------------------
// diffToBlockPayload
// ---------------------------------------------------------------------------

describe("diffToBlockPayload", () => {
    it("copies additions and removals", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({ timestamp: "2026-05-02T01:00:00.000Z" });
        const diff: PerspectiveDiff = { additions: [link1], removals: [link2] };

        const payload = diffToBlockPayload(diff);
        assert.equal(payload.additions.length, 1);
        assert.equal(payload.removals.length, 1);
    });

    it("creates new arrays (no aliasing)", () => {
        const diff: PerspectiveDiff = { additions: [makeLinkExpression()], removals: [] };
        const payload = diffToBlockPayload(diff);
        assert.notEqual(payload.additions, diff.additions);
    });
});

// ---------------------------------------------------------------------------
// blockToPerspectiveDiff
// ---------------------------------------------------------------------------

describe("blockToPerspectiveDiff", () => {
    it("extracts diff from block", () => {
        const block: HypercoreCommitBlock = {
            type: "ad4m:PerspectiveDiff",
            seq: 0,
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T00:00:00.000Z",
            additions: [makeLinkExpression()],
            removals: [],
        };

        const diff = blockToPerspectiveDiff(block);
        assert.equal(diff.additions.length, 1);
        assert.equal(diff.removals.length, 0);
    });
});

// ---------------------------------------------------------------------------
// blocksToPerspectiveDiff
// ---------------------------------------------------------------------------

describe("blocksToPerspectiveDiff", () => {
    it("accumulates from multiple blocks", () => {
        const blocks: HypercoreCommitBlock[] = [
            {
                type: "ad4m:PerspectiveDiff",
                seq: 0,
                author: "did:key:z6MkTest",
                timestamp: "2026-05-02T00:00:00.000Z",
                additions: [makeLinkExpression()],
                removals: [],
            },
            {
                type: "ad4m:PerspectiveDiff",
                seq: 1,
                author: "did:key:z6MkTest",
                timestamp: "2026-05-02T01:00:00.000Z",
                additions: [makeLinkExpression({ timestamp: "2026-05-02T01:00:00.000Z" })],
                removals: [makeLinkExpression({ timestamp: "2026-05-02T02:00:00.000Z" })],
            },
        ];

        const diff = blocksToPerspectiveDiff(blocks);
        assert.equal(diff.additions.length, 2);
        assert.equal(diff.removals.length, 1);
    });

    it("handles empty array", () => {
        const diff = blocksToPerspectiveDiff([]);
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });
});

// ---------------------------------------------------------------------------
// verifyRoundTrip
// ---------------------------------------------------------------------------

describe("verifyRoundTrip", () => {
    it("returns true for identical links", () => {
        const link = makeLinkExpression();
        assert.ok(verifyRoundTrip(link, link));
    });

    it("returns false for different sources", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({ data: { source: "different", target: "literal://world", predicate: "sioc://content_of" } });
        assert.equal(verifyRoundTrip(link1, link2), false);
    });

    it("returns false for different proofs", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({ proof: { signature: "different", key: "key123" } });
        assert.equal(verifyRoundTrip(link1, link2), false);
    });
});

// ---------------------------------------------------------------------------
// Full round-trip: link → commit block → serialize → deserialize → link
// ---------------------------------------------------------------------------

describe("Full round-trip", () => {
    it("link → commit block → link is lossless", () => {
        const original = makeLinkExpression();
        const diff: PerspectiveDiff = { additions: [original], removals: [] };

        // Build commit block
        const result = commitDiffWithTimestamp(diff, 0, "did:key:z6MkTest", "2026-05-02T00:00:00.000Z");

        // Serialize and deserialize
        const deserialized = deserializeCommitBlock(result.serialized);
        assert.ok(deserialized);

        // Extract diff
        const recovered = blockToPerspectiveDiff(deserialized!);
        assert.equal(recovered.additions.length, 1);

        // Verify round-trip
        assert.ok(verifyRoundTrip(original, recovered.additions[0]));
    });

    it("multiple links survive round-trip", () => {
        const link1 = makeLinkExpression();
        const link2 = makeLinkExpression({
            data: { source: "a", target: "b", predicate: "c" },
            timestamp: "2026-05-02T01:00:00.000Z",
        });
        const link3 = makeLinkExpression({
            data: { source: "x", target: "y", predicate: "z" },
            timestamp: "2026-05-02T02:00:00.000Z",
        });

        const diff: PerspectiveDiff = {
            additions: [link1, link2],
            removals: [link3],
        };

        const result = commitDiffWithTimestamp(diff, 0, "did:key:z6MkTest", "2026-05-02T00:00:00.000Z");
        const deserialized = deserializeCommitBlock(result.serialized);
        assert.ok(deserialized);

        const recovered = blockToPerspectiveDiff(deserialized!);
        assert.equal(recovered.additions.length, 2);
        assert.equal(recovered.removals.length, 1);
        assert.ok(verifyRoundTrip(link1, recovered.additions[0]));
        assert.ok(verifyRoundTrip(link2, recovered.additions[1]));
    });
});

// ---------------------------------------------------------------------------
// processBlock
// ---------------------------------------------------------------------------

describe("processBlock", () => {
    it("parses valid block data", () => {
        const block: HypercoreCommitBlock = {
            type: "ad4m:PerspectiveDiff",
            seq: 0,
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T00:00:00.000Z",
            additions: [makeLinkExpression()],
            removals: [],
        };
        const serialized = serializeCommitBlock(block);

        const result = processBlock(serialized);
        assert.ok(result);
        assert.equal(result!.diff.additions.length, 1);
        assert.equal(result!.block.seq, 0);
    });

    it("returns null for invalid data", () => {
        assert.equal(processBlock("not json"), null);
    });
});

// ---------------------------------------------------------------------------
// processBlocks
// ---------------------------------------------------------------------------

describe("processBlocks", () => {
    it("processes multiple blocks", () => {
        const blocks = [
            serializeCommitBlock({
                type: "ad4m:PerspectiveDiff",
                seq: 0,
                author: "did:key:z6MkTest",
                timestamp: "2026-05-02T00:00:00.000Z",
                additions: [makeLinkExpression()],
                removals: [],
            }),
            serializeCommitBlock({
                type: "ad4m:PerspectiveDiff",
                seq: 1,
                author: "did:key:z6MkTest",
                timestamp: "2026-05-02T01:00:00.000Z",
                additions: [makeLinkExpression({ timestamp: "2026-05-02T01:00:00.000Z" })],
                removals: [],
            }),
        ];

        const result = processBlocks(blocks);
        assert.equal(result.blocks.length, 2);
        assert.equal(result.diff.additions.length, 2);
    });

    it("skips invalid blocks", () => {
        const blocks = [
            serializeCommitBlock({
                type: "ad4m:PerspectiveDiff",
                seq: 0,
                author: "did:key:z6MkTest",
                timestamp: "2026-05-02T00:00:00.000Z",
                additions: [makeLinkExpression()],
                removals: [],
            }),
            "invalid",
        ];

        const result = processBlocks(blocks);
        assert.equal(result.blocks.length, 1);
        assert.equal(result.diff.additions.length, 1);
    });
});
