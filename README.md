# Hypercore Link Language for AD4M

AD4M link language that syncs Perspective triples via an HTTP sidecar gateway backed by Hyperswarm + Corestore.

## What It Does

- **Commits:** links → blocks appended to a Hypercore feed via the sidecar gateway
- **Sync:** polls gateway for new blocks → local links
- **Query:** indexed local store (source, target, predicate)
- **P2P replication:** Hyperswarm DHT for peer discovery and feed replication
- **Sidecar pattern:** a Node.js gateway process handles Hyperswarm; the language talks HTTP

## Template Variables

| Variable | Description |
|----------|-------------|
| `HYPERCORE_KEY` | Public key of the Hypercore feed |
| `DISCOVERY_KEY` | Discovery key for Hyperswarm |
| `BOOTSTRAP_NODES` | DHT bootstrap nodes |
| `HYPERCORE_GATEWAY_URL` | HTTP sidecar gateway URL |
| `NEIGHBOURHOOD_META` | AD4M neighbourhood metadata |

## Building

```bash
pnpm install
deno run --allow-all esbuild.ts
```

Requires `@coasys/ad4m-ldk` at `../ad4m/ad4m-ldk/js/` or set `AD4M_LDK_ENTRY`.

## Testing

```bash
node --experimental-vm-modules --import tsx --test tests/*.test.ts
```

239 tests across 11 suites.

## Architecture

Same [pure/impure pattern](https://github.com/HexaField/ad4m-link-language-template) as all AD4M link languages. Protocol-specific modules:

- `src/commit-block.ts` / `commit-block.pure.ts` — block format for perspective diffs
- `src/encryption.ts` — feed encryption
- `src/index-keys.ts` / `index-keys.pure.ts` — secondary index management
- `src/membership.ts` / `membership.pure.ts` — Hyperswarm peer membership
- `src/signals.ts` / `signals.pure.ts` — Hyperswarm signaling
- `src/translate.ts` / `translate.pure.ts` — link ↔ block translation
- `src/dual-language.ts` — dual-language support
- `src/sdna.ts` — social DNA definitions
- `src/settings.ts` — language settings
- `src/sync.ts` — sync orchestration

`ad4m:host` imports confined to 4 adapter files + `index.ts`.

## License

CAL-1.0
