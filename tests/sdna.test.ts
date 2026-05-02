/**
 * Tests for SDNA pattern detection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectPattern, isSocialPattern } from "../src/sdna.js";
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

// ---------------------------------------------------------------------------
// detectPattern
// ---------------------------------------------------------------------------

describe("detectPattern", () => {
    it("detects chat-message from default predicate", () => {
        const link = makeLinkExpression({
            data: { source: "channel://main", target: "expr://msg-001", predicate: "flux://has_message" },
        });
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "chat-message");
        assert.equal(pattern.contentUri, "expr://msg-001");
        assert.equal(pattern.channelUri, "channel://main");
    });

    it("detects chat-message from sioc://content_of", () => {
        const link = makeLinkExpression({
            data: { source: "channel://main", target: "expr://msg-001", predicate: "sioc://content_of" },
        });
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "chat-message");
    });

    it("detects chat-message from custom predicates", () => {
        const link = makeLinkExpression({
            data: { source: "channel://main", target: "expr://msg-001", predicate: "custom://chat" },
        });
        const pattern = detectPattern(link, ["custom://chat"]);
        assert.equal(pattern.type, "chat-message");
    });

    it("detects reply", () => {
        const link = makeLinkExpression({
            data: { source: "expr://parent", target: "expr://reply", predicate: "flux://has_reply" },
        });
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "reply");
        assert.equal(pattern.parentUri, "expr://parent");
        assert.equal(pattern.contentUri, "expr://reply");
    });

    it("detects reply from sioc://reply_of", () => {
        const link = makeLinkExpression({
            data: { source: "expr://parent", target: "expr://reply", predicate: "sioc://reply_of" },
        });
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "reply");
    });

    it("detects mention", () => {
        const link = makeLinkExpression({
            data: { source: "expr://msg", target: "did:key:z6MkAlice", predicate: "flux://has_mention" },
        });
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "mention");
        assert.equal(pattern.mentionedAgent, "did:key:z6MkAlice");
    });

    it("detects reaction", () => {
        const link = makeLinkExpression({
            data: { source: "expr://msg", target: "👍", predicate: "flux://has_reaction" },
        });
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "reaction");
        assert.equal(pattern.contentUri, "👍");
    });

    it("detects reaction from emoji://reaction", () => {
        const link = makeLinkExpression({
            data: { source: "expr://msg", target: "❤️", predicate: "emoji://reaction" },
        });
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "reaction");
    });

    it("detects collection", () => {
        const link = makeLinkExpression({
            data: { source: "coll://items", target: "expr://item-1", predicate: "rdf://has_member" },
        });
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "collection");
        assert.equal(pattern.collectionUri, "coll://items");
        assert.equal(pattern.contentUri, "expr://item-1");
    });

    it("returns unknown for unrecognized predicates", () => {
        const link = makeLinkExpression({
            data: { source: "a", target: "b", predicate: "custom://something" },
        });
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "unknown");
    });

    it("returns unknown for empty predicate", () => {
        const link = makeLinkExpression({
            data: { source: "a", target: "b" },
        });
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "unknown");
    });
});

// ---------------------------------------------------------------------------
// isSocialPattern
// ---------------------------------------------------------------------------

describe("isSocialPattern", () => {
    it("returns true for chat-message", () => {
        assert.ok(isSocialPattern({ type: "chat-message" }));
    });

    it("returns true for reply", () => {
        assert.ok(isSocialPattern({ type: "reply" }));
    });

    it("returns true for reaction", () => {
        assert.ok(isSocialPattern({ type: "reaction" }));
    });

    it("returns false for mention", () => {
        assert.equal(isSocialPattern({ type: "mention" }), false);
    });

    it("returns false for collection", () => {
        assert.equal(isSocialPattern({ type: "collection" }), false);
    });

    it("returns false for unknown", () => {
        assert.equal(isSocialPattern({ type: "unknown" }), false);
    });

    it("returns false for content", () => {
        assert.equal(isSocialPattern({ type: "content" }), false);
    });
});
