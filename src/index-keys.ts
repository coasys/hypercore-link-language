/**
 * Hyperbee index key generation — wraps pure key functions with
 * storage adapter integration.
 *
 * Uses injected interfaces — no ad4m:host imports.
 *
 * Spec §7: Hyperbee Indexing.
 */

import type { LinkExpression } from "./types.js";
import type { IndexField } from "./index-keys.pure.js";
import {
    hashKey,
    sourceKey,
    targetKey,
    predicateKey,
    authorKey,
    timestampKey,
    sourcePrefix,
    targetPrefix,
    predicatePrefix,
    authorPrefix,
    ALL_LINKS_PREFIX,
    allIndexKeys,
    allIndexKeysForDeletion,
} from "./index-keys.pure.js";

// Re-export pure functions
export {
    hashKey,
    sourceKey,
    targetKey,
    predicateKey,
    authorKey,
    timestampKey,
    sourcePrefix,
    targetPrefix,
    predicatePrefix,
    authorPrefix,
    ALL_LINKS_PREFIX,
    allIndexKeys,
    allIndexKeysForDeletion,
} from "./index-keys.pure.js";

export type { IndexField } from "./index-keys.pure.js";

/**
 * Generate all index entries for a LinkExpression.
 *
 * @param link - The link to index
 * @param linkHash - Precomputed hash of the link
 * @param enabledFields - Which fields to index
 * @returns Array of [key, value] pairs for the storage adapter
 */
export function indexEntriesForLink(
    link: LinkExpression,
    linkHash: string,
    enabledFields: IndexField[],
): Array<[key: string, value: string]> {
    return allIndexKeys(
        linkHash,
        link.data.source || "",
        link.data.target || "",
        link.data.predicate || "",
        link.author,
        link.timestamp,
        enabledFields,
    );
}

/**
 * Generate all index keys to delete for a LinkExpression removal.
 */
export function indexKeysForDeletion(
    link: LinkExpression,
    linkHash: string,
    enabledFields: IndexField[],
): string[] {
    return allIndexKeysForDeletion(
        linkHash,
        link.data.source || "",
        link.data.target || "",
        link.data.predicate || "",
        link.author,
        link.timestamp,
        enabledFields,
    );
}
