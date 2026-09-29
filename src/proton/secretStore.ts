import { Platform, type SecretStorage } from 'obsidian';

import type { Logger } from '../util/logger';

/** One secret value, read and written whole. */
export interface SecretSlot {
    read(): string | null;
    /** `null` clears the secret. */
    write(value: string | null): void;
}

/**
 * A secret in Obsidian's secret storage.
 *
 * The plugin stores a Proton session: an access token, a refresh token, and the
 * password that unlocks the user's private keys. Obsidian keeps these secrets
 * per device, outside the vault, and backed by the platform keystore where
 * there is one. That matters twice over for a sync plugin: anything written
 * into the vault would be picked up by the user's other backups, and by this
 * very plugin. Unlike Electron's `safeStorage`, which 0.1.0 used, it also
 * exists on Android and iOS.
 */
export class ObsidianSecretSlot implements SecretSlot {
    constructor(
        private readonly storage: SecretStorage,
        private readonly id: string,
    ) {}

    read(): string | null {
        // Cleared secrets read back as an empty string.
        return this.storage.getSecret(this.id) || null;
    }

    write(value: string | null): void {
        this.storage.setSecret(this.id, value ?? '');
    }
}

type SafeStorage = {
    isEncryptionAvailable(): boolean;
    decryptString(encrypted: Buffer): string;
};

/**
 * Decrypt a session saved by 0.1.0, which encrypted it with Electron's
 * `safeStorage` into `session.json`. Desktop only, since that is the only
 * place such a file can have been written. Used once, to migrate the session
 * into {@link ObsidianSecretSlot}, so upgrading does not sign anyone out.
 */
export function decryptLegacySession(base64CipherText: string, logger: Logger): string | null {
    if (!Platform.isDesktopApp) {
        return null;
    }
    for (const moduleName of ['electron', '@electron/remote']) {
        try {
            const required = window.require(moduleName) as Record<string, unknown>;
            const safeStorage =
                (required?.safeStorage as SafeStorage | undefined) ??
                ((required?.remote as Record<string, unknown> | undefined)?.safeStorage as SafeStorage | undefined);
            if (safeStorage?.isEncryptionAvailable?.() === true) {
                return safeStorage.decryptString(Buffer.from(base64CipherText, 'base64'));
            }
        } catch (error) {
            logger.debug(`Could not decrypt the old session with "${moduleName}"`, error);
        }
    }
    return null;
}
