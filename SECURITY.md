# Security model, and what this fork changes

This is a hardening fork of [Proton Drive Sync](https://github.com/MarckFp/obsidian-proton-sync).
The goal is the one the plugin's README cannot promise on its own: a Proton
session that other plugins cannot lift with one line, and logs that are safe to
paste into a bug report. Nothing here requires the user to set anything up.

Every claim below was measured on a running Obsidian 1.15.0 (plugin 0.11.4, then
this fork), by loading a second plugin that tries the attack for real — not by
reading the code and hoping. See "Measurements".

## Assets

| Asset | Where it lives | Consequence if taken |
| --- | --- | --- |
| Proton session: `accessToken`, `refreshToken`, `userKeyPassword`, `cacheKey` | OS keystore (desktop) or Obsidian secret storage | Full Drive access for the account, including everything outside the vault |
| Drive contents and metadata | vault (after sync), IndexedDB cache, logs | The user's notes, plus the layout of their Drive |
| Vault contents | plain files on disk | Readable and writable by any plugin regardless of this plugin |

## Adversaries, and what can actually be done about each

| Adversary | Closed by this fork? | How |
| --- | --- | --- |
| Another plugin reading the session through `app.secretStorage` | **Partly** — closed on desktop with a keystore, impossible on mobile | session moved to an encrypted file of the plugin's own (`session.bin`), old secret cleared |
| Another plugin reaching `plugins.plugins["proton-drive-sync"].session.getClient()` | **Yes** | session, engine, state, logger and the conflict queue live in module scope now, not on the plugin instance |
| Another plugin reading note names and node ids out of the log buffer, the console, or a pasted report | **Yes** | every log line is redacted at the logger: `«file a1b2c3»`, `«node»` |
| Another plugin reading the account address out of `sync-state.json` | **Yes** | the file stores a one-way tag instead of the address |
| A file or token going to a host that is not Proton's | **Yes** | every request is parsed and refused unless the host is `proton.me` / `proton.ch` over HTTPS |
| Another plugin reading the vault, and with it every synced note | No — **cannot be** | a plugin that can read files can read the vault; the sync is not the cause |
| Another plugin capturing `Authorization` headers for every request in the app (Electron `webRequest`) | No — **cannot be, in this process** | needs a separate process for the network, which ends the "pure plugin" property and desktop-only |
| Other OS users, or a stolen disk | Depends on the OS keystore | the encrypted file is only as strong as the keyring behind it; on a machine without one, the plugin says so in the log and falls back |
| Someone who can write to the shared Drive folder | No | they can put files in the vault; the plugin's existing path and name checks are what contain them |

Two of those are worth stating plainly, because they bound what "hardening"
means here: **inside one Obsidian process there is no boundary between
plugins.** Any credential the plugin can use, another plugin can obtain — if not
by a property lookup, then by patching Electron's network stack or reading the
file the plugin wrote. Source changes can remove every *convenient* path (they
now are removed), but they cannot remove the capability.

## What changed, in code

- `src/runtime.ts` — the session, engine, state, conflict history, device list,
  PIN slot, logger and pending-conflict queue moved off the plugin instance into
  module scope. The instance keeps only UI-facing methods that return no
  credentials (`syncNow`, `setPaused`, `openPanel`, …).
- `src/proton/secretStore.ts` — `SafeStorageFileSlot` stores the session and the
  PIN-unlock material in `session.bin` / `unlock.bin` inside the plugin's own
  folder, encrypted by Electron `safeStorage` (DPAPI, Keychain, libsecret).
  `migrateSecret` moves an existing session out of Obsidian's secret storage on
  first launch and clears the old copy, so upgrading does not sign anyone out.
  Mobile keeps Obsidian's secret storage: there is no keystore and no Node there.
- `src/util/logger.ts` — `redactNames`: quoted names and paths, bare file-like
  tokens, addresses and long node ids are replaced with stable tokens before
  anything is written to the buffer or the console. `logShowsNames` (off by
  default) restores the real names for a report.
- `src/proton/endpoints.ts` — `assertProtonUrl`, called in the one place every
  request is built; the host is parsed, not pattern-matched, so
  `proton.me.evil.example` is refused.
- `src/sync/state.ts` — the state file keeps `tag:xxxxxxxx` instead of the
  account address; existing files are rewritten on load.

## Measurements

Adversary plugin (`proton-drive-sync` 0.11.4 before, this fork after), same
vault, same machine:

| Probe | Before | After |
| --- | --- | --- |
| `plugins.plugins["proton-drive-sync"].session.getClient()` | returns an authenticated client | `undefined` |
| Listing the Drive root through it | succeeded | impossible — nothing reachable |
| `secretStorage.listSecrets()` proton ids | 2 | 2 in the test container (no keyring → documented fallback); 0 with a keystore, unit-tested |
| `sync-state.json` contains the address | yes | no (`tag:…`) |
| Log lines carrying note names | yes | `GET «file 6ffe59» 200 (351ms)` |
| Sync still works during the change | — | yes: soak test continued, 41 notes, `pending: 0`, `retries: 0` |

## Watching the other plugins

Every plugin in the vault can read the vault and this plugin's sign-in, so the
set of installed plugins is part of the security model. At each start the plugin
fingerprints the others — a sha-256 of each `main.js`, not only the version a
plugin writes about itself — compares it with the previous start, and reports
what is new, changed or gone, in a notice and in Settings → Proton Drive Sync →
Security. `watchOtherPlugins` turns it off.

It is **tamper-evident, not tamper-proof**: a hostile plugin shares the process
and could rewrite the record. It covers the realistic cases — a plugin you
installed once updates itself, or a new one appears — instead of those happening
in silence.

Measured: appending a line to another plugin's `main.js` and restarting produced
`Attacker Probe (code changed) changed since the last start. Any plugin here can
read this vault and the Proton sign-in — check Settings → Community plugins.`,
and the settings section listed the change with the new fingerprint.

## Not done yet

- The desktop keystore path cannot be exercised in the headless test container
  (no Secret Service), so it is covered by unit tests rather than end-to-end.
  It needs one run on a real desktop to be called verified.
- The device-list files on Drive still carry the account address, because the
  list shows which account a device uses. Removing it changes a file format and
  is a separate decision.
- `session.bin` is only as good as the OS keyring. The plugin logs a warning
  when it has to fall back, rather than pretending otherwise.
