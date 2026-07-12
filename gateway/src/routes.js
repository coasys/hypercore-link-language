/**
 * REST handlers for the Hypercore Autobase gateway.
 *
 * Contract consumed by the hypercore AD4M Link Language's GatewayClient:
 *
 * | Method | Path                        | Body / Query              | Response                                  |
 * |--------|-----------------------------|---------------------------|-------------------------------------------|
 * | GET    | /health                     | —                         | { status, bases }                         |
 * | POST   | /bases                      | { neighbourhood? | key? } | { key, discoveryKey, localWriterKey, writable } |
 * | GET    | /bases/:key                 | —                         | { key, discoveryKey, localWriterKey, writable, replicating, peers } |
 * | GET    | /bases/:key/revision        | —                         | { revision, heads }                       |
 * | GET    | /bases/:key/links           | —                         | { links: LinkExpression[] }               |
 * | GET    | /bases/:key/oplog           | —                         | { ops: { seq, op }[] }                     |
 * | GET    | /bases/:key/diff?since=<n>  | since = linearized seq    | { revision, additions, removals, seq }    |
 * | POST   | /bases/:key/commit          | { additions, removals }   | { revision, seq }                         |
 * | POST   | /bases/:key/writers         | { writerKey }             | { ok, writable }                          |
 * | POST   | /bases/:key/replicate       | { bootstrap? }            | { status, discoveryKey, peers }           |
 * | DELETE | /bases/:key/replicate       | —                         | { status }                                |
 *
 * A "commit" appends observed add/remove ops to THIS gateway's local input
 * feed; Autobase linearizes across all writers. The response `revision` is the
 * real Autobase content hash after read-your-writes settling.
 *
 * Removals carry the ORIGINAL link hash (computed identically by the language
 * and gateway from the LinkExpression), so an observed-remove converges against
 * the exact add across replicas.
 */

import { hashLinkExpression } from './link-hash.js'
import { foldOplog } from './autobase-node.js'

/**
 * Accept either a bare LinkExpression or a { link, hash } wrapper. When the
 * caller supplies an explicit content hash (the language does, using AD4M's own
 * hash), use it verbatim as the OR-Set key so all agents agree; otherwise fall
 * back to the gateway's canonical link hash.
 * @param {any} entry
 * @returns {{ link: any, hash: string }}
 */
function normaliseEntry (entry) {
  if (entry && typeof entry === 'object' && 'link' in entry && 'hash' in entry &&
      typeof entry.hash === 'string' && entry.hash.length > 0) {
    return { link: entry.link, hash: entry.hash }
  }
  // Bare LinkExpression.
  return { link: entry, hash: hashLinkExpression(entry) }
}

