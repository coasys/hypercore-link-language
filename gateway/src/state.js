/**
 * Gateway state — owns the set of live Autobase nodes, one per neighbourhood.
 *
 * A neighbourhood is identified by its Autobase key (hex). Creating a base
 * returns a fresh key; joining an existing one bootstraps from a known key.
 * Each base gets its own Corestore under a per-base storage directory so
 * multiple neighbourhoods coexist in one gateway process.
 */

import path from 'path'
import fs from 'fs'
import { AutobaseNode } from './autobase-node.js'

export class GatewayState {
  /**
   * @param {string} storageRoot  Root dir under which per-base Corestores live.
   */
  constructor (storageRoot) {
    this.storageRoot = storageRoot
    /** @type {Map<string, AutobaseNode>} key(hex) → node */
    this.bases = new Map()
    /** @type {Map<string, Promise<AutobaseNode>>} de-dupe concurrent opens */
    this.opening = new Map()
    fs.mkdirSync(storageRoot, { recursive: true })
  }

  /**
   * Create a brand-new Autobase (new neighbourhood). Storage dir is temporary
   * until we learn the real key, then indexed by key.
   * @returns {Promise<AutobaseNode>}
   */
  async createBase () {
    // Use a random subdir; the base's own key becomes the map handle.
    const tmpName = 'new-' + Math.random().toString(36).slice(2, 12)
    const dir = path.join(this.storageRoot, tmpName)
    const node = new AutobaseNode(dir, null)
    await node.ready()
    this.bases.set(node.key(), node)
    return node
  }

  /**
   * Open (join) an existing Autobase by key, or return the already-open node.
   * @param {string} keyHex
   * @returns {Promise<AutobaseNode>}
   */
  async openBase (keyHex) {
    const existing = this.bases.get(keyHex)
    if (existing) return existing

    const inFlight = this.opening.get(keyHex)
    if (inFlight) return inFlight

    const promise = (async () => {
      const dir = path.join(this.storageRoot, 'base-' + keyHex.slice(0, 32))
      const node = new AutobaseNode(dir, keyHex)
      await node.ready()
      this.bases.set(keyHex, node)
      this.opening.delete(keyHex)
      return node
    })()

    this.opening.set(keyHex, promise)
    return promise
  }

  /**
   * Get a live node by key, or null.
   * @param {string} keyHex
   * @returns {AutobaseNode | null}
   */
  get (keyHex) {
    return this.bases.get(keyHex) || null
  }

  /** Number of live bases. */
  size () {
    return this.bases.size
  }

  async closeAll () {
    for (const node of this.bases.values()) {
      await node.close()
    }
    this.bases.clear()
  }
}
