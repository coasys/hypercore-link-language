/**
 * Canonical link-hash — the OR-Set key for a LinkExpression.
 *
 * This MUST be byte-for-byte identical to the language's `orSetLinkHash`
 * (src/link-hash.ts) so that an observed-remove emitted by one agent references
 * the exact same key as the original add emitted by another agent — that
 * identity is what makes removals converge across replicas.
 *
 * Scheme: SHA-256 (hex) over the canonical JSON of the link's identifying
 * fields, in a fixed key order. Author + timestamp + signature are included so
 * the hash pins the exact expression (two agents asserting the same triple
 * produce distinct, independently-removable elements — proper OR-Set add
 * identity).
 */

import { createHash } from 'crypto'

/**
 * @param {any} link  a LinkExpression: { author, timestamp, data:{source,predicate,target}, proof:{signature} }
 * @returns {string} lowercase hex SHA-256
 */
export function hashLinkExpression (link) {
  const data = (link && link.data) || {}
  const proof = (link && link.proof) || {}
  const canonical = JSON.stringify([
    data.source == null ? null : String(data.source),
    data.predicate == null ? null : String(data.predicate),
    data.target == null ? null : String(data.target),
    link && link.author == null ? null : String(link.author),
    link && link.timestamp == null ? null : String(link.timestamp),
    proof.signature == null ? null : String(proof.signature)
  ])
  return createHash('sha256').update(canonical).digest('hex')
}