function json (res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function err (res, status, message) {
  json(res, status, { error: message })
}

/**
 * Read-your-writes: wait until the just-committed ops are observable in the
 * resolved fold — every appended add present, every appended remove absent.
 *
 * This is defined over the observable link set (exactly what `revision()`
 * hashes), NOT a jittery view-core hash, so it settles precisely when the ops
 * linearize and the revision it returns is immediately stable across every
 * subsequent read. Called with no expected hashes (e.g. after addWriter) it
 * returns as soon as one linearization pass completes.
 */
async function settle (node, adds = [], removes = [], deadlineMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    await node.update()
    const live = new Set((await node.links()).map((e) => e.hash))
    if (adds.every((h) => live.has(h)) && removes.every((h) => !live.has(h))) {
      return node.revision()
    }
    await new Promise((r) => setTimeout(r, 15))
  }
  return node.revision()
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function health (state) {
  return async (_req, res) => {
    json(res, 200, { status: 'ok', bases: state.size() })
  }
}

export function createBase (state) {
  return async (req, res, _params, body) => {
    try {
      let node
      if (body && typeof body.neighbourhood === 'string' && body.neighbourhood.length > 0) {
        // Co-located rendezvous: resolve a neighbourhood handle to one shared
        // writable base (create-once). See state.openNeighbourhood.
        node = await state.openNeighbourhood(body.neighbourhood)
      } else if (body && typeof body.key === 'string' && body.key.length > 0) {
        node = await state.openBase(body.key)
      } else {
        node = await state.createBase()
      }
      json(res, 200, {
        key: node.key(),
        discoveryKey: node.discoveryKey(),
        localWriterKey: node.localWriterKey(),
        writable: node.writable()
      })
    } catch (e) {
      err(res, 500, `createBase failed: ${e.message}`)
    }
  }
}

export function getBase (state) {
  return async (_req, res, params) => {
    const node = state.get(params.key)
    if (!node) return err(res, 404, 'base not found')
    json(res, 200, {
      key: node.key(),
      discoveryKey: node.discoveryKey(),
      localWriterKey: node.localWriterKey(),
      writable: node.writable(),
      replicating: node.replicating(),
      peers: node.peerCount()
    })
  }
}

export function getRevision (state) {
  return async (_req, res, params) => {
    const node = state.get(params.key)
    if (!node) return err(res, 404, 'base not found')
    await node.update()
    const revision = await node.revision()
    const heads = await node.heads()
    json(res, 200, { revision, heads })
  }
}

export function getLinks (state) {
  return async (_req, res, params) => {
    const node = state.get(params.key)
    if (!node) return err(res, 404, 'base not found')
    const links = await node.links()
    json(res, 200, { links: links.map((l) => l.link) })
  }
}

export function getOplog (state) {
  return async (_req, res, params) => {
    const node = state.get(params.key)
    if (!node) return err(res, 404, 'base not found')
    const ops = await node.oplog()
    json(res, 200, { ops })
  }
}

export function getDiff (state) {
  return async (_req, res, params, _body, query) => {
    const node = state.get(params.key)
    if (!node) return err(res, 404, 'base not found')
    const sinceSeq = parseInt(query.get('since') || '-1', 10)
    const since = Number.isFinite(sinceSeq) ? sinceSeq : -1
    const newOps = await node.opsSince(since)

    // Present the incremental ops as a PerspectiveDiff: adds → additions,
    // removes → removals (carrying the original link).
    const additions = []
    const removals = []
    for (const { op } of newOps) {
      if (op.type === 'add' && op.link) additions.push(op.link)
      else if (op.type === 'remove' && op.link) removals.push(op.link)
    }
    const maxSeq = newOps.length > 0 ? newOps[newOps.length - 1].seq : since
    const revision = await node.revision()
    json(res, 200, { revision, additions, removals, seq: maxSeq })
  }
}

export function commit (state) {
  return async (_req, res, params, body) => {
    const node = state.get(params.key)
    if (!node) return err(res, 404, 'base not found')
    if (!node.writable()) return err(res, 409, 'base not writable yet (writer not authorised)')

    const additions = Array.isArray(body && body.additions) ? body.additions : []
    const removals = Array.isArray(body && body.removals) ? body.removals : []

    if (additions.length === 0 && removals.length === 0) {
      const revision = await node.revision()
      return json(res, 200, { revision, seq: -1 })
    }

    // Append observed add/remove ops. Each op is keyed by the link's content
    // hash. The language computes this key with AD4M's own content-address hash
    // and sends it as `.hash`; the gateway uses that verbatim so all agents
    // agree on the OR-Set key. Bare LinkExpressions (no wrapper) fall back to
    // the gateway's canonical hash. A removal thus references the EXACT hash of
    // the add, so it converges against that add across replicas.
    const addHashes = []
    const removeHashes = []
    for (const entry of additions) {
      const { link, hash } = normaliseEntry(entry)
      addHashes.push(hash)
      await node.appendAdd(hash, link)
    }
    for (const entry of removals) {
      const { link, hash } = normaliseEntry(entry)
      removeHashes.push(hash)
      await node.appendRemove(hash, link)
    }

    const revision = await settle(node, addHashes, removeHashes)
    const ops = await node.oplog()
    const maxSeq = ops.length > 0 ? ops[ops.length - 1].seq : -1
    json(res, 200, { revision, seq: maxSeq })
  }
}

export function addWriter (state) {
  return async (_req, res, params, body) => {
    const node = state.get(params.key)
    if (!node) return err(res, 404, 'base not found')
    const writerKey = body && body.writerKey
    if (typeof writerKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(writerKey)) {
      return err(res, 400, 'writerKey must be a 64-char hex string')
    }
    if (!node.writable()) return err(res, 409, 'this base cannot authorise writers (not writable)')
    await node.addWriter(writerKey)
    await settle(node)
    json(res, 200, { ok: true, writable: node.writable() })
  }
}

export function startReplicate (state) {
  return async (_req, res, params, body) => {
    const node = state.get(params.key)
    if (!node) return err(res, 404, 'base not found')
    const bootstrap = body && Array.isArray(body.bootstrap) ? body.bootstrap : undefined
    await node.joinSwarm(bootstrap)
    json(res, 200, {
      status: 'replicating',
      discoveryKey: node.discoveryKey(),
      peers: node.peerCount()
    })
  }
}

export function stopReplicate (state) {
  return async (_req, res, params) => {
    const node = state.get(params.key)
    if (!node) return err(res, 404, 'base not found')
    await node.leaveSwarm()
    json(res, 200, { status: 'stopped' })
  }
}

// Re-export fold for tests that assert DAG-fold ≡ link set.
export { foldOplog }
