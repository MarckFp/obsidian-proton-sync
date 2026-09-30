# Proton Drive Sync for Obsidian

Bidirectional sync between an Obsidian vault and a folder in Proton Drive, built
on Proton's [official Drive SDK](https://github.com/ProtonDriveApps/sdk). Your
notes are end-to-end encrypted by the SDK before they leave the device, with the
same implementation Proton's own clients use.

> [!WARNING]
> **This plugin is vibe-coded.** It was written largely by an AI coding
> assistant, with a human directing and reviewing the work rather than writing
> every line. It has automated tests, but it has not been through a security
> audit or long real-world use, and it syncs, and can delete, the files in your
> vault. Try it on a copy of a vault first, keep backups, and expect bugs.

> **Status: alpha, and it depends on a pre-release SDK.** Read
> [Before you rely on this](#before-you-rely-on-this) first. Keep a backup.

## What it does

- **Two-way sync** of the whole vault — notes, attachments (images, video,
  audio, PDFs), folders, and your `.obsidian` settings.
- **Renames stay renames.** Renaming or moving a note or folder, here or on
  another device, renames the same file on the other side, keeping its Drive
  revision history.
- **Three-way conflict detection.** Every synced file records the version both
  sides last agreed on, so a device that has been offline for a week can tell an
  edit it missed from an edit it made. Only a genuine double-edit is reported as
  a conflict.
- **Conflict remediation**, from keeping both copies (the default — nothing is
  ever silently overwritten) to a line-level three-way merge that combines edits
  made to different parts of a note.
- **Conflict notifications.** When a file changed in two places, a notice names
  it and says how it was settled. Click the file name to open it.
- **Side-by-side comparison of conflicts.** See exactly what differs between two
  versions of a note, as a code review would show it: lines only in one version
  in red with `-`, lines only in the other in green with `+`, and the changed
  words highlighted. Then pick which version to keep from the same window.
- **A preview before the first sync.** When a vault with files meets a Drive
  folder with files, you see what will be uploaded, downloaded and treated as a
  conflict before anything moves, and can hold off.
- **Pause and resume**, from the status bar, the command palette or settings.
- **A status bar that says what is happening**: files checked in the current
  pass, the progress of a large upload or download, and how long ago the last
  sync finished.
- **Mobile-friendly options**: sync on Wi-Fi only (Android), and leave large
  files for a computer to sync.
- **Event-based updates.** Changes from other devices arrive through Drive's
  event feed rather than by re-walking the tree.

## Before you rely on this

A few things are worth knowing before you point this at a vault you care about.

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

**Desktop and mobile.** The plugin runs on Windows, macOS, Linux, Android and
iOS. Requests go out through Obsidian's `requestUrl` on every platform, and
sign-in and encryption use only web APIs. Differences on mobile:

- Large attachments are held in memory while they transfer, because streaming
  to disk needs Node, which mobile does not have. A multi-gigabyte video can
  exhaust a phone's memory; set **Leave large files for other devices** under
  **On phones and tablets** in settings. It applies to phones and tablets only,
  so one vault can have the same setting everywhere.
- **Sync on Wi-Fi only** holds the sync while on mobile data. Only Android tells
  apps which kind of connection they are on, so on iOS it has no effect.
- The OS suspends Obsidian in the background, so nothing syncs while the app is
  closed. Pending edits are pushed when you leave the app, and Drive is checked
  as soon as you come back.
- Sign-in opens Proton in the system browser. Approve the device there, then
  switch back to Obsidian, where it completes on its own.

Mobile support is new and has had far less testing than desktop.

**Encryption runs on the UI thread.** The SDK encrypts and decrypts in-process,
so a very large attachment can make Obsidian stutter while it transfers. On
desktop, files over 32 MB are streamed to and from disk rather than held in memory, so size is
not a hard limit, but use **Skip files larger than** in settings if the
stutter bites.

**Requires Obsidian 1.13.7 or later.**

## Installing

There is no community-plugin listing. Build it and copy it in:

```bash
npm install
npm run build
```

Then copy `main.js`, `manifest.json` and `styles.css` into
`<your vault>/.obsidian/plugins/proton-drive-sync/`, and enable the plugin in
**Settings → Community plugins**.

On Android and iOS, put the same three files in that folder of the vault on the
device, using a file manager, a USB cable, or a plugin installer such as BRAT.

For development, `npm run dev` rebuilds on change; point it at a test vault by
building into that vault's plugin folder.

## Setting it up

The first time the plugin loads, a setup window walks you through it. It only
appears once. To see it again, run **Open setup assistant** from the command
palette. Everything it sets is also in **Settings → Proton Drive Sync**.

1. **Sign in.** A Proton page opens in your browser and you approve the device
   there. The plugin never sees your password, so two-factor, security keys and
   SSO all keep working.
2. **Choose a Drive folder.** Give the vault a folder of its own — everything in
   it is treated as part of the vault.
3. **Choose whether to sync Obsidian settings** (on by default), then **Start
   syncing**. Nothing is transferred before that.

If both the vault and the Drive folder already hold files, the first sync shows
a preview first: how many files will be downloaded, uploaded, or are on both
sides with different content, with the file names one click away. **Start
syncing** goes ahead; **Not now** pauses syncing until you resume it. A first
sync never deletes anything on either side. The same preview appears after
**Rebuild sync state** or a change of Drive folder, which are first syncs too.

On each additional device, sign in and pick **the same folder**. The first sync
pairs up files that already match, byte for byte, without transferring them.
Settings from Drive take precedence over a new device's defaults. Restart
Obsidian after that first sync so it loads them.

## How conflicts are handled

A conflict is when a file changed *on both sides* since they last agreed. An edit
on one side only is not a conflict; it is just a sync.

| Setting | What happens |
| --- | --- |
| **Keep both versions** (default) | This device's version keeps its filename. The other is saved beside it as `note (conflict 2026-09-18 1431 from laptop).md`. Both then sync everywhere. |
| **Merge the changes** | Combines edits to different parts of a note — the usual shape after a device has been offline. Falls back to keeping both when the edits overlap, when the file is not text, or when the previous version is no longer in Drive's revision history. |
| **Keep whichever was edited last** | Uses modification times. Falls back to keeping both when they tie, or when Drive has no recorded time for the file. |
| **Keep this device's / Keep Drive** | The chosen side keeps the filename; the other is kept as a conflict copy unless you turn copies off. |
| **Ask me each time** | Nothing is written. The file is skipped until you choose, via **Show sync conflicts** in the command palette or the status bar's right-click menu. |

### Comparing versions

Under **Ask me each time**, each file in **Show sync conflicts** has a
**Compare** button. It shows this device's version against the one on Drive as
a diff: lines only on this device in red with `-`, lines only on Drive in green
with `+`, a few unchanged lines around each change, and the rest folded away.
The Markdown is shown as source, so a changed link target or heading level is as
visible as a changed word. **Keep both**, **Keep this device** and **Keep Drive**
are right underneath.

Under the other policies, a conflict usually leaves a conflict copy beside the
note. Open either file and run **Compare with conflict copy** from the command
palette, or click **Compare** in the conflict notice. From the diff you can keep
the note and delete the copy, or replace the note with the copy. The copy goes
to Obsidian's trash either way, so a wrong choice can be undone.

Two cases ignore the setting, because there is no second version to choose
between: if a file was **deleted on one device and edited on the other**, the
edit always wins. A deletion can be repeated; a lost edit cannot be recovered.

Deletions that *aren't* contested do propagate, and locally they go to the system
trash rather than being erased. A file is only removed from the vault when Drive
confirms it was deleted or trashed. A file that is merely missing from the Drive
folder — moved elsewhere in Drive, or not found because a request failed — is
kept, and uploaded again if needed.

Files in the `.obsidian` folder never get conflict copies, since Obsidian would
never read them. When a new device joins, Drive's copy wins. Otherwise the most
recent edit wins.

## Pausing, progress and troubleshooting

Click the status bar item to sync now, or to resume when paused. Right-click it
for **Pause syncing**, **Show sync conflicts** and the settings. The same
actions are in the command palette, which is the only way on mobile, where
Obsidian has no status bar.

While paused, nothing is uploaded, downloaded or polled. Edits made in the
meantime, on this device or elsewhere, are found by the full sync that runs when
you resume. The pause is remembered across restarts.

While a sync runs, the status bar shows how many files of the current pass have
been checked (`Syncing 120/4000`), or the progress of a large transfer
(`↑ lecture.mp4 45%`). When idle, it says how long ago the last sync finished.

If something goes wrong, **Copy sync log** (in the command palette, or under
**Recent activity** in settings) copies the recent log with the plugin and
Obsidian versions, ready to paste into a bug report. It includes file names, so
look it over before sharing it.

## What is never synced

Regardless of settings: `.obsidian/workspace.json` and the other pane-layout and
cache files (devices fight over them), this plugin's own sign-in, sync state and
settings (they belong to each device), `.trash/`, `.git/`, `.DS_Store`,
`Thumbs.db`, and editor scratch files. `.obsidian` as a whole is excluded if you
turn off **Sync Obsidian settings**.

Add your own exclusions as globs — `Private/`, `**/*.pdf` — in settings. A
pattern that would not do what it looks like, such as one with a leading `/` or
Windows `\` separators, is flagged under the field as you type.

## Using several devices at once

Each device keeps its own record of the last version it agreed on with Drive, so
devices never need to be online together. What to expect when they are:

- **The same note edited on two devices before either syncs** is a conflict,
  resolved by your conflict setting. By default both versions are kept.
- **The same note saved on two devices within seconds of each other.** Drive
  has no way to reject an upload because another one just landed, so both
  succeed. After each upload the plugin checks the file's revision history, and
  keeps a version it has just replaced as a conflict copy. Nothing is lost, but
  you may see a conflict copy for what felt like one edit.
- **A new note with the same name created on two devices** is a conflict too,
  resolved the same way.
- **A note deleted on one device while it is edited on another**: the edit
  wins, as above. If the deletion reaches Drive in the moment between the other
  device's check and its upload, the edit ends up in the Drive trash, where you
  can restore it.
- **Renames on two devices at once**: the last one to reach Drive wins, and the
  other device follows it.
- **"Keep whichever was edited last"** compares modification times from
  different devices, so it is only as good as their clocks.
- **Each device names its conflict copies** after itself. On mobile the default
  name is the platform, such as "iPhone". Give each device a distinct name in
  the settings if you have two of the same kind.
- **Changes from other devices arrive** on the next Drive check, 30 seconds by
  default.
- **Names that differ only in letter case**, such as `Note.md` and `note.md`, can
  exist side by side on Drive, Linux and Android. They are the same file on
  Windows, macOS and iOS. Such pairs are left alone, with a warning in the
  plugin's log, until you rename one of them.
- **On Windows, a file open in another program** (a video in a player, say) may
  be locked, and an update to it waits until the next sync after it is closed.

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

Run the tests with `npm test` and the Obsidian review rules with `npm run lint`;
CI runs both. The tests cover the reconciliation table, the merge, the diff,
path filtering, the state store and the HTTP transport — everything that can be
exercised without a real vault and a real Proton account.

### Where your credentials live

The Proton session — access token, refresh token, and the password that unlocks
your keys — is kept in Obsidian's secret storage. That storage belongs to the
device, not the vault, and uses the platform's keystore where there is one. It
is never written inside the vault, so it is never synced, and a copied vault
does not carry your sign-in with it. Each device signs in on its own. Sessions
saved by version 0.1.0 in `session.json` are moved into secret storage on the
first launch, and the file is deleted.

The sync state in `sync-state.json` holds paths, node ids and content hashes. No
file contents, and no key material.

## Permissions and disclosures

Obsidian's plugin review flags some of what this plugin does. Here is each one
and why it is there.

- **Network.** The plugin talks to Proton's API (`*.proton.me`) and nothing
  else, through Obsidian's `requestUrl`. File contents and names are encrypted
  on the device before they leave it.
- **Filesystem access outside the vault API (desktop only).** On desktop, files
  over 32 MB are streamed with Node's `fs` and hashed with Node's `crypto`
  instead of being read whole into memory, and downloads are written to a
  temporary file beside the target and renamed into place once complete. Only
  paths inside the vault are opened, resolved through the adapter's own
  `getFullPath`. On mobile, where there is no Node, everything goes through the
  adapter and large files are read whole.
- **No telemetry.** The Drive SDK's metrics are dropped, not sent (see
  `src/proton/telemetry.ts`).
- **Clipboard.** Write only, and only when you ask: "Copy link" in the sign-in
  dialog copies the Proton sign-in link, and "Copy sync log" copies the recent
  log. The plugin never reads the clipboard.
- **Dynamic code (`Function` / `new Function`).** Not in the plugin's own code.
  It comes from two bundled libraries: `ttag`, the translation library inside
  Proton's Drive SDK, which compiles plural-form rules, and `core-js`, whose
  polyfills use it for feature detection (`Function("return this")` and an
  async-generator probe). None of it runs on file contents or on anything
  received from the network.
- **Obsidian's secret storage** holds the Proton session; see
  [Where your credentials live](#where-your-credentials-live).

## Licence

Copyright (C) 2026 maez.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

GPL-3.0 because the built plugin bundles `@protontech/crypto`, which Proton
publishes under GPL-3.0, so the `main.js` users install has to be distributed
under the GPL anyway. Other bundled packages keep their own licences and are
listed in a header at the top of `main.js`, among them Proton's OpenPGP.js fork
(LGPL-3.0+) and several MIT and BSD packages, all compatible with the GPL.

`src/proton/account/` is vendored from
[ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk) and stays under
its original MIT licence (© Proton AG); see `src/proton/account/LICENSE.md` and
`src/proton/account/VENDORED.md`.

Not affiliated with or endorsed by Proton AG.
