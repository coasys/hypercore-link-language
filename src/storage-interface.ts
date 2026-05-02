/**
 * Storage adapter interface — interfaces and singleton only.
 *
 * No ad4m:host imports. Safe for cross-runtime testing.
 */

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
