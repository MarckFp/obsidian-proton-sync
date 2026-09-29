/**
 * Ambient declarations for the "Uint8Array to/from base64" TC39 proposal.
 *
 * `@protontech/crypto` ships TypeScript source (its package `exports` point at
 * `.ts` files) and uses these methods throughout its SRP and OpenPGP paths, but
 * TypeScript's `esnext` lib does not declare them yet, so compiling the plugin
 * surfaces the crypto package's own type errors. Declaring them here fixes the
 * build and is honest at runtime: `src/polyfills.ts` loads the core-js
 * implementation before any crypto code runs.
 *
 * Delete this file once the methods land in TypeScript's bundled lib files.
 */

type Uint8ArrayBase64Alphabet = 'base64' | 'base64url';
type Uint8ArrayLastChunkHandling = 'loose' | 'strict' | 'stop-before-partial';

interface Uint8Array<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> {
    toBase64(options?: { alphabet?: Uint8ArrayBase64Alphabet; omitPadding?: boolean }): string;
    toHex(): string;
    setFromBase64(
        string: string,
        options?: {
            alphabet?: Uint8ArrayBase64Alphabet;
            lastChunkHandling?: Uint8ArrayLastChunkHandling;
        },
    ): { read: number; written: number };
    setFromHex(string: string): { read: number; written: number };
}

interface Uint8ArrayConstructor {
    fromBase64(
        string: string,
        options?: {
            alphabet?: Uint8ArrayBase64Alphabet;
            lastChunkHandling?: Uint8ArrayLastChunkHandling;
        },
    ): Uint8Array<ArrayBuffer>;
    fromHex(string: string): Uint8Array<ArrayBuffer>;
}
