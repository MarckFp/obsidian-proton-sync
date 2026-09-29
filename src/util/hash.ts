/**
 * SHA-1 over file bytes.
 *
 * SHA-1 rather than something modern because Proton Drive records exactly this
 * digest in a revision's extended attributes (`claimedDigests.sha1`). Matching
 * it is what lets the engine decide whether a remote revision holds the bytes
 * the vault already has without downloading it. This is a change-detection
 * check between two copies of the user's own data, not a security boundary —
 * the confidentiality and integrity guarantees come from Proton's end-to-end
 * encryption, which the SDK verifies independently.
 */
export async function sha1Hex(data: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-1', data);
    return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
    let hex = '';
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
}
