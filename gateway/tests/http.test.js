/**
 * HTTP-level integration test for the gateway server + REST contract.
 *
 * Drives the real http.Server (on an ephemeral port) through the exact endpoints
 * the language's GatewayClient calls, proving the wire contract works
 * end-to-end: create base → commit add → revision is a content hash → links
 * reflect the add → diff returns the op → commit remove → link gone.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { GatewayState } from '../src/state.js'
import { createServer } from '../src/server.js'

function link (source, target) {
  return {
    author: 'did:key:z6MkHttp',
    timestamp: '2026-07-12T00:00:00.000Z',
    data: { source, target, predicate: 'sioc://content_of' },
    proof: { signature: 'sig-' + source, key: 'k' }
  }
}

async function start () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-gw-http-'))
  const state = new GatewayState(root)
  const server = createServer(state)
  await new Promise((r) => server.listen(0, r))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const stop = async () => {
    await new Promise((r) => server.close(r))
    await state.closeAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
  return { base, stop }
}

async function req (base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

test('HTTP: full commit / revision / links / diff / remove round-trip', async (t) => {
  const { base, stop } = await start()
  t.after(stop)

  // health
  const health = await req(base, 'GET', '/health')
  assert.equal(health.status, 200)
  assert.equal(health.body.status, 'ok')

  // create a fresh base
  const created = await req(base, 'POST', '/bases', {})
  assert.equal(created.status, 200)
  const key = created.body.key
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.equal(created.body.writable, true, 'creator is writable')

  // revision of empty base is "" (no fake seq)
  const rev0 = await req(base, 'GET', `/bases/${key}/revision`)
  assert.equal(rev0.status, 200)
  assert.ok(!/^\d+$/.test(rev0.body.revision), 'revision is never a bare integer')

  // commit an add
  const l1 = link('http://1', 'http://t1')
  const commit1 = await req(base, 'POST', `/bases/${key}/commit`, { additions: [l1], removals: [] })
  assert.equal(commit1.status, 200)
  assert.match(commit1.body.revision, /^[0-9a-f]{64}$/, 'commit returns a real content-hash revision')

  // links reflect the add
  const links1 = await req(base, 'GET', `/bases/${key}/links`)
  assert.equal(links1.body.links.length, 1)
  assert.equal(links1.body.links[0].data.source, 'http://1')

  // diff since -1 returns the op as an addition
  const diff = await req(base, 'GET', `/bases/${key}/diff?since=-1`)
  assert.equal(diff.body.additions.length, 1)
  assert.equal(diff.body.removals.length, 0)

  // commit a remove of the same link → gone
  const commit2 = await req(base, 'POST', `/bases/${key}/commit`, { additions: [], removals: [l1] })
  assert.equal(commit2.status, 200)
  assert.notEqual(commit2.body.revision, commit1.body.revision, 'revision advances on removal')

  const links2 = await req(base, 'GET', `/bases/${key}/links`)
  assert.equal(links2.body.links.length, 0, 'link removed')

  // reopening the same key returns the same base identity
  const reopened = await req(base, 'POST', '/bases', { key })
  assert.equal(reopened.body.key, key)
})
