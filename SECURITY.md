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
| Another plugin reading the account address out of `sync-state.json` | **Yes** | the file stores an obscured tag (`tag:2c412a28`, a 32-bit hash) instead of the address; it keeps the address out of the file, and can be confirmed against a candidate address |
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

An update is announced by Obsidian, with a changelog, so repeating "plugin X
changed" says nothing the user does not already know. Two things an update
notice never says are kept:

- **the same version with different code** — an update does not produce that, so
  it means the bundle was replaced some other way;
- **an update whose code starts mentioning credential APIs it did not mention
  before** (`safeStorage`, `plugins.plugins`, this plugin's id) — which is what
  "this plugin can now read the sign-in" looks like from the outside.
  `secretStorage` is deliberately not one of them: Obsidian recommends it for a
  plugin's own API keys, so adopting it is not a security event, and warning
  about it made the notice untrustworthy.

Versions, additions and removals are still recorded (sha-256 of each `main.js`,
not the version a plugin writes about itself) and folded away in Settings →
Proton Drive Sync → Security; only the two cases above raise a notice.
`watchOtherPlugins` turns it off.

It is **tamper-evident, not tamper-proof**: a hostile plugin shares the process
and could rewrite the record. It is also name-based — a bundle that reaches for
the secret storage through a reference saved earlier will not mention the name.

Measured on the rig, all three cases:

| Change made to another plugin | Result |
| --- | --- |
| a line appended, version untouched | `Attacker Probe — same version 1.0.0, different code — an update does not do that` |
| `1.2.0 → 1.3.0`, ordinary code | no notice; `3 other plugin(s); nothing since the last start that Obsidian would not already tell you`, update listed under a fold |
| `1.0.0 → 1.2.0` with a `safeStorage` reference added | `Share Probe — 1.0.0 → 1.2.0 now mentions safeStorage` |
| `1.0.0 → 1.2.0` with a `secretStorage` reference added | no notice: plugins are told to use it for their own keys |


## Capability, not only credentials

Removing the tokens from reach is not enough: the plugin's own methods stay
callable from every other plugin, and some of them act on the user's data.
`shareNote()` created a public read-only link to any note — exfiltration with the
user's own keys, no token needed. `signOut()` and `restoreVersion()` were the
same kind of lever.

`security/capability.ts` generates a token in module scope and hands it to this
plugin's UI only. Those three methods now refuse to run without it:

```
shareNote("README.md")          -> Refusing a share link: it was not asked for from this plugin's own interface
signOut()                       -> Refusing signing out: …
restoreVersion("README.md", …)  -> Refusing restoring an old version: …
```

Measured with a probe plugin that made exactly those three calls.

## Tripwires, and what they are worth

`security/tripwire.ts` wraps the shared `app.secretStorage` methods once and puts
trap getters on the plugin instance for the names a hostile plugin tries first
(`session`, `client`, `credentials`…). A call that touches this plugin's ids is
attributed through the plugin frame in the stack (`plugin:<id>:<line>:<col>`, or
`/plugins/<id>/main.js` on older builds) and recorded, in Settings and on disk.

The wrappers are **restored in `onunload`**. Leaving them in place after a
reload is worse than not having them: they keep calling the instance that was
unloaded, and the "already installed" guard stops the new instance from wiring
its own — so its report stays empty while the settings page claims to be
watching.

## Who can write the code, and is it still the code

- `security/permissions.ts` reports a plugin folder, `main.js`, `session.bin` or
  `.obsidian` that other users can write (mode bits, desktop only). Whoever can
  replace `main.js` runs code with the user's keyring, which defeats the
  encrypted session entirely. It warns by default; `refuseOnInsecurePermissions`
  pauses syncing instead.
- `security/selfIntegrity.ts` records the digest of `main.js` with its version at
  install. Same version and different code is not an update, and is reported as
  `changed-without-update` with a notice that says to treat the sign-in as
  exposed.

Measured: with the folder at `0777` the settings section listed
`the plugin folder is writable by anyone on this machine (0777)` and
`this plugin's own code is writable by anyone on this machine`; replacing
`main.js` without bumping the version produced `Changed without a new version —
treat the sign-in as exposed`.

Caveat from that test: the check sees the permissions the app sees. In a
container or on a share the mount can present `0700` while the host has `0777`,
and this cannot tell.


## Verified on a real desktop (2026-11-03, X13, Obsidian 1.14.5 Flatpak)

The keystore path cannot be exercised in the headless test container, so it was
checked on a laptop with GNOME keyring running:

| Check | Result |
| --- | --- |
| Secret Service on the session bus | `org.freedesktop.secrets` → `gnome-keyring-daemon` |
| libsecret round-trip (store/lookup/clear) | works for the login user |
| Existing Safe Storage entries | `chrome_libsecret_os_crypt_password_v2` present, so Electron has a real store |
| `session.bin` after sign-in | 452 bytes, base64 ciphertext, **no** `accessToken`/`refreshToken`/`userKeyPassword` in plaintext |
| Session left in Obsidian's secret storage | none: the leveldb holds the id string only, zero token material |
| `sync-state.json` | `"accountEmail":"tag:2c412a28"` — no address |
| Sync on that device | 45 files pulled; `README.md` byte-identical (sha256 `358b820c…`) to the NAS copy |
| Self-integrity record | `plugin-self.json` written on first start |

That closes the last open question from the earlier measurement: on a machine
where the OS can encrypt, the plugin uses the encrypted file and leaves nothing
readable behind, and sync still works.


## The metadata cache

The SDK keeps the names, sizes and revisions it has loaded in IndexedDB between
starts, encrypted with a key that lives inside the session. That is what makes a
restart cheap — measured on the test vault: a warm start takes 10 s, the same
start without the cache 19 s, and the gap grows with the number of folders.

It also held names the vault does not have on disk: folders browsed while
choosing where the vault would live. Those entries are now dropped at write time
(`persistentCache.nodeScope`). The SDK keys a node `node-<uid>` and a volume
`volume-<id>`, so the filter strips that prefix and compares the uid with what
the sync state knows; an entry is also kept when its own parent tag names a node
the state knows, which covers a file made a moment ago and the files in
`.devices`. The synced folder, the folders above it and `.devices` are handed to
the filter explicitly, because they are read on every start but never reach the
state. Entries that carry no names at all (shares, volumes, keys) are kept.
In-memory behaviour is unchanged; only what survives a restart is filtered.

Clearing the cache is no longer a security measure — whoever can read it can
read the session it is keyed from — so it is a button ("Clear cached Drive
metadata") for the cases where a rebuild is wanted, not something that happens
on lock.

## Not done yet



- The desktop keystore path cannot be exercised in the headless test container
  (no Secret Service), so it is covered by unit tests rather than end-to-end.
  It needs one run on a real desktop to be called verified.
- The device-list files on Drive still carry the account address, because the
  list shows which account a device uses. Removing it changes a file format and
  is a separate decision.
- `session.bin` is only as good as the OS keyring. The plugin logs a warning
  when it has to fall back, rather than pretending otherwise.
