import type { Logger } from '../util/logger';

type SafeStorage = {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
};

/**
 * Wrapper over Electron's `safeStorage`, which encrypts a string with a key
 * held by the OS keychain (Keychain on macOS, libsecret on Linux, DPAPI on
 * Windows) — the same mechanism Proton's own desktop clients use for a session.
 *
 * The plugin stores a Proton session: an access token, a refresh token, and the
 * password that unlocks the user's private keys. Writing that to
 * `data.json` in the clear would put it in the vault, where it would be picked
 * up by the user's other backups — and, for anyone syncing `.obsidian`, by this
 * very plugin.
 *
 * `safeStorage` lives in the main process, so it is reached over Electron's
 * remote bridge. Obsidian exposes that, but which of the two module names works
 * has changed across Electron versions, so both are tried and the result is
 * cached. When neither is reachable, {@link isAvailable} reports false and the
 * caller is expected to refuse to persist rather than silently downgrade.
 */
export class SecretStore {
    private resolved = false;
    private safeStorage: SafeStorage | null = null;

    constructor(private readonly logger: Logger) {}

    isAvailable(): boolean {
        return this.get() !== null;
    }

    /** Returns base64 ciphertext, or null when encryption is unavailable. */
    encrypt(plainText: string): string | null {
        const safeStorage = this.get();
        if (!safeStorage) {
            return null;
        }
        try {
            return safeStorage.encryptString(plainText).toString('base64');
        } catch (error) {
            this.logger.error('Failed to encrypt secret', error);
            return null;
        }
    }

    decrypt(base64CipherText: string): string | null {
        const safeStorage = this.get();
        if (!safeStorage) {
            return null;
        }
        try {
            return safeStorage.decryptString(Buffer.from(base64CipherText, 'base64'));
        } catch (error) {
            // Most often this means the OS keychain entry is gone, or the blob
            // was written by a different user account. Not recoverable; the
            // caller re-authenticates.
            this.logger.warn('Failed to decrypt stored session; a new sign-in is needed', error);
            return null;
        }
    }

    private get(): SafeStorage | null {
        if (this.resolved) {
            return this.safeStorage;
        }
        this.resolved = true;

        for (const moduleName of ['electron', '@electron/remote']) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const required = window.require(moduleName) as Record<string, unknown>;
                const candidate =
                    (required?.safeStorage as SafeStorage | undefined) ??
                    ((required?.remote as Record<string, unknown> | undefined)?.safeStorage as
                        | SafeStorage
                        | undefined);

                if (candidate?.isEncryptionAvailable?.() === true) {
                    this.logger.debug(`Using safeStorage from "${moduleName}"`);
                    this.safeStorage = candidate;
                    return this.safeStorage;
                }
            } catch {
                // Module not reachable from the renderer; try the next name.
            }
        }

        this.logger.warn('Electron safeStorage is unavailable; the Proton session cannot be stored encrypted');
        return null;
    }
}
