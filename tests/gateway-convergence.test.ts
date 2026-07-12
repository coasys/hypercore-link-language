/**
 * Language-side integration test against the REAL Autobase gateway.
 *
 * This drives the language's own modules — the GatewayClient (transport.ts),
 * the OR-Set link hash (link-hash.ts), and the sync fold (sync.ts) — against a
 * live gateway http.Server on an ephemeral port. It proves the reworked
 * language honours AD4M's perspective-sync contract end to end:
 *
 *   - currentRevision() is the Autobase linearized content hash (64-hex),
 *     deterministic and stable — NEVER a sequence number.
 *   - commit() sends OR-Set add/remove ops keyed by the link's content hash.
 *   - a removal carries the ORIGINAL link's hash and converges against the add.
 *   - sync() folds the gateway diff into the derived cache (Role B), and the
 *     cache mirrors the authoritative linearized log.
 *
 * These are the language-side companions to the gateway's in-process
 * convergence tests (gateway/tests/convergence.test.js).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { StorageAdapter, RuntimeAdapter } from "../src/adapters.js";
import { initStorage, initRuntime } from "../src/adapters.js";
import type { Transport, TransportResponse } from "../src/transport.js";
import { initTransport, initGateway, getGateway } from "../src/transport.js";
import type { HashedLink } from "../src/transport.js";
import { orSetLinkHash } from "../src/link-hash.js";
import { sync as doSync, setGatewaySync, setLastSyncedSeq } from "../src/sync.js";
import * as store from "../src/store.js";
import type { LinkExpression } from "../src/types.js";

// Import the real gateway (JS ESM) — same server the language talks to in prod.
import { GatewayState } from "../gateway/src/state.js";
import { createServer } from "../gateway/src/server.js";

// ---------------------------------------------------------------------------
// Mock runtime/storage (no ad4m:host). The mock hash is a plain content hash;
// what matters is that the language and gateway agree on the OR-Set key, which
// they do because the language SENDS the key it computed and the gateway uses
// it verbatim.
// ---------------------------------------------------------------------------

class MockStorageAdapter implements StorageAdapter {
    private data = new Map<string, string>();
    get(key: string): string | null { return this.data.get(key) ?? null; }
    put(key: string, value: string): void { this.data.set(key, value); }
    delete(key: string): void { this.data.delete(key); }
    listKeys(prefix?: string): string[] {
        const all = [...this.data.keys()];
        return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    }
}

class MockRuntime implements RuntimeAdapter {
    hash(data: string): string {
        // djb2 → "Qm"+hex, mimicking AD4M's content-address hash shape.
        let h = 5381;
        for (let i = 0; i < data.length; i++) h = ((h << 5) + h + data.charCodeAt(i)) | 0;
        return `Qm${(h >>> 0).toString(16)}`;
    }
    emitSignal(): void { /* no-op */ }
    emitPerspectiveDiff(): void { /* no-op */ }
}

/** A Transport backed by Node's global fetch — the loopback wire to the gateway. */
class NodeFetchTransport implements Transport {
    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        const res = await fetch(url, {
            method,
            headers,
            body: (method === "GET" || method === "HEAD") ? undefined : body,
        });
        const text = await res.text();
        return { status: res.status, headers: {}, body: text };
    }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function link(source: string, target: string, overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkLang",
        timestamp: "2026-07-12T00:00:00.000Z",
        data: { source, target, predicate: "sioc://content_of" },
        proof: { signature: "sig-" + source, key: "k" },
        ...overrides,
    };
}

