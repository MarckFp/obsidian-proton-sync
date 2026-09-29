# Proton Drive Sync for Obsidian

Bidirectional sync between an Obsidian vault and a folder in Proton Drive, built
on Proton's [official Drive SDK](https://github.com/ProtonDriveApps/sdk). Your
notes are end-to-end encrypted by the SDK before they leave the device, with the
same implementation Proton's own clients use.

> **Status: alpha, and it depends on a pre-release SDK.** Read
> [Before you rely on this](#before-you-rely-on-this) first. Keep a backup.

## What it does

- **Two-way sync** of the whole vault — notes, attachments, folders, and
  optionally your `.obsidian` settings.
- **Three-way conflict detection.** Every synced file records the version both
  sides last agreed on, so a device that has been offline for a week can tell an
  edit it missed from an edit it made. Only a genuine double-edit is reported as
  a conflict.
- **Conflict remediation**, from keeping both copies (the default — nothing is
  ever silently overwritten) to a line-level three-way merge that combines edits
  made to different parts of a note.
- **Event-based updates.** Changes from other devices arrive through Drive's
  event feed rather than by re-walking the tree.

## Before you rely on this

Four things are worth knowing before you point this at a vault you care about.

**"Almost instant" is one-way.** Local edits upload within about two seconds of
you stopping typing. Changes made on *another* device take up to the poll
interval to arrive — **30 seconds by default**. The Proton Drive API has no push
or websocket channel, so there is no way to do better than polling, and Proton's
[usage guidelines](https://github.com/ProtonDriveApps/sdk#operational-requirements)
ask third-party clients not to poll aggressively: an account that does can be
rate-limited. You can lower the interval in settings, down to a floor of 15
seconds, at your own risk. This is a limit of the service, not of this plugin.

**The SDK is not released for third-party use yet.** Proton's README allows
personal, non-commercial projects like this one and asks that they go through the
SDK rather than the raw API — which is what this does — but it also says the
interface may still change, and it describes a **cryptographic model change
targeted for late 2026 / early 2027** after which clients that have not been
updated will stop interoperating. If this plugin is not updated by then, it will
stop working.

**Desktop only.** Obsidian's renderer is subject to CORS, and Proton's API does
not allow the plugin's origin, so requests go out through Obsidian's `requestUrl`
— which exists only on desktop. Sign-in also uses Node's crypto.

**Encryption runs on the UI thread.** The SDK encrypts and decrypts in-process,
so a very large attachment can make Obsidian stutter while it transfers. Use
**Skip files larger than** in settings if that bites.

## Installing

There is no community-plugin listing. Build it and copy it in:

```bash
npm install
npm run build
```

Then copy `main.js`, `manifest.json` and `styles.css` into
`<your vault>/.obsidian/plugins/proton-drive-sync/`, and enable the plugin in
**Settings → Community plugins**.

For development, `npm run dev` rebuilds on change; point it at a test vault by
building into that vault's plugin folder.

## Setting it up

1. **Settings → Proton Drive Sync → Sign in.** A Proton page opens in your
   browser and you approve the device there. The plugin never sees your password,
   so two-factor, security keys and SSO all keep working.
2. **Choose a Drive folder.** Give the vault a folder of its own — everything in
   it is treated as part of the vault.
3. On each additional device, sign in and pick **the same folder**. The first
   sync pairs up files that already match, byte for byte, without transferring
   them.

## How conflicts are handled

A conflict is when a file changed *on both sides* since they last agreed. An edit
on one side only is not a conflict; it is just a sync.

| Setting | What happens |
| --- | --- |
| **Keep both versions** (default) | This device's version keeps its filename. The other is saved beside it as `note (conflict 2026-09-18 1431 from laptop).md`. Both then sync everywhere. |
| **Merge the changes** | Combines edits to different parts of a note — the usual shape after a device has been offline. Falls back to keeping both when the edits overlap, when the file is not text, or when the previous version is no longer in Drive's revision history. |
| **Keep whichever was edited last** | Uses modification times. Falls back to keeping both when they tie, or when Drive has no recorded time for the file. |
| **Keep this device's / Keep Drive** | The chosen side keeps the filename; the other is kept as a conflict copy unless you turn copies off. |
| **Ask me each time** | Nothing is written. The file is skipped until you choose, via **Show sync conflicts** in the command palette. |

Two cases ignore the setting, because there is no second version to choose
between: if a file was **deleted on one device and edited on the other**, the
edit always wins. A deletion can be repeated; a lost edit cannot be recovered.

Deletions that *aren't* contested do propagate, and locally they go to the system
trash rather than being erased.

## What is never synced

Regardless of settings: `.obsidian/workspace.json` and the other pane-layout and
cache files (devices fight over them), `.trash/`, `.git/`, `.DS_Store`,
`Thumbs.db`, and editor scratch files. `.obsidian` as a whole is excluded unless
you turn on **Sync Obsidian settings**.

Add your own exclusions as globs — `Private/`, `**/*.pdf` — in settings.

## How it works

```
vault events ─┐                                  ┌─ Drive events (polled)
              ├─→ batched ─→ reconcile() ─→ apply ┤
sync state ───┘                    │              └─ upload / download
                                   └─→ conflict ─→ policy ─→ merge / copy
```

`src/sync/reconcile.ts` is the core: a pure function from
(last-agreed version, local file, remote node) to one decision. It does all the
interesting thinking and none of the I/O, which is why the awkward cases have
tests rather than anecdotes.

| Path | What lives there |
| --- | --- |
| `src/sync/reconcile.ts` | The decision table. Pure. |
| `src/sync/merge.ts` | Line-level three-way merge. Pure. |
| `src/sync/engine.ts` | Watches both sides and applies decisions. |
| `src/sync/state.ts` | What the last sync agreed on, per path. |
| `src/proton/` | SDK wiring: transport, session, credentials. |
| `src/proton/account/` | Vendored from Proton's SDK repo — see its `VENDORED.md`. |

Run the tests with `npm test`. They cover the reconciliation table, the merge,
path filtering, the state store and the HTTP transport — everything that can be
exercised without a real vault and a real Proton account.

### Where your credentials live

The Proton session — access token, refresh token, and the password that unlocks
your keys — is encrypted with Electron's `safeStorage`, which holds the key in
your OS keychain, and written to `session.json` in the plugin folder. If no
OS-backed encryption is available, **the session is not written to disk at all**
and you sign in again next launch; it is never stored in the clear, because the
plugin folder is inside the vault it uploads.

The sync state in `sync-state.json` holds paths, node ids and content hashes. No
file contents, and no key material.

## Licence

MIT. Includes code vendored from
[ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk) (MIT); see
`src/proton/account/VENDORED.md`.

Not affiliated with or endorsed by Proton AG.
