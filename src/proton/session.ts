import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import { MemoryCache, OpenPGPCryptoWithCryptoProxy, ProtonDriveClient } from '@protontech/drive-sdk';
import type { Logger } from '../util/logger';
import { ApiClient, initAccount, type Addresses, type Auth, type Srp } from './account';
import type { Credentials } from './credentials';
import { HTTPClient } from './httpClient';
import { revokeSession } from './revoke';
import { obsidianFetch } from './obsidianFetch';
import { Telemetry } from './telemetry';

/**
 * Proton requires every client to identify itself honestly in `x-pm-appversion`,
 * in the shape `external-drive-{name}@{semver}-{channel}`. Requests carrying a
 * value that impersonates a first-party client may be blocked outright, and
 * Proton uses this string to trace and, if necessary, block a specific buggy
 * build — so it names this plugin and nothing else.
 */
const APP_VERSION = `external-drive-obsidian_sync@${__PLUGIN_VERSION__}-alpha`;

/** The auth client id Proton reserves for third-party Drive integrations. */
const AUTH_CLIENT_ID = 'external-drive';

const DRIVE_API_URL = 'drive-api.proton.me';
const ACCOUNT_URL = 'account.proton.me';

let cryptoEndpointReady = false;

/**
 * Initialise the OpenPGP endpoint that `CryptoProxy` dispatches to.
 *
 * `CryptoProxy` keeps its endpoint in module-level state, so this must happen
 * exactly once per renderer, before any SDK or account code runs — and the SRP
 * helpers must be handed to the account module rather than imported by it, so
 * that both halves talk to the same endpoint.
 */
function initCryptoOnce(): OpenPGPCryptoWithCryptoProxy {
    if (!cryptoEndpointReady) {
        CryptoApi.init({});
        CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
        cryptoEndpointReady = true;
    }
    return new OpenPGPCryptoWithCryptoProxy(CryptoProxy);
}

export type SignInHandle = {
    /** The account.proton.me URL the user has to open to approve the session. */
    url: string;
    /** Resolves with the signed-in address once the user approves, or rejects. */
    completion: Promise<string>;
};

/**
 * Owns the Proton session and the configured `ProtonDriveClient`.
 *
 * Construction is cheap and happens whether or not the user is signed in; the
 * Drive client only becomes available once there is a session, because the SDK
 * needs address keys to decrypt anything.
 */
export class ProtonSession {
    private readonly telemetry: Telemetry;

    private apiClient: ApiClient | null = null;
    private auth: Auth | null = null;
    private addresses: Addresses | null = null;
    private srp: Srp | null = null;
    private client: ProtonDriveClient | null = null;

    constructor(
        private readonly credentials: Credentials,
        private readonly clientUid: string,
        private readonly logger: Logger,
    ) {
        this.telemetry = new Telemetry(logger);
    }

    /**
     * Load any stored session and build the Drive client if one exists.
     *
     * Safe to call when signed out: it leaves {@link isSignedIn} false and the
     * settings tab shows a sign-in button.
     */
    async init(): Promise<void> {
        const cryptoModule = initCryptoOnce();

        this.apiClient = new ApiClient({
            baseUrl: DRIVE_API_URL,
            appVersion: APP_VERSION,
            credentials: this.credentials,
            logger: this.logger.getLogger('api'),
            // Obsidian's renderer is subject to CORS and Proton does not allow
            // this origin, so every request goes out through Obsidian instead.
            fetch: obsidianFetch,
        });

        const account = await initAccount({
            authClientId: AUTH_CLIENT_ID,
            apiClient: this.apiClient,
            credentials: this.credentials,
            cryptoProxy: CryptoProxy,
            // Passed in rather than imported by the account module, so both use
            // the endpoint initialised above.
            srpApi: { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp },
            logger: this.logger.getLogger('account'),
            accountUrl: ACCOUNT_URL,
        });

        this.auth = account.auth;
        this.addresses = account.addresses;
        this.srp = account.srp;

        if (this.credentials.isLoggedIn()) {
            this.buildClient(cryptoModule);
        }
    }

