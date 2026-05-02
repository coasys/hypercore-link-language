/**
 * Signal protocol: outbound requests + inbound event handling.
 *
 * Wraps the pure signal constructors with the runtime adapter's
 * emitSignal function for actual communication with the executor.
 *
 * Uses injected interfaces — no ad4m:host imports.
 */

import { getRuntime } from "./runtime-interface.js";
import {
    buildAppendSignal,
    buildQuerySignal,
    buildJoinSwarmSignal,
    buildLeaveSwarmSignal,
    parseInboundSignal,
    generateRequestId,
} from "./signals.pure.js";
import type {
    BlockSignal,
    QueryResultSignal,
    PeerSignal,
    InboundSignal,
} from "./signals.pure.js";

// Re-export types and pure functions
export type {
    AppendSignal,
    QuerySignal,
    JoinSwarmSignal,
    LeaveSwarmSignal,
    BlockSignal,
    QueryResultSignal,
    PeerSignal,
    InboundSignal,
    OutboundSignal,
} from "./signals.pure.js";

export {
    buildAppendSignal,
    buildQuerySignal,
    buildJoinSwarmSignal,
    buildLeaveSwarmSignal,
    parseInboundSignal,
    generateRequestId,
} from "./signals.pure.js";

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
