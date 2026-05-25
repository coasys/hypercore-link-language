/**
 * Tests for the telepresence module.
 *
 * Covers: pure functions, HTTP call integration with mocked transport,
 * graceful degradation on 404, inbox polling, and signal callback dispatch.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter } from "../src/adapters.js";
import { initStorage } from "../src/adapters.js";
import type { RuntimeAdapter } from "../src/adapters.js";
import { initRuntime } from "../src/adapters.js";
import { initTransport } from "../src/transport.js";
import type { Transport, TransportResponse } from "../src/transport.js";
import * as store from "../src/store.js";

// Pure functions
import {
    buildStatusPayload,
    buildSignalPayload,
    buildBroadcastPayload,
    parsePeerList,
    filterSelfFromPeers,
    peersToAgentList,
    parseInboxMessages,
    TELEPRESENCE_PATHS,
} from "../src/telepresence.js";
import type { PeerInfo, InboxMessage } from "../src/telepresence.js";

// Impure module
import {
    initTelepresence,
    resetTelepresence,
    isTelepresenceInitialized,
    setOnlineStatus,
    getOnlineAgents,
    sendSignal,
    sendBroadcast,
    registerSignalCallback,
    pollInbox,
    getSignalCallbackCount,
    getLastInboxCheck,
} from "../src/telepresence.js";

// ---------------------------------------------------------------------------
// Mock adapters
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

class MockRuntime implements RuntimeAdapter {
    public signals: string[] = [];
    public diffs: unknown[] = [];
    hash(data: string): string {
        let h = 0;
        for (let i = 0; i < data.length; i++) {
            h = ((h << 5) - h + data.charCodeAt(i)) | 0;
        }
        return `Qm${Math.abs(h).toString(16)}`;
    }
    emitSignal(data: string): void { this.signals.push(data); }
    emitPerspectiveDiff(diff: unknown): void { this.diffs.push(diff); }
}

/** Records calls and returns configurable responses. */
class MockTransport implements Transport {
    public calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    public responses: Map<string, TransportResponse> = new Map();
    public defaultResponse: TransportResponse = { status: 200, headers: {}, body: "{}" };

    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        this.calls.push({ url, method, headers, body });
        // Match by method + path (strip base URL)
        const path = url.replace(/^https?:\/\/[^/]+/, "");
        const key = `${method} ${path}`;
        return this.responses.get(key) || this.defaultResponse;
    }

    /** Set the response for a specific method + path. */
    setResponse(method: string, path: string, response: TransportResponse): void {
        this.responses.set(`${method} ${path}`, response);
    }

    /** Get the last call made. */
    lastCall(): { url: string; method: string; headers: Record<string, string>; body: string } | undefined {
        return this.calls[this.calls.length - 1];
    }

    /** Get calls matching a method + path pattern. */
    callsTo(method: string, pathSubstring: string): typeof this.calls {
        return this.calls.filter(c => c.method === method && c.url.includes(pathSubstring));
    }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GATEWAY_URL = "http://localhost:9999";
