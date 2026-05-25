/**
 * Adapter interfaces and singletons for cross-runtime abstraction.
 *
 * Combines Transport (HTTP), Storage, Runtime, and Signing
 * interfaces + init/get singletons.
 * No ad4m:host imports. Safe for cross-runtime testing.
 * Deno-specific implementations are in adapters-deno.ts.
 */

// ---------------------------------------------------------------------------
// Transport (HTTP)
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
// WasmTransport — future WASM runtime via http-ext.fetch
// ---------------------------------------------------------------------------

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
// HTTP Transport singleton
// ---------------------------------------------------------------------------

let _transport: Transport | null = null;

export function initTransport(transport: Transport): void {
    _transport = transport;
}

export function getTransport(): Transport {
    if (!_transport) {
        throw new Error(
            "Transport not initialized. Call initTransport() during language init().",
        );
    }
    return _transport;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface StorageAdapter {
    get(key: string): string | null;
    put(key: string, value: string): void;
    delete(key: string): void;
    listKeys(prefix?: string): string[];
}

let _storage: StorageAdapter | null = null;

export function initStorage(adapter: StorageAdapter): void {
    _storage = adapter;
}

export function getStorage(): StorageAdapter {
    if (!_storage) {
        throw new Error(
            "StorageAdapter not initialized. Call initStorage() during language init().",
        );
    }
    return _storage;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface RuntimeAdapter {
    /** Content-address hash: SHA-256 → CIDv1 → base58btc, prefixed "Qm". */
    hash(data: string): string;
    /** Emit a signal to the executor (e.g. relay publish requests). */
    emitSignal(data: string): void;
    /** Emit a perspective diff for local subscribers. */
    emitPerspectiveDiff(diff: unknown): void;
}

let _runtime: RuntimeAdapter | null = null;

export function initRuntime(adapter: RuntimeAdapter): void {
    _runtime = adapter;
}

export function getRuntime(): RuntimeAdapter {
    if (!_runtime) {
        throw new Error(
            "RuntimeAdapter not initialized. Call initRuntime() during language init().",
        );
    }
    return _runtime;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export interface SigningAdapter {
    /** Sign a string payload and return the hex-encoded signature. */
    signStringHex(payload: string): string;
    /** Return the signing key ID. */
    signingKeyId(): string;
}

let _signing: SigningAdapter | null = null;

export function initSigning(adapter: SigningAdapter): void {
    _signing = adapter;
}

export function getSigning(): SigningAdapter {
    if (!_signing) {
        throw new Error(
            "SigningAdapter not initialized. Call initSigning() during language init().",
        );
    }
    return _signing;
}
