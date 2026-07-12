# Hypercore Link Language for AD4M

An AD4M link language that syncs Perspective triples over a Hypercore
**Autobase** — a multi-writer, deterministically-linearized append-only log —
replicated across peers via Hyperswarm.

This language honours AD4M's `perspective-sync` contract with a genuine
hash-linked diff-DAG: `currentRevision()` returns a content hash of the resolved
link set (the SHA-256 of the sorted live OR-Set hashes, folded from the
authoritative Autobase op-log) — a real content hash, identical across converged
replicas, never a sequence number — and removals are first-class OR-Set ops that
converge against the exact add they cancel.

## Convergence model

AD4M's `perspective-sync` expects a convergent substrate: a diff-DAG with
content-hash revisions and a deterministic merge. This language provides that by
riding Autobase:

- **Role A — convergence substrate (authoritative):** an Autobase, one per
  neighbourhood. Each agent writes its own PerspectiveDiff ops (add/remove,
  keyed by the link's content hash) to its own input feed. Autobase linearizes
  all writers into a single deterministic op-log (the DAG). The revision is a
  content hash of the resolved OR-Set state folded from that op-log — a pure
  function of the observable link set, so it is stable across reads and
  independent of Autobase's indexer/ack flush cadence.
- **Role B — native projection (derived):** the materialised link set, folded
  from the authoritative op-log as an OR-Set. The language's local KV store is a
  derived read cache of this projection, rebuilt by folding gateway diffs. It is
  never the source of truth.

Key properties (all covered by regression tests):

- `currentRevision()` is a real 64-hex content hash — deterministic, stable for
  unchanged state, and identical across converged replicas regardless of the
  order writes arrived.
- Removals carry the **original** link's OR-Set hash, so an observed-remove
  converges against the exact add across replicas (first-class observed-remove).
- Folding the linearized op-log from genesis reproduces the materialised link
  set — the DAG is authoritative.

## Why a sidecar gateway

Native Hypercore / Autobase / Hyperswarm need RocksDB storage, a UDP DHT, and
in-process linearization — none of which run inside the Language's Deno/WASM
sandbox. So that work lives in a small Node.js **gateway** process (in
`gateway/`), and the language talks to it over HTTP via AD4M's `httpFetch`. The
gateway owns one Autobase per neighbourhood and exposes a REST contract; the
language sends the OR-Set key it computed with AD4M's own content-address hash,
and the gateway uses that key verbatim so every agent shares one keyspace.

A legacy signal-based fallback (executor-relayed diff blocks) remains for
executors without a gateway, but it has no Autobase and therefore no convergent
content-hash revision — the gateway path is the real convergence path.

## Template Variables

| Variable | Description |
|----------|-------------|
| `HYPERCORE_KEY` | The Autobase key — the neighbourhood's stable identifier (hex). `auto` / unfilled creates a fresh base. |
| `DISCOVERY_KEY` | Discovery key (Hyperswarm topic), returned by the gateway when the base is opened. |
| `BOOTSTRAP_NODES` | JSON array of DHT bootstrap nodes. |
| `HYPERCORE_GATEWAY_URL` | HTTP URL of the sidecar gateway. |
| `NEIGHBOURHOOD_META` | AD4M neighbourhood metadata. |

## Building

```bash
pnpm install
deno run --allow-all esbuild.ts   # → build/bundle.js
```

Requires `@coasys/ad4m-ldk` at `../ad4m/ad4m-ldk/js/` or set `AD4M_LDK_ENTRY`.

## Testing

Language modules (run under `tsx`):

```bash
node --import tsx --test tests/*.test.ts
```

286 language tests across 89 suites, including `tests/gateway-convergence.test.ts`,
which drives the language's GatewayClient + OR-Set hash + sync fold against a
live gateway server.

Gateway (native Autobase, run with plain Node):

```bash
cd gateway && npm test
```

8 gateway tests, including two-writer in-process Autobase convergence
(`gateway/tests/convergence.test.js`): real content-hash revision, revision
byte-identical across many reads of unchanged state (no view-core drift), order-
independent identical revision hash, removal convergence, DAG-fold ≡ link set,
and multi-writer authorisation.

## Layout

Language (`src/`) — no `ad4m:host` imports except the two Deno adapter files:

- `transport.ts` — `GatewayClient`: the REST contract (openBase, revision, links,
  oplog, diff, commit, addWriter, replicate) over an injected `Transport`.
- `link-hash.ts` — the OR-Set link hash (AD4M content-address hash of the
  canonical link content), computed identically to the gateway.
- `commit-block.ts` — commit-block model + a real content-address block hash.
- `sync.ts` — folds the gateway's incremental diff into the derived cache;
  legacy signal-buffer fallback.
- `store.ts` — the derived link cache (KV) with source/target/predicate/author
  indexes.
- `translate.ts` — link ↔ block translation, dual-language dedup, pattern
  detection.
- `membership.ts` — known writer-key set (peer input feeds to authorise).
- `signals.ts` / `telepresence.ts` / `encryption.ts` / `index-keys.ts` /
  `settings.ts` / `types.ts` — supporting modules.
- `adapters.ts` — Transport / Storage / Runtime / Signing interfaces + singletons.
- `adapters-deno.ts` — the Deno implementations wrapping `ad4m:host`.

Gateway (`gateway/src/`) — Node.js, native Holepunch stack:

- `autobase-node.js` — wraps Corestore + Autobase; maintains the authoritative
  op-log and the derived OR-Set view; `revision()` = `resolvedStateDigest` over
  the sorted live link hashes (a pure function of the folded set, not the
  jittery `base.hash()` view-core merkle).
- `state.js` — one AutobaseNode per base key.
- `routes.js` / `server.js` — the REST handlers and HTTP server.
- `link-hash.js` — the gateway's fallback canonical link hash (for bare links).

## License

CAL-1.0
