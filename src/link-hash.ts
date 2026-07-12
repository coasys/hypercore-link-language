/**
 * OR-Set link hash — the content-addressed identity of a LinkExpression, used
 * as the merge key in the Autobase gateway's OR-Set.
 *
 * The gateway keys every add/remove op by this hash. A removal carries the
 * ORIGINAL link's hash so it converges against the exact add across replicas
 * (spec §2.4, first-class observed-remove). Every agent computes this the same
 * way — via AD4M's own content-address hash injected through the runtime — so
 * the key is identical network-wide, and the gateway uses the value verbatim.
 *
 * Uses injected interfaces — no ad4m:host imports.
 */

import { getRuntime } from "./adapters.js";
import type { LinkExpression } from "./types.js";

/**
 * Canonical content of a LinkExpression for hashing. Fixed field order; author,
 * timestamp and signature are included so two agents asserting the same triple
 * produce distinct, independently-removable OR-Set elements (correct add
 * identity). Keep in exact lockstep with the gateway's canonical form.
 */
export function orSetLinkContent(link: LinkExpression): string {
    const data = link.data || ({} as LinkExpression["data"]);
    const proof = link.proof || ({} as LinkExpression["proof"]);
    return JSON.stringify([
        data.source == null ? null : String(data.source),
        data.predicate == null ? null : String(data.predicate),
        data.target == null ? null : String(data.target),
        link.author == null ? null : String(link.author),
        link.timestamp == null ? null : String(link.timestamp),
        proof.signature == null ? null : String(proof.signature),
    ]);
}

/**
 * The OR-Set key for a link: AD4M's content-address hash of the canonical
 * content. Sent to the gateway as the op key; the gateway trusts it verbatim so
 * all agents share one keyspace.
 */
export function orSetLinkHash(
    link: LinkExpression,
    hashFn?: (data: string) => string,
): string {
    const fn = hashFn ?? getRuntime().hash;
    return fn(orSetLinkContent(link));
}
