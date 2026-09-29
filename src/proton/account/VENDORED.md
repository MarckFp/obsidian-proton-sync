# Vendored: `proton-drive-sdk-account`

This directory is a copy of `incubating/account/js/src` from
[ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk) (MIT).

It provides Proton account login, session refresh and address-key handling —
everything `ProtonDriveClient` needs to be handed a `ProtonDriveAccount`. The
Drive SDK itself is consumed from npm as `@protontech/drive-sdk`, but this
module is marked `"private": true` upstream and is **not published**, so the
only way to use it is to vendor it. Upstream describes it as a temporary
stand-in until an official Account SDK exists; expect to re-vendor it when that
lands.

Vendored from commit `6cbf2f442079ded7fadf93dc59494e71e04f19bb` (2026-09-15).

## Local changes

- `api-core-types.ts` and `api-auth-types.ts` are hand-written replacements for
  the OpenAPI-generated originals (~29k lines combined), trimmed to the nine
  operations this module actually calls. They keep the generated `paths` /
  `components` shape so the consuming files need no edits.

- `apiClient.ts` gained an optional `fetch` on `ApiClientOptions`, passed
  through to `ky`. Obsidian's renderer runs on the `app://obsidian.md` origin
  and Proton's API sends CORS headers only for Proton's own web clients, so the
  browser blocks the plugin's requests before they leave the process. The
  plugin supplies `../obsidianFetch.ts`, which routes them through Obsidian's
  `requestUrl`. Both additions are marked `LOCAL ADDITION` in the file.

- `authWeb.ts` decrypts the sign-in fork payload with WebCrypto instead of
  `node:crypto`, so sign-in works on Obsidian mobile, where there is no Node.
  `parseUserKeyPassword` became async as a result, and its one call in
  `auth.ts` gained an `await`. Marked `LOCAL CHANGE` in `authWeb.ts`.

Every other runtime file is byte-identical to upstream.

## Re-vendoring

    git clone --depth 1 https://github.com/ProtonDriveApps/sdk
    cp sdk/incubating/account/js/src/{accountAddress,accountApi,apiClient,addresses,auth,authWeb,index,logger,sessionCredentials,sleep,srp,telemetryPreference}.ts \
       src/proton/account/

Note that this overwrites `apiClient.ts` and `authWeb.ts`; re-apply the `fetch`
option, or the plugin will fail every request with a CORS error, and the
WebCrypto port, or the plugin will not load on mobile. Then run `npm run check-types`
and widen the trimmed type files if new fields are referenced.
