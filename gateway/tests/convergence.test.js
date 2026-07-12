/**
 * Two-writer Autobase convergence tests (in-process, no external broker).
 *
 * These are the acceptance-criteria regression tests for spec §5. They run two
 * real AutobaseNode instances backed by on-disk Corestores, replicate them over
 * an in-process stream pipe (the exact replication protocol Autobase uses over
 * Hyperswarm, minus the network), and assert genuine convergence.
 *
 * A single-writer append-only feed CANNOT pass these — they only pass because
 * Autobase deterministically linearizes two independent input feeds.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AutobaseNode, foldOplog } from '../src/autobase-node.js'
import { hashLinkExpression } from '../src/link-hash.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hc-gw-test-'))
}

function link (source, target, opts = {}) {
  return {
    author: opts.author || 'did:key:z6MkA',
    timestamp: opts.timestamp || '2026-07-12T00:00:00.000Z',
    data: { source, target, predicate: opts.predicate || 'sioc://content_of' },
    proof: { signature: opts.signature || 'sig-' + source + '-' + target, key: 'k' }
  }
}

async function settleBoth (a, b, rounds = 60) {
  for (let i = 0; i < rounds; i++) {
    await a.update()
    await b.update()
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Spin up two writers, join writer B into writer A's base, replicate. */
async function twoWriters (root) {
  const A = new AutobaseNode(path.join(root, 'A'), null)
  await A.ready()
  const B = new AutobaseNode(path.join(root, 'B'), A.key())
  await B.ready()
  const streams = A.replicateWith(B)
  // Authorise B's local input feed into the linearization.
  await A.addWriter(B.localWriterKey())
  await settleBoth(A, B)
  return { A, B, streams }
}

function linkSetKey (links) {
  // Order-independent comparison of a link set by their canonical hashes.
  return links.map((l) => hashLinkExpression(l)).sort().join('|')
}

async function foldedLinkSet (node) {
  const links = await node.links()
  return links.map((l) => l.link)
}

// ---------------------------------------------------------------------------
// §5.1 — currentRevision is a real content hash
// ---------------------------------------------------------------------------

test('revision is a real content hash (not a seq), changes with content, stable', async (t) => {
  const root = tmpDir()
  const { A, B, streams } = await twoWriters(root)
  t.after(async () => { streams.a.destroy(); streams.b.destroy(); await A.close(); await B.close(); fs.rmSync(root, { recursive: true, force: true }) })

  const rev0 = await A.revision()
  // Not a sequence number string.
  assert.ok(!/^\d+$/.test(rev0), `revision must not be a bare integer, got ${rev0}`)

  await A.appendAdd(hashLinkExpression(link('a://1', 'b://1')), link('a://1', 'b://1'))
  await settleBoth(A, B)
  const rev1 = await A.revision()

  // Real hash: 64-hex (SHA-256 of the merkle roots) and different from before.
  assert.match(rev1, /^[0-9a-f]{64}$/, 'revision should be 64-char hex content hash')
  assert.notEqual(rev1, rev0, 'revision must change when content is committed')

  // Deterministic/stable for the same state.
  const rev1again = await A.revision()
  assert.equal(rev1again, rev1, 'revision must be stable for an unchanged state')
})

// Regression: the revision must be byte-identical across MANY reads of an
// unchanged state, even with a linearization update() between each read (what
// the /revision route does). The prior base.hash() revision drifted here as
// Autobase's indexer/acker flushed the view core, so two consecutive reads
// could differ; the resolved-state digest is a pure function of the folded link
// set and must not move.
test('revision is byte-identical across many reads of unchanged state', async (t) => {
  const root = tmpDir()
  const { A, B, streams } = await twoWriters(root)
  t.after(async () => { streams.a.destroy(); streams.b.destroy(); await A.close(); await B.close(); fs.rmSync(root, { recursive: true, force: true }) })

  const l1 = link('stable://1', 'v://1')
  const l2 = link('stable://2', 'v://2')
  await A.appendAdd(hashLinkExpression(l1), l1)
  await B.appendAdd(hashLinkExpression(l2), l2)
  await settleBoth(A, B)

  const reads = []
  for (let i = 0; i < 30; i++) {
    await A.update()
    reads.push(await A.revision())
  }
  const distinct = new Set(reads)
  assert.equal(distinct.size, 1,
    `revision must be identical across reads; saw ${distinct.size} distinct: ${[...distinct].join(', ')}`)
  assert.match(reads[0], /^[0-9a-f]{64}$/)

  // Converged replicas compute the identical revision.
  await B.update()
  assert.equal(await B.revision(), reads[0], 'converged replicas compute identical revision')
})

// ---------------------------------------------------------------------------
// §5.2 — the op-log (DAG) is authoritative: folding it reproduces the link set
// ---------------------------------------------------------------------------

test('folding the linearized op-log from genesis reproduces the link set', async (t) => {
  const root = tmpDir()
  const { A, B, streams } = await twoWriters(root)
  t.after(async () => { streams.a.destroy(); streams.b.destroy(); await A.close(); await B.close(); fs.rmSync(root, { recursive: true, force: true }) })

  const l1 = link('src://1', 'tgt://1')
  const l2 = link('src://2', 'tgt://2')
  const l3 = link('src://3', 'tgt://3')
  await A.appendAdd(hashLinkExpression(l1), l1)
  await A.appendAdd(hashLinkExpression(l2), l2)
  await B.appendAdd(hashLinkExpression(l3), l3)
  await settleBoth(A, B)
  await A.appendRemove(hashLinkExpression(l2), l2)
  await settleBoth(A, B)

  // The materialised link set (Role B).
  const materialised = await foldedLinkSet(A)

  // Independently fold the raw op-log (Role A) from genesis.
  const ops = (await A.oplog()).map((e) => e.op)
  const refolded = foldOplog(ops).map((x) => x.link)

  assert.equal(linkSetKey(materialised), linkSetKey(refolded),
    'materialised link set must equal a fresh fold of the authoritative op-log')

  // And the expected set: {l1, l3} (l2 removed).
  assert.equal(linkSetKey(materialised), linkSetKey([l1, l3]))
})

