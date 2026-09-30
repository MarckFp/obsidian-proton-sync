import type { DataAdapter } from 'obsidian';

import type { Logger } from '../util/logger';
import type { SessionCredentials, SessionInfo } from './account';
import type { SecretSlot } from './secretStore';

type StoredSession = {
    version: 1;
    uid: string;
    accessToken: string;
    refreshToken?: string;
    userKeyPassword: string;
    telemetryEnabled: boolean;
    accountEmail?: string;
};

/** Where 0.1.0 kept the session, and how to read it back. */
export type LegacySessionFile = {
    adapter: DataAdapter;
    path: string;
    decrypt: (base64CipherText: string) => string | null;
};

/**
 * The plugin's `SessionCredentials`, kept in a {@link SecretSlot}.
 *
 * Kept out of `data.json` on purpose. Settings are saved on every change and
 * are fair game for a user to inspect or copy between machines; a session is
 * neither, and it belongs to one device. Keeping it outside the vault also
 * means a copied or synced vault never carries anyone's sign-in along.
 */
export class Credentials implements SessionCredentials {
    private session: StoredSession | null = null;
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly slot: SecretSlot,
        private readonly legacy: LegacySessionFile,
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
        this.session = null;
        let stored = await this.slot.read();
        if (stored === null) {
            stored = await this.migrateLegacyFile();
        }
        if (stored === null) {
            return;
        }
        try {
            this.session = JSON.parse(stored) as StoredSession;
            this.logger.debug('Loaded stored Proton session');
        } catch (error) {
            this.logger.error('Failed to read the stored session', error);
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

    /** Drop the session from memory, leaving it stored; for locking with the PIN. */
    unload(): void {
        this.session = null;
    }

    async signOut(): Promise<void> {
        this.session = null;
        await this.slot.write(null);
        await this.removeLegacyFile();
        this.emitChanged();
    }

    private async persist(): Promise<void> {
        if (this.session) {
            await this.slot.write(JSON.stringify(this.session));
            // A new session supersedes one an older version left behind.
            await this.removeLegacyFile();
        }
    }

    /**
     * Move a session saved by 0.1.0 into the slot.
     *
     * The old file is deleted once migrated, or when it is not something this
     * plugin wrote. It is kept when decryption merely failed: on Linux the
     * keyring is often still locked early in a login, and deleting the file
     * then would sign the user out for good over a timing accident.
     */
    private async migrateLegacyFile(): Promise<string | null> {
        const { adapter, path, decrypt } = this.legacy;
        let file: { encrypted?: boolean; payload?: unknown };
        try {
            if (!(await adapter.exists(path))) {
                return null;
            }
            file = JSON.parse(await adapter.read(path)) as typeof file;
        } catch (error) {
            this.logger.warn('Discarding an unreadable session file left by an older version', error);
            await this.removeLegacyFile();
            return null;
        }
        if (file.encrypted !== true || typeof file.payload !== 'string') {
            // Only reachable for a file this plugin did not write. Refuse it
            // rather than adopt a session of unknown provenance.
            this.logger.warn('Stored session is not encrypted; ignoring it');
            await this.removeLegacyFile();
            return null;
        }

        const decrypted = decrypt(file.payload);
        if (decrypted === null) {
            this.logger.warn('Could not decrypt the session saved by an older version; will try again next launch');
            return null;
        }
        await this.slot.write(decrypted);
        await this.removeLegacyFile();
        this.logger.info('Moved the stored Proton session into Obsidian’s secret storage');
        return decrypted;
    }

    private async removeLegacyFile(): Promise<void> {
        try {
            if (await this.legacy.adapter.exists(this.legacy.path)) {
                await this.legacy.adapter.remove(this.legacy.path);
            }
        } catch (error) {
            this.logger.warn('Failed to remove the old session file', error);
        }
    }

    private emitChanged(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}
