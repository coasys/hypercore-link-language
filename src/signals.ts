/**
 * Signal protocol: outbound requests + inbound event handling.
 *
 * Wraps the pure signal constructors with the runtime adapter's
 * emitSignal function for actual communication with the executor.
 *
 * Uses injected interfaces — no ad4m:host imports.
 */

import { getRuntime } from "./adapters.js";

// ---------------------------------------------------------------------------
// Outbound: emit signals to the executor
// ---------------------------------------------------------------------------

/**
 * Request the executor to append a block to the Hypercore feed.
 */
export function emitAppend(feedKey: string, data: string, seq: number): void {
    const signal = buildAppendSignal(feedKey, data, seq);
    getRuntime().emitSignal(JSON.stringify(signal));
}

/**
 * Request the executor to perform a Hyperbee range query.
 *
 * Returns the request ID for correlating the response.
 */
export function emitQuery(feedKey: string, prefix: string, limit?: number): string {
    const requestId = generateRequestId();
    const signal = buildQuerySignal(feedKey, prefix, requestId, limit);
    getRuntime().emitSignal(JSON.stringify(signal));
    return requestId;
}

/**
 * Request the executor to join a Hyperswarm topic.
 */
export function emitJoinSwarm(
    discoveryKey: string,
    bootstrap?: string[],
    maxPeers?: number,
): void {
    const signal = buildJoinSwarmSignal(discoveryKey, bootstrap, maxPeers);
    getRuntime().emitSignal(JSON.stringify(signal));
}

/**
 * Request the executor to leave a Hyperswarm topic.
 */
export function emitLeaveSwarm(discoveryKey: string): void {
    const signal = buildLeaveSwarmSignal(discoveryKey);
    getRuntime().emitSignal(JSON.stringify(signal));
}

// ---------------------------------------------------------------------------
// Inbound: process signals from the executor
// ---------------------------------------------------------------------------

/**
 * Process a raw signal from the executor.
 *
 * Parses the signal and dispatches to the appropriate handler.
 */
export function processInboundSignal(
    signalData: unknown,
): {
    kind: "block";
    signal: BlockSignal;
} | {
    kind: "query-result";
    signal: QueryResultSignal;
} | {
    kind: "peer";
    signal: PeerSignal;
} | {
    kind: "ignored";
    reason: string;
} {
    const signal = parseInboundSignal(signalData);
    if (!signal) {
        return { kind: "ignored", reason: "unrecognized signal format" };
    }

    switch (signal.type) {
        case "hypercore:block":
            return { kind: "block", signal };
        case "hypercore:query:result":
            return { kind: "query-result", signal };
        case "hyperswarm:peer":
            return { kind: "peer", signal };
        default:
            return { kind: "ignored", reason: `unknown signal type` };
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppendSignal {
    type: "hypercore:append";
    feedKey: string;
    data: string;
    seq: number;
}

export interface QuerySignal {
    type: "hypercore:query";
    requestId: string;
    feedKey: string;
    prefix: string;
    limit?: number;
}

export interface JoinSwarmSignal {
    type: "hyperswarm:join";
    discoveryKey: string;
    bootstrap?: string[];
    maxPeers?: number;
}

export interface LeaveSwarmSignal {
    type: "hyperswarm:leave";
    discoveryKey: string;
}

export type OutboundSignal = AppendSignal | QuerySignal | JoinSwarmSignal | LeaveSwarmSignal;

export interface BlockSignal {
    type: "hypercore:block";
    feedKey: string;
    seq: number;
    data: string;
    author: string;
    remote: boolean;
}

export interface QueryResultSignal {
    type: "hypercore:query:result";
    requestId: string;
    entries: Array<{ key: string; value: string }>;
}

export interface PeerSignal {
    type: "hyperswarm:peer";
    action: "connected" | "disconnected";
    peerKey: string;
    feedKey?: string;
}

export type InboundSignal = BlockSignal | QueryResultSignal | PeerSignal;

// ---------------------------------------------------------------------------
// Outbound signal constructors
// ---------------------------------------------------------------------------

/**
 * Build an append signal to request the executor to append a block to the feed.
 */
export function buildAppendSignal(
    feedKey: string,
    data: string,
    seq: number,
): AppendSignal {
    return {
        type: "hypercore:append",
        feedKey,
        data,
        seq,
    };
}

/**
 * Build a query signal to request a Hyperbee range query from the executor.
 */
export function buildQuerySignal(
    feedKey: string,
    prefix: string,
    requestId: string,
    limit?: number,
): QuerySignal {
    return {
        type: "hypercore:query",
        requestId,
        feedKey,
        prefix,
        limit,
    };
}

/**
 * Build a join-swarm signal to request the executor to join a Hyperswarm topic.
 */
export function buildJoinSwarmSignal(
    discoveryKey: string,
    bootstrap?: string[],
    maxPeers?: number,
): JoinSwarmSignal {
    const signal: JoinSwarmSignal = {
        type: "hyperswarm:join",
        discoveryKey,
    };
    if (bootstrap && bootstrap.length > 0) signal.bootstrap = bootstrap;
    if (maxPeers !== undefined) signal.maxPeers = maxPeers;
    return signal;
}

/**
 * Build a leave-swarm signal to request the executor to leave a Hyperswarm topic.
 */
export function buildLeaveSwarmSignal(discoveryKey: string): LeaveSwarmSignal {
    return {
        type: "hyperswarm:leave",
        discoveryKey,
    };
}

// ---------------------------------------------------------------------------
// Inbound signal parsing
// ---------------------------------------------------------------------------

/**
 * Parse an inbound signal from the executor.
 *
 * Returns the typed signal if valid, or null if unrecognized.
 */
export function parseInboundSignal(signal: unknown): InboundSignal | null {
    if (typeof signal !== "object" || signal === null) return null;

    const s = signal as Record<string, unknown>;
    const type = s.type;

    if (type === "hypercore:block") {
        if (
            typeof s.feedKey === "string" &&
            typeof s.seq === "number" &&
            typeof s.data === "string" &&
            typeof s.author === "string" &&
            typeof s.remote === "boolean"
        ) {
            return s as unknown as BlockSignal;
        }
        return null;
    }

    if (type === "hypercore:query:result") {
        if (
            typeof s.requestId === "string" &&
            Array.isArray(s.entries)
        ) {
            return s as unknown as QueryResultSignal;
        }
        return null;
    }

    if (type === "hyperswarm:peer") {
        if (
            typeof s.peerKey === "string" &&
            (s.action === "connected" || s.action === "disconnected")
        ) {
            return s as unknown as PeerSignal;
        }
        return null;
    }

    return null;
}

/**
 * Generate a unique request ID for query signals.
 */
export function generateRequestId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `q_${timestamp}_${random}`;
}