    isSignedIn(): boolean {
        return this.credentials.isLoggedIn() && this.client !== null;
    }

    get accountEmail(): string | undefined {
        return this.credentials.accountEmail;
    }

    /**
     * The Drive client.
     *
     * @throws if called while signed out — callers are expected to check
     * {@link isSignedIn} first, and a thrown error here means a bug rather than
     * a state the user can get into.
     */
    getClient(): ProtonDriveClient {
        if (!this.client) {
            throw new Error('Not signed in to Proton Drive');
        }
        return this.client;
    }

    /**
     * Start the browser sign-in flow.
     *
     * Proton's session-fork flow is the only complete one available here: the
     * user approves in a real Proton page, and the plugin receives a forked
     * session without ever seeing the password, which also means 2FA, security
     * keys and SSO all keep working without this plugin implementing any of
     * them.
     *
     * Returns as soon as the URL is known so the caller can show it, with the
     * long poll for approval left on `completion`.
     */
    async beginWebSignIn(signal?: AbortSignal): Promise<SignInHandle> {
        const auth = this.auth;
        if (!auth) {
            throw new Error('Proton session is not initialised');
        }

        const { promise: url, resolve: resolveUrl, reject: rejectUrl } = Promise.withResolvers<string>();

        const completion = auth
            .authViaWeb((signInUrl) => resolveUrl(signInUrl), signal)
            .then(async () => {
                this.buildClient(initCryptoOnce());

                const primary = await this.addresses!.getOwnPrimaryAddress();
                await this.credentials.setAccountEmail(primary.email);
                this.logger.info(`Signed in to Proton as ${primary.email}`);
                return primary.email;
            });

        // A failure before the URL is known - the fork request itself being
        // refused, say - has to surface as a rejection of this call, since the
        // caller is still awaiting the URL and will never look at `completion`.
        completion.catch((error: unknown) => rejectUrl(error));

        const signInUrl = await url;
        return { url: signInUrl, completion };
    }

    /**
     * End the session with Proton, then forget it here.
     *
     * Revoked on Proton's side first, while the tokens needed to ask are still
     * at hand: deleting only the local copy would leave a session that anyone
     * who had copied it could keep using, and keep refreshing, until it
     * expired. The local copy is deleted whatever Proton answers, so a device
     * that is offline, or a session Proton had already ended, still signs out;
     * the session then stays listed under Account → Security → Sessions until
     * it expires or is revoked there.
     */
    async signOut(): Promise<{ revoked: boolean }> {
        const revoked = await this.revoke();
        await this.credentials.signOut();
        this.client = null;
        return { revoked };
    }

    private async revoke(): Promise<boolean> {
        if (!this.apiClient || !this.credentials.uid || !this.credentials.accessToken) {
            return false;
        }
        return revokeSession(this.apiClient, this.logger);
    }

    private buildClient(cryptoModule: OpenPGPCryptoWithCryptoProxy): void {
        if (!this.apiClient || !this.addresses || !this.srp) {
            throw new Error('Proton session is not initialised');
        }

        this.client = new ProtonDriveClient({
            config: { baseUrl: DRIVE_API_URL, clientUid: this.clientUid },
            httpClient: new HTTPClient(this.apiClient),
            // Held in memory only. Persisting these would mean writing node
            // keys and session keys into the vault directory, and the cost of
            // rebuilding them is a handful of requests after a restart.
            entitiesCache: new MemoryCache(),
            cryptoCache: new MemoryCache(),
            account: this.addresses,
            openPGPCryptoModule: cryptoModule,
            // The account module's SRP wrapper, which already speaks the
            // argument order the SDK expects.
            srpModule: this.srp,
            telemetry: this.telemetry,
        });
    }
}
