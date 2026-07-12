# AGENTS.md — hypercore-link-language

AD4M link language that syncs a Perspective over a Hypercore **Autobase** — a
multi-writer, deterministically-linearized append-only log — replicated across
peers via Hyperswarm. The native Holepunch stack can't run inside the Deno/WASM
language sandbox, so a small **Node.js sidecar gateway** (`gateway/`) owns the
Autobase and the language talks to it over HTTP.

## Architecture (the load-bearing idea)

- **Role A — convergence substrate (source of truth).** One Autobase per
  neighbourhood. Each agent writes its own add/remove ops (keyed by link content
  hash) to its own input feed; Autobase linearizes all writers into a single
  deterministic op-log (the DAG). The materialised link set is an **OR-Set**
  folded from that op-log.
- **Role B — native projection (derived).** None — Hypercore has no human-app
  idiom. The language's local KV store is a derived read cache of the fold.

Invariants — do not break these:

- `currentRevision()` = `resolvedStateDigest` — the SHA-256 of the sorted **live
  OR-Set link hashes** folded from the op-log. This is a pure function of the
  observable link set, so it is stable across reads and identical across
  converged replicas. **Never** `base.hash()` (the Autobase view-core merkle,
  which drifts between reads with indexer/ack flush cadence), a feed length, or a
  timestamp.
- Removals are **first-class OR-Set ops carrying the original link's hash**, so an
  observed-remove converges against the exact add.
- The gateway uses the OR-Set key the language computed with AD4M's own
  content-address hash **verbatim**, so every agent shares one keyspace.

## Layout

Language (`src/`) — no `ad4m:host` imports except the two adapter files:

- `src/transport.ts` — `GatewayClient`: the REST contract (openBase, revision,
  links, oplog, diff, commit, addWriter, replicate) over an injected `Transport`.
- `src/link-hash.ts` — the OR-Set link hash (AD4M content-address hash),
  computed identically to the gateway.
- `src/commit-block.ts` — commit-block model + content-address block hash.
- `src/sync.ts` — folds the gateway's incremental diff into the derived cache;
  legacy signal-buffer fallback for executors without a gateway.
- `src/membership.ts` — known writer-key set (peer input feeds to authorise).
- `src/store.ts` — derived link cache with source/target/predicate/author indexes.
- `src/translate.ts` — link ↔ block translation, dual-language dedup.
- `src/{encryption,index-keys,signals,telepresence,settings,types}.ts` — feed
  encryption, index keys, executor-relayed signals, Hyperswarm presence, settings.
- `src/adapters.ts` / `src/adapters-deno.ts` — injected adapters; `ad4m:host`
  confined here + `index.ts`.

Gateway (`gateway/src/`) — Node.js, native Holepunch:

- `autobase-node.js` — wraps Corestore + Autobase; `revision()` =
  `resolvedStateDigest` over the sorted live link hashes (NOT `base.hash()`).
- `state.js` — one AutobaseNode per base key.
- `routes.js` / `server.js` — REST handlers + HTTP server.
- `link-hash.js` — fallback canonical link hash for bare links.

## Build / test / typecheck

```bash
NODE_ENV=development pnpm install     # NODE_ENV=production skips devDeps — installs look broken
deno run --allow-all esbuild.ts       # bundle → build/ (needs @coasys/ad4m-ldk at ../ad4m/ad4m-ldk/js or AD4M_LDK_ENTRY)
npx tsc --noEmit                      # typecheck — the ONLY type gate; tsx/esbuild transpile without checking
node --experimental-vm-modules --import tsx --test tests/*.test.ts   # language suite

cd gateway && npm test               # gateway suite: node --test tests/*.test.js
cd gateway && npm start              # run the gateway: node src/server.js
```

ESM imports use explicit `.js` extensions even for `.ts` sources. `npm test`
summary lines are `ℹ tests N` / `ℹ pass N` / `ℹ fail N`.

## What's unit-tested vs what needs a live backend

Hermetic: the language suite drives `GatewayClient` + OR-Set hash + sync fold
against a live in-process gateway server; the gateway suite runs two-writer
in-process Autobase convergence (real content-hash revision, revision
byte-identical across many reads of unchanged state, order-independent identical
hash, removal convergence, DAG-fold ≡ link set, multi-writer authorisation).
**Not** in CI: Hyperswarm DHT peer discovery + replication across separate
machines (needs a real UDP DHT and two gateway processes).

## Gotchas

- **Never** use `base.hash()` for the revision — it is a view-core merkle that
  jitters with indexer/ack flush timing and is not identical across replicas. Use
  the resolved OR-Set state digest.
- The gateway is a **separate Node package** with its own `package.json`,
  `node_modules`, and test runner — build/test it independently of the language.
