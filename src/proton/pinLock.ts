import type { SecretSlot } from './secretStore';

/**
 * An optional PIN over the stored Proton session.
 *
 * Without a PIN the session sits in Obsidian's secret storage as is, which the
 * operating system protects while the device is locked but not from anyone
 * using it unlocked: Obsidian's own Keychain settings can show it. With a PIN,
 * what is stored is the session encrypted with a key derived from the PIN, so
 * a copy of the secret is useless without the PIN, and Obsidian asks for it
 * when the plugin starts.
 *
 * The PIN is never stored. The key derived from it stays in memory while
 * Obsidian runs, so tokens refreshed during the session are saved encrypted
 * again; it is gone when Obsidian closes. A forgotten PIN cannot be
 * recovered, only replaced: {@link PinProtectedSlot.forget} deletes the
 * locked session and the user signs in again. Notes are not affected either
 * way, since the PIN only ever protected the sign-in.
 *
 * Key derivation is PBKDF2-SHA256 at 600,000 iterations (OWASP's 2023
 * recommendation), the strongest function WebCrypto offers on every platform
 * Obsidian runs on; encryption is AES-256-GCM.
 */

export const MIN_PIN_LENGTH = 6;

const FORMAT = 'proton-drive-sync/pin-v1';
const ITERATIONS = 600_000;
/** Binds the ciphertext to its purpose, so it cannot be passed off as anything else. */
const ASSOCIATED_DATA = new TextEncoder().encode(FORMAT);

type Envelope = {
    format: typeof FORMAT;
    kdf: 'PBKDF2-SHA256';
    iterations: number;
    salt: string;
    iv: string;
    data: string;
};

type UnlockedKey = { key: CryptoKey; salt: Uint8Array<ArrayBuffer>; iterations: number };

/** Reading a PIN-protected session before {@link PinProtectedSlot.unlock}. */
export class LockedError extends Error {
    constructor() {
        super('The Proton session is locked with a PIN');
        this.name = 'LockedError';
    }
}

export type Protection = 'none' | 'plain' | 'pin';

export class PinProtectedSlot implements SecretSlot {
    private unlocked: UnlockedKey | null = null;

    constructor(
        private readonly inner: SecretSlot,
        /** Recorded with each encryption, so a slot always opens what an older setting wrote. */
        private readonly iterations = ITERATIONS,
    ) {}

    /** What is stored: nothing, a session as is, or one locked with a PIN. */
    async protection(): Promise<Protection> {
        const raw = await this.inner.read();
        if (raw === null) {
            return 'none';
        }
        return parseEnvelope(raw) ? 'pin' : 'plain';
    }

    /** Whether the stored session is locked and has not been unlocked in this run. */
    async isLocked(): Promise<boolean> {
        return this.unlocked === null && (await this.protection()) === 'pin';
    }

    async read(): Promise<string | null> {
        const raw = await this.inner.read();
        if (raw === null) {
            return null;
        }
        const envelope = parseEnvelope(raw);
        if (!envelope) {
            return raw;
        }
        if (!this.unlocked) {
            throw new LockedError();
        }
        return decrypt(envelope, this.unlocked.key);
    }

    /**
     * Save the session, encrypted when a PIN is set. Clearing it (sign-out)
     * also drops the PIN: it protected that session, and the next one is
     * offered a PIN of its own.
     */
    async write(value: string | null): Promise<void> {
        if (value === null) {
            this.unlocked = null;
            await this.inner.write(null);
            return;
        }
        await this.inner.write(this.unlocked ? JSON.stringify(await encrypt(value, this.unlocked)) : value);
    }

    /** Try a PIN. On success the session can be read for the rest of this run. */
    async unlock(pin: string): Promise<boolean> {
        const key = await this.keyFor(pin);
        if (key) {
            this.unlocked = key;
        }
        return key !== null;
    }

    /** Whether `pin` opens the stored session, without changing anything. */
    async verify(pin: string): Promise<boolean> {
        return (await this.keyFor(pin)) !== null;
    }

    /** Protect the stored session with a new PIN, replacing any old one. Needs the session readable. */
    async setPin(pin: string): Promise<void> {
        if (pin.length < MIN_PIN_LENGTH) {
            throw new Error(`The PIN needs at least ${MIN_PIN_LENGTH} characters`);
        }
        const session = await this.read();
        if (session === null) {
            throw new Error('Sign in to Proton first; there is no session to protect yet');
        }
        const salt = crypto.getRandomValues(new Uint8Array(16));
        this.unlocked = { key: await deriveKey(pin, salt, this.iterations), salt, iterations: this.iterations };
        await this.write(session);
    }

    /** Store the session without a PIN again. Needs the session readable. */
    async removePin(): Promise<void> {
        const session = await this.read();
        this.unlocked = null;
        if (session !== null) {
            await this.inner.write(session);
        }
    }

    /**
     * For a forgotten PIN: delete the locked session without reading it. The
     * user signs in again. It cannot be ended on Proton's side from here,
     * since that needs the tokens the PIN protects.
     */
    async forget(): Promise<void> {
        this.unlocked = null;
        await this.inner.write(null);
    }

    private async keyFor(pin: string): Promise<UnlockedKey | null> {
        const raw = await this.inner.read();
        const envelope = raw === null ? null : parseEnvelope(raw);
        if (!envelope) {
            return null;
        }
        const salt = fromBase64(envelope.salt);
        const key = await deriveKey(pin, salt, envelope.iterations);
        try {
            await decrypt(envelope, key);
        } catch {
            return null;
        }
        return { key, salt, iterations: envelope.iterations };
    }
}

async function deriveKey(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
        'deriveKey',
    ]);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

async function encrypt(plaintext: string, unlocked: UnlockedKey): Promise<Envelope> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: ASSOCIATED_DATA },
        unlocked.key,
        new TextEncoder().encode(plaintext),
    );
    return {
        format: FORMAT,
        kdf: 'PBKDF2-SHA256',
        iterations: unlocked.iterations,
        salt: toBase64(unlocked.salt),
        iv: toBase64(iv),
        data: toBase64(new Uint8Array(data)),
    };
}

/** Throws when the key is wrong or the data was tampered with; GCM checks both. */
async function decrypt(envelope: Envelope, key: CryptoKey): Promise<string> {
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: ASSOCIATED_DATA },
        key,
        fromBase64(envelope.data),
    );
    return new TextDecoder().decode(plaintext);
}

function parseEnvelope(raw: string): Envelope | null {
    try {
        const value = JSON.parse(raw) as Partial<Envelope> | null;
        if (
            value?.format === FORMAT &&
            typeof value.iterations === 'number' &&
            typeof value.salt === 'string' &&
            typeof value.iv === 'string' &&
            typeof value.data === 'string'
        ) {
            return value as Envelope;
        }
    } catch {
        // A plain session, or not JSON at all.
    }
    return null;
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
