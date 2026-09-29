import type {
    ProtonDriveHTTPClient,
    ProtonDriveHTTPClientBlobRequest,
    ProtonDriveHTTPClientJsonRequest,
} from '@protontech/drive-sdk';

import type { ApiClient } from './account';

/**
 * The transport `ProtonDriveClient` calls out through.
 *
 * Everything is routed via the account module's `ApiClient` rather than plain
 * `fetch` so that session refresh, the `x-pm-appversion` identification header
 * and Proton's retry behaviour apply to Drive traffic as well as account
 * traffic — a Drive request that 401s has to trigger the same token refresh as
 * an account one, or the plugin drops offline until it is reloaded.
 *
 * `throwHttpErrors: false` is required: the SDK reads status codes off the
 * `Response` itself and maps them to its own error types.
 */
export class HTTPClient implements ProtonDriveHTTPClient {
    constructor(private readonly apiClient: ApiClient) {}

    async fetchJson(options: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
        return this.apiClient.authenticatedRequest(options.url, {
            method: options.method,
            ...(options.json !== undefined ? { json: options.json } : {}),
            ...(options.body !== undefined && options.json === undefined ? { body: options.body } : {}),
            headers: options.headers,
            timeout: options.timeoutMs,
            signal: options.signal,
            throwHttpErrors: false,
        });
    }

    async fetchBlob(options: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
        return this.apiClient.authenticatedRequest(options.url, {
            method: options.method,
            body: options.body,
            headers: options.headers,
            timeout: options.timeoutMs,
            signal: options.signal,
            throwHttpErrors: false,
        });
    }
}
