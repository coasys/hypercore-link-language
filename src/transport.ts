/**
 * Transport abstraction layer — interfaces and singleton only.
 *
 * No ad4m:host imports. Safe for cross-runtime testing.
 *
 * Provides both raw HTTP transport and high-level gateway client methods.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface TransportResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface Transport {
    fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse>;
}

// ---------------------------------------------------------------------------
// Gateway client — high-level API for the Hypercore Autobase Gateway sidecar
// ---------------------------------------------------------------------------
//
// The gateway owns one Autobase per neighbourhood. Each agent writes AD4M link
// diffs as ops to its own input feed; Autobase linearizes them. The gateway is
// the AD4M-facing convergence substrate (Role A). See gateway/README.md.

/** Info about an Autobase (a neighbourhood). */
export interface BaseInfo {
    /** Hex Autobase key — the neighbourhood's stable identifier. */
    key: string;
    /** Hex discovery key — the Hyperswarm topic. */
    discoveryKey: string;
    /** This agent's local input-feed writer key (hex). */
    localWriterKey: string;
    /** Whether this agent can currently append (has been authorised). */
    writable: boolean;
    /** Whether the base is joined to Hyperswarm. */
    replicating?: boolean;
    /** Connected Hyperswarm peer count. */
    peers?: number;
}

/** A linearized head as (writerKey, length) — a version-vector element. */
export interface RevisionHead {
    key: string;
    length: number;
}

/** { link, hash } op wrapper: the OR-Set key the language computed for a link. */
export interface HashedLink {
    link: unknown;
    hash: string;
}

/** Incremental diff since a linearized op sequence. */
export interface GatewayDiff {
    revision: string;
    additions: unknown[];
    removals: unknown[];
    seq: number;
}

/**
 * High-level client for the Hypercore Autobase Gateway REST API.
 * Uses the injected Transport for actual HTTP calls.
 */
export class GatewayClient {
    private baseUrl: string;
    private transport: Transport;

    constructor(baseUrl: string, transport: Transport) {
        // Strip trailing slash
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.transport = transport;
    }

