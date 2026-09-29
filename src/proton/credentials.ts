import type { DataAdapter } from 'obsidian';

import type { Logger } from '../util/logger';
import type { SessionCredentials, SessionInfo } from './account';
import type { SecretStore } from './secretStore';

type StoredSession = {
    version: 1;
    uid: string;
    accessToken: string;
    refreshToken?: string;
    userKeyPassword: string;
    telemetryEnabled: boolean;
    accountEmail?: string;
};

type SessionFile = { encrypted: true; payload: string } | { encrypted: false; payload: StoredSession };

/**
 * The plugin's `SessionCredentials`, backed by a file next to the plugin.
 *
 * Kept out of `data.json` on purpose. Settings are saved on every change and
 * are fair game for a user to inspect, copy between machines or commit; a
 * session is none of those things, and giving it its own file means signing out
 * can delete it outright rather than having to scrub a shared document.
 *
 * Nothing is written unless {@link SecretStore} can encrypt it. Falling back to
 * plaintext would put an access token and the user's key password inside the
 * vault directory, which is exactly the thing this plugin then uploads.
 */
export class Credentials implements SessionCredentials {
    private session: StoredSession | null = null;
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly adapter: DataAdapter,
        private readonly filePath: string,
        private readonly secretStore: SecretStore,
        private readonly logger: Logger,
    ) {}

    get uid(): string | undefined {
        return this.session?.uid;
    }

    get accessToken(): string | undefined {
        return this.session?.accessToken;
    }

    get refreshToken(): string | undefined {
        return this.session?.refreshToken;
    }

    get accountEmail(): string | undefined {
        return this.session?.accountEmail;
    }

    on(_event: 'sessionInfoChanged', callback: () => void): void {
        this.listeners.add(callback);
    }

    isLoggedIn(): boolean {
        return this.session !== null && Boolean(this.session.uid) && Boolean(this.session.userKeyPassword);
    }

    isTelemetryEnabled(): boolean {
        return this.session?.telemetryEnabled ?? false;
    }

    getUserKeyPassword(): string | undefined {
        return this.session?.userKeyPassword;
    }

    async load(): Promise<void> {
        if (!(await this.adapter.exists(this.filePath))) {
            this.session = null;
            return;
        }

        try {
            const file = JSON.parse(await this.adapter.read(this.filePath)) as SessionFile;
            if (!file.encrypted) {
                // Only reachable for a file this plugin did not write. Refuse it
                // rather than adopt a session of unknown provenance.
                this.logger.warn('Stored session is not encrypted; ignoring it');
                this.session = null;
                return;
            }

            const decrypted = this.secretStore.decrypt(file.payload);
            if (decrypted === null) {
                this.session = null;
                return;
            }
            this.session = JSON.parse(decrypted) as StoredSession;
            this.logger.debug('Loaded stored Proton session');
        } catch (error) {
            this.logger.error('Failed to read the stored session', error);
            this.session = null;
        }
    }

    async setSessionInfo(info: SessionInfo): Promise<void> {
        this.session = {
            version: 1,
            telemetryEnabled: false,
            userKeyPassword: '',
            ...this.session,
            uid: info.uid,
            accessToken: info.accessToken,
            ...(info.refreshToken !== undefined && { refreshToken: info.refreshToken }),
        };
        await this.persist();
        this.emitChanged();
    }

    async setUserKeyPassword(userKeyPassword: string): Promise<void> {
        this.session = {
            version: 1,
            uid: '',
            accessToken: '',
            telemetryEnabled: false,
            ...this.session,
            userKeyPassword,
        };
        await this.persist();
    }

    async setTelemetryEnabled(enabled: boolean): Promise<void> {
        if (!this.session) {
            return;
        }
        this.session.telemetryEnabled = enabled;
        await this.persist();
    }

    /** Records which account the session belongs to, for display in settings. */
    async setAccountEmail(email: string): Promise<void> {
        if (!this.session) {
            return;
        }
        this.session.accountEmail = email;
        await this.persist();
    }

    async signOut(): Promise<void> {
        this.session = null;
        try {
            if (await this.adapter.exists(this.filePath)) {
                await this.adapter.remove(this.filePath);
            }
        } catch (error) {
            this.logger.error('Failed to remove the stored session', error);
        }
        this.emitChanged();
    }

    private async persist(): Promise<void> {
        if (!this.session) {
            return;
        }

        const encrypted = this.secretStore.encrypt(JSON.stringify(this.session));
        if (encrypted === null) {
            // The session stays usable for this Obsidian session; it just will
            // not survive a restart. Signing in again is a far better outcome
            // than leaving key material in the vault.
            this.logger.warn('Session not persisted: no OS-backed encryption is available');
            return;
        }

        const file: SessionFile = { encrypted: true, payload: encrypted };
        await this.adapter.write(this.filePath, JSON.stringify(file));
    }

    private emitChanged(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}
