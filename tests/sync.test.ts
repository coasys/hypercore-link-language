/**
 * Tests for sync coordination module.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter } from "../src/storage-interface.js";
import { initStorage } from "../src/storage-interface.js";
import type { RuntimeAdapter } from "../src/runtime-interface.js";
import { initRuntime } from "../src/runtime-interface.js";

import * as store from "../src/store.js";
import { sync, syncFromBuffer, bufferBlock, clearBuffer, getBufferSize, handleInboundSignal } from "../src/sync.js";
import { initTransport } from "../src/transport.js";
import type { Transport, TransportResponse } from "../src/transport.js";
import { serializeCommitBlock } from "../src/commit-block.pure.js";
import type { HypercoreCommitBlock } from "../src/commit-block.pure.js";
import type { LinkExpression } from "../src/types.js";
import type { BlockSignal } from "../src/signals.pure.js";

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FEED_KEY = "aa".repeat(32);

function makeLinkExpression(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "literal://hello",
            target: "literal://world",
            predicate: "sioc://content_of",
        },
        proof: { signature: "abc123", key: "key123" },
        ...overrides,
    };
}

function makeBlock(seq: number, additions: LinkExpression[], removals: LinkExpression[] = []): string {
    return serializeCommitBlock({
        type: "ad4m:PerspectiveDiff",
        seq,
        author: "did:key:z6MkTest",
        timestamp: new Date(Date.now() + seq * 1000).toISOString(),
        additions,
        removals,
    });
}

function makeBlockSignal(seq: number, data: string, remote: boolean = true): BlockSignal {
    return {
        type: "hypercore:block",
        feedKey: FEED_KEY,
        seq,
        data,
        author: "did:key:z6MkRemote",
        remote,
    };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe("Sync module", () => {
    beforeEach(() => {
        initStorage(new MockStorageAdapter());
        initRuntime(new MockRuntime());
        // Init a no-op transport so getGateway() returns null (signal mode)
        initTransport({
            async fetch(): Promise<TransportResponse> {
                return { status: 200, headers: {}, body: '{}' };
            }
        });
        store.initStore();
        clearBuffer();
    });

    // -----------------------------------------------------------------------
    // Buffer management
    // -----------------------------------------------------------------------

    describe("buffer management", () => {
        it("starts empty", () => {
            assert.equal(getBufferSize(), 0);
        });

        it("tracks buffer size", () => {
            bufferBlock(makeBlockSignal(0, makeBlock(0, [makeLinkExpression()])));
            assert.equal(getBufferSize(), 1);
            bufferBlock(makeBlockSignal(1, makeBlock(1, [makeLinkExpression()])));
            assert.equal(getBufferSize(), 2);
        });

        it("clearBuffer resets to empty", () => {
            bufferBlock(makeBlockSignal(0, makeBlock(0, [makeLinkExpression()])));
            clearBuffer();
            assert.equal(getBufferSize(), 0);
        });
    });

    // -----------------------------------------------------------------------
    // sync()
    // -----------------------------------------------------------------------

    describe("sync() — async gateway-aware", () => {
        it("returns empty diff for empty buffer", async () => {
            const diff = await sync();
            assert.equal(diff.additions.length, 0);
            assert.equal(diff.removals.length, 0);
        });

        it("processes single block", async () => {
            const link = makeLinkExpression();
            bufferBlock(makeBlockSignal(0, makeBlock(0, [link])));

            const diff = await sync();
            assert.equal(diff.additions.length, 1);
            assert.equal(diff.additions[0].data.source, "literal://hello");
        });

        it("processes multiple blocks", async () => {
            const link1 = makeLinkExpression();
            const link2 = makeLinkExpression({ timestamp: "2026-05-02T01:00:00.000Z" });
            bufferBlock(makeBlockSignal(0, makeBlock(0, [link1])));
            bufferBlock(makeBlockSignal(1, makeBlock(1, [link2])));

            const diff = await sync();
            assert.equal(diff.additions.length, 2);
        });

        it("drains the buffer after sync", async () => {
            bufferBlock(makeBlockSignal(0, makeBlock(0, [makeLinkExpression()])));
            await sync();
            assert.equal(getBufferSize(), 0);
        });

        it("deduplicates by sequence number", async () => {
            const block = makeBlock(0, [makeLinkExpression()]);
            bufferBlock(makeBlockSignal(0, block));
            bufferBlock(makeBlockSignal(0, block));
            bufferBlock(makeBlockSignal(0, block));

            const diff = await sync();
            assert.equal(diff.additions.length, 1);
        });

        it("does not reprocess already-processed blocks", async () => {
            const block = makeBlock(0, [makeLinkExpression()]);
            bufferBlock(makeBlockSignal(0, block));
            await sync(); // Process block 0

            // Buffer the same block again
            bufferBlock(makeBlockSignal(0, block));
            const diff = await sync();
            assert.equal(diff.additions.length, 0);
        });

        it("handles removals", async () => {
            const link = makeLinkExpression();
            store.putLink(link);

            bufferBlock(makeBlockSignal(0, makeBlock(0, [], [link])));
            const diff = await sync();

            assert.equal(diff.removals.length, 1);
            assert.equal(store.getLink(store.hashLink(link)), null);
        });

        it("sorts blocks by sequence", async () => {
            const link1 = makeLinkExpression({ data: { source: "first", target: "t", predicate: "p" } });
            const link2 = makeLinkExpression({ data: { source: "second", target: "t", predicate: "p" } });

            // Buffer out of order
            bufferBlock(makeBlockSignal(1, makeBlock(1, [link2])));
            bufferBlock(makeBlockSignal(0, makeBlock(0, [link1])));

            const diff = await sync();
            assert.equal(diff.additions.length, 2);
            // First addition should be from seq 0
            assert.equal(diff.additions[0].data.source, "first");
        });

        it("updates revision to latest sequence", async () => {
            bufferBlock(makeBlockSignal(0, makeBlock(0, [makeLinkExpression()])));
            bufferBlock(makeBlockSignal(5, makeBlock(5, [makeLinkExpression({ timestamp: "2026-05-02T05:00:00.000Z" })])));

            await sync();
            assert.equal(store.getRevision(), "5");
        });

        it("skips invalid block data", async () => {
            bufferBlock(makeBlockSignal(0, "not valid json"));
            bufferBlock(makeBlockSignal(1, makeBlock(1, [makeLinkExpression()])));

            const diff = await sync();
            assert.equal(diff.additions.length, 1); // Only block 1 processed
        });
    });

    describe("syncFromBuffer() — synchronous buffer drain", () => {
        it("returns empty diff for empty buffer", () => {
            const diff = syncFromBuffer();
            assert.equal(diff.additions.length, 0);
            assert.equal(diff.removals.length, 0);
        });

        it("processes single block", () => {
            const link = makeLinkExpression();
            bufferBlock(makeBlockSignal(0, makeBlock(0, [link])));

            const diff = syncFromBuffer();
            assert.equal(diff.additions.length, 1);
            assert.equal(diff.additions[0].data.source, "literal://hello");
        });
    });

    // -----------------------------------------------------------------------
    // handleInboundSignal
    // -----------------------------------------------------------------------

    describe("handleInboundSignal", () => {
        it("buffers hypercore:block signals", () => {
            const block = makeBlock(0, [makeLinkExpression()]);
            const result = handleInboundSignal({
                type: "hypercore:block",
                feedKey: FEED_KEY,
                seq: 0,
                data: block,
                author: "did:key:z6MkRemote",
                remote: true,
            });

            assert.equal(result.kind, "block");
            assert.equal(getBufferSize(), 1);
        });

        it("handles peer connected signals", () => {
            const result = handleInboundSignal({
                type: "hyperswarm:peer",
                action: "connected",
                peerKey: "peer1",
                feedKey: FEED_KEY,
            });

            assert.equal(result.kind, "peer");
            assert.ok(store.listPeers().includes("peer1"));
        });

        it("handles peer disconnected signals", () => {
            store.setPeer("peer1", {});

            handleInboundSignal({
                type: "hyperswarm:peer",
                action: "disconnected",
                peerKey: "peer1",
            });

            assert.equal(store.listPeers().includes("peer1"), false);
        });

        it("ignores unknown signals", () => {
            const result = handleInboundSignal({ type: "unknown:type" });
            assert.equal(result.kind, "ignored");
        });

        it("ignores null signals", () => {
            const result = handleInboundSignal(null);
            assert.equal(result.kind, "ignored");
        });

        it("ignores string signals", () => {
            const result = handleInboundSignal("not an object");
            assert.equal(result.kind, "ignored");
        });
    });
});
