import { requestUrl, type RequestUrlParam } from 'obsidian';

/**
 * A `fetch`-compatible function backed by Obsidian's `requestUrl`.
 *
 * Obsidian's renderer runs on the `app://obsidian.md` origin, and the browser's
 * `fetch` applies CORS to it like any web page. Proton's API sends
 * `Access-Control-Allow-Origin` for Proton's own web clients, not for a plugin,
 * so every request the plugin makes with the built-in `fetch` would be blocked
 * before it left the process. `requestUrl` is Obsidian's escape hatch: it issues
 * the request from outside the renderer's security context, where CORS does not
 * apply.
 *
 * This is why the plugin is desktop-only.
 *
 * The trade-off is that `requestUrl` buffers: it has no streaming body and no
 * abort support, so a transfer holds its bytes in memory and runs to completion
 * once started. The SDK already chunks file content into blocks, so the ceiling
 * is a block rather than a whole file, but a very large attachment still costs
 * more memory here than a streaming client would.
 */
export async function obsidianFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input as RequestInfo, init);

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

    const response = await requestUrl(params);

    // `requestUrl` lowercases header names and omits the status text. Neither
    // matters to the callers here, which read status codes and JSON bodies.
    return new Response(bodyFor(response.status, response.arrayBuffer), {
        status: response.status,
        headers: new Headers(response.headers ?? {}),
    });
}

/**
 * 204 and 304 must carry no body; constructing a `Response` with one throws.
 */
function bodyFor(status: number, body: ArrayBuffer): ArrayBuffer | null {
    return status === 204 || status === 304 ? null : body;
}
