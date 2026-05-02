/**
 * Telepresence module — gateway HTTP calls, DID mapping, inbox polling.
 *
 * Provides the TelepresenceCapability implementation for the Hypercore
 * Link Language. Communicates with the sidecar gateway's telepresence
 * endpoints for P2P presence, signalling, and broadcast.
 *
 * Gateway endpoints (require gateway support):
 *   POST   /telepresence/status     — set online status
 *   GET    /telepresence/peers      — list connected peers
 *   POST   /telepresence/signal     — send directed signal to peer
 *   POST   /telepresence/broadcast  — broadcast to all peers
 *   GET    /telepresence/inbox      — poll for incoming signals
 *
 * Gracefully handles 404 (gateway doesn't support telepresence yet)
 * by returning empty/no-op results.
 *
 * Uses injected transport — no ad4m:host imports.
 */

import type { DID } from "./types.js";
import { getTransport } from "./transport.js";
import type { TransportResponse } from "./transport.js";
import {
    buildStatusPayload,
    buildSignalPayload,
    buildBroadcastPayload,
    parsePeerList,
    peersToAgentList,
    parseInboxMessages,
    TELEPRESENCE_PATHS,
} from "./telepresence.pure.js";
import type { InboxMessage, SendResult } from "./telepresence.pure.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _gatewayBaseUrl: string = "";
let _myDid: DID = "";
let _feedKey: string = "";
let _signalCallbacks: Array<(signal: { from: DID; payload: unknown }) => void> = [];
let _lastInboxCheck: string = "";
let _initialized: boolean = false;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the telepresence module.
 * Must be called during language init() after transport is ready.
 */
export function initTelepresence(
    gatewayBaseUrl: string,
    myDid: DID,
    feedKey: string,
): void {
    _gatewayBaseUrl = gatewayBaseUrl.replace(/\/+$/, "");
    _myDid = myDid;
    _feedKey = feedKey;
    _signalCallbacks = [];
    _lastInboxCheck = "";
    _initialized = true;
}

/**
 * Check if telepresence has been initialized.
 */
export function isTelepresenceInitialized(): boolean {
    return _initialized;
}

/**
 * Reset telepresence state (for testing or teardown).
 */
export function resetTelepresence(): void {
    _gatewayBaseUrl = "";
    _myDid = "";
    _feedKey = "";
    _signalCallbacks = [];
    _lastInboxCheck = "";
    _initialized = false;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Make a request to a gateway telepresence endpoint.
 * Returns null on 404 (endpoint not supported) for graceful degradation.
 */
async function telepresenceFetch(
    method: string,
    path: string,
    body?: unknown,
): Promise<TransportResponse | null> {
    const url = `${_gatewayBaseUrl}${path}`;
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    const bodyStr = body !== undefined ? JSON.stringify(body) : "";

    try {
        const response = await getTransport().fetch(url, method, headers, bodyStr);

        // 404 = gateway doesn't support this endpoint yet — graceful degradation
        if (response.status === 404) {
            return null;
        }

        return response;
    } catch (err) {
        console.error(`[telepresence] ${method} ${path} failed:`, err);
        return null;
    }
}

/**
 * Parse JSON response body, returning null on failure.
 */
function parseResponseBody(response: TransportResponse): unknown {
    try {
        return JSON.parse(response.body);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// TelepresenceCapability implementation
// ---------------------------------------------------------------------------

/**
 * Set the agent's online status.
 * POST /telepresence/status
 */
export async function setOnlineStatus(status: unknown): Promise<void> {
    if (!_initialized) return;

    const payload = buildStatusPayload(_myDid, status, _feedKey);
    const response = await telepresenceFetch("POST", TELEPRESENCE_PATHS.status, payload);

    if (response && response.status >= 400) {
        console.warn(`[telepresence] setOnlineStatus failed: ${response.status}`);
    }
}

/**
 * Get the list of currently online agents.
 * GET /telepresence/peers
 */
export async function getOnlineAgents(): Promise<unknown[]> {
    if (!_initialized) return [];

    const response = await telepresenceFetch("GET", TELEPRESENCE_PATHS.peers);
    if (!response) return [];

    const body = parseResponseBody(response);
    const peers = parsePeerList(body);
    return peersToAgentList(peers);
}

/**
 * Send a directed signal to a specific peer.
 * POST /telepresence/signal
 */
export async function sendSignal(remoteDid: DID, payload: unknown): Promise<object> {
    if (!_initialized) return { status: "not_initialized" };

    const signalBody = buildSignalPayload(_myDid, remoteDid, payload);
    const response = await telepresenceFetch("POST", TELEPRESENCE_PATHS.signal, signalBody);

    if (!response) return { status: "not_supported" };

    if (response.status >= 400) {
        return { status: "error", code: response.status };
    }

    const body = parseResponseBody(response);
    return (body as object) || { status: "ok" };
}

/**
 * Broadcast a payload to all connected peers.
 * POST /telepresence/broadcast
 */
export async function sendBroadcast(payload: unknown): Promise<object> {
    if (!_initialized) return { status: "not_initialized" };

    const broadcastBody = buildBroadcastPayload(_myDid, payload);
    const response = await telepresenceFetch("POST", TELEPRESENCE_PATHS.broadcast, broadcastBody);

    if (!response) return { status: "not_supported" };

    if (response.status >= 400) {
        return { status: "error", code: response.status };
    }

    const body = parseResponseBody(response);
    return (body as object) || { status: "ok" };
}

/**
 * Register a callback for incoming signals.
 * Signals are delivered via inbox polling during sync cycles.
 */
export async function registerSignalCallback(
    callback: (signal: { from: DID; payload: unknown }) => void,
): Promise<void> {
    _signalCallbacks.push(callback);
}

// ---------------------------------------------------------------------------
// Inbox polling (called during sync cycle)
// ---------------------------------------------------------------------------

/**
 * Poll the gateway inbox for new signals and dispatch to registered callbacks.
 * Should be called during each sync cycle.
 *
 * GET /telepresence/inbox?since={lastCheck}
 */
export async function pollInbox(): Promise<void> {
    if (!_initialized || _signalCallbacks.length === 0) return;

    const params = _lastInboxCheck
        ? `?since=${encodeURIComponent(_lastInboxCheck)}`
        : "";
    const path = `${TELEPRESENCE_PATHS.inbox}${params}`;

    const response = await telepresenceFetch("GET", path);
    if (!response) return;

    const body = parseResponseBody(response);
    const messages = parseInboxMessages(body);

    if (messages.length === 0) return;

    // Update the last check timestamp to the newest message
    const latestTimestamp = messages.reduce((latest, msg) => {
        return msg.timestamp > latest ? msg.timestamp : latest;
    }, _lastInboxCheck);
    _lastInboxCheck = latestTimestamp;

    // Dispatch to all registered callbacks
    for (const msg of messages) {
        for (const callback of _signalCallbacks) {
            try {
                callback({ from: msg.from, payload: msg.payload });
            } catch (err) {
                console.error(`[telepresence] signal callback error:`, err);
            }
        }
    }
}

/**
 * Get the number of registered signal callbacks (for testing).
 */
export function getSignalCallbackCount(): number {
    return _signalCallbacks.length;
}

/**
 * Get the last inbox check timestamp (for testing).
 */
export function getLastInboxCheck(): string {
    return _lastInboxCheck;
}
