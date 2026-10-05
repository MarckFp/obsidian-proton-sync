import { updateServerTimeWithUpdateTimestamp } from '@protontech/crypto/serverTime';
import { requestUrl, type RequestUrlParam } from 'obsidian';

import { requestStats } from '../util/requestStats';

/**
 * A `fetch`-compatible function backed by Obsidian's `requestUrl`.
 *
 * Obsidian's renderer runs on its own origin (`app://obsidian.md` on desktop,
 * a `capacitor://` or `http://localhost` one on mobile), and the browser's
 * `fetch` applies CORS to it like any web page. Proton's API sends
 * `Access-Control-Allow-Origin` for Proton's own web clients, not for a plugin,
 * so every request the plugin makes with the built-in `fetch` would be blocked
 * before it left the process. `requestUrl` is Obsidian's escape hatch: it issues
 * the request from outside the renderer's security context, where CORS does not
 * apply. It does so on desktop and on mobile alike.
 *
 * The trade-off is that `requestUrl` buffers: it has no streaming body and no
 * abort support, so a transfer holds its bytes in memory and runs to completion
 * once started. The SDK already chunks file content into blocks, so the ceiling
 * is a block rather than a whole file, but a very large attachment still costs
 * more memory here than a streaming client would.
 */
export async function obsidianFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
        headers[key] = value;
    });

    const params: RequestUrlParam = {
        url: request.url,
        method: request.method,
        headers,
        // Status codes are the SDK's and the account module's to interpret;
        // both read them off the response rather than catching.
        throw: false,
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        params.body = await request.arrayBuffer();
    }

    const requestedAt = new Date();
    const response = await requestUrl(params);
    requestStats.record(response.status);
    followServerTime(response.headers, requestedAt);

    // `requestUrl` lowercases header names and omits the status text. Neither
    // matters to the callers here, which read status codes and JSON bodies.
    return new Response(bodyFor(response.status, response.arrayBuffer), {
        status: response.status,
        headers: new Headers(response.headers ?? {}),
    });
}

/**
 * Keep the crypto library's clock in step with Proton's.
 *
 * Every signature is dated, and every signature from another device is checked
 * against the current time, using `serverTime()` from `@protontech/crypto`.
 * Until it is given the server's time it falls back to this device's clock, so
 * a device whose clock is off dates its uploads wrongly and can refuse another
 * device's freshly signed file as signed "in the future". Proton's own clients
 * feed it every response's `Date` header, and so does this. The time recorded
 * with it is when the request was sent, not answered, as the library asks, so
 * the server time is never taken for fresher than it is.
 */
function followServerTime(headers: Record<string, string> | undefined, requestedAt: Date): void {
    const date = headers?.['date'] ?? headers?.['Date'];
    const time = date === undefined ? NaN : Date.parse(date);
    if (!Number.isNaN(time)) {
        updateServerTimeWithUpdateTimestamp(new Date(time), requestedAt);
    }
}

/**
 * 204 and 304 must carry no body; constructing a `Response` with one throws.
 */
function bodyFor(status: number, body: ArrayBuffer): ArrayBuffer | null {
    return status === 204 || status === 304 ? null : body;
}
