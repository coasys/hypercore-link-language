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
// Gateway client — high-level API for the Hypercore Gateway sidecar
// ---------------------------------------------------------------------------

export interface FeedInfo {
    key: string;
    discoveryKey: string;
    writable: boolean;
    length: number;
    replicating?: boolean;
}

export interface Entry {
    seq: number;
    data: string;
}

export interface SyncResult {
    entries: Entry[];
    length: number;
}

export interface AppendResult {
    seq: number;
    byteLength: number;
}

/**
 * High-level client for the Hypercore Gateway REST API.
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
    async health(): Promise<{ status: string; feeds: number }> {
        return this.request('GET', '/health') as Promise<{ status: string; feeds: number }>;
    }

    /** POST /feeds — create a new writable feed */
    async createFeed(): Promise<FeedInfo> {
        return this.request('POST', '/feeds') as Promise<FeedInfo>;
    }

    /** GET /feeds — list all feeds */
    async listFeeds(): Promise<FeedInfo[]> {
        return this.request('GET', '/feeds') as Promise<FeedInfo[]>;
    }

    /** GET /feeds/:key — get feed info */
    async getFeed(key: string): Promise<FeedInfo> {
        return this.request('GET', `/feeds/${key}`) as Promise<FeedInfo>;
    }

    /** POST /feeds/:key/append — append data to feed */
    async append(key: string, data: string): Promise<AppendResult> {
        return this.request('POST', `/feeds/${key}/append`, { data }) as Promise<AppendResult>;
    }

    /** GET /feeds/:key/entries — query entries */
    async query(key: string, start?: number, end?: number): Promise<Entry[]> {
        const params = new URLSearchParams();
        if (start !== undefined) params.set('start', start.toString());
        if (end !== undefined) params.set('end', end.toString());
        const qs = params.toString();
        const path = `/feeds/${key}/entries${qs ? `?${qs}` : ''}`;
        return this.request('GET', path) as Promise<Entry[]>;
    }

    /** GET /feeds/:key/entries/:seq — get single entry */
    async getEntry(key: string, seq: number): Promise<Entry> {
        return this.request('GET', `/feeds/${key}/entries/${seq}`) as Promise<Entry>;
    }

    /** GET /feeds/:key/sync — get entries since a sequence number */
    async sync(key: string, since: number): Promise<SyncResult> {
        return this.request('GET', `/feeds/${key}/sync?since=${since}`) as Promise<SyncResult>;
    }

    /** POST /feeds/:key/replicate — start P2P replication */
    async startReplication(key: string): Promise<{ status: string; key: string; discoveryKey?: string }> {
        return this.request('POST', `/feeds/${key}/replicate`) as Promise<{ status: string; key: string; discoveryKey?: string }>;
    }

    /** DELETE /feeds/:key/replicate — stop replication */
    async stopReplication(key: string): Promise<{ status: string; key: string }> {
        return this.request('DELETE', `/feeds/${key}/replicate`) as Promise<{ status: string; key: string }>;
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
