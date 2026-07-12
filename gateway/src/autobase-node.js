/**
 * Autobase node — the native multi-writer merge authority.
 *
 * Each AD4M neighbourhood maps to one Autobase. Every agent writes AD4M link
 * diffs as operations to its OWN local input feed; Autobase deterministically
 * linearizes all writers' feeds into a single ordered op-log. The linearized
 * log is the authoritative source of truth (Role A, the convergence substrate).
 *
 * The `apply` handler folds the linearized ops into a Hyperbee view holding two
 * separate keyspaces that embody the spec's two roles:
 *
 *   Role A — the AUTHORITATIVE op-log:  oplog/<paddedSeq> = the raw op, appended
 *     in linearization order. This is the source of truth. Folding oplog/* from
 *     genesis reproduces the link set exactly (see foldOplog).
 *
 *   Role B — a DERIVED OR-Set projection keyed by link hash:
 *     link/<hash> = { link, tombstone } — the materialised link set, produced by
 *     folding Role A. Never read back as truth; always derivable.
 *
 * Ops:
 *   - add(hash, link)   → oplog append + link/<hash> = { link, tombstone:false }
 *   - remove(hash)      → oplog append + link/<hash> = { tombstone:true } —
 *                         observed-remove carrying the ORIGINAL link hash, so it
 *                         converges against the exact add across replicas.
 *   - addWriter(key)    → host.addWriter(key): a control op that authorises a
 *                         new agent's input feed into the linearization.
 *
 * `revision()` returns `await base.hash()` — the Merkle tree hash of Autobase's
 * linearized system core. This is a real content hash of the DAG head(s):
 * deterministic for a given linearized state and order-independent across
 * replication orders. It is NOT a sequence number.
 */

import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'

// ---------------------------------------------------------------------------
// Operation model
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AddOp    { type:'add', hash, link }
 * @typedef {Object} RemoveOp { type:'remove', hash, link? }
 * @typedef {Object} WriterOp { type:'addWriter', key }  // key: hex writer key
 */

const OP_ADD = 'add'
const OP_REMOVE = 'remove'
const OP_ADD_WRITER = 'addWriter'
const VIEW_PREFIX = 'link/'
const OPLOG_PREFIX = 'oplog/'
const OPLOG_SEQ_KEY = 'meta/oplog-seq'
const SEQ_PAD = 16 // zero-padded so lexicographic order == numeric order

// ---------------------------------------------------------------------------
// AutobaseNode
// ---------------------------------------------------------------------------

export class AutobaseNode {
  /**
   * @param {string} storageDir  Directory for this base's Corestore (on disk).
   * @param {string|null} bootstrap  Existing base key (hex) to join, or null to create.
   */
  constructor (storageDir, bootstrap = null) {
    this.storageDir = storageDir
    this.bootstrap = bootstrap
    this.store = new Corestore(storageDir)
    this.base = null
    this.swarm = null
    this._discoveryTopic = null
  }

  async ready () {
    const bootKey = this.bootstrap ? b4a.from(this.bootstrap, 'hex') : null

    this.base = new Autobase(this.store, bootKey, {
      valueEncoding: 'json',
      // Auto-ack quickly so multi-writer linearization progresses without an
      // external clock. In-process convergence relies on this.
      ackInterval: 10,
      open: (store) => {
        const core = store.get('view', { valueEncoding: 'json' })
        return new Hyperbee(core, {
          keyEncoding: 'utf-8',
          valueEncoding: 'json',
          extension: false
        })
      },
      apply: applyOps
    })

    await this.base.ready()
    return this
  }

  /** Hex-encoded Autobase key (the neighbourhood's stable identifier). */
  key () {
    return b4a.toString(this.base.key, 'hex')
  }

  /** Hex-encoded discovery key (Hyperswarm topic). */
  discoveryKey () {
    return b4a.toString(this.base.discoveryKey, 'hex')
  }

  /** Hex-encoded local input-feed writer key for THIS agent. */
  localWriterKey () {
    return b4a.toString(this.base.local.key, 'hex')
  }

  writable () {
    return this.base.writable
  }

  /**
   * The AD4M `currentRevision`: a real content hash of the linearized DAG head.
   *
   * `base.hash()` = Merkle tree hash of Autobase's linearized system core.
   * Deterministic for a given linearized state, identical across replicas that
   * have converged, and stable across restarts for the same state. Returns null
   * only before the system core has any indexed length (empty base) — callers
   * treat null as the empty-state revision "".
   *
   * @returns {Promise<string>} hex content hash, or "" for the empty base.
   */
  async revision () {
    const h = await this.base.hash()
    return h ? b4a.toString(h, 'hex') : ''
  }