// ---------------------------------------------------------------------------
// §5.3 — removal convergence across two writers
// ---------------------------------------------------------------------------

test('removal converges: A adds L, B removes L (by hash) → L absent on both', async (t) => {
  const root = tmpDir()
  const { A, B, streams } = await twoWriters(root)
  t.after(async () => { streams.a.destroy(); streams.b.destroy(); await A.close(); await B.close(); fs.rmSync(root, { recursive: true, force: true }) })

  const L = link('remove://me', 'target://x')
  const h = hashLinkExpression(L)

  // A adds L.
  await A.appendAdd(h, L)
  await settleBoth(A, B)
  assert.equal((await foldedLinkSet(B)).length, 1, 'B should observe the add')

  // B removes L by the ORIGINAL hash it observed.
  await B.appendRemove(h, L)
  await settleBoth(A, B)

  const onA = await foldedLinkSet(A)
  const onB = await foldedLinkSet(B)
  assert.equal(onA.length, 0, 'L must be absent on A after B removes it')
  assert.equal(onB.length, 0, 'L must be absent on B after B removes it')
  assert.equal(linkSetKey(onA), linkSetKey(onB), 'A and B converge to the same (empty) set')
})

test('concurrent add on A + remove-of-different on B both apply deterministically', async (t) => {
  const root = tmpDir()
  const { A, B, streams } = await twoWriters(root)
  t.after(async () => { streams.a.destroy(); streams.b.destroy(); await A.close(); await B.close(); fs.rmSync(root, { recursive: true, force: true }) })

  const seed = link('seed://1', 'seed://t')
  await A.appendAdd(hashLinkExpression(seed), seed)
  await settleBoth(A, B)

  // Concurrently: A adds L1, B removes the seed.
  const l1 = link('conc://1', 'conc://t')
  await A.appendAdd(hashLinkExpression(l1), l1)
  await B.appendRemove(hashLinkExpression(seed), seed)
  await settleBoth(A, B)

  const onA = await foldedLinkSet(A)
  const onB = await foldedLinkSet(B)
  assert.equal(linkSetKey(onA), linkSetKey(onB), 'A and B converge')
  assert.equal(linkSetKey(onA), linkSetKey([l1]), 'result is {l1}: seed removed, l1 added')
})

// ---------------------------------------------------------------------------
// §5.4 — merge is order-independent (revision hash equal regardless of order)
// ---------------------------------------------------------------------------

test('two writers converge to identical revision hash regardless of order', async (t) => {
  const root = tmpDir()
  const { A, B, streams } = await twoWriters(root)
  t.after(async () => { streams.a.destroy(); streams.b.destroy(); await A.close(); await B.close(); fs.rmSync(root, { recursive: true, force: true }) })

  const l1 = link('order://1', 'order://t1')
  const l2 = link('order://2', 'order://t2')
  const l3 = link('order://3', 'order://t3')

  // Interleave writes across both writers in a nontrivial order.
  await A.appendAdd(hashLinkExpression(l1), l1)
  await B.appendAdd(hashLinkExpression(l2), l2)
  await settleBoth(A, B)
  await B.appendAdd(hashLinkExpression(l3), l3)
  await A.appendRemove(hashLinkExpression(l2), l2)
  await settleBoth(A, B, 80)

  const revA = await A.revision()
  const revB = await B.revision()

  assert.match(revA, /^[0-9a-f]{64}$/)
  assert.equal(revA, revB, 'converged replicas must have identical revision hashes')

  // And identical folded link sets: {l1, l3}.
  assert.equal(linkSetKey(await foldedLinkSet(A)), linkSetKey(await foldedLinkSet(B)))
  assert.equal(linkSetKey(await foldedLinkSet(A)), linkSetKey([l1, l3]))
})

// ---------------------------------------------------------------------------
// Multi-writer authority: B can only write after being authorised
// ---------------------------------------------------------------------------

test('a second agent becomes a writer via addWriter and its ops linearize', async (t) => {
  const root = tmpDir()
  const A = new AutobaseNode(path.join(root, 'A'), null)
  await A.ready()
  const B = new AutobaseNode(path.join(root, 'B'), A.key())
  await B.ready()
  const streams = A.replicateWith(B)
  t.after(async () => { streams.a.destroy(); streams.b.destroy(); await A.close(); await B.close(); fs.rmSync(root, { recursive: true, force: true }) })

  assert.equal(B.writable(), false, 'B is not writable before authorisation')

  await A.addWriter(B.localWriterKey())
  await settleBoth(A, B)
  assert.equal(B.writable(), true, 'B becomes writable after A authorises its feed')

  const lb = link('fromB://1', 'fromB://t', { author: 'did:key:z6MkB' })
  await B.appendAdd(hashLinkExpression(lb), lb)
  await settleBoth(A, B)

  // A sees B's write — proving genuine multi-writer linearization.
  assert.equal(linkSetKey(await foldedLinkSet(A)), linkSetKey([lb]))
})
