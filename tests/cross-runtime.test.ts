/**
 * Cross-runtime test harness.
 *
 * Exercises the full production modules using mock adapters that
 * simulate an alternative runtime. Proves that the core logic has
 * NO hidden dependency on ad4m:host.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Adapter interfaces
import type { StorageAdapter } from "../src/storage-interface.js";
import { initStorage } from "../src/storage-interface.js";
import type { Transport, TransportResponse } from "../src/transport.js";
import { initTransport } from "../src/transport.js";
import type { SigningAdapter } from "../src/signing-interface.js";
import { initSigning } from "../src/signing-interface.js";
import type { RuntimeAdapter } from "../src/runtime-interface.js";
import { initRuntime } from "../src/runtime-interface.js";

// Production modules under test
import * as store from "../src/store.js";
import {
    commitDiff,
    commitDiffWithTimestamp,
    processBlock,
    processBlocks,
} from "../src/translate.js";
import { linkContentKey, blockToPerspectiveDiff, verifyRoundTrip } from "../src/translate.pure.js";
import { serializeCommitBlock, deserializeCommitBlock } from "../src/commit-block.pure.js";
import { shouldFederate, linkOriginKey, linkContentHash } from "../src/dual-language.js";
import { sync, bufferBlock, clearBuffer, handleInboundSignal } from "../src/sync.js";
import { detectPattern, isSocialPattern } from "../src/sdna.js";
import { parseSettings, DEFAULT_SETTINGS } from "../src/settings.js";
import {
    buildAppendSignal,
    buildJoinSwarmSignal,
    buildLeaveSwarmSignal,
    parseInboundSignal,
} from "../src/signals.pure.js";
import { isValidWriterKey, filterValidWriterKeys } from "../src/membership.pure.js";
import { addWriter, listWriters, isKnownWriter } from "../src/membership.js";
import {
    setEncryptionKey,
    getEncryptionKey,
    isEncryptionEnabled,
    clearEncryptionKey,
    xorEncrypt,
    xorDecrypt,
    prepareBlockForStorage,
} from "../src/encryption.js";
import {
    allIndexKeys,
    allIndexKeysForDeletion,
    hashKey,
    sourceKey,
    sourcePrefix,
} from "../src/index-keys.pure.js";

// Types
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";
import type { HypercoreCommitBlock } from "../src/commit-block.pure.js";
import type { BlockSignal } from "../src/signals.pure.js";

// ---------------------------------------------------------------------------
// Mock Adapters
// ---------------------------------------------------------------------------

class MockStorageAdapter implements StorageAdapter {
    private data = new Map<string, string>();

    get(key: string): string | null {
        return this.data.get(key) ?? null;
    }

    put(key: string, value: string): void {
        this.data.set(key, value);
    }

    delete(key: string): void {
        this.data.delete(key);
    }

    listKeys(prefix?: string): string[] {
        const all = [...this.data.keys()];
        if (!prefix) return all;
        return all.filter(k => k.startsWith(prefix));
    }

    _dump(): Map<string, string> {
        return new Map(this.data);
    }

    _clear(): void {
        this.data.clear();
    }
}

class MockTransport implements Transport {
    public requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];

    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        this.requests.push({ url, method, headers, body });
        return { status: 200, headers: {}, body: "" };
    }
}

class MockSigningAdapter implements SigningAdapter {
    signStringHex(payload: string): string {
        return "mocksig" + payload.length.toString(16);
    }

    signingKeyId(): string {
        return "mock-key-id";
    }
}

class MockRuntime implements RuntimeAdapter {
    public signals: string[] = [];
    public diffs: unknown[] = [];

    hash(data: string): string {
        return simpleHash(data);
    }

    emitSignal(data: string): void {
        this.signals.push(data);
    }

    emitPerspectiveDiff(diff: unknown): void {
        this.diffs.push(diff);
    }
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FEED_KEY = "aa".repeat(32);
const DISCOVERY_KEY = "bb".repeat(32);

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

function makeChatLink(): LinkExpression {
    return makeLinkExpression({
        data: {
            source: "channel://main",
            target: "expr://msg-001",
            predicate: "flux://has_message",
        },
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

let mockStorage: MockStorageAdapter;
let mockTransport: MockTransport;
let mockSigning: MockSigningAdapter;
let mockRuntime: MockRuntime;

function initAllAdapters(): void {
    mockStorage = new MockStorageAdapter();
    mockTransport = new MockTransport();
    mockSigning = new MockSigningAdapter();
    mockRuntime = new MockRuntime();

    initRuntime(mockRuntime);
    initStorage(mockStorage);
    initTransport(mockTransport);
    initSigning(mockSigning);
    store.initStore(simpleHash);
    clearBuffer();
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Store operations via mock storage
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Store operations", () => {
    beforeEach(() => initAllAdapters());

    it("stores and retrieves a link", () => {
        const link = makeLinkExpression();
        const hash = store.putLink(link);
        assert.ok(hash);

        const retrieved = store.getLink(hash);
        assert.ok(retrieved);
        assert.equal(retrieved!.data.source, "literal://hello");
    });

    it("indexes by source, target, predicate, and author", () => {
        const link = makeLinkExpression();
        store.putLink(link);

        assert.equal(store.queryLinks({ source: "literal://hello" }).length, 1);
        assert.equal(store.queryLinks({ target: "literal://world" }).length, 1);
        assert.equal(store.queryLinks({ predicate: "sioc://content_of" }).length, 1);
        assert.equal(store.queryLinks({ author: "did:key:z6MkTest" }).length, 1);
    });

    it("returns empty for queries with no matches", () => {
        store.putLink(makeLinkExpression());
        assert.equal(store.queryLinks({ source: "nonexistent" }).length, 0);
    });

    it("removes links and cleans up indexes", () => {
        const link = makeLinkExpression();
        const hash = store.putLink(link);
        store.removeLink(link);
        assert.equal(store.getLink(hash), null);
        assert.equal(store.queryLinks({ source: "literal://hello" }).length, 0);
    });

    it("applies PerspectiveDiff", () => {
        const link1 = makeLinkExpression();
        store.putLink(link1);

        const link2 = makeLinkExpression({
            data: { source: "a", target: "b", predicate: "c" },
        });

        store.applyDiff({
            additions: [link2],
            removals: [link1],
        });

        assert.equal(store.getLink(store.hashLink(link1)), null);
        assert.ok(store.getLink(store.hashLink(link2)));
    });

    it("allLinks returns all stored links", () => {
        store.putLink(makeLinkExpression());
        store.putLink(makeLinkExpression({
            data: { source: "x", target: "y", predicate: "z" },
            timestamp: "2026-05-02T01:00:00.000Z",
        }));
        assert.equal(store.allLinks().links.length, 2);
    });

    it("manages revision tracking", () => {
        assert.equal(store.getRevision(), null);
        store.setRevision("12345");
        assert.equal(store.getRevision(), "12345");
    });

    it("manages block tracking", () => {
        assert.equal(store.isBlockProcessed(0), false);
        store.setBlockProcessed(0);
        assert.equal(store.isBlockProcessed(0), true);
    });

    it("manages block deduplication", () => {
        assert.equal(store.hasSeenBlock("hash1"), false);
        store.markBlockSeen("hash1");
        assert.equal(store.hasSeenBlock("hash1"), true);
    });

    it("manages peers", () => {
        store.setPeer("pk1", { name: "Alice" });
        store.setPeer("pk2", { name: "Bob" });
        assert.equal(store.listPeers().length, 2);

        const meta = store.getPeerMetadata("pk1");
        assert.ok(meta);
        assert.equal(meta!.name, "Alice");

        store.removePeer("pk1");
        assert.equal(store.listPeers().length, 1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Translation via mock runtime
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Translation", () => {
    beforeEach(() => initAllAdapters());

    it("builds commit block from diff", () => {
        const link = makeLinkExpression();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const result = commitDiff(diff, {
            seq: 0,
            author: "did:key:z6MkTest",
            hashFn: simpleHash,
        });

        assert.ok(result);
        assert.equal(result!.block.type, "ad4m:PerspectiveDiff");
        assert.equal(result!.block.seq, 0);
        assert.equal(result!.block.additions.length, 1);
        assert.ok(result!.linkHashes.length > 0);
    });

    it("respects shouldCommit filter", () => {
        const link = makeLinkExpression();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const result = commitDiff(diff, {
            seq: 0,
            author: "did:key:z6MkTest",
            hashFn: simpleHash,
            shouldCommit: () => false,
        });

        assert.equal(result, null); // All links filtered out
    });

    it("returns null for empty diff after filtering", () => {
        const diff: PerspectiveDiff = { additions: [], removals: [] };

        const result = commitDiff(diff, {
            seq: 0,
            author: "did:key:z6MkTest",
            hashFn: simpleHash,
        });

        assert.equal(result, null);
    });

    it("processes raw block data", () => {
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
    });

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
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Sync pipeline via mock adapters
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Sync pipeline", () => {
    beforeEach(() => initAllAdapters());

    it("full round-trip: link → commit block → buffer → sync → link", () => {
        // 1. Create a link and build commit block
        const original = makeLinkExpression();
        const diff: PerspectiveDiff = { additions: [original], removals: [] };

        const result = commitDiffWithTimestamp(diff, 0, "did:key:z6MkTest", "2026-05-02T00:00:00.000Z");

        // 2. Simulate the block arriving from Hyperswarm replication
        const blockSignal = makeBlockSignal(0, result.serialized);

        // 3. Buffer and sync
        bufferBlock(blockSignal);
        const syncDiff = sync();

        // 4. Verify round-trip
        assert.equal(syncDiff.additions.length, 1);
        const roundTripped = syncDiff.additions[0];
        assert.equal(roundTripped.data.source, original.data.source);
        assert.equal(roundTripped.data.predicate, original.data.predicate);
        assert.equal(roundTripped.data.target, original.data.target);
        assert.equal(roundTripped.author, original.author);
        assert.equal(roundTripped.proof.signature, original.proof.signature);
    });

    it("deduplicates blocks from multiple peers", () => {
        const block: HypercoreCommitBlock = {
            type: "ad4m:PerspectiveDiff",
            seq: 0,
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T00:00:00.000Z",
            additions: [makeLinkExpression()],
            removals: [],
        };
        const serialized = serializeCommitBlock(block);

        // Same block from 3 peers
        bufferBlock(makeBlockSignal(0, serialized));
        bufferBlock(makeBlockSignal(0, serialized));
        bufferBlock(makeBlockSignal(0, serialized));

        const diff = sync();
        assert.equal(diff.additions.length, 1);
    });

    it("processes blocks in sequence order", () => {
        const block0 = serializeCommitBlock({
            type: "ad4m:PerspectiveDiff",
            seq: 0,
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T00:00:00.000Z",
            additions: [makeLinkExpression()],
            removals: [],
        });
        const block1 = serializeCommitBlock({
            type: "ad4m:PerspectiveDiff",
            seq: 1,
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T01:00:00.000Z",
            additions: [makeLinkExpression({ timestamp: "2026-05-02T01:00:00.000Z" })],
            removals: [],
        });

        // Buffer out of order
        bufferBlock(makeBlockSignal(1, block1));
        bufferBlock(makeBlockSignal(0, block0));

        const diff = sync();
        assert.equal(diff.additions.length, 2);
    });

    it("handles removals in commit blocks", () => {
        // First, add a link
        const link = makeLinkExpression();
        store.putLink(link);

        // Then receive a block that removes it
        const removalBlock = serializeCommitBlock({
            type: "ad4m:PerspectiveDiff",
            seq: 0,
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T01:00:00.000Z",
            additions: [],
            removals: [link],
        });

        bufferBlock(makeBlockSignal(0, removalBlock));
        const diff = sync();

        assert.equal(diff.removals.length, 1);
        assert.equal(store.getLink(store.hashLink(link)), null);
    });

    it("updates revision after sync", () => {
        const block = serializeCommitBlock({
            type: "ad4m:PerspectiveDiff",
            seq: 5,
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T00:00:00.000Z",
            additions: [makeLinkExpression()],
            removals: [],
        });

        bufferBlock(makeBlockSignal(5, block));
        sync();

        assert.equal(store.getRevision(), "5");
    });

    it("tracks remote peers", () => {
        const block = serializeCommitBlock({
            type: "ad4m:PerspectiveDiff",
            seq: 0,
            author: "did:key:z6MkRemote",
            timestamp: "2026-05-02T00:00:00.000Z",
            additions: [makeLinkExpression()],
            removals: [],
        });

        bufferBlock(makeBlockSignal(0, block));
        sync();

        const peers = store.listPeers();
        assert.ok(peers.includes("did:key:z6MkRemote"));
    });

    it("empty buffer returns empty diff", () => {
        const diff = sync();
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Signal handling
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Signal handling", () => {
    beforeEach(() => initAllAdapters());

    it("handles hypercore:block signals", () => {
        const block = serializeCommitBlock({
            type: "ad4m:PerspectiveDiff",
            seq: 0,
            author: "did:key:z6MkTest",
            timestamp: "2026-05-02T00:00:00.000Z",
            additions: [makeLinkExpression()],
            removals: [],
        });

        const result = handleInboundSignal({
            type: "hypercore:block",
            feedKey: FEED_KEY,
            seq: 0,
            data: block,
            author: "did:key:z6MkTest",
            remote: true,
        });

        assert.equal(result.kind, "block");
    });

    it("handles hyperswarm:peer connected signals", () => {
        const result = handleInboundSignal({
            type: "hyperswarm:peer",
            action: "connected",
            peerKey: "peer123",
            feedKey: FEED_KEY,
        });

        assert.equal(result.kind, "peer");
        assert.ok(store.listPeers().includes("peer123"));
    });

    it("handles hyperswarm:peer disconnected signals", () => {
        store.setPeer("peer123", {});

        handleInboundSignal({
            type: "hyperswarm:peer",
            action: "disconnected",
            peerKey: "peer123",
        });

        assert.equal(store.listPeers().includes("peer123"), false);
    });

    it("ignores unknown signal types", () => {
        const result = handleInboundSignal({ type: "unknown" });
        assert.equal(result.kind, "ignored");
    });

    it("ignores non-object signals", () => {
        const result = handleInboundSignal("string");
        assert.equal(result.kind, "ignored");
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Dual-language integration
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Dual-language", () => {
    beforeEach(() => initAllAdapters());

    it("prevents echo loop for hypercore-origin links", () => {
        const link = makeLinkExpression();
        const linkHash = store.hashLink(link);
        mockStorage.put(linkOriginKey(linkHash), "hypercore");

        assert.equal(shouldFederate(linkHash, (key) => mockStorage.get(key)), false);
    });

    it("federates native-origin links", () => {
        const link = makeLinkExpression();
        const linkHash = store.hashLink(link);
        mockStorage.put(linkOriginKey(linkHash), "native");

        assert.equal(shouldFederate(linkHash, (key) => mockStorage.get(key)), true);
    });

    it("federates new local commits (no origin)", () => {
        const link = makeLinkExpression();
        const linkHash = store.hashLink(link);

        assert.equal(shouldFederate(linkHash, (key) => mockStorage.get(key)), true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. SDNA pattern detection
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: SDNA patterns", () => {
    it("detects chat patterns", () => {
        const link = makeChatLink();
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "chat-message");
    });

    it("detects reaction patterns", () => {
        const link = makeLinkExpression({
            data: { source: "expr://msg", target: "👍", predicate: "flux://has_reaction" },
        });
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "reaction");
    });

    it("detects reply patterns", () => {
        const link = makeLinkExpression({
            data: { source: "expr://parent", target: "expr://reply", predicate: "flux://has_reply" },
        });
        const pattern = detectPattern(link);
        assert.equal(pattern.type, "reply");
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Settings parsing
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Settings", () => {
    it("parses settings from JSON string", () => {
        const settings = parseSettings(JSON.stringify({
            syncMode: "publish-only",
            swarm: { maxPeers: 8 },
        }));
        assert.equal(settings.syncMode, "publish-only");
        assert.equal(settings.swarm.maxPeers, 8);
    });

    it("handles invalid input gracefully", () => {
        const settings = parseSettings("not-json");
        assert.equal(settings.syncMode, "bidirectional");
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Membership management
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Membership", () => {
    beforeEach(() => initAllAdapters());

    it("adds and lists writers", () => {
        const key = "a".repeat(64);
        assert.ok(addWriter(key, "did:key:z6MkAlice"));
        assert.equal(listWriters().length, 1);
        assert.equal(listWriters()[0].feedKey, key);
    });

    it("rejects duplicate writers", () => {
        const key = "a".repeat(64);
        addWriter(key, "did:key:z6MkAlice");
        assert.equal(addWriter(key, "did:key:z6MkAlice"), false);
    });

    it("rejects invalid keys", () => {
        assert.equal(addWriter("short", "did:key:z6MkAlice"), false);
    });

    it("checks known writers", () => {
        const key = "b".repeat(64);
        assert.equal(isKnownWriter(key), false);
        addWriter(key, "did:key:z6MkBob");
        assert.ok(isKnownWriter(key));
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Encryption
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Encryption", () => {
    beforeEach(() => initAllAdapters());

    it("manages encryption key lifecycle", () => {
        assert.equal(isEncryptionEnabled(), false);
        setEncryptionKey("cc".repeat(32));
        assert.ok(isEncryptionEnabled());
        clearEncryptionKey();
        assert.equal(isEncryptionEnabled(), false);
    });

    it("XOR round-trip works", () => {
        const data = "Test data for Hypercore block encryption";
        const key = "dd".repeat(32);
        const encrypted = xorEncrypt(data, key);
        assert.notEqual(encrypted, data);
        const decrypted = xorDecrypt(encrypted, key);
        assert.equal(decrypted, data);
    });

    it("prepareBlockForStorage reflects encryption state", () => {
        let result = prepareBlockForStorage("data");
        assert.equal(result.encrypt, false);

        setEncryptionKey("ee".repeat(32));
        result = prepareBlockForStorage("data");
        assert.equal(result.encrypt, true);
        assert.equal(result.keyHex, "ee".repeat(32));
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Index keys
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Index keys", () => {
    it("generates all index entries", () => {
        const entries = allIndexKeys(
            "h1", "src", "tgt", "pred", "auth", "ts",
            ["source", "target", "predicate", "author", "timestamp"],
        );
        assert.equal(entries.length, 6);
        assert.ok(entries.some(([k]) => k === hashKey("h1")));
        assert.ok(entries.some(([k]) => k === sourceKey("src", "h1")));
    });

    it("generates deletion keys", () => {
        const keys = allIndexKeysForDeletion(
            "h1", "src", "tgt", "pred", "auth", "ts",
            ["source", "target"],
        );
        assert.equal(keys.length, 3); // primary + source + target
    });

    it("sourcePrefix works for range queries", () => {
        assert.equal(sourcePrefix("literal://hello"), "link:src:literal://hello:");
    });
});