  /**
   * Version-vector digest: the linearized system's head nodes as
   * (writerKey, length) pairs, sorted. A deterministic secondary descriptor of
   * the multi-writer head set (spec §2: "hash of the set of per-writer heads").
   *
   * @returns {Promise<Array<{ key: string, length: number }>>}
   */
  async heads () {
    try {
      const info = await this.base.getIndexedInfo()
      const heads = (info && info.heads) || []
      return heads
        .map((h) => ({ key: b4a.toString(h.key, 'hex'), length: h.length }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.length - b.length))
    } catch {
      return []
    }
  }

  /** Pull the latest linearized state before reading. */
  async update () {
    await this.base.update()
  }

  /**
   * Join Hyperswarm on this base's discovery key and replicate with every peer.
   * This is the real P2P transport that carries other agents' input feeds to us
   * (and ours to them), so Autobase can linearize across machines. Idempotent.
   *
   * @param {string[]} [bootstrap]  optional DHT bootstrap nodes
   */
  async joinSwarm (bootstrap) {
    if (this.swarm) return
    const swarmOpts = {}
    if (Array.isArray(bootstrap) && bootstrap.length > 0) {
      swarmOpts.bootstrap = bootstrap
    }
    this.swarm = new Hyperswarm(swarmOpts)
    this.swarm.on('connection', (conn) => {
      // Wire each peer connection into the base's replication protocol.
      this.base.replicate(conn)
    })
    this._discoveryTopic = this.base.discoveryKey
    const discovery = this.swarm.join(this._discoveryTopic, { server: true, client: true })
    await discovery.flushed()
  }

  /** Leave Hyperswarm and stop replicating with remote peers. */
  async leaveSwarm () {
    if (!this.swarm) return
    try { await this.swarm.destroy() } catch { /* ignore */ }
    this.swarm = null
    this._discoveryTopic = null
  }

  /**
   * Directly replicate this base with another in-process (stream pipe, no DHT).
   * Used for deterministic multi-writer convergence tests: the exact same
   * replication Autobase uses over Hyperswarm, minus the network. Returns the
   * two protocol streams so callers can tear them down.
   *
   * @param {AutobaseNode} other
   * @returns {{ a: import('stream').Duplex, b: import('stream').Duplex }}
   */
  replicateWith (other) {
    const a = this.base.replicate(true)
    const b = other.base.replicate(false)
    a.on('error', () => {})
    b.on('error', () => {})
    a.pipe(b).pipe(a)
    return { a, b }
  }

  /** Whether this base is currently joined to Hyperswarm. */
  replicating () {
    return this.swarm !== null
  }

  /** Number of currently connected Hyperswarm peers. */
  peerCount () {
    return this.swarm ? this.swarm.connections.size : 0
  }

  /**
   * Append an add-link op to this agent's local feed.
   * @param {string} hash content hash of the link
   * @param {unknown} link the LinkExpression (round-tripped verbatim)
   */
  async appendAdd (hash, link) {
    await this.base.append({ type: OP_ADD, hash, link })
  }

  /**
   * Append an observed-remove op carrying the ORIGINAL link hash.
   * @param {string} hash content hash of the link being removed
   * @param {unknown} [link] optional original link (for provenance)
   */
  async appendRemove (hash, link) {
    await this.base.append({ type: OP_REMOVE, hash, link })
  }

  /**
   * Authorise another agent's input feed into the linearization.
   * @param {string} writerKeyHex hex writer key
   */
  async addWriter (writerKeyHex) {
    await this.base.append({ type: OP_ADD_WRITER, key: writerKeyHex })
  }

  /**
   * The materialised link set, produced by folding the authoritative op-log.
   *
   * Role B (derived projection). We read the Role-A op-log and fold it here
   * rather than trusting the cached link/* keyspace, so `links()` is provably a
   * function of the op-log. (The cached link/* keyspace is maintained purely as
   * an incremental convenience and is asserted equal to this fold by test.)
   *
   * @returns {Promise<Array<{ hash: string, link: unknown }>>}
   */
  async links () {
    const ops = await this.oplog()
    return foldOplog(ops.map((e) => e.op))
  }

  /**
   * Read the FULL authoritative linearized op-log (Role A). These are the raw
   * ops in deterministic linearization order — the source of truth. Folding
   * them from genesis reproduces the link set (see foldOplog). Used by /diff for
   * the sync callback and by the fold-reproduces-linkset acceptance test.
   *
   * @returns {Promise<Array<{ seq: number, op: unknown }>>}
   */
  async oplog () {
    await this.base.update()
    const ops = []
    for await (const { key, value } of this.base.view.createReadStream({
      gte: OPLOG_PREFIX,
      lt: OPLOG_PREFIX + '￿'
    })) {
      if (typeof key !== 'string' || !key.startsWith(OPLOG_PREFIX)) continue
      const seq = parseInt(key.slice(OPLOG_PREFIX.length), 10)
      ops.push({ seq, op: value })
    }
    ops.sort((a, b) => a.seq - b.seq)
    return ops
  }

