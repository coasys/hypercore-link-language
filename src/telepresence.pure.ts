/**
 * Pure functions for telepresence — signal construction, status parsing,
 * peer list filtering, inbox handling.
 *
 * Zero runtime deps. No ad4m:host imports.
 */

import type { DID } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Online status payload sent to the gateway. */
export interface OnlineStatusPayload {
    did: DID;
    status: unknown;
    feedKey: string;
}

/** Peer info returned from the gateway. */
export interface PeerInfo {
    did: DID;
    status: unknown;
    feedKey?: string;
    lastSeen?: string;
}

/** Directed signal payload sent to a specific peer. */
export interface SignalPayload {
    from: DID;
    to: DID;
    payload: unknown;
}

/** Broadcast payload sent to all peers. */
export interface BroadcastPayload {
    from: DID;
    payload: unknown;
}

/** Inbox message received from a peer. */
export interface InboxMessage {
    from: DID;
    payload: unknown;
    timestamp: string;
}

/** Result of sending a signal or broadcast. */
export interface SendResult {
    status: string;
    recipients?: number;
}

// ---------------------------------------------------------------------------
// Status construction
// ---------------------------------------------------------------------------

/**
 * Build the request body for setting online status.
 */
export function buildStatusPayload(
    did: DID,
    status: unknown,
    feedKey: string,
): OnlineStatusPayload {
    return { did, status, feedKey };
}

// ---------------------------------------------------------------------------
// Signal construction
// ---------------------------------------------------------------------------

/**
 * Build the request body for sending a directed signal.
 */
export function buildSignalPayload(
    fromDid: DID,
    toDid: DID,
    payload: unknown,
): SignalPayload {
    return { from: fromDid, to: toDid, payload };
}

/**
 * Build the request body for sending a broadcast.
 */
export function buildBroadcastPayload(
    fromDid: DID,
    payload: unknown,
): BroadcastPayload {
    return { from: fromDid, payload };
}

// ---------------------------------------------------------------------------
// Peer list filtering
// ---------------------------------------------------------------------------

/**
 * Parse a raw peer list response from the gateway.
 * Gracefully handles malformed data by filtering invalid entries.
 */
export function parsePeerList(raw: unknown): PeerInfo[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isPeerInfo);
}

/**
 * Type guard for PeerInfo.
 */
function isPeerInfo(val: unknown): val is PeerInfo {
    if (typeof val !== "object" || val === null) return false;
    const obj = val as Record<string, unknown>;
    return typeof obj.did === "string" && obj.did.length > 0;
}

/**
 * Filter peers to exclude a specific DID (typically self).
 */
export function filterSelfFromPeers(peers: PeerInfo[], selfDid: DID): PeerInfo[] {
    return peers.filter(p => p.did !== selfDid);
}

/**
 * Convert PeerInfo list to the agent object format expected by getOnlineAgents.
 */
export function peersToAgentList(peers: PeerInfo[]): unknown[] {
    return peers.map(p => ({
        did: p.did,
        status: p.status,
    }));
}

// ---------------------------------------------------------------------------
// Inbox parsing
// ---------------------------------------------------------------------------

/**
 * Parse inbox messages from a raw gateway response.
 */
export function parseInboxMessages(raw: unknown): InboxMessage[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isInboxMessage);
}

/**
 * Type guard for InboxMessage.
 */
function isInboxMessage(val: unknown): val is InboxMessage {
    if (typeof val !== "object" || val === null) return false;
    const obj = val as Record<string, unknown>;
    return typeof obj.from === "string" && typeof obj.timestamp === "string";
}

// ---------------------------------------------------------------------------
// Gateway endpoint paths
// ---------------------------------------------------------------------------

export const TELEPRESENCE_PATHS = {
    status: "/telepresence/status",
    peers: "/telepresence/peers",
    signal: "/telepresence/signal",
    broadcast: "/telepresence/broadcast",
    inbox: "/telepresence/inbox",
} as const;
