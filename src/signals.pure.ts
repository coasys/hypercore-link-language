/**
 * Pure signal message construction for Hypercore/Hyperswarm operations.
 *
 * Zero runtime deps. All functions produce well-typed signal payloads.
 *
 * Signal Protocol:
 *
 * Outbound (Language → Executor):
 *   hypercore:append   — append commit block to feed
 *   hypercore:query    — Hyperbee range query by key prefix
 *   hyperswarm:join    — join swarm with discovery key
 *   hyperswarm:leave   — leave swarm
 *
 * Inbound (Executor → Language):
 *   hypercore:block        — new block appended (local or replicated)
 *   hypercore:query:result — query response
 *   hyperswarm:peer        — peer connected/disconnected
 */

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
