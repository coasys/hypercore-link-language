/**
 * Runtime interface — interfaces and singleton only.
 *
 * No ad4m:host imports. Safe for cross-runtime testing.
 */

export interface RuntimeAdapter {
    /** Content-address hash: SHA-256 → CIDv1 → base58btc, prefixed "Qm". */
    hash(data: string): string;
    /** Emit a signal to the executor (e.g. Hypercore/Hyperswarm commands). */
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
