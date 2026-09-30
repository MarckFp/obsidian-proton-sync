import type { paths as AuthPaths } from './api-auth-types';
import { createHttpClient, type HttpClient } from './http';
import type { Logger } from './logger';
import type { SessionCredentials } from './sessionCredentials';

const DEFAULT_TIMEOUT_MS = 30_000;

type RefreshResponseBody =
    AuthPaths['/auth/{_version}/refresh']['post']['responses']['200']['content']['application/json'];

export type ApiClientOptions = {
    baseUrl: string;
    appVersion: string;
    credentials: SessionCredentials;
    logger: Logger;
    headers?: Record<string, string | undefined>;
    /**
     * The transport every request goes out through.
     *
     * LOCAL ADDITION (not upstream). Obsidian's renderer is subject to CORS and
     * Proton's API does not allow the plugin's origin, so requests have to go
     * through Obsidian's `requestUrl`. Required, so that no request can fall
     * back to the renderer's own `fetch`. See ../obsidianFetch.ts and
     * VENDORED.md.
     */
    fetch: typeof fetch;
};

/*
 * LOCAL CHANGE (not upstream): built on ./http.ts instead of `ky`. The session
 * headers are read per request rather than baked into a client rebuilt on
 * every `sessionInfoChanged`, and a 401 is repeated at most once after a
 * refresh, where the ky hook could keep refreshing and repeating. See
 * VENDORED.md.
 */
export class ApiClient {
    private readonly authenticatedClient: HttpClient;
    private readonly unauthenticatedClient: HttpClient;

    private activeRefreshPromise: Promise<boolean> | null = null;

    readonly baseUrlWithProtocol: string;

    constructor(private readonly options: ApiClientOptions) {
        const baseUrl = options.baseUrl;
        this.baseUrlWithProtocol = baseUrl.match(/^https?:\/\//) ? baseUrl : `https://${baseUrl}`;

        const baseHeaders = Object.fromEntries(
            Object.entries({ 'x-pm-appversion': options.appVersion, ...options.headers }).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
            ),
        );

        this.unauthenticatedClient = createHttpClient({
            fetch: options.fetch,
            timeout: DEFAULT_TIMEOUT_MS,
            headers: () => baseHeaders,
        });
        this.authenticatedClient = createHttpClient({
            fetch: options.fetch,
            timeout: DEFAULT_TIMEOUT_MS,
            headers: () => ({
                ...baseHeaders,
                ...(this.options.credentials.uid && { 'x-pm-uid': this.options.credentials.uid }),
                ...(this.options.credentials.accessToken && {
                    Authorization: `Bearer ${this.options.credentials.accessToken}`,
                }),
            }),
            shouldResend: async (request, response) => {
                if (response.status !== 401 || shouldSkipAuthRefreshForUrl(request.url)) {
                    return false;
                }
                this.options.logger.info('Refreshing session');
                const rejectedAccessToken = getAccessTokenFromHeaders(request.headers);
                const refreshed = await this.refreshSessionIfPossible(rejectedAccessToken);
                return refreshed && Boolean(this.options.credentials.uid && this.options.credentials.accessToken);
            },
        });
    }

    get authenticatedRequest(): HttpClient {
        return this.authenticatedClient;
    }

    get unauthenticatedRequest(): HttpClient {
        return this.unauthenticatedClient;
    }

    async refreshSessionIfPossible(rejectedAccessToken?: string): Promise<boolean> {
        // If the current access token is already different from the rejected
        // one, let's use the current access token without refreshing as
        // another request already refreshed the session.
        const currentAccessToken = this.options.credentials.accessToken;
        if (currentAccessToken && currentAccessToken !== rejectedAccessToken) {
            this.options.logger.debug('Skipping session refresh, another request already refreshed the session');
            return true;
        }

        // Only one refresh can be in progress at a time.
        this.activeRefreshPromise ??= this.performTokenRefresh().finally(() => {
            this.activeRefreshPromise = null;
        });
        return this.activeRefreshPromise;
    }

    private async performTokenRefresh(): Promise<boolean> {
        const refreshToken = this.options.credentials.refreshToken;
        if (!refreshToken) {
            this.options.logger.warn('Failed to refresh session: missing RefreshToken');
            return false;
        }

        const response = await this.authenticatedClient.post(`${this.baseUrlWithProtocol}/auth/v4/refresh`, {
            json: {
                ResponseType: 'token',
                GrantType: 'refresh_token',
                RefreshToken: refreshToken,
            },
            throwHttpErrors: false,
        });

        if (!response.ok) {
            this.options.logger.error('Failed to refresh session', response);
            if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                await this.options.credentials.signOut();
            }
            return false;
        }

        const data = await response.json<RefreshResponseBody>();
        const uid = data.UID ?? this.options.credentials.uid;
        const accessToken = data.AccessToken;
        if (!uid || !accessToken) {
            this.options.logger.error('Failed to refresh session: missing UID or AccessToken');
            return false;
        }

        await this.options.credentials.setSessionInfo({
            uid,
            accessToken,
            refreshToken: data.RefreshToken ?? refreshToken,
        });
        return true;
    }
}

function getAccessTokenFromHeaders(headers: HeadersInit | undefined): string | undefined {
    if (!headers) {
        return undefined;
    }

    const normalizedHeaders = headers instanceof Headers ? headers : new Headers(headers);
    const authorization = normalizedHeaders.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) {
        return undefined;
    }

    return authorization.slice('Bearer '.length);
}

function shouldSkipAuthRefreshForUrl(url: string): boolean {
    let pathname: string;
    try {
        pathname = new URL(url).pathname.toLowerCase();
    } catch {
        pathname = url.toLowerCase();
    }
    if (pathname.includes('/auth/v4/refresh')) {
        return true;
    }
    if (pathname.includes('/auth/v4/sessions')) {
        return true;
    }
    if (pathname.includes('/core/v4/auth')) {
        return true;
    }
    return false;
}