    private async request(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<unknown> {
        const url = `${this.baseUrl}${path}`;
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        const bodyStr = body !== undefined ? JSON.stringify(body) : '';

        const response = await this.transport.fetch(url, method, headers, bodyStr);

        if (response.status >= 400) {
            let errorMsg = `Gateway ${method} ${path} failed (${response.status})`;
            try {
                const errBody = JSON.parse(response.body);
                if (errBody.error) errorMsg += `: ${errBody.error}`;
            } catch { /* ignore parse error */ }
            throw new Error(errorMsg);
        }

        return JSON.parse(response.body);
    }

    /** GET /health */
    async health(): Promise<{ status: string; bases: number }> {
        return this.request('GET', '/health') as Promise<{ status: string; bases: number }>;
    }

    /**
     * POST /bases — create a new Autobase, or open (join) an existing one by key.
     */
    async openBase(key?: string): Promise<BaseInfo> {
        const body = key ? { key } : {};
        return this.request('POST', '/bases', body) as Promise<BaseInfo>;
    }

    /**
     * POST /bases with a neighbourhood HANDLE — resolve co-located agents to one
     * shared, writable Autobase (create-once per handle). Use this when the
     * neighbourhood is identified by a deterministic handle (the AD4M
     * neighbourhood id) rather than a real Autobase bootstrap key: an Autobase
     * key is a generated core key that cannot be chosen in advance, so opening a
     * handle as a bootstrap key yields a non-writable base. Returns the real base
     * key both agents then use for every subsequent op.
     */
    async openNeighbourhood(handle: string): Promise<BaseInfo> {
        return this.request('POST', '/bases', { neighbourhood: handle }) as Promise<BaseInfo>;
    }

    /** GET /bases/:key — current base info. */
    async getBase(key: string): Promise<BaseInfo> {
        return this.request('GET', `/bases/${key}`) as Promise<BaseInfo>;
    }

    /**
     * GET /bases/:key/revision — the REAL content-hash revision (Autobase
     * linearized Merkle head) plus the head version-vector. This is what
     * currentRevision() returns.
     */
    async revision(key: string): Promise<{ revision: string; heads: RevisionHead[] }> {
        return this.request('GET', `/bases/${key}/revision`) as Promise<{ revision: string; heads: RevisionHead[] }>;
    }

    /** GET /bases/:key/links — the materialised link set (folded from the DAG). */
    async links(key: string): Promise<{ links: unknown[] }> {
        return this.request('GET', `/bases/${key}/links`) as Promise<{ links: unknown[] }>;
    }

    /** GET /bases/:key/oplog — the full authoritative linearized op-log. */
    async oplog(key: string): Promise<{ ops: Array<{ seq: number; op: unknown }> }> {
        return this.request('GET', `/bases/${key}/oplog`) as Promise<{ ops: Array<{ seq: number; op: unknown }> }>;
    }

    /**
     * GET /bases/:key/diff?since=<seq> — ops linearized after `sinceSeq`, shaped
     * as a PerspectiveDiff, for the incremental sync callback.
     */
    async diff(key: string, sinceSeq: number): Promise<GatewayDiff> {
        return this.request('GET', `/bases/${key}/diff?since=${sinceSeq}`) as Promise<GatewayDiff>;
    }

    /**
     * POST /bases/:key/commit — append observed add/remove ops. Each entry
     * carries the link and its OR-Set hash. Returns the new revision + the max
     * linearized op seq (read-your-writes).
     */
    async commit(
        key: string,
        additions: HashedLink[],
        removals: HashedLink[],
    ): Promise<{ revision: string; seq: number }> {
        return this.request('POST', `/bases/${key}/commit`, { additions, removals }) as Promise<{ revision: string; seq: number }>;
    }

    /** POST /bases/:key/writers — authorise another agent's input feed. */
    async addWriter(key: string, writerKey: string): Promise<{ ok: boolean; writable: boolean }> {
        return this.request('POST', `/bases/${key}/writers`, { writerKey }) as Promise<{ ok: boolean; writable: boolean }>;
    }

    /** POST /bases/:key/replicate — join Hyperswarm and replicate with peers. */
    async startReplication(key: string, bootstrap?: string[]): Promise<{ status: string; discoveryKey: string; peers: number }> {
        const body = bootstrap && bootstrap.length > 0 ? { bootstrap } : {};
        return this.request('POST', `/bases/${key}/replicate`, body) as Promise<{ status: string; discoveryKey: string; peers: number }>;
    }

    /** DELETE /bases/:key/replicate — leave Hyperswarm. */
    async stopReplication(key: string): Promise<{ status: string }> {
        return this.request('DELETE', `/bases/${key}/replicate`) as Promise<{ status: string }>;
    }
}

// ---------------------------------------------------------------------------
// WasmTransport — future WASM runtime via http-ext.fetch
// ---------------------------------------------------------------------------

/**
 * Transport implementation for the WASM runtime. When the executor adds
 * http-ext support, this becomes functional. Until then it throws a
 * clear error.
 */
export class WasmTransport implements Transport {
    async fetch(
        _url: string,
        _method: string,
        _headers: Record<string, string>,
        _body: string,
    ): Promise<TransportResponse> {
        throw new Error(
            "WasmTransport: http-ext is not available in the current runtime. " +
            "The executor must provide the http-ext WIT import for WASM Languages " +
            "to make outbound HTTP requests.",
        );
    }
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let _transport: Transport | null = null;
let _gateway: GatewayClient | null = null;

/**
 * Initialize the global transport. Must be called once during `init()`.
 */
export function initTransport(transport: Transport): void {
    _transport = transport;
}

/**
 * Get the global transport instance.
 * Throws if `initTransport()` has not been called.
 */
export function getTransport(): Transport {
    if (!_transport) {
        throw new Error(
            "Transport not initialized. Call initTransport() during language init().",
        );
    }
    return _transport;
}

/**
 * Initialize the gateway client with a base URL.
 * Uses the already-initialized transport.
 */
export function initGateway(baseUrl: string): void {
    if (!_transport) {
        throw new Error(
            "Transport must be initialized before gateway. Call initTransport() first.",
        );
    }
    _gateway = new GatewayClient(baseUrl, _transport);
}

/**
 * Get the global gateway client instance.
 * Returns null if not initialized (gateway mode not configured).
 */
export function getGateway(): GatewayClient | null {
    return _gateway;
}
