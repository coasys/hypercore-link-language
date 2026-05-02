/**
 * Deno-specific transport implementation.
 * Wraps httpFetch from ad4m:host.
 *
 * httpFetch behavior (from executor's host.js):
 * - On 2xx success: returns the response body as a raw string
 * - On non-2xx: throws Error("http_fetch METHOD URL -> STATUS: BODY")
 *
 * Only imported by index.ts — never by core modules or tests.
 */

import { httpFetch } from "@coasys/ad4m-ldk";
import type { Transport, TransportResponse } from "./transport.js";

export class DenoTransport implements Transport {
    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        try {
            const responseText = await httpFetch(
                url,
                method,
                JSON.stringify(headers),
                body,
            );

            return {
                status: 200,
                headers: {},
                body: responseText || "",
            };
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const match = errMsg.match(/http_fetch\s+\S+\s+\S+\s+->\s+(\d+):\s*(.*)?$/s);
            if (match) {
                return {
                    status: parseInt(match[1], 10),
                    headers: {},
                    body: match[2] || "",
                };
            }
            console.error(`[transport] httpFetch error: ${errMsg}`);
            return { status: 0, headers: {}, body: errMsg };
        }
    }
}
