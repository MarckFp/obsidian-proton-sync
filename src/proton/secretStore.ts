import { Platform, type DataAdapter, type SecretStorage } from 'obsidian';

import type { Logger } from '../util/logger';

/**
 * One secret value, read and written whole. Asynchronous so that a slot can
 * encrypt what it stores; see `PinProtectedSlot`.
 */
export interface SecretSlot {
    read(): Promise<string | null>;
    /** `null` clears the secret. */
    write(value: string | null): Promise<void>;
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

    async read(): Promise<string | null> {
        // Cleared secrets read back as an empty string.
        return this.storage.getSecret(this.id) || null;
    }

    async write(value: string | null): Promise<void> {
        this.storage.setSecret(this.id, value ?? '');
    }
}

/**
 * Node's `fs`, on desktop only.
 *
 * Obsidian writes through its adapter, which creates files with the process
 * umask (0644 on most systems). A session file that any local user can read is
 * a finding the plugin reports itself, so it is also fixed where it is created.
 */
function nodeFs(): typeof import('node:fs') | null {
    try {
        return (window.require('node:fs') as typeof import('node:fs')) ?? null;
    } catch {
        return null;
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

/**
 * A secret in an encrypted file of the plugin's own, keyed by the OS keystore
 * (Electron `safeStorage`: DPAPI on Windows, Keychain on macOS, libsecret on
 * Linux).
 *
 * Obsidian's secret storage is a better home in one respect — it exists on
 * mobile — but it is a single namespace that *every* plugin can read with one
 * call (`app.secretStorage.listSecrets()` and `getSecret()`), and the ids name
 * the plugin, so a session kept there is a two-line theft. This keeps the same
 * protection at rest while removing the shared-API shortcut; the file lives in
 * the plugin's own folder, which is never synced.
 *
 * It is not a boundary against a plugin that goes looking for files and calls
 * `safeStorage.decryptString` itself — nothing inside one process is; see
 * SECURITY.md.
 */
export class SafeStorageFileSlot implements SecretSlot {
    constructor(
        private readonly adapter: DataAdapter,
        private readonly path: string,
        private readonly safeStorage: SafeStorageWithEncryption,
    ) {}

    async read(): Promise<string | null> {
        if (!(await this.adapter.exists(this.path))) {
            return null;
        }
        try {
            const encoded = await this.adapter.read(this.path);
            const value = this.safeStorage.decryptString(Buffer.from(encoded, 'base64')) || null;
            if (value !== null) {
                // Heal a file an older version wrote readable by everyone.
                this.closeToOthers();
            }
            return value;
        } catch {
            // A different OS user, a reinstalled keychain, or a corrupted file:
            // the secret is unreadable, and saying so is better than throwing
            // on every start. The caller signs in again.
            return null;
        }
    }

    async write(value: string | null): Promise<void> {
        if (value === null) {
            if (await this.adapter.exists(this.path)) {
                await this.adapter.remove(this.path);
            }
            return;
        }
        await this.adapter.write(this.path, this.safeStorage.encryptString(value).toString('base64'));
        this.closeToOthers();
    }

    /** Make an existing file private, in case an older version wrote it 0644. */
    closeToOthers(): void {
        const fs = nodeFs();
        if (!fs) {
            return;
        }
        // `fs` resolves a relative path against Obsidian's working directory,
        // which is not the vault, so the path has to become absolute first.
        const base = (this.adapter as unknown as { getBasePath?: () => string }).getBasePath?.();
        const target = base && !this.path.startsWith('/') ? `${base}/${this.path}` : this.path;
        try {
            fs.chmodSync(target, 0o600);
        } catch {
            // Best effort: a filesystem without modes, or a path the app cannot
            // reach from Node. The permission check reports what it sees.
        }
    }
}

export type SafeStorageWithEncryption = SafeStorage & { encryptString(value: string): Buffer };

/** Electron's `safeStorage`, when this platform can encrypt at all; null otherwise (mobile, or no keyring). */
export function encryptedStorage(logger: Logger): SafeStorageWithEncryption | null {
    if (!Platform.isDesktopApp) {
        return null;
    }
    for (const moduleName of ['electron', '@electron/remote']) {
        try {
            const required = window.require(moduleName) as Record<string, unknown>;
            const candidate =
                (required?.safeStorage as SafeStorageWithEncryption | undefined) ??
                ((required?.remote as Record<string, unknown> | undefined)?.safeStorage as
                    | SafeStorageWithEncryption
                    | undefined);
            if (candidate?.isEncryptionAvailable?.() === true && typeof candidate.encryptString === 'function') {
                return candidate;
            }
        } catch (error) {
            logger.debug(`Could not reach safeStorage through "${moduleName}"`, error);
        }
    }
    return null;
}

/**
 * Move a value left in Obsidian's secret storage into `to`, then clear it, so
 * upgrading does not sign anyone out and the old copy stops being readable by
 * other plugins. Best effort: a failure here means the user signs in again.
 */
export async function migrateSecret(from: ObsidianSecretSlot, to: SecretSlot): Promise<boolean> {
    const existing = await to.read();
    if (existing !== null) {
        return false;
    }
    const legacy = await from.read();
    if (legacy === null) {
        return false;
    }
    await to.write(legacy);
    await from.write(null);
    return true;
}
