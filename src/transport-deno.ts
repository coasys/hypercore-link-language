/**
 * Deno-specific transport implementation.
 * Wraps httpFetch from ad4m:host.
 *
 * Only imported by index.ts — never by core modules or tests.
 *
 * IMPORTANT: The executor's httpFetch(url, method, headersJson, body)
 * returns the raw response body text (not a structured object).
 * It throws on non-ok HTTP responses.
 */

import { httpFetch } from "@coasys/ad4m-ldk";
import type { Transport, TransportResponse } from "./transport.js";

/**
 * Transport implementation for the Deno/JS executor runtime.
 * Delegates to `httpFetch` from `ad4m:host`.
 */
export class DenoTransport implements Transport {
    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        try {
            // httpFetch returns raw response body text on success,
            // throws on non-2xx responses
            const responseText = await httpFetch(
                url,
                method,
                JSON.stringify(headers),
                body,
            );

            return {
                status: 200,
                headers: {},
                body: responseText,
            };
        } catch (err: unknown) {
            // httpFetch throws: "http_fetch METHOD URL -> STATUS: BODY"
            const message = err instanceof Error ? err.message : String(err);
            const match = message.match(/http_fetch \w+ .+ -> (\d+): (.*)/s);
            if (match) {
                return {
                    status: parseInt(match[1], 10),
                    headers: {},
                    body: match[2],
                };
            }
            // Unknown error — wrap as 500
            return {
                status: 500,
                headers: {},
                body: JSON.stringify({ error: message }),
            };
        }
    }
}
