// LOCAL CHANGE: WebCrypto instead of `node:crypto`, so sign-in also works on
// Obsidian mobile, where Node modules do not exist. Same format and semantics.

export const DEFAULT_PROTON_ACCOUNT_URL = 'account.proton.me';
const FORK_AAD = new TextEncoder().encode('fork');
const GCM_NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

export const FORK_POLL_INTERVAL_MS = 5000;
export const FORK_INITIAL_DELAY_MS = 5000;
export const FORK_MAX_POLL_TIME_MS = 10 * 60 * 1000; // 10 minutes

type ForkPayloadJson = {
    type?: string;
    keyPassword?: string;
};

export function generateSignInUrl(
    authClientId: string,
    userCode: string,
    accountUrl: string = DEFAULT_PROTON_ACCOUNT_URL,
): {
    encryptionKey: Uint8Array<ArrayBuffer>;
    signInUrl: string;
} {
    const accountUrlWithProtocol = accountUrl.match(/^https?:\/\//) ? accountUrl : `https://${accountUrl}`;

    const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
    const base64EncodedKey = encryptionKey.toBase64();
    const payload = `0:${userCode}:${base64EncodedKey}:${authClientId}`;
    const signInUrl = `${accountUrlWithProtocol}/desktop/login?app=drive&pv=3#payload=${encodeURIComponent(payload)}`;

    return {
        encryptionKey,
        signInUrl,
    };
}

export async function parseUserKeyPassword(
    encryptionKey: Uint8Array<ArrayBuffer>,
    encryptedPayload: string,
): Promise<string> {
    const decryptedPayload = await decryptForkPayload(encryptedPayload, encryptionKey);
    const userKeyPassword = parseForkUserKeyPassword(decryptedPayload);
    return userKeyPassword;
}

async function decryptForkPayload(encodedPayload: string, encryptionKey: Uint8Array<ArrayBuffer>): Promise<string> {
    const blob = Uint8Array.fromBase64(encodedPayload);
    if (blob.length < GCM_NONCE_LENGTH + GCM_TAG_LENGTH) {
        throw new Error('Invalid fork payload blob length');
    }
    const nonce = blob.subarray(0, GCM_NONCE_LENGTH);
    // WebCrypto expects the tag appended to the ciphertext, which is exactly
    // how the blob is laid out after the nonce.
    const ciphertextAndTag = blob.subarray(GCM_NONCE_LENGTH);
    const key = await crypto.subtle.importKey('raw', encryptionKey, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: FORK_AAD, tagLength: GCM_TAG_LENGTH * 8 },
        key,
        ciphertextAndTag,
    );
    return new TextDecoder().decode(plaintext);
}

function parseForkUserKeyPassword(decryptedPayloadJson: string): string {
    const payload = JSON.parse(decryptedPayloadJson) as ForkPayloadJson;
    const keyPassword = payload.keyPassword;
    if (typeof keyPassword !== 'string') {
        throw new Error('Failed to deserialize the fork payload');
    }
    return keyPassword;
}
