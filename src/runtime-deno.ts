/**
 * Deno-specific runtime adapter implementation.
 * Wraps ad4m:host hash, emitSignal, emitPerspectiveDiff functions.
 *
 * Only imported by index.ts — never by core modules or tests.
 */

import {
    hash,
    emitSignal,
    emitPerspectiveDiff,
} from "@coasys/ad4m-ldk";
import type { RuntimeAdapter } from "./runtime-interface.js";

export class DenoRuntime implements RuntimeAdapter {
    hash(data: string): string {
        return hash(data);
    }

    emitSignal(data: string): void {
        emitSignal(data);
    }

    emitPerspectiveDiff(diff: unknown): void {
        emitPerspectiveDiff(diff);
    }
}
