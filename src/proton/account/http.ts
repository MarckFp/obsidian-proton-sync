/**
 * A minimal HTTP client for the account module, in place of `ky`.
 *
 * LOCAL ADDITION (not upstream). Upstream builds its `ApiClient` on `ky`; this
 * keeps the small part of ky's surface the module uses (`get`/`post`, `json`
 * bodies, `searchParams`, `.json()` on the result, `HTTPError`, timeouts, and
 * ky's retry rules) so the files that call it stay as upstream wrote them.
 * Requests go out through the `fetch` it is given, which in the plugin is
 * `obsidianFetch`, and so through Obsidian's `requestUrl`. See VENDORED.md.
 */

export type SearchParams = Record<string, string | number | boolean>;

export type RequestOptions = {
    method?: string;
    headers?: HeadersInit;
    /** Serialised as the body, with `content-type: application/json`. */
    json?: unknown;
    body?: BodyInit | null;
    searchParams?: SearchParams;
    /** Milliseconds; the request fails with a `TimeoutError` after this long. */
    timeout?: number;
    signal?: AbortSignal;
    /** Throw an {@link HTTPError} for a non-2xx status. Default true. */
    throwHttpErrors?: boolean;
    /**
     * Retry transient failures the way ky does. Default true. Turned off for
     * the Drive SDK's traffic, which has its own, more thorough retry logic.
     */
    retry?: boolean;
};

/** A `Response` whose `json()` is typed with what the endpoint returns. */
export type TypedResponse<T> = Omit<Response, 'json'> & { json<J = T>(): Promise<J> };

export type ResponsePromise<T> = Promise<TypedResponse<T>> & {
    /** The parsed body. Also asks for JSON with `accept: application/json`, as ky does. */
    json<J = T>(): Promise<J>;
};

export interface HttpClient {
    <T = unknown>(url: string, options?: RequestOptions): ResponsePromise<T>;
    get<T = unknown>(url: string, options?: Omit<RequestOptions, 'method'>): ResponsePromise<T>;
    post<T = unknown>(url: string, options?: Omit<RequestOptions, 'method'>): ResponsePromise<T>;
}

export class HTTPError extends Error {
    constructor(
        readonly response: Response,
        readonly request: { method: string; url: string },
    ) {
        super(`Request failed with status code ${response.status}: ${request.method} ${request.url}`);
        this.name = 'HTTPError';
    }
}

/** Named as the Drive SDK expects, so it retries a timed-out request. */
export class TimeoutError extends Error {
    constructor(request: { method: string; url: string }) {
        super(`Request timed out: ${request.method} ${request.url}`);
        this.name = 'TimeoutError';
    }
}

export type ClientConfig = {
    fetch: typeof fetch;
    /** Headers for every request, read at send time so a refreshed token is picked up. */
    headers: () => Record<string, string>;
    timeout: number;
    /**
     * Called with a response before it is returned or thrown. Resolving true
     * sends the request once more, with freshly read headers: how a request
     * rejected for an expired token is repeated after the session is refreshed.
     */
    shouldResend?: (request: { method: string; url: string; headers: Headers }, response: Response) => Promise<boolean>;
};

