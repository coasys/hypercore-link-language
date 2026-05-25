/**
 * Tests for signal protocol (pure message construction + parsing).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    buildAppendSignal,
    buildQuerySignal,
    buildJoinSwarmSignal,
    buildLeaveSwarmSignal,
    parseInboundSignal,
    generateRequestId,
} from "../src/signals.js";

import type {
    AppendSignal,
    QuerySignal,
    JoinSwarmSignal,
    LeaveSwarmSignal,
    BlockSignal,
    QueryResultSignal,
    PeerSignal,
} from "../src/signals.js";

// ---------------------------------------------------------------------------
// Outbound signal constructors
// ---------------------------------------------------------------------------

describe("buildAppendSignal", () => {
    it("creates correct structure", () => {
        const signal = buildAppendSignal("feedkey123", '{"data":"test"}', 5);
        assert.equal(signal.type, "hypercore:append");
        assert.equal(signal.feedKey, "feedkey123");
        assert.equal(signal.data, '{"data":"test"}');
        assert.equal(signal.seq, 5);
    });
});

describe("buildQuerySignal", () => {
    it("creates correct structure", () => {
        const signal = buildQuerySignal("feedkey123", "link:src:hello:", "req_001");
        assert.equal(signal.type, "hypercore:query");
        assert.equal(signal.feedKey, "feedkey123");
        assert.equal(signal.prefix, "link:src:hello:");
        assert.equal(signal.requestId, "req_001");
        assert.equal(signal.limit, undefined);
    });

    it("includes limit when provided", () => {
        const signal = buildQuerySignal("feedkey123", "link:", "req_002", 100);
        assert.equal(signal.limit, 100);
    });
});

describe("buildJoinSwarmSignal", () => {
    it("creates correct structure", () => {
        const signal = buildJoinSwarmSignal("discoverykey123");
        assert.equal(signal.type, "hyperswarm:join");
        assert.equal(signal.discoveryKey, "discoverykey123");
        assert.equal(signal.bootstrap, undefined);
        assert.equal(signal.maxPeers, undefined);
    });

    it("includes bootstrap when provided", () => {
        const signal = buildJoinSwarmSignal("dk", ["node1:49737", "node2:49737"]);
        assert.deepEqual(signal.bootstrap, ["node1:49737", "node2:49737"]);
    });

    it("includes maxPeers when provided", () => {
        const signal = buildJoinSwarmSignal("dk", undefined, 16);
        assert.equal(signal.maxPeers, 16);
    });

    it("omits bootstrap when empty array", () => {
        const signal = buildJoinSwarmSignal("dk", []);
        assert.equal(signal.bootstrap, undefined);
    });
});

describe("buildLeaveSwarmSignal", () => {
    it("creates correct structure", () => {
        const signal = buildLeaveSwarmSignal("discoverykey123");
        assert.equal(signal.type, "hyperswarm:leave");
        assert.equal(signal.discoveryKey, "discoverykey123");
    });
});

// ---------------------------------------------------------------------------
// Inbound signal parsing
// ---------------------------------------------------------------------------

describe("parseInboundSignal", () => {
    it("parses hypercore:block signal", () => {
        const raw: BlockSignal = {
            type: "hypercore:block",
            feedKey: "abc",
            seq: 5,
            data: '{"type":"ad4m:PerspectiveDiff"}',
            author: "did:key:z6MkTest",
            remote: true,
        };
        const result = parseInboundSignal(raw);
        assert.ok(result);
        assert.equal(result!.type, "hypercore:block");
    });

    it("parses hypercore:query:result signal", () => {
        const raw: QueryResultSignal = {
            type: "hypercore:query:result",
            requestId: "req_001",
            entries: [{ key: "link:hash:abc", value: "{}" }],
        };
        const result = parseInboundSignal(raw);
        assert.ok(result);
        assert.equal(result!.type, "hypercore:query:result");
    });

    it("parses hyperswarm:peer connected signal", () => {
        const raw: PeerSignal = {
            type: "hyperswarm:peer",
            action: "connected",
            peerKey: "peerkey123",
        };
        const result = parseInboundSignal(raw);
        assert.ok(result);
        assert.equal(result!.type, "hyperswarm:peer");
        assert.equal((result as PeerSignal).action, "connected");
    });

    it("parses hyperswarm:peer disconnected signal", () => {
        const raw: PeerSignal = {
            type: "hyperswarm:peer",
            action: "disconnected",
            peerKey: "peerkey123",
        };
        const result = parseInboundSignal(raw);
        assert.ok(result);
    });

    it("returns null for unknown types", () => {
        assert.equal(parseInboundSignal({ type: "unknown" }), null);
    });

    it("returns null for null", () => {
        assert.equal(parseInboundSignal(null), null);
    });

    it("returns null for non-objects", () => {
        assert.equal(parseInboundSignal("string"), null);
        assert.equal(parseInboundSignal(42), null);
    });

    it("returns null for invalid block signal (missing fields)", () => {
        assert.equal(parseInboundSignal({
            type: "hypercore:block",
            feedKey: "abc",
            // missing seq, data, author, remote
        }), null);
    });

    it("returns null for invalid query result (missing entries)", () => {
        assert.equal(parseInboundSignal({
            type: "hypercore:query:result",
            requestId: "req",
            // missing entries
        }), null);
    });

    it("returns null for invalid peer signal (bad action)", () => {
        assert.equal(parseInboundSignal({
            type: "hyperswarm:peer",
            action: "invalid",
            peerKey: "pk",
        }), null);
    });
});

// ---------------------------------------------------------------------------
// generateRequestId
// ---------------------------------------------------------------------------

describe("generateRequestId", () => {
    it("generates string starting with q_", () => {
        const id = generateRequestId();
        assert.ok(id.startsWith("q_"));
    });

    it("generates unique IDs", () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
            ids.add(generateRequestId());
        }
        assert.equal(ids.size, 100);
    });
});
