/**
 * SDNA / Subject Class pattern detection.
 *
 * Detects known Subject Class patterns in LinkExpressions.
 * Used for commit filtering and potential rendering hints.
 *
 * Pure functions — no ad4m:host imports.
 */

import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectedPattern {
    type: "chat-message" | "reply" | "content" | "mention" | "reaction" | "collection" | "unknown";
    /** Expression URI to resolve for content. */
    contentUri?: string;
    /** For replies: the parent message URI. */
    parentUri?: string;
    /** For chat: the channel/conversation URI. */
    channelUri?: string;
    /** For mentions: the mentioned agent DID or URI. */
    mentionedAgent?: string;
    /** For collections: the collection URI. */
    collectionUri?: string;
}

// ---------------------------------------------------------------------------
// Well-known predicates
// ---------------------------------------------------------------------------

const CHAT_PREDICATES = new Set([
    "flux://has_message",
    "sioc://content_of",
]);

const REPLY_PREDICATES = new Set([
    "flux://has_reply",
    "sioc://reply_of",
]);

const REACTION_PREDICATES = new Set([
    "flux://has_reaction",
    "emoji://reaction",
]);

const COLLECTION_PREDICATES = new Set([
    "rdf://has_member",
    "flux://has_item",
]);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect the SDNA pattern of a link based on its predicate.
 *
 * Priority (first match wins):
 * 1. Predicate in chatPredicates → chat-message
 * 2. Reply predicates → reply
 * 3. Predicate contains "mention" → mention
 * 4. Reaction predicates → reaction
 * 5. Collection predicates → collection
 * 6. Default → unknown
 */
export function detectPattern(
    link: LinkExpression,
    chatPredicates?: string[],
): DetectedPattern {
    const predicate = link.data.predicate || "";
    const source = link.data.source || "";
    const target = link.data.target || "";

    const chatPreds = chatPredicates
        ? new Set([...CHAT_PREDICATES, ...chatPredicates])
        : CHAT_PREDICATES;

    // 1. Chat message
    if (predicate && chatPreds.has(predicate)) {
        return {
            type: "chat-message",
            contentUri: target,
            channelUri: source,
        };
    }

    // 2. Reply
    if (REPLY_PREDICATES.has(predicate)) {
        return {
            type: "reply",
            contentUri: target,
            parentUri: source,
        };
    }

    // 3. Mention
    if (predicate && predicate.toLowerCase().includes("mention")) {
        return {
            type: "mention",
            mentionedAgent: target,
        };
    }

    // 4. Reaction
    if (REACTION_PREDICATES.has(predicate)) {
        return {
            type: "reaction",
            contentUri: target,
        };
    }

    // 5. Collection
    if (COLLECTION_PREDICATES.has(predicate)) {
        return {
            type: "collection",
            collectionUri: source,
            contentUri: target,
        };
    }

    // 6. Unknown
    return { type: "unknown" };
}

/**
 * Check if a detected pattern is a social interaction pattern.
 */
export function isSocialPattern(pattern: DetectedPattern): boolean {
    return pattern.type === "chat-message" ||
        pattern.type === "reply" ||
        pattern.type === "reaction";
}