function hashed(l: LinkExpression, runtime: MockRuntime): HashedLink {
    return { link: l, hash: orSetLinkHash(l, runtime.hash) };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: ReturnType<typeof createServer>;
let state: GatewayState;
let storageRoot: string;
let baseUrl: string;
const runtime = new MockRuntime();

before(async () => {
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hc-lang-gw-"));
    state = new GatewayState(storageRoot);
    server = createServer(state);
    await new Promise<void>((r) => server.listen(0, () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await state.closeAll();
    fs.rmSync(storageRoot, { recursive: true, force: true });
});

describe("language ⇄ gateway convergence (real Autobase)", () => {
    beforeEach(() => {
        initStorage(new MockStorageAdapter());
        initRuntime(runtime);
        initTransport(new NodeFetchTransport());
        initGateway(baseUrl);
        store.initStore();
    });

    it("currentRevision is a real content hash (64-hex), not a sequence number", async () => {
        const gateway = getGateway()!;
        const base = await gateway.openBase();
        assert.match(base.key, /^[0-9a-f]{64}$/, "base key is a 64-hex Autobase key");
        assert.equal(base.writable, true, "creator is writable");

        // Empty base: revision is "" (never a fake integer).
        const rev0 = (await gateway.revision(base.key)).revision;
        assert.ok(!/^\d+$/.test(rev0), `empty revision must not be a bare integer, got ${rev0}`);

        // Commit an add via OR-Set hashed op.
        const l1 = link("a://1", "t://1");
        const result = await gateway.commit(base.key, [hashed(l1, runtime)], []);
        assert.match(result.revision, /^[0-9a-f]{64}$/, "commit returns a real content-hash revision");

        // revision() returns the SAME real hash, and is stable across reads.
        const revA = (await gateway.revision(base.key)).revision;
        const revB = (await gateway.revision(base.key)).revision;
        assert.match(revA, /^[0-9a-f]{64}$/);
        assert.equal(revA, revB, "revision is deterministic/stable for unchanged state");
        assert.equal(revA, result.revision, "commit revision matches the head revision");
    });

    it("sync() folds the gateway diff into the derived cache", async () => {
        const gateway = getGateway()!;
        const base = await gateway.openBase();
        setGatewaySync(base.key, -1);
        setLastSyncedSeq(-1);

        const l1 = link("fold://1", "t://1");
        const l2 = link("fold://2", "t://2");
        await gateway.commit(base.key, [hashed(l1, runtime), hashed(l2, runtime)], []);

        // Fold via the language's own sync path.
        const diff = await doSync();
        assert.equal(diff.additions.length, 2, "sync surfaces both adds");
        assert.equal(diff.removals.length, 0);

        // Derived cache mirrors the authoritative log.
        const cached = store.allLinks().links;
        const sources = cached.map((l) => l.data.source).sort();
        assert.deepEqual(sources, ["fold://1", "fold://2"]);

        // Cache revision was set to the real content hash by sync().
        assert.match(store.getRevision() || "", /^[0-9a-f]{64}$/);
    });

    it("a removal (carrying the original link hash) converges: link leaves the cache", async () => {
        const gateway = getGateway()!;
        const base = await gateway.openBase();
        setGatewaySync(base.key, -1);
        setLastSyncedSeq(-1);

        const L = link("remove://me", "t://x");

        // Add, fold.
        await gateway.commit(base.key, [hashed(L, runtime)], []);
        const addDiff = await doSync();
        assert.equal(addDiff.additions.length, 1);
        assert.equal(store.allLinks().links.length, 1, "cache has the link after add");
        const revAfterAdd = store.getRevision();

        // Remove the SAME link by its original OR-Set hash, fold.
        await gateway.commit(base.key, [], [hashed(L, runtime)]);
        const removeDiff = await doSync();
        assert.equal(removeDiff.removals.length, 1, "sync surfaces the removal");
        assert.equal(store.allLinks().links.length, 0, "link absent from cache after remove");

        // Revision advanced on removal — it is content-derived, not a counter.
        assert.notEqual(store.getRevision(), revAfterAdd, "revision changes on removal");
        assert.match(store.getRevision() || "", /^[0-9a-f]{64}$/);
    });

    it("reopening the same base key yields the same identity and links", async () => {
        const gateway = getGateway()!;
        const base = await gateway.openBase();
        const l1 = link("reopen://1", "t://1");
        await gateway.commit(base.key, [hashed(l1, runtime)], []);

        const reopened = await gateway.openBase(base.key);
        assert.equal(reopened.key, base.key, "same base key on reopen");

        const links = (await gateway.links(base.key)).links as LinkExpression[];
        assert.equal(links.length, 1);
        assert.equal(links[0].data.source, "reopen://1");
    });
});
