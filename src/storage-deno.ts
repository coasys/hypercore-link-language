/**
 * Deno-specific storage adapter implementation.
 * Wraps ad4m:host storage KV functions.
 *
 * Only imported by index.ts — never by core modules or tests.
 */

import {
    storageGet,
    storagePut,
    storageDelete,
    storageListKeys,
} from "@coasys/ad4m-ldk";
import type { StorageAdapter } from "./storage-interface.js";

export class DenoStorageAdapter implements StorageAdapter {
    get(key: string): string | null {
        return storageGet(key);
    }

    put(key: string, value: string): void {
        storagePut(key, value);
    }

    delete(key: string): void {
        storageDelete(key);
    }

    listKeys(prefix?: string): string[] {
        return storageListKeys(prefix);
    }
}