const MY_DID = "did:key:z6MkTest";
const FEED_KEY = "aa".repeat(32);

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("Telepresence pure functions", () => {

    describe("buildStatusPayload", () => {
        it("constructs a valid status payload", () => {
            const payload = buildStatusPayload(MY_DID, { online: true }, FEED_KEY);
            assert.equal(payload.did, MY_DID);
            assert.deepEqual(payload.status, { online: true });
            assert.equal(payload.feedKey, FEED_KEY);
        });
    });

    describe("buildSignalPayload", () => {
        it("constructs a valid signal payload", () => {
            const payload = buildSignalPayload(MY_DID, "did:key:z6MkRemote", { type: "offer" });
            assert.equal(payload.from, MY_DID);
            assert.equal(payload.to, "did:key:z6MkRemote");
            assert.deepEqual(payload.payload, { type: "offer" });
        });
    });

    describe("buildBroadcastPayload", () => {
        it("constructs a valid broadcast payload", () => {
            const payload = buildBroadcastPayload(MY_DID, { msg: "hello" });
            assert.equal(payload.from, MY_DID);
            assert.deepEqual(payload.payload, { msg: "hello" });
        });
    });

    describe("parsePeerList", () => {
        it("parses valid peer list", () => {
            const raw = [
                { did: "did:key:z6MkA", status: { online: true } },
                { did: "did:key:z6MkB", status: null },
            ];
            const peers = parsePeerList(raw);
            assert.equal(peers.length, 2);
            assert.equal(peers[0].did, "did:key:z6MkA");
        });

        it("filters invalid entries", () => {
            const raw = [
                { did: "did:key:z6MkA", status: true },
                { notADid: true },
                null,
                "string",
                { did: "", status: null },
            ];
            const peers = parsePeerList(raw);
            assert.equal(peers.length, 1);
            assert.equal(peers[0].did, "did:key:z6MkA");
        });

        it("returns empty for non-array", () => {
            assert.deepEqual(parsePeerList(null), []);
            assert.deepEqual(parsePeerList("string"), []);
            assert.deepEqual(parsePeerList(42), []);
            assert.deepEqual(parsePeerList({}), []);
        });
    });

    describe("filterSelfFromPeers", () => {
        it("removes self from peer list", () => {
            const peers: PeerInfo[] = [
                { did: MY_DID, status: true },
                { did: "did:key:z6MkOther", status: true },
            ];
            const filtered = filterSelfFromPeers(peers, MY_DID);
            assert.equal(filtered.length, 1);
            assert.equal(filtered[0].did, "did:key:z6MkOther");
        });

        it("returns all peers if self not present", () => {
            const peers: PeerInfo[] = [
                { did: "did:key:z6MkA", status: true },
                { did: "did:key:z6MkB", status: true },
            ];
            const filtered = filterSelfFromPeers(peers, MY_DID);
            assert.equal(filtered.length, 2);
        });
    });

    describe("peersToAgentList", () => {
        it("converts to agent list format", () => {
            const peers: PeerInfo[] = [
                { did: "did:key:z6MkA", status: { online: true }, feedKey: "abc" },
            ];
            const agents = peersToAgentList(peers);
            assert.equal(agents.length, 1);
            assert.deepEqual(agents[0], { did: "did:key:z6MkA", status: { online: true } });
        });
    });

    describe("parseInboxMessages", () => {
        it("parses valid inbox messages", () => {
            const raw = [
                { from: "did:key:z6MkA", payload: { type: "offer" }, timestamp: "2026-05-02T00:00:00Z" },
                { from: "did:key:z6MkB", payload: null, timestamp: "2026-05-02T00:01:00Z" },
            ];
            const messages = parseInboxMessages(raw);
            assert.equal(messages.length, 2);
            assert.equal(messages[0].from, "did:key:z6MkA");
        });

        it("filters invalid messages", () => {
            const raw = [
                { from: "did:key:z6MkA", payload: {}, timestamp: "2026-05-02T00:00:00Z" },
                { payload: {}, timestamp: "2026-05-02T00:00:00Z" }, // missing from
                { from: "did:key:z6MkB", payload: {} }, // missing timestamp
                null,
            ];
            const messages = parseInboxMessages(raw);
            assert.equal(messages.length, 1);
        });

        it("returns empty for non-array", () => {
            assert.deepEqual(parseInboxMessages(null), []);
            assert.deepEqual(parseInboxMessages({}), []);
        });
    });

    describe("TELEPRESENCE_PATHS", () => {
        it("has all required paths", () => {
            assert.equal(TELEPRESENCE_PATHS.status, "/telepresence/status");
            assert.equal(TELEPRESENCE_PATHS.peers, "/telepresence/peers");
            assert.equal(TELEPRESENCE_PATHS.signal, "/telepresence/signal");
            assert.equal(TELEPRESENCE_PATHS.broadcast, "/telepresence/broadcast");
            assert.equal(TELEPRESENCE_PATHS.inbox, "/telepresence/inbox");
        });
    });
});

// ---------------------------------------------------------------------------
// Integration tests (with mocked transport)
// ---------------------------------------------------------------------------

