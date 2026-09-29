/**
 * Runtime APIs the Proton Drive SDK and `@protontech/crypto` rely on but that
 * are not guaranteed to exist in the Chromium build Obsidian ships.
 *
 * The SDK's README calls these out explicitly as the consumer's responsibility:
 * it downlevels syntax but bundles no polyfills. `Uint8Array` base64/hex landed
 * in Chrome 133 and `Array.fromAsync` in Chrome 121, both of which are newer
 * than the Electron in older Obsidian builds, and every one of them throws a
 * bare `TypeError` when missing — deep inside a crypto or upload code path,
 * where it would look like a corrupt-data bug rather than a missing API.
 *
 * Imported for side effects only, and first, before anything that can reach
 * SDK code. `core-js` installs each method only when it is absent, so on a
 * current Electron this costs one feature test per method and nothing else.
 *
 * Deliberately narrower than `@protontech/crypto/polyfill`, which pulls in the
 * whole of `core-js/stable` (~800 KB in the bundle) to cover browsers far older
 * than any Obsidian desktop release.
 */

import 'core-js/proposals/array-buffer-base64';
import 'core-js/features/array/from-async';