  /**
   * Ops with linearized sequence strictly greater than `sinceSeq`. Powers the
   * incremental sync callback: the language folds these into a PerspectiveDiff.
   *
   * @param {number} sinceSeq
   * @returns {Promise<Array<{ seq: number, op: unknown }>>}
   */
  async opsSince (sinceSeq) {
    const ops = await this.oplog()
    return ops.filter((e) => e.seq > sinceSeq)
  }

  async close () {
    if (this.swarm) {
      try { await this.swarm.destroy() } catch { /* ignore */ }
      this.swarm = null
    }
    if (this.base) {
      try { await this.base.close() } catch { /* ignore */ }
    }
    try { await this.store.close() } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// apply — the deterministic linearization fold (OR-Set over link hashes)
// ---------------------------------------------------------------------------

/**
 * Autobase apply handler. Runs deterministically over the linearized nodes on
 * every writer, so all replicas that see the same ops produce byte-identical
 * views (hence identical `base.hash()`).
 *
 * @param {Array<{ value: unknown, from: unknown }>} nodes
 * @param {Hyperbee} view
 * @param {{ addWriter(key: Buffer, opts?: object): Promise<void> }} host
 */
async function applyOps (nodes, view, host) {
  // Deterministic monotonic op-log sequence, persisted in the view meta. Read
  // once, increment locally, write back — apply runs in linearization order on
  // every replica, so the same op lands at the same seq everywhere.
  let seqNode = await view.get(OPLOG_SEQ_KEY)
  let nextSeq = seqNode && typeof seqNode.value === 'number' ? seqNode.value : 0

  for (const node of nodes) {
    const op = node.value
    if (!op || typeof op !== 'object') continue

    if (op.type === OP_ADD_WRITER && typeof op.key === 'string') {
      // Authorise a new agent's input feed as an indexer, so its ops join the
      // linearization and count toward acks. Not a link op — not logged.
      await host.addWriter(b4a.from(op.key, 'hex'), { indexer: true })
      continue
    }

    if (op.type === OP_ADD && typeof op.hash === 'string') {
      // Role A: append the raw op to the authoritative linearized log.
      await view.put(seqKey(nextSeq), { type: OP_ADD, hash: op.hash, link: op.link })
      nextSeq++
      // Role B: OR-Set add — insert the link keyed by its content hash. Re-adding
      // identical immutable content after a tombstone resurrects it.
      await view.put(VIEW_PREFIX + op.hash, { link: op.link, tombstone: false })
      continue
    }

    if (op.type === OP_REMOVE && typeof op.hash === 'string') {
      // Role A: append the raw observed-remove op (carries the original hash).
      await view.put(seqKey(nextSeq), { type: OP_REMOVE, hash: op.hash, link: op.link })
      nextSeq++
      // Role B: observed-remove — tombstone the SPECIFIC observed hash. Because
      // it references the exact content hash of the add, it converges against
      // that add regardless of replication order.
      await view.put(VIEW_PREFIX + op.hash, { tombstone: true, link: op.link })
      continue
    }
  }

  await view.put(OPLOG_SEQ_KEY, nextSeq)
}

/** Zero-padded op-log key so lexicographic order matches numeric order. */
function seqKey (seq) {
  return OPLOG_PREFIX + String(seq).padStart(SEQ_PAD, '0')
}

/**
 * Fold a linearized op sequence (Role A) into the materialised link set
 * (Role B). Pure OR-Set semantics: add inserts by hash; observed-remove deletes
 * the specific hash. This is the canonical derivation — the acceptance test
 * asserts folding the op-log reproduces the cached link set.
 *
 * @param {Array<unknown>} ops
 * @returns {Array<{ hash: string, link: unknown }>}
 */
function foldOplog (ops) {
  const live = new Map()
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue
    if (op.type === OP_ADD && typeof op.hash === 'string') {
      live.set(op.hash, op.link)
    } else if (op.type === OP_REMOVE && typeof op.hash === 'string') {
      live.delete(op.hash)
    }
  }
  return [...live.entries()].map(([hash, link]) => ({ hash, link }))
}

export {
  applyOps,
  foldOplog,
  OP_ADD,
  OP_REMOVE,
  OP_ADD_WRITER,
  VIEW_PREFIX,
  OPLOG_PREFIX
}