describe("Telepresence module", () => {
    let transport: MockTransport;

    beforeEach(() => {
        transport = new MockTransport();
        initStorage(new MockStorageAdapter());
        initRuntime(new MockRuntime());
        initTransport(transport);
        store.initStore();
        resetTelepresence();
    });

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    describe("initialization", () => {
        it("starts uninitialized", () => {
            assert.equal(isTelepresenceInitialized(), false);
        });

        it("initializes with gateway URL", () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            assert.equal(isTelepresenceInitialized(), true);
        });

        it("resetTelepresence clears state", () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            resetTelepresence();
            assert.equal(isTelepresenceInitialized(), false);
            assert.equal(getSignalCallbackCount(), 0);
        });
    });

    // -----------------------------------------------------------------------
    // setOnlineStatus
    // -----------------------------------------------------------------------

    describe("setOnlineStatus", () => {
        it("POSTs to /telepresence/status", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            await setOnlineStatus({ online: true });

            const calls = transport.callsTo("POST", "/telepresence/status");
            assert.equal(calls.length, 1);

            const body = JSON.parse(calls[0].body);
            assert.equal(body.did, MY_DID);
            assert.deepEqual(body.status, { online: true });
            assert.equal(body.feedKey, FEED_KEY);
        });

        it("no-ops when not initialized", async () => {
            await setOnlineStatus({ online: true });
            assert.equal(transport.calls.length, 0);
        });

        it("handles 404 gracefully", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            transport.setResponse("POST", "/telepresence/status", {
                status: 404, headers: {}, body: '{"error":"not found"}',
            });

            // Should not throw
            await setOnlineStatus({ online: true });
        });
    });

    // -----------------------------------------------------------------------
    // getOnlineAgents
    // -----------------------------------------------------------------------

    describe("getOnlineAgents", () => {
        it("GETs from /telepresence/peers and returns agent list", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            transport.setResponse("GET", "/telepresence/peers", {
                status: 200, headers: {},
                body: JSON.stringify([
                    { did: "did:key:z6MkA", status: { online: true } },
                    { did: "did:key:z6MkB", status: { online: false } },
                ]),
            });

            const agents = await getOnlineAgents();
            assert.equal(agents.length, 2);
            assert.deepEqual(agents[0], { did: "did:key:z6MkA", status: { online: true } });
        });

        it("returns empty when not initialized", async () => {
            const agents = await getOnlineAgents();
            assert.deepEqual(agents, []);
        });

        it("returns empty on 404 (graceful degradation)", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            transport.setResponse("GET", "/telepresence/peers", {
                status: 404, headers: {}, body: "",
            });

            const agents = await getOnlineAgents();
            assert.deepEqual(agents, []);
        });

        it("returns empty on malformed response", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            transport.setResponse("GET", "/telepresence/peers", {
                status: 200, headers: {}, body: "not json",
            });

            const agents = await getOnlineAgents();
            assert.deepEqual(agents, []);
        });
    });

    // -----------------------------------------------------------------------
    // sendSignal
    // -----------------------------------------------------------------------

    describe("sendSignal", () => {
        it("POSTs to /telepresence/signal with correct payload", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            transport.setResponse("POST", "/telepresence/signal", {
                status: 200, headers: {},
                body: JSON.stringify({ status: "delivered" }),
            });

            const result = await sendSignal("did:key:z6MkRemote", { type: "offer", sdp: "v=0..." });

            const calls = transport.callsTo("POST", "/telepresence/signal");
            assert.equal(calls.length, 1);

            const body = JSON.parse(calls[0].body);
            assert.equal(body.from, MY_DID);
            assert.equal(body.to, "did:key:z6MkRemote");
            assert.deepEqual(body.payload, { type: "offer", sdp: "v=0..." });
            assert.deepEqual(result, { status: "delivered" });
        });

        it("returns not_initialized when not initialized", async () => {
            const result = await sendSignal("did:key:z6MkRemote", {});
            assert.deepEqual(result, { status: "not_initialized" });
        });

        it("returns not_supported on 404", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            transport.setResponse("POST", "/telepresence/signal", {
                status: 404, headers: {}, body: "",
            });

            const result = await sendSignal("did:key:z6MkRemote", {});
            assert.deepEqual(result, { status: "not_supported" });
        });

        it("returns error on 500", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            transport.setResponse("POST", "/telepresence/signal", {
                status: 500, headers: {}, body: '{"error":"internal"}',
            });

            const result = await sendSignal("did:key:z6MkRemote", {});
            assert.deepEqual(result, { status: "error", code: 500 });
        });
    });

    // -----------------------------------------------------------------------
    // sendBroadcast
    // -----------------------------------------------------------------------

    describe("sendBroadcast", () => {
        it("POSTs to /telepresence/broadcast", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            transport.setResponse("POST", "/telepresence/broadcast", {
                status: 200, headers: {},
                body: JSON.stringify({ status: "sent", recipients: 3 }),
            });

            const result = await sendBroadcast({ msg: "hello everyone" });

            const calls = transport.callsTo("POST", "/telepresence/broadcast");
            assert.equal(calls.length, 1);

            const body = JSON.parse(calls[0].body);
            assert.equal(body.from, MY_DID);
            assert.deepEqual(body.payload, { msg: "hello everyone" });
            assert.deepEqual(result, { status: "sent", recipients: 3 });
        });

        it("returns not_initialized when not initialized", async () => {
            const result = await sendBroadcast({});
            assert.deepEqual(result, { status: "not_initialized" });
        });

        it("returns not_supported on 404", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            transport.setResponse("POST", "/telepresence/broadcast", {
                status: 404, headers: {}, body: "",
            });

            const result = await sendBroadcast({});
            assert.deepEqual(result, { status: "not_supported" });
        });
    });

    // -----------------------------------------------------------------------
    // registerSignalCallback
    // -----------------------------------------------------------------------

    describe("registerSignalCallback", () => {
        it("registers a callback", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            await registerSignalCallback(() => {});
            assert.equal(getSignalCallbackCount(), 1);
        });

        it("supports multiple callbacks", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            await registerSignalCallback(() => {});
            await registerSignalCallback(() => {});
            assert.equal(getSignalCallbackCount(), 2);
        });

        it("callbacks cleared on reset", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            await registerSignalCallback(() => {});
            resetTelepresence();
            assert.equal(getSignalCallbackCount(), 0);
        });
    });

    // -----------------------------------------------------------------------
    // pollInbox
    // -----------------------------------------------------------------------

    describe("pollInbox", () => {
        it("fetches inbox and dispatches to callbacks", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);

            const received: Array<{ from: string; payload: unknown }> = [];
            await registerSignalCallback((signal) => {
                received.push(signal);
            });

            transport.setResponse("GET", "/telepresence/inbox", {
                status: 200, headers: {},
                body: JSON.stringify([
                    { from: "did:key:z6MkA", payload: { type: "offer" }, timestamp: "2026-05-02T00:00:00Z" },
                    { from: "did:key:z6MkB", payload: { type: "answer" }, timestamp: "2026-05-02T00:01:00Z" },
                ]),
            });

            await pollInbox();

            assert.equal(received.length, 2);
            assert.equal(received[0].from, "did:key:z6MkA");
            assert.deepEqual(received[0].payload, { type: "offer" });
            assert.equal(received[1].from, "did:key:z6MkB");
        });

        it("skips polling when no callbacks registered", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            await pollInbox();
            assert.equal(transport.calls.length, 0);
        });

        it("skips polling when not initialized", async () => {
            await pollInbox();
            assert.equal(transport.calls.length, 0);
        });

        it("updates lastInboxCheck timestamp", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            await registerSignalCallback(() => {});

            transport.setResponse("GET", "/telepresence/inbox", {
                status: 200, headers: {},
                body: JSON.stringify([
                    { from: "did:key:z6MkA", payload: {}, timestamp: "2026-05-02T00:01:00Z" },
                    { from: "did:key:z6MkB", payload: {}, timestamp: "2026-05-02T00:05:00Z" },
                ]),
            });

            await pollInbox();
            assert.equal(getLastInboxCheck(), "2026-05-02T00:05:00Z");
        });

        it("passes since parameter on subsequent polls", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            await registerSignalCallback(() => {});

            // First poll
            transport.setResponse("GET", "/telepresence/inbox", {
                status: 200, headers: {},
                body: JSON.stringify([
                    { from: "did:key:z6MkA", payload: {}, timestamp: "2026-05-02T00:01:00Z" },
                ]),
            });
            await pollInbox();

            // Second poll should include since parameter
            transport.setResponse("GET", "/telepresence/inbox?since=2026-05-02T00%3A01%3A00Z", {
                status: 200, headers: {},
                body: JSON.stringify([
                    { from: "did:key:z6MkB", payload: {}, timestamp: "2026-05-02T00:02:00Z" },
                ]),
            });
            await pollInbox();

            // Check that the second call included the since parameter
            const inboxCalls = transport.callsTo("GET", "/telepresence/inbox");
            assert.equal(inboxCalls.length, 2);
            assert.ok(inboxCalls[1].url.includes("since="));
        });

        it("handles 404 gracefully", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            await registerSignalCallback(() => {});

            transport.setResponse("GET", "/telepresence/inbox", {
                status: 404, headers: {}, body: "",
            });

            // Should not throw
            await pollInbox();
        });

        it("dispatches to multiple callbacks", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);

            const received1: unknown[] = [];
            const received2: unknown[] = [];
            await registerSignalCallback((s) => received1.push(s));
            await registerSignalCallback((s) => received2.push(s));

            transport.setResponse("GET", "/telepresence/inbox", {
                status: 200, headers: {},
                body: JSON.stringify([
                    { from: "did:key:z6MkA", payload: { msg: "hi" }, timestamp: "2026-05-02T00:00:00Z" },
                ]),
            });

            await pollInbox();
            assert.equal(received1.length, 1);
            assert.equal(received2.length, 1);
        });

        it("tolerates callback errors", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);

            const received: unknown[] = [];
            await registerSignalCallback(() => { throw new Error("boom"); });
            await registerSignalCallback((s) => received.push(s));

            transport.setResponse("GET", "/telepresence/inbox", {
                status: 200, headers: {},
                body: JSON.stringify([
                    { from: "did:key:z6MkA", payload: {}, timestamp: "2026-05-02T00:00:00Z" },
                ]),
            });

            // Should not throw despite first callback throwing
            await pollInbox();
            // Second callback should still receive the message
            assert.equal(received.length, 1);
        });

        it("handles empty inbox", async () => {
            initTelepresence(GATEWAY_URL, MY_DID, FEED_KEY);
            await registerSignalCallback(() => {});

            transport.setResponse("GET", "/telepresence/inbox", {
                status: 200, headers: {}, body: "[]",
            });

            await pollInbox();
            assert.equal(getLastInboxCheck(), "");
        });
    });
});