/** ky's defaults, which the account module was written against. */
const RETRY_LIMIT = 2;
const RETRY_METHODS = ['GET', 'PUT', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE'];
const RETRY_STATUS_CODES = [408, 413, 429, 500, 502, 503, 504];
const RETRY_AFTER_STATUS_CODES = [413, 429, 503];
/**
 * Upper bound on a server-requested wait. ky has none; an hour-long
 * `Retry-After` should fail the request, not hang sign-in for an hour.
 */
const MAX_RETRY_AFTER_MS = 60_000;

export function createHttpClient(config: ClientConfig): HttpClient {
    const call = <T>(url: string, options: RequestOptions = {}): ResponsePromise<T> => {
        let acceptJson = false;
        // Sent on the next microtask, so a `.json()` chained straight onto the
        // call can still ask for JSON first. ky does the same.
        const response = Promise.resolve().then(() => send(config, url, options, acceptJson)) as ResponsePromise<T>;
        response.json = async <J = T>() => {
            acceptJson = true;
            const result = await response;
            if (result.status === 204) {
                return '' as J;
            }
            const text = await result.text();
            return (text === '' ? '' : JSON.parse(text)) as J;
        };
        return response;
    };
    const client = call as HttpClient;
    client.get = (url, options) => call(url, { ...options, method: 'GET' });
    client.post = (url, options) => call(url, { ...options, method: 'POST' });
    return client;
}

async function send<T>(
    config: ClientConfig,
    url: string,
    options: RequestOptions,
    acceptJson: boolean,
): Promise<TypedResponse<T>> {
    const method = (options.method ?? 'GET').toUpperCase();
    const target = withSearchParams(url, options.searchParams);
    const request = { method, url: target };
    const retry = (options.retry ?? true) && RETRY_METHODS.includes(method);

    let body = options.body ?? null;
    if (options.json !== undefined) {
        body = JSON.stringify(options.json);
    }

    let resent = false;
    for (let attempt = 0; ; attempt++) {
        const headers = new Headers(config.headers());
        new Headers(options.headers).forEach((value, key) => headers.set(key, value));
        if (options.json !== undefined && !headers.has('content-type')) {
            headers.set('content-type', 'application/json');
        }
        if (acceptJson && !headers.has('accept')) {
            headers.set('accept', 'application/json');
        }

        let response: Response;
        try {
            response = await withDeadline(
                config.fetch(target, { method, headers, body, signal: options.signal }),
                options.timeout ?? config.timeout,
                options.signal,
                request,
            );
        } catch (error) {
            const transient = !(error instanceof TimeoutError) && !isAbort(error);
            if (retry && transient && attempt < RETRY_LIMIT) {
                await sleep(backoff(attempt));
                continue;
            }
            throw error;
        }

        if (!resent && config.shouldResend && (await config.shouldResend({ ...request, headers }, response))) {
            resent = true;
            attempt--;
            continue;
        }

        if (response.ok || options.throwHttpErrors === false) {
            return response;
        }
        if (retry && attempt < RETRY_LIMIT && RETRY_STATUS_CODES.includes(response.status)) {
            const wait = retryAfter(response);
            if (wait !== null || response.status !== 413) {
                await sleep(wait ?? backoff(attempt));
                continue;
            }
        }
        throw new HTTPError(response, request);
    }
}

function withSearchParams(url: string, searchParams: SearchParams | undefined): string {
    if (!searchParams) {
        return url;
    }
    const target = new URL(url);
    for (const [key, value] of Object.entries(searchParams)) {
        target.searchParams.set(key, String(value));
    }
    return target.toString();
}

/**
 * Settle with the response, or reject once the timeout passes or the signal
 * fires, whichever is first.
 *
 * `requestUrl` cannot be cancelled, so a request given up on here still runs
 * to completion in the background; its result is simply dropped. That is what
 * ky did too, since it could only abort a `fetch` that honours signals.
 */
function withDeadline(
    response: Promise<Response>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    request: { method: string; url: string },
): Promise<Response> {
    if (signal?.aborted) {
        return Promise.reject(abortError(signal));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            finish();
            reject(abortError(signal));
        };
        const timer = window.setTimeout(() => {
            finish();
            reject(new TimeoutError(request));
        }, timeoutMs);
        const finish = () => {
            window.clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        response.then(
            (value) => {
                finish();
                resolve(value);
            },
            (error: unknown) => {
                finish();
                reject(error instanceof Error ? error : new Error(String(error)));
            },
        );
    });
}

/** An error named `AbortError`, which is how the Drive SDK recognises a cancelled request. */
function abortError(signal: AbortSignal | undefined): Error {
    const reason: unknown = signal?.reason;
    if (reason instanceof Error && reason.name === 'AbortError') {
        return reason;
    }
    const error = new Error('Request aborted', { cause: reason });
    error.name = 'AbortError';
    return error;
}

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

/** 300 ms, then 600 ms: ky's default backoff. */
function backoff(attempt: number): number {
    return 300 * 2 ** attempt;
}

/** The wait a `Retry-After` header asks for, in milliseconds, for the statuses that honour it. */
function retryAfter(response: Response): number | null {
    const header = response.headers.get('retry-after');
    if (!header || !RETRY_AFTER_STATUS_CODES.includes(response.status)) {
        return null;
    }
    const seconds = Number(header);
    const ms = Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
    return Number.isNaN(ms) ? null : Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
