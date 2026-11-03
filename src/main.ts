// Must be first: the SDK and its crypto reach for runtime APIs that older
// Electron builds lack, and they fail deep inside a transfer rather than at
// load time.
import './polyfills';

import { getRuntime } from './runtime';
import { watchPlugins } from './security/pluginWatch';
import { installTripwires, type TripwireHit } from './security/tripwire';
import { requireUi, uiProof } from './security/capability';
import { checkPermissions } from './security/permissions';
import { checkSelf } from './security/selfIntegrity';
import {
    apiVersion,
    type App,
    MarkdownView,
    Notice,
    Platform,
    Plugin,
    setIcon,
    setTooltip,
    TAbstractFile,
    TFile,
    TFolder,
} from 'obsidian';

import { Credentials } from './proton/credentials';
import { PinProtectedSlot, RememberedUnlock } from './proton/pinLock';
import { ConflictHistory } from './sync/conflictHistory';
import {
    decryptLegacySession,
    encryptedStorage,
    migrateSecret,
    ObsidianSecretSlot,
    SafeStorageFileSlot,
    type SecretSlot,
} from './proton/secretStore';
import { ProtonSession } from './proton/session';
import { DEFAULT_SETTINGS, type PluginSettings } from './settings';
import { FolderPickerModal, type ChosenFolder } from './ui/folderPickerModal';
import { DeviceList, DeviceRegistry, nextRequestAt, type DeviceRequest, type FolderMemory } from './sync/devices';
import { DriveIO, sharedWithOthers } from './sync/drive';
import { SyncEngine, type ConflictEvent, type OpenEditor, type SyncPlan, type SyncSummary } from './sync/engine';
import { errorMessage } from './sync/engine/helpers';
import { SyncState } from './sync/state';
import { formatLogEntries, Logger, setLogShowsNames } from './util/logger';
import { compareConflictCopyOf, compareWithConflictCopy, conflictPairsFor, versionComparison } from './ui/compare';
import { showConflictNotice } from './ui/conflictNotice';
import { ConflictsModal } from './ui/conflictsModal';
import { DeviceRemovedModal, DevicesModal } from './ui/devicesModal';
import { FirstSyncModal } from './ui/firstSyncModal';
import { PinFormModal, UnlockModal } from './ui/pinModals';
import { ReloadModal } from './ui/reloadModal';
import { CONFLICT_POLICIES, ProtonDriveSyncSettingsTab } from './ui/settingsTab';
import { SetupModal } from './ui/setupModal';
import { ShareModal } from './ui/shareModal';
import { StatusBar } from './ui/statusBar';
import { SYNC_PANEL_VIEW, SyncPanelView } from './ui/syncPanel';
import { type NoteIndicator, noteIndicator, statusIcon, statusLabel, statusSpins } from './ui/syncStatus';

/** The plugin's own handles; see runtime.ts for why they are not on the instance. */
const runtime = getRuntime();

/** Where 0.1.0 kept the session; migrated into secret storage on first load. */
const LEGACY_SESSION_FILE = 'session.json';
const STATE_FILE = 'sync-state.json';
/** The session, encrypted by the OS keystore; never in the vault's plain sight or in secret storage. */
const SESSION_SECRET_FILE = 'session.bin';
/** The PIN-unlock material, same treatment. */
const UNLOCK_SECRET_FILE = 'unlock.bin';
const CONFLICT_HISTORY_FILE = 'conflict-history.json';
/** Local-storage key for the installation id; see {@link ProtonDriveSyncPlugin.installationId}. */
const CLIENT_UID_KEY = 'proton-drive-sync-client-uid';
/**
 * Local-storage key for the last request from the device list this device
 * acted on; see {@link DeviceList}. Kept with the installation id rather than
 * in the settings, which another sync tool might copy to a different device.
 */
const HANDLED_REQUEST_KEY = 'proton-drive-sync-device-request-handled';
/** Where the device list's folder was found, so a start need not search the synced folder for it. */
const DEVICES_FOLDER_KEY = 'proton-drive-sync-devices-folder';

/** Conflicts found within this long of each other share one notice. */
const CONFLICT_NOTICE_DELAY_MS = 1500;

/** How often the status bar's "synced 5m ago" is brought up to date. */
const STATUS_REFRESH_MS = 30_000;

/**
 * How often a paused device checks the device list for a request, such as
 * being resumed. Paused, it reads none of Drive's changes, which is how it
 * learns of one otherwise; a couple of small reads every two minutes is all
 * this costs, and only while paused.
 */
const PAUSED_REQUEST_CHECK_MS = 2 * 60_000;

/** How often the PIN's time limit is checked while Obsidian is open. */
const LOCK_CHECK_MS = 15_000;
/** How often, at most, a remembered unlock's expiry is pushed back while Obsidian is in use. */
const REMEMBER_SAVE_MS = 60_000;

/**
 * The Network Information API, where the WebView has it: Android does, iOS
 * does not. Only `type` is used, to tell cellular from Wi-Fi.
 */
type NetworkConnection = {
    type?: string;
    addEventListener(type: 'change', listener: () => void): void;
    removeEventListener(type: 'change', listener: () => void): void;
};

function networkConnection(): NetworkConnection | undefined {
    return (navigator as Navigator & { connection?: NetworkConnection }).connection;
}




export default class ProtonDriveSyncPlugin extends Plugin {
    // Obsidian declares `settings?: unknown` on Plugin; this narrows it.
    declare settings: PluginSettings;
    /** Where the Proton session is kept, encrypted with the user's PIN if they set one. */
    /** The stored session is PIN-protected and has not been unlocked in this run. */
    locked = false;
    /** Whether a PIN protects the stored session; cached for the settings tab, which renders synchronously. */
    pinEnabled = false;
    /** Wrong PINs entered so far in this run; see {@link UnlockModal}. */
    private readonly pinFailures = { count: 0 };
    private unlocking: Promise<boolean> | null = null;
    /** The unlocked PIN key, kept across restarts when the PIN has a time limit. */
    private rememberedUnlock!: RememberedUnlock;
    /** Last time the user did anything in Obsidian; measures "away" for the PIN's time limit. */
    private lastActivity = Date.now();
    private lastRememberSave = 0;
    private settingsTab: ProtonDriveSyncSettingsTab | null = null;
    /** What the settings tab last rendered from; see {@link refreshSettingsTab}. */
    private settingsTabKey = '';
    /** This device's place in the vault's device list; see {@link DeviceList}. */
    /** This installation's id: the SDK's client id, and the device's id on the device list. */
    /** The device list is off because the vault is shared with other people; see {@link openDeviceList}. */
    private devicesOffForSharing = false;

    private statusBar!: StatusBar;
    /** The ribbon icon standing in for the status bar on mobile; null on desktop. */
    private ribbonIcon: HTMLElement | null = null;
    /** The sync-state button added to each note's header on mobile; see {@link updateNoteIndicators}. */
    private readonly noteActions = new WeakMap<MarkdownView, HTMLElement>();
    /** What the status bar, ribbon icon and panel currently show. */
    private summary!: SyncSummary;
    private conflictNoticeTimer: number | null = null;
    /** Tripwire hits already announced, so a repeating caller is not a stream of notices. */
    private tripwireNotices: Set<string> | null = null;

    override async onload(): Promise<void> {
        await this.loadSettings();

        runtime.logger = new Logger(this.settings.logLevel);
        // After the workspace is ready, so the first start of the day does not
        // delay anything the user is waiting for.
        setLogShowsNames(this.settings.logShowsNames ?? false);
        // Nothing can stop a plugin in this process, but the moment one reaches
        // for the sign-in it can be named. See security/tripwire.ts.
        runtime.tripwire = installTripwires({
            app: this.app,
            selfId: this.manifest.id,
            instance: this,
            logger: runtime.logger.getLogger('security'),
            onHit: (hit) => {
                const announced = this.tripwireNotices ?? (this.tripwireNotices = new Set<string>());
                const key = `${hit.by ?? 'unknown'}:${hit.wire}`;
                if (announced.has(key)) {
                    return;
                }
                announced.add(key);
                runtime.logger.warn(`Tripwire: ${hit.by ?? 'something'} reached ${hit.wire}`);
                void this.rememberTripwireHit(hit);
                new Notice(
                    `Proton Drive Sync: ${hit.by ?? 'something'} reached for the Proton sign-in (${hit.wire}). ` +
                        'Settings → Proton Drive Sync → Security lists it.',
                    15000,
                );
            },
        });
        this.statusBar = new StatusBar(this.addStatusBarItem(), {
            syncNow: () => void this.syncNowOrSetUp(),
            togglePause: () => void this.setPaused(!this.settings.paused),
            showConflicts: () => new ConflictsModal(this.app, this).open(),
            openPanel: () => void this.openPanel(),
            openSettings: () => this.openSettings(),
        });
        this.registerView(
            SYNC_PANEL_VIEW,
            (leaf) =>
                new SyncPanelView(leaf, {
                    summary: () => this.summary,
                    pendingChanges: () => runtime.engine.pendingChanges(),
                    activeNote: () => this.app.workspace.getActiveFile()?.path ?? null,
                    canListVersions: () => this.isConfigured() && !this.locked && runtime.engine.isConnected(),
                    versionsKey: (path) => runtime.engine.versionsKey(path),
                    noteVersions: (path) => runtime.engine.noteVersions(path),
                    compareVersion: (path, version) => versionComparison(this, path, version),
                    shareNote: (path) => this.shareNote(path, uiProof()),
                    recentlyDeleted: () => runtime.engine.recentlyDeleted(),
                    restoreDeleted: async (item) => {
                        await runtime.engine.restoreDeleted(item);
                        new Notice(`Restored "${item.path}"; it is back in the vault after the next check.`);
                    },
                    pollSeconds: () => runtime.engine.pollSeconds(),
                    sharedBy: () => this.settings.remoteFolderSharedBy,
                    openFile: (path) => void this.app.workspace.openLinkText(path, '', false),
                    syncNow: () => void this.syncNowOrSetUp(),
                    togglePause: () => void this.setPaused(!this.settings.paused),
                    showConflicts: () => new ConflictsModal(this.app, this).open(),
                    openSettings: () => this.openSettings(),
                }),
        );
        // Obsidian's mobile app has no status bar, so there the ribbon, which
        // it shows in the sidebar and the ribbon menu, carries the status.
        if (Platform.isMobile) {
            this.ribbonIcon = this.addRibbonIcon('refresh-cw', 'Proton Drive Sync', () => void this.openPanel());
        }
        this.registerInterval(window.setInterval(() => this.refreshStatus(), STATUS_REFRESH_MS));
        this.registerInterval(
            window.setInterval(() => {
                if (this.settings.paused && this.devicesAvailable()) {
                    void this.checkDeviceRequests();
                }
            }, PAUSED_REQUEST_CHECK_MS),
        );

        const clientUid = this.installationId();
        runtime.clientUid = clientUid;
        const protonLogger = runtime.logger.getLogger('proton');
        // The session goes into an encrypted file of our own when the OS can
        // encrypt at all, so that it is not sitting in the one namespace every
        // other plugin can read; Obsidian's secret storage stays the home on
        // mobile, where there is no keystore and no Node. See SECURITY.md.
        const safeStorage = encryptedStorage(protonLogger);
        const legacySession = new ObsidianSecretSlot(
            this.app.secretStorage,
            `proton-drive-sync-session-${clientUid}`,
        );
        const legacyUnlock = new ObsidianSecretSlot(this.app.secretStorage, `proton-drive-sync-unlock-${clientUid}`);
        const sessionInner: SecretSlot = safeStorage
            ? new SafeStorageFileSlot(this.app.vault.adapter, this.pluginFile(SESSION_SECRET_FILE), safeStorage)
            : legacySession;
        const unlockInner: SecretSlot = safeStorage
            ? new SafeStorageFileSlot(this.app.vault.adapter, this.pluginFile(UNLOCK_SECRET_FILE), safeStorage)
            : legacyUnlock;
        if (safeStorage) {
            // Upgrading: move what an older version left in secret storage, so
            // nobody is signed out and the old, readable copy goes away.
            await migrateSecret(legacySession, sessionInner);
            await migrateSecret(legacyUnlock, unlockInner);
        }
        runtime.sessionSlot = new PinProtectedSlot(sessionInner);
        this.rememberedUnlock = new RememberedUnlock(unlockInner);
        const credentials = new Credentials(
            runtime.sessionSlot,
            {
                adapter: this.app.vault.adapter,
                path: this.pluginFile(LEGACY_SESSION_FILE),
                decrypt: (payload) => decryptLegacySession(payload, protonLogger),
            },
            protonLogger,
        );
        runtime.session = new ProtonSession(credentials, clientUid, protonLogger, () => runtime.state.cursorsFingerprint());
        // The metadata cache keeps only nodes the vault syncs; see security/capability.ts
        // and persistentCache.nodeScope.
        runtime.session.setNodeSource(() => new Set(runtime.state.entries().map((record) => record.nodeUid)));
        runtime.state = new SyncState(
            this.app.vault.adapter,
            this.pluginFile(STATE_FILE),
            runtime.logger.getLogger('state'),
            // The Drive cache is only valid at the event position it was saved
            // at, so it is saved whenever the state, and its cursor, are.
            () => void runtime.session.flushCache(),
        );
        runtime.conflictHistory = new ConflictHistory(
            this.app.vault.adapter,
            this.pluginFile(CONFLICT_HISTORY_FILE),
            runtime.logger.getLogger('conflicts'),
        );
        await runtime.conflictHistory.load();
        runtime.engine = new SyncEngine(
            this.app,
            runtime.state,
            this.settings,
            runtime.logger.getLogger('sync'),
            {
                onChange: (summary) => this.onSyncChange(summary),
                onConflict: (event) => this.onConflict(event),
                onSettingsAdopted: (paths) => this.onSettingsAdopted(paths),
                onDevicesChanged: () => void this.checkDeviceRequests(),
            },
            { configDir: this.app.vault.configDir, pluginDir: this.pluginDir(), pluginId: this.manifest.id },
            {
                isMobile: Platform.isMobileApp,
                windows: Platform.isWin,
                isMetered: () => networkConnection()?.type === 'cellular',
                isHidden: () => document.visibilityState === 'hidden',
                openEditor: (path) => this.openEditor(path),
            },
        );

        runtime.devices = new DeviceList(
            {
                self: () => ({
                    id: runtime.clientUid,
                    name: this.settings.deviceName,
                    platform: platformName(),
                    pluginVersion: this.manifest.version,
                    account: runtime.session.accountEmail ?? null,
                }),
                handled: () => Number(this.app.loadLocalStorage(HANDLED_REQUEST_KEY)) || 0,
                setHandled: (at) => this.app.saveLocalStorage(HANDLED_REQUEST_KEY, at),
            },
            runtime.logger.getLogger('devices'),
        );

        // Until connect() says otherwise: a stored sign-in is being restored,
        // which can take a few seconds, and "Sign in" would be wrong meanwhile.
        this.summary = { ...runtime.engine.getSummary(), status: 'connecting' };
        this.settingsTab = new ProtonDriveSyncSettingsTab(this.app, this);
        this.addSettingTab(this.settingsTab);
        window.setTimeout(() => void this.scanOtherPlugins(), 4000);
        window.setTimeout(() => void this.checkOwnSecurity(), 5000);
        this.registerCommands();
        this.registerVaultEvents();
        this.registerLifecycleEvents();

        // Deferred until the workspace is ready so a first sync does not
        // compete with Obsidian opening the vault, and so the flood of vault
        // events Obsidian emits while indexing is not mistaken for user edits.
        this.app.workspace.onLayoutReady(() => {
            void this.connect().then(() => {
                if (!this.settings.onboardingComplete) {
                    this.openSetup();
                }
            });
        });
    }

    override onunload(): void {
        if (this.conflictNoticeTimer !== null) {
            window.clearTimeout(this.conflictNoticeTimer);
        }
        // Obsidian does not wait for unload, so there is nothing to hand the
        // promise to; `stop` cancels timers synchronously before it awaits.
        void runtime.engine.stop();
        runtime.devices.open(null);
        void this.rememberUnlock();
    }

    openSetup(): void {
        new SetupModal(this.app, this).open();
    }

    /** After a successful sign-in: start syncing, unless told not to. */
    async onSignedIn(options: { connect?: boolean } = {}): Promise<void> {
        if (options.connect ?? true) {
            await this.reconnect();
        }
    }

    /** Point the vault at a Drive folder and, unless told not to, start syncing with it. */
    async setRemoteFolder(folder: ChosenFolder, options: { connect?: boolean } = {}): Promise<void> {
        const changed = folder.uid !== this.settings.remoteFolderUid;
        this.settings.remoteFolderUid = folder.uid;
        this.settings.remoteFolderPath = folder.path;
        this.settings.remoteFolderSharedBy = folder.sharedBy;
        if (changed && folder.shared && this.settings.syncObsidianConfig) {
            // A shared vault is used by several people: syncing the config
            // folder would hand each of them everyone else's theme, plugins
            // and hotkeys. Off by default; the setting can turn it back on.
            this.settings.syncObsidianConfig = false;
            this.notify('settings and plugins are not synced with a shared folder; turn this back on in the settings if you want them.');
        }
        await this.saveSettings();

        if (changed) {
            // The sync state describes the old folder, and reconciling against
            // a different tree with it would read as mass deletions on both
            // sides.
            await runtime.engine.stop();
            await runtime.state.reset();
            await runtime.session.clearCache();
        }
        if (options.connect ?? true) {
            await this.reconnect();
        }
    }

    isConfigured(): boolean {
        return runtime.session.isSignedIn() && Boolean(this.settings.remoteFolderUid);
    }

    /** Forget the sync state and compare everything afresh. Stops first, so no pass writes into the cleared state. */
    async rebuildState(): Promise<void> {
        await runtime.engine.stop();
        await runtime.state.reset();
        await runtime.session.clearCache();
        await this.connect();
    }

    /**
     * Pause or resume, remembering the choice across restarts.
     *
     * Resuming into a sync that has never run (paused from the first-sync
     * preview, say) shows the preview again, since nothing has changed that
     * would make it less of a surprise.
     */
    async setPaused(paused: boolean, request?: DeviceRequest): Promise<void> {
        if (request && this.settings.paused === paused) {
            // Asked from another device for what is already the case.
            return;
        }
        this.settings.paused = paused;
        await this.saveSettings();
        if (paused) {
            runtime.engine.pause();
            this.notify(request ? requestNotice(request) : 'syncing paused.');
            return;
        }
        if (
            this.isConfigured() &&
            runtime.state.paths().length === 0 &&
            !(await this.confirmFirstSync(runtime.state.wasLost()))
        ) {
            this.settings.paused = true;
            await this.saveSettings();
            return;
        }
        this.notify(request ? requestNotice(request) : 'syncing resumed.');
        await runtime.engine.resume();
    }

    // -- PIN ---------------------------------------------------------------

    /**
     * Ask for the PIN. Resolves true once the session is unlocked; false when
     * the user closed the prompt, or chose to forget a lost PIN, which leaves
     * them signed out.
     */
    private unlock(): Promise<boolean> {
        this.unlocking ??= new Promise<boolean>((resolve) => {
            new UnlockModal(this.app, {
                verify: (pin) => runtime.sessionSlot.unlock(pin),
                forget: () => runtime.sessionSlot.forget(),
                failures: this.pinFailures,
                onDone: (result) => {
                    if (result === 'unlocked') {
                        this.locked = false;
                        this.markActive();
                        void this.rememberUnlock();
                    } else if (result === 'forgotten') {
                        this.locked = false;
                        this.pinEnabled = false;
                        void this.rememberedUnlock.clear();
                        this.showStatus({ ...runtime.engine.getSummary(), status: 'signed-out' });
                        this.notify('the locked sign-in was deleted. Sign in again to keep syncing.');
                    }
                    resolve(result === 'unlocked');
                },
            }).open();
        }).finally(() => {
            this.unlocking = null;
        });
        return this.unlocking;
    }

    /** Set up, change or remove the PIN, after asking for the current one where there is one. */
    managePin(mode: 'set' | 'change' | 'remove', onDone?: () => void): void {
        new PinFormModal(this.app, {
            mode,
            verify: (pin) => runtime.sessionSlot.verify(pin),
            apply: async (newPin) => {
                if (mode === 'remove') {
                    await runtime.sessionSlot.removePin();
                } else if (newPin !== null) {
                    await runtime.sessionSlot.setPin(newPin);
                }
                this.pinEnabled = mode !== 'remove';
                this.markActive();
                // A new PIN means a new key, and no PIN means nothing to remember.
                await this.rememberUnlock();
                this.refreshSettingsTab();
                this.notify(
                    mode === 'set'
                        ? 'PIN set. Obsidian will ask for it when it starts.'
                        : mode === 'change'
                          ? 'PIN changed.'
                          : 'PIN removed.',
                );
            },
            onDone: () => onDone?.(),
        }).open();
    }

    /** The time limit for the PIN changed in the settings. */
    async onPinLockAfterChanged(): Promise<void> {
        this.markActive();
        await this.rememberUnlock();
    }

    private markActive(): void {
        this.lastActivity = Date.now();
    }

    /** The PIN has a time limit, and it has run out since the user last did anything. */
    private lockDue(): boolean {
        const minutes = this.settings.pinLockAfterMinutes;
        return (
            minutes > 0 &&
            this.pinEnabled &&
            !this.locked &&
            runtime.session.isSignedIn() &&
            Date.now() - this.lastActivity >= minutes * 60_000
        );
    }

    /** Something happened in Obsidian: lock if the time limit ran out first, otherwise restart the clock. */
    private onActivity(): void {
        if (this.lockDue()) {
            void this.lockNow();
            return;
        }
        this.markActive();
        if (Date.now() - this.lastRememberSave >= REMEMBER_SAVE_MS) {
            void this.rememberUnlock();
        }
    }

    /**
     * Keep the unlocked key until the time limit runs out, counted from the
     * last activity, so reopening Obsidian within it does not ask for the PIN;
     * or delete it, when there is no time limit or nothing unlocked.
     */
    private async rememberUnlock(): Promise<void> {
        const minutes = this.settings.pinLockAfterMinutes;
        const key = runtime.sessionSlot.exportKey();
        if (minutes <= 0 || !this.pinEnabled || this.locked || key === null) {
            await this.rememberedUnlock.clear();
            return;
        }
        this.lastRememberSave = Date.now();
        await this.rememberedUnlock.save(key, this.lastActivity + minutes * 60_000);
    }

    /**
     * The time limit ran out: stop syncing, drop the session from memory, and
     * ask for the PIN. The session stays stored, encrypted, and nothing else
     * is lost; unlocking picks up where it left off.
     */
    private async lockNow(): Promise<void> {
        if (this.locked) {
            return;
        }
        this.locked = true;
        runtime.logger.info(`Locked after ${this.settings.pinLockAfterMinutes} minute(s) away`);
        await runtime.engine.stop();
        this.closeDeviceList();
        runtime.session.lock();
        runtime.sessionSlot.lock();
        await this.rememberedUnlock.clear();
        this.showStatus({ ...runtime.engine.getSummary(), status: 'locked' });
        await this.connect();
    }

    /** Resolve true once the user has entered the right PIN, or straight away when there is none. */
    private confirmPin(purpose: string): Promise<boolean> {
        if (!this.pinEnabled) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            new PinFormModal(this.app, {
                mode: 'confirm',
                purpose,
                verify: (pin) => runtime.sessionSlot.verify(pin),
                apply: async () => undefined,
                onDone: resolve,
            }).open();
        });
    }

    /** Sign out, with the PIN first when there is one; see {@link endSession}. */
    async signOut(proof?: string): Promise<void> {
        requireUi(proof, 'signing out');
        if (!(await this.confirmPin('sign out'))) {
            return;
        }
        const revoked = await this.endSession();
        this.notify(
            revoked
                ? 'signed out, and the session was ended on Proton.'
                : 'signed out on this device, but Proton could not be reached to end the session. ' +
                      'Revoke it under account.proton.me → Security → Sessions if you need it gone now.',
        );
        await this.reconnect();
    }

    /**
     * End the session on Proton's side before forgetting it here. Resolves
     * whether Proton confirmed it.
     *
     * The chosen Drive folder, and the sync state that describes it, go too.
     * Both belong to the account being signed out of, and the next sign-in
     * may be a different one, where that folder id means nothing, or the
     * same account wanting a different folder. Nothing is deleted on Drive
     * or in the vault; signing in again and choosing a folder starts a fresh
     * first sync, which pairs up files that already match.
     */
    private async endSession(): Promise<boolean> {
        await runtime.engine.stop();
        this.closeDeviceList();
        const { revoked } = await runtime.session.signOut();
        this.pinEnabled = false;
        await this.rememberedUnlock.clear();
        this.settings.remoteFolderUid = null;
        this.settings.remoteFolderPath = null;
        this.settings.remoteFolderSharedBy = null;
        await this.saveSettings();
        await runtime.state.reset();
        this.refreshSettingsTab();
        return revoked;
    }

    /** Everything this device logged recently, with enough context to go in a bug report. */

    /**
     * Compare the plugins installed in this vault with the set seen last time.
     *
     * Every plugin in a vault can read the vault and this plugin's sign-in, so a
     * new or updated one is a security event. This cannot stop the code — it is
     * the same process — but it makes the change visible instead of silent.
     */


    /** Where the tripwire record lives: beside the state, never synced. */
    private tripwireLogPath(): string {
        return this.pluginFile('tripwire-log.json');
    }

    /**
     * Keep hits on disk as well as in memory.
     *
     * A plugin that reads the sign-in during startup does it before anyone is
     * looking at a notice, and Obsidian is often closed again straight after.
     * The file is what makes "it happened while I was not watching" visible on
     * the next start; it holds plugin ids and wire names, no note names.
     */
    private async rememberTripwireHit(hit: TripwireHit): Promise<void> {
        try {
            const path = this.tripwireLogPath();
            let log: { seenAt: number; hits: TripwireHit[] } = { seenAt: 0, hits: [] };
            if (await this.app.vault.adapter.exists(path)) {
                log = JSON.parse(await this.app.vault.adapter.read(path)) as typeof log;
            }
            log.hits = [...(log.hits ?? []), hit].slice(-200);
            await this.app.vault.adapter.write(path, JSON.stringify(log, null, 1));
        } catch (error) {
            runtime.logger.warn('Could not write the tripwire record', error);
        }
    }

    /** On start: say whether anything reached for the sign-in since the last one. */
    async reportEarlierTripwireHits(): Promise<void> {
        try {
            const path = this.tripwireLogPath();
            if (!(await this.app.vault.adapter.exists(path))) {
                return;
            }
            const log = JSON.parse(await this.app.vault.adapter.read(path)) as { seenAt: number; hits: TripwireHit[] };
            const fresh = (log.hits ?? []).filter((hit) => hit.at > (log.seenAt ?? 0));
            log.seenAt = Date.now();
            await this.app.vault.adapter.write(path, JSON.stringify(log, null, 1));
            if (fresh.length === 0) {
                return;
            }
            const who = [...new Set(fresh.map((hit) => hit.by ?? 'something'))].slice(0, 3).join(', ');
            new Notice(
                `Proton Drive Sync: ${fresh.length} attempt(s) to reach the Proton sign-in since the last start ` +
                    `(${who}). Settings → Proton Drive Sync → Security lists them.`,
                20000,
            );
        } catch (error) {
            runtime.logger.warn('Could not read the tripwire record', error);
        }
    }

    /**
     * Three things that decide whether the hardening holds at all: who else can
     * write to this plugin's code and to the stored sign-in, whether that code
     * is still what was installed, and whether anything has already reached for
     * the sign-in since the last start.
     */
    async checkOwnSecurity(): Promise<void> {
        if (this.settings.warnOnInsecurePermissions) {
            try {
                const findings = checkPermissions(this.app, this.pluginDir());
                runtime.securityFindings = findings;
                if (findings.length > 0) {
                    const first = findings[0].problem;
                    const more = findings.length > 1 ? ` (+${findings.length - 1} more)` : '';
                    new Notice(
                        `Proton Drive Sync: ${first}${more}. Anyone who can write this plugin's code runs it ` +
                            'with your keyring; see Settings → Proton Drive Sync → Security.',
                        15000,
                    );
                    if (this.settings.refuseOnInsecurePermissions) {
                        await this.setPaused(true);
                        runtime.logger.warn('Syncing paused: the vault is writable by other users');
                    }
                }
            } catch (error) {
                runtime.logger.warn('Could not check the permissions of this vault', error);
            }
        }

        try {
            runtime.selfIntegrity = await checkSelf(this.app, this.pluginDir(), this.manifest.version, runtime.logger);
            if (runtime.selfIntegrity === 'changed-without-update') {
                new Notice(
                    'Proton Drive Sync: this plugin\'s own code changed without a new version. If you did not ' +
                        'replace it, sign out of Proton and reinstall.',
                    20000,
                );
            }
        } catch (error) {
            runtime.logger.warn('Could not check this plugin\'s own code', error);
        }

        await this.reportEarlierTripwireHits();
    }

    async scanOtherPlugins(): Promise<void> {
        if (!this.settings.watchOtherPlugins) {
            return;
        }
        try {
            const report = await watchPlugins(this.app, this.manifest.id, this.pluginDir());
            runtime.pluginWatch = report;
            // Only what Obsidian's own update notice would not say; an update
            // announced by Obsidian is not worth repeating. See PluginAlert.
            if (report.alerts.length === 0) {
                return;
            }
            const listed = report.alerts
                .slice(0, 3)
                .map((alert) => `${alert.name}: ${alert.why}`)
                .join('; ');
            const more = report.alerts.length > 3 ? ` and ${report.alerts.length - 3} more` : '';
            new Notice(`Proton Drive Sync: ${listed}${more}. See Settings → Proton Drive Sync → Security.`, 15000);
        } catch (error) {
            runtime.logger.warn('Could not scan the other plugins in this vault', error);
        }
    }

    async copyLog(): Promise<void> {
        const header = [
            `Proton Drive Sync ${this.manifest.version}`,
            `Obsidian ${apiVersion}, ${Platform.isMobileApp ? 'mobile' : 'desktop'}`,
            `Status: ${runtime.engine.getSummary().status}`,
            '',
        ];
        await navigator.clipboard.writeText(header.join('\n') + formatLogEntries(runtime.logger.getEntries()));
        new Notice('Sync log copied. It lists file names; check it before sharing.');
    }

    notify(message: string): void {
        new Notice(`Proton Drive Sync: ${message}`);
    }

    /**
     * Bring the sync up, if there is both a session and a chosen folder.
     *
     * Called on load and again whenever the user signs in or picks a folder, so
     * the plugin becomes active without a reload.
     */
    async connect(): Promise<void> {
        try {
            await this.connectSession();
        } catch (error) {
            // Nothing above expects to fail; without this the status would
            // keep saying "Connecting".
            runtime.logger.error('Could not start syncing', error);
            this.showStatus({ ...runtime.engine.getSummary(), status: 'error', lastError: errorMessage(error) });
        }
    }

    private async connectSession(): Promise<void> {
        this.pinEnabled = (await runtime.sessionSlot.protection()) === 'pin';
        this.locked = await runtime.sessionSlot.isLocked();
        if (this.locked && this.settings.pinLockAfterMinutes > 0) {
            // Unlocked within the time limit before Obsidian last closed.
            const remembered = await this.rememberedUnlock.load();
            if (remembered !== null && (await runtime.sessionSlot.unlockWithKey(remembered))) {
                this.locked = false;
                this.markActive();
            }
        }
        if (this.locked) {
            this.showStatus({ ...runtime.engine.getSummary(), status: 'locked' });
            if (!(await this.unlock())) {
                return;
            }
        }
        this.showStatus({ ...runtime.engine.getSummary(), status: 'connecting' });
        try {
            await runtime.session.init();
        } catch (error) {
            runtime.logger.error('Could not restore the Proton session', error);
            this.showStatus({ ...runtime.engine.getSummary(), status: 'signed-out' });
            return;
        }

        if (!runtime.session.isSignedIn()) {
            this.showStatus({ ...runtime.engine.getSummary(), status: 'signed-out' });
            return;
        }
        if (!this.settings.remoteFolderUid) {
            this.showStatus({ ...runtime.engine.getSummary(), status: 'not-configured' });
            return;
        }

        await runtime.state.load(runtime.session.accountEmail ?? null, this.settings.remoteFolderUid);
        if (runtime.state.wasLost() || runtime.state.paths().length === 0) {
            // A sync starting from nothing must not trust anything cached
            // about how Drive used to look.
            await runtime.session.clearCache();
        } else {
            await runtime.session.validateCache(runtime.state.cursorsFingerprint());
        }
        // Before anything syncs: what other devices asked of this one.
        if (!(await this.openDeviceList(this.settings.remoteFolderUid))) {
            return;
        }
        if (
            !this.settings.paused &&
            runtime.state.paths().length === 0 &&
            !(await this.confirmFirstSync(runtime.state.wasLost()))
        ) {
            this.settings.paused = true;
            await this.saveSettings();
        }
        await runtime.engine.start(runtime.session.getClient(), this.settings.remoteFolderUid);
    }

    /**
     * Before a first sync that mixes two sets of files, show what it will do
     * and let the user hold off. Resolves true to go ahead.
     *
     * Goes ahead without asking when one side is empty or both already agree,
     * and also when the preview itself fails: a first sync has no record of
     * earlier state, so it can add and keep copies but never delete.
     *
     * A vault holding nothing but its config folder counts as empty. That is
     * what a vault created a minute ago looks like: Obsidian's default
     * settings and this plugin, nothing the user would miss when Drive's
     * settings replace them.
     */
    private async confirmFirstSync(stateLost = false): Promise<boolean> {
        const rootUid = this.settings.remoteFolderUid;
        if (!rootUid) {
            return true;
        }
        this.showStatus({ ...runtime.engine.getSummary(), status: 'syncing' });

        let plan: SyncPlan;
        try {
            plan = await runtime.engine.plan(runtime.session.getClient(), rootUid);
        } catch (error) {
            if (stateLost) {
                // Without the record of the last sync and without a preview,
                // going ahead would bring deletions back unseen. Hold off.
                runtime.logger.error('Could not preview the sync after the sync state was lost; pausing', error);
                this.notify('the record of the last sync could not be read, so syncing is paused. Resume it to try again.');
                return false;
            }
            runtime.logger.warn('Could not preview the first sync; going ahead, since it deletes nothing', error);
            return true;
        }
        const changes = plan.uploads.length + plan.downloads.length + plan.conflicts.length + plan.removals.length;
        // A lost state is shown whenever there is anything to sync at all: the
        // user had a sync history and has to hear that it is gone.
        const worthAsking = stateLost
            ? plan.localFiles + plan.remoteFiles > 0
            : plan.localNotes > 0 && plan.remoteFiles > 0 && changes > 0;
        if (!worthAsking) {
            return true;
        }

        const folderName = this.settings.remoteFolderPath ?? 'the Drive folder';
        const policy = CONFLICT_POLICIES[this.settings.conflictPolicy];
        return new Promise((resolve) => {
            new FirstSyncModal(this.app, plan, folderName, policy.toLowerCase(), resolve, stateLost).open();
        });
    }

    /**
     * Drive's Obsidian settings are now in this vault, but Obsidian keeps
     * running on the ones it loaded at startup, with the plugins, themes and
     * snippets that came with them, until it reloads.
     */
    private onSettingsAdopted(paths: string[]): void {
        new ReloadModal(this.app, paths, () => this.reloadApp()).open();
    }

    private reloadApp(): void {
        const commands = (this.app as App & { commands?: { executeCommandById(id: string): boolean } }).commands;
        if (!commands?.executeCommandById('app:reload')) {
            window.location.reload();
        }
    }

    private async syncNowOrSetUp(): Promise<void> {
        if (this.locked) {
            await this.connect();
            return;
        }
        if (!this.isConfigured()) {
            this.openSetup();
            return;
        }
        if (this.summary.status === 'folder-missing') {
            this.chooseFolder();
            return;
        }
        await runtime.engine.syncNow();
    }

    /** Pick another Drive folder for the vault, as the settings tab does. */
    private chooseFolder(): void {
        new FolderPickerModal(
            this.app,
            runtime.session.getClient(),
            (folder) => void this.setRemoteFolder(folder),
            runtime.logger.getLogger('folder-picker'),
        ).open();
    }

    private openSettings(): void {
        const setting = (this.app as App & { setting?: { open(): void; openTabById(id: string): void } }).setting;
        setting?.open();
        setting?.openTabById(this.manifest.id);
    }

    /** Tear the sync down and bring it back with the current configuration. */
    async reconnect(): Promise<void> {
        await runtime.engine.stop();
        await this.connect();
    }

    // -- device list -------------------------------------------------------

    /**
     * Open the vault's device list, and act on a request left for this device
     * since it last looked. Resolves false when that was to remove it: it has
     * signed out, and there is nothing to sync.
     *
     * Off for a vault in someone else's Drive or shared with others, whose
     * devices would otherwise see this one, and could pause or remove it.
     */
    private async openDeviceList(rootUid: string): Promise<boolean> {
        const client = runtime.session.getClient();
        const logger = runtime.logger.getLogger('devices');
        let registry: DeviceRegistry | null = null;
        let shared = this.settings.remoteFolderSharedBy !== null;
        if (!shared) {
            registry = new DeviceRegistry(new DriveIO(client, logger), rootUid, logger, this.devicesFolderMemory(rootUid));
            // Both hold up the sync, so they run side by side; the list read
            // here is dropped if the folder turns out to be shared.
            [shared] = await Promise.all([
                sharedWithOthers(client, rootUid).catch((error: unknown) => {
                    logger.warn('Could not check whether the folder is shared; the device list stays off for now', error);
                    return true;
                }),
                registry.prepare(),
            ]);
            if (shared) {
                registry = null;
            }
        }
        runtime.devices.open(registry);
        runtime.engine.watchDevices(registry);
        this.devicesOffForSharing = shared;

        const request = await runtime.devices.pendingRequest();
        if (!request) {
            return true;
        }
        if (request.state === 'removed') {
            await this.removedByAnotherDevice(request);
            return false;
        }
        // The sync has not started: it starts from the setting.
        if (this.settings.paused !== (request.state === 'paused')) {
            this.settings.paused = request.state === 'paused';
            await this.saveSettings();
            this.notify(requestNotice(request));
        }
        return true;
    }

    /** Where this vault found the device list's folder last time, for the folder it syncs with. */
    private devicesFolderMemory(rootUid: string): FolderMemory {
        return {
            load: () => {
                const saved = this.app.loadLocalStorage(DEVICES_FOLDER_KEY) as { rootUid?: unknown; uid?: unknown } | null;
                return saved?.rootUid === rootUid && typeof saved.uid === 'string' ? saved.uid : null;
            },
            save: (uid) => this.app.saveLocalStorage(DEVICES_FOLDER_KEY, { rootUid, uid }),
        };
    }

    private closeDeviceList(): void {
        runtime.devices.open(null);
        runtime.engine.watchDevices(null);
        this.devicesOffForSharing = false;
    }

    /** The device list changed on Drive while syncing: act on a new request for this device, if there is one. */
    private async checkDeviceRequests(): Promise<void> {
        const request = await runtime.devices.pendingRequest();
        if (!request) {
            return;
        }
        if (request.state === 'removed') {
            await this.removedByAnotherDevice(request);
            return;
        }
        await this.setPaused(request.state === 'paused', request);
    }

    /**
     * Another device removed this one from the vault's device list: say so on
     * the list, sign out, and explain. Signing in again is what brings it back;
     * the request stays handled, so it is not acted on a second time.
     */
    private async removedByAnotherDevice(request: DeviceRequest): Promise<void> {
        runtime.logger.warn(`Removed from the device list by "${request.byName || request.by}"; signing out`);
        await runtime.devices.recordRemoved();
        await this.endSession();
        this.showStatus({ ...runtime.engine.getSummary(), status: 'signed-out' });
        new DeviceRemovedModal(this.app, request, () => this.openSetup()).open();
    }

    /** Whether the vault's device list can be shown: synced with an own folder that is not shared, and connected. */
    devicesAvailable(): boolean {
        return runtime.devices.current !== null && runtime.engine.isConnected() && !this.locked;
    }

    /** Every device syncing the vault, with ways to pause, resume or remove the others. */
    showDevices(): void {
        const registry = runtime.devices.current;
        if (!registry || !this.devicesAvailable()) {
            this.notify(
                this.devicesOffForSharing
                    ? 'the device list is off for a vault shared with other people.'
                    : 'sign in, choose a Drive folder and unlock to see the devices syncing this vault.',
            );
            return;
        }
        new DevicesModal(this.app, {
            selfId: runtime.clientUid,
            list: () => registry.list(),
            ask: async (entry, state) => {
                // Read again, in case another device asked something since
                // the dialog listed it: a request has to come after it.
                const [record, request] = await Promise.all([registry.record(entry.id), registry.request(entry.id)]);
                await registry.ask(entry.id, {
                    state,
                    at: nextRequestAt({ record, request }),
                    by: runtime.clientUid,
                    byName: this.settings.deviceName,
                });
            },
            forget: (id) => registry.forget(id),
        }).open();
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        runtime.logger.setLevel(this.settings.logLevel);
        runtime.engine.updateSettings(this.settings);
        // The device name may have changed, which the device list shows.
        runtime.devices.noteChange();
    }

    private async loadSettings(): Promise<void> {
        const stored = (await this.loadData()) as Partial<PluginSettings> | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);

        let changed = false;
        // Installations configured before the setup assistant existed have
        // no use for it.
        if (stored?.onboardingComplete === undefined && stored?.remoteFolderUid) {
            this.settings.onboardingComplete = true;
            changed = true;
        }

        // 0.1.0 kept the installation id here; it now lives in local storage.
        const legacy = this.settings as { clientUid?: unknown };
        if ('clientUid' in legacy) {
            if (typeof legacy.clientUid === 'string' && legacy.clientUid && !this.storedInstallationId()) {
                this.app.saveLocalStorage(CLIENT_UID_KEY, legacy.clientUid);
            }
            delete legacy.clientUid;
            changed = true;
        }
        // Filled in on first run rather than in the defaults, because it names
        // this device's conflict copies from then on.
        if (!this.settings.deviceName) {
            this.settings.deviceName = defaultDeviceName();
            changed = true;
        }
        if (changed) {
            await this.saveData(this.settings);
        }
    }

    private registerCommands(): void {
        this.addCommand({
            id: 'sync-now',
            icon: 'refresh-cw',
            name: 'Sync now',
            callback: () => void this.syncNowOrSetUp(),
        });

        this.addCommand({
            id: 'open-setup',
            icon: 'wand',
            name: 'Open setup assistant',
            callback: () => this.openSetup(),
        });

        this.addCommand({
            id: 'show-conflicts',
            icon: 'alert-circle',
            name: 'Show sync conflicts',
            callback: () => new ConflictsModal(this.app, this).open(),
        });

        this.addCommand({
            id: 'show-devices',
            icon: 'monitor-smartphone',
            name: 'Show devices syncing this vault',
            callback: () => this.showDevices(),
        });

        this.addCommand({
            id: 'pause-sync',
            icon: 'pause-circle',
            name: 'Pause syncing',
            checkCallback: (checking) => {
                if (this.settings.paused) {
                    return false;
                }
                if (!checking) {
                    void this.setPaused(true);
                }
                return true;
            },
        });

        this.addCommand({
            id: 'resume-sync',
            icon: 'play-circle',
            name: 'Resume syncing',
            checkCallback: (checking) => {
                if (!this.settings.paused) {
                    return false;
                }
                if (!checking) {
                    void this.setPaused(false);
                }
                return true;
            },
        });

        this.addCommand({
            id: 'compare-conflict-copy',
            icon: 'git-compare',
            name: 'Compare with conflict copy',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || conflictPairsFor(this.app, file).length === 0) {
                    return false;
                }
                if (!checking) {
                    compareConflictCopyOf(this.app, file);
                }
                return true;
            },
        });

        this.addCommand({
            id: 'copy-share-link',
            icon: 'link',
            name: 'Copy Proton Drive share link',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || !this.isConfigured() || this.locked) {
                    return false;
                }
                if (!checking) {
                    this.shareNote(file.path, uiProof());
                }
                return true;
            },
        });

        this.addCommand({
            id: 'unlock',
            icon: 'lock-open',
            name: 'Unlock with PIN',
            checkCallback: (checking) => {
                if (!this.locked) {
                    return false;
                }
                if (!checking) {
                    void this.connect();
                }
                return true;
            },
        });

        this.addCommand({
            id: 'open-panel',
            icon: 'cloud',
            name: 'Open sync panel',
            callback: () => void this.openPanel(),
        });

        this.addCommand({
            id: 'copy-log',
            icon: 'clipboard-copy',
            name: 'Copy sync log',
            callback: () => void this.copyLog(),
        });
    }

    /** The note's public link on Drive, with Copy and Stop sharing, or a form to make one. */
    shareNote(path: string, proof?: string): void {
        // A public link is exfiltration with the user's own keys: only this
        // plugin's UI may ask for one. See security/capability.ts.
        requireUi(proof, 'a share link');
        new ShareModal(this.app, path, {
            load: () => runtime.engine.noteShareLink(path),
            create: (options) => runtime.engine.createNoteShareLink(path, options),
            remove: () => runtime.engine.removeNoteShareLink(path),
        }).open();
    }

    private registerVaultEvents(): void {
        const { vault } = this.app;

        this.registerEvent(vault.on('create', (file) => this.onFileChanged(file)));
        this.registerEvent(vault.on('modify', (file) => this.onFileChanged(file)));
        this.registerEvent(
            vault.on('delete', (file) => {
                if (file instanceof TFolder) {
                    runtime.engine.onVaultFolderDelete(file.path);
                } else {
                    this.onFileChanged(file);
                }
            }),
        );
        this.registerEvent(
            vault.on('rename', (file, oldPath) => {
                runtime.engine.onVaultRename(oldPath, file.path, file instanceof TFolder);
            }),
        );
    }

    private onFileChanged(file: TAbstractFile): void {
        // Folder creation arrives here too; it is handled by the full sync,
        // since an empty folder has no content to upload.
        if (file instanceof TFile) {
            runtime.engine.onVaultChange(file.path);
        }
    }

    private onSyncChange(summary: SyncSummary): void {
        if (summary.status === 'folder-missing' && this.summary.status !== 'folder-missing') {
            this.notify(
                `${summary.lastError ?? 'the Drive folder this vault syncs with is missing'}. Nothing syncs until it is ` +
                    'restored on Proton Drive, or another folder is chosen: click the status bar item, or Choose folder in the sync panel.',
            );
        }
        this.showStatus(summary);
        runtime.devices.noteStatus(summary);
    }

    /** Show a summary everywhere the sync's state appears. */
    private showStatus(summary: SyncSummary): void {
        this.summary = summary;
        this.statusBar.update(summary);
        this.updateNoteIndicators();
        this.refreshSettingsTab();
        if (this.ribbonIcon) {
            setIcon(this.ribbonIcon, statusIcon(summary));
            this.ribbonIcon.toggleClass('proton-drive-sync-spin', statusSpins(summary));
            setTooltip(this.ribbonIcon, `Proton Drive Sync: ${statusLabel(summary)}`);
        }
        for (const leaf of this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW)) {
            if (leaf.view instanceof SyncPanelView) {
                leaf.view.update(summary);
            }
        }
    }

    /**
     * Rebuild the settings tab when something it shows has changed.
     *
     * Obsidian reads a tab's setting definitions when the tab is added, at
     * plugin load, and again only when the plugin calls `update()`; opening
     * the settings just redraws what it read then. At load the saved sign-in
     * has not been restored yet, so without this the tab would keep showing
     * a vault signed in last week as signed out, and hide what depends on
     * being signed in, such as the PIN. Keyed, so the progress updates that
     * arrive several times a second during a sync do not rebuild it each time.
     */
    refreshSettingsTab(): void {
        if (!this.settingsTab) {
            return;
        }
        const key = JSON.stringify([
            runtime.session.isSignedIn(),
            runtime.session.accountEmail,
            this.locked,
            this.pinEnabled,
            this.settings.remoteFolderUid,
            this.settings.remoteFolderPath,
            this.settings.conflictPolicy,
            this.summary?.conflicts,
        ]);
        if (key === this.settingsTabKey) {
            return;
        }
        this.settingsTabKey = key;
        this.settingsTab.update();
    }

    /** Re-show the current summary, so "synced 5m ago" keeps counting. */
    private refreshStatus(): void {
        if (this.summary) {
            this.showStatus(this.summary);
        }
    }

    /**
     * Show whether the note in view is in sync: a pulsing dot beside the
     * status-bar icon on desktop, green when it is and red when it has changes
     * not synced yet; on mobile, where there is no status bar, the same dot as
     * a button in each note's header, which turns into a spinning sync icon
     * while that note transfers and opens the sync panel when tapped. Hidden
     * when there is no sync to speak of: signed out, no folder, or locked.
     */
    private updateNoteIndicators(): void {
        const shown = this.isConfigured() && !this.locked;
        const active = this.app.workspace.getActiveFile();
        this.statusBar.setNote(shown && active ? this.indicatorFor(active) : null);
        for (const leaf of this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW)) {
            if (leaf.view instanceof SyncPanelView) {
                leaf.view.noteChanged();
            }
        }

        if (!Platform.isMobile) {
            return;
        }
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view;
            if (!(view instanceof MarkdownView) || !view.file) {
                continue;
            }
            let action = this.noteActions.get(view);
            if (!shown) {
                action?.hide();
                continue;
            }
            if (!action) {
                action = view.addAction('circle', 'Sync status', () => void this.openPanel());
                action.addClass('proton-drive-sync-note-action');
                this.noteActions.set(view, action);
            }
            action.show();
            renderNoteAction(action, this.indicatorFor(view.file));
        }
    }

    /**
     * The editor a note is open in, for the engine to bring a downloaded
     * version in through it instead of writing under it.
     */
    private openEditor(path: string): OpenEditor | null {
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view;
            if (view instanceof MarkdownView && view.file?.path === path) {
                const editor = view.editor;
                return {
                    text: () => editor.getValue(),
                    replace: (next) => {
                        // Only the part that differs is replaced, so the
                        // editor maps the cursor and selection through the
                        // change instead of resetting them.
                        const current = editor.getValue();
                        if (current === next) {
                            return;
                        }
                        let start = 0;
                        while (start < current.length && start < next.length && current[start] === next[start]) {
                            start++;
                        }
                        let end = 0;
                        while (
                            end < current.length - start &&
                            end < next.length - start &&
                            current[current.length - 1 - end] === next[next.length - 1 - end]
                        ) {
                            end++;
                        }
                        editor.replaceRange(
                            next.slice(start, next.length - end),
                            editor.offsetToPos(start),
                            editor.offsetToPos(current.length - end),
                        );
                    },
                };
            }
        }
        return null;
    }

    /**
     * Bring back an earlier version of a note: write it into the note, so the
     * sync uploads it as a new version and every safeguard of an ordinary edit
     * applies. Through the editor when the note is open, so the cursor stays
     * and nothing typed meanwhile is written over; else through the vault.
     */
    async restoreVersion(path: string, data: ArrayBuffer, proof?: string): Promise<void> {
        requireUi(proof, 'restoring an old version');
        const file = this.app.vault.getFileByPath(path);
        if (!file) {
            throw new Error('the note no longer exists');
        }
        const editor = this.openEditor(path);
        if (editor) {
            editor.replace(new TextDecoder().decode(data));
            return;
        }
        await this.app.vault.modifyBinary(file, data);
    }

    /** Whether a note has changes that have not reached Drive yet. */
    hasUnsyncedChanges(path: string): boolean {
        const file = this.app.vault.getFileByPath(path);
        const stat = file ? { size: file.stat.size, mtime: file.stat.mtime } : null;
        return runtime.engine.noteSyncState(path, stat) === 'pending';
    }

    private indicatorFor(file: TFile): NoteIndicator {
        const state = runtime.engine.noteSyncState(file.path, { size: file.stat.size, mtime: file.stat.mtime });
        return noteIndicator(
            state,
            runtime.engine.pendingChanges().find((change) => change.path === file.path),
        );
    }

    /** Reveal the sync panel, opening it in the right sidebar if it is not open yet. */
    async openPanel(): Promise<void> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(SYNC_PANEL_VIEW)[0];
        if (!leaf) {
            const created = workspace.getRightLeaf(false);
            if (!created) {
                return;
            }
            await created.setViewState({ type: SYNC_PANEL_VIEW, active: true });
            leaf = created;
        }
        await workspace.revealLeaf(leaf);
    }

    /**
     * Collect conflicts briefly before telling the user, so a sync that finds
     * twenty of them shows one notice, not twenty.
     */
    private onConflict(event: ConflictEvent): void {
        void runtime.conflictHistory.add(event);
        runtime.pendingConflicts.push(event);
        if (this.conflictNoticeTimer !== null) {
            return;
        }
        this.conflictNoticeTimer = window.setTimeout(() => {
            this.conflictNoticeTimer = null;
            showConflictNotice(this.app, runtime.pendingConflicts.splice(0), {
                reviewConflicts: () => new ConflictsModal(this.app, this).open(),
                compare: (path, copyPath) => compareWithConflictCopy(this.app, path, copyPath),
            });
        }, CONFLICT_NOTICE_DELAY_MS);
    }

    /**
     * Keep the plugin in step with the app's lifecycle.
     *
     * Leaving the app pushes pending edits out at once, because a mobile OS
     * may suspend or kill it before the debounce timer fires. Returning to it,
     * or getting the network back, checks Drive straight away instead of
     * waiting out a poll interval that may have been frozen in the background.
     */
    private registerLifecycleEvents(): void {
        // The current-note indicator follows the note in view and its edits.
        const update = () => this.updateNoteIndicators();
        this.registerEvent(this.app.workspace.on('active-leaf-change', update));
        this.registerEvent(this.app.workspace.on('layout-change', update));
        this.registerEvent(this.app.workspace.on('file-open', update));
        this.registerEvent(this.app.vault.on('modify', update));

        this.registerDomEvent(document, 'visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                runtime.engine.flushPendingEdits();
                // The OS may close the app from the background; save the
                // expiry as it stands.
                void this.rememberUnlock();
                return;
            }
            // Back from the background, perhaps after longer than the PIN's
            // time limit: timers do not run there, so check now.
            if (this.lockDue()) {
                void this.lockNow();
                return;
            }
            this.markActive();
            runtime.engine.pollNow();
        });

        // Using Obsidian restarts the PIN's clock.
        this.registerDomEvent(document, 'pointerdown', () => this.onActivity());
        this.registerDomEvent(document, 'keydown', () => this.onActivity());
        this.registerInterval(
            window.setInterval(() => {
                if (this.lockDue()) {
                    void this.lockNow();
                }
            }, LOCK_CHECK_MS),
        );
        this.registerDomEvent(window, 'online', () => runtime.engine.pollNow());

        // Moving between Wi-Fi and mobile data, for the "Wi-Fi only" setting.
        const connection = networkConnection();
        if (connection) {
            const onChange = () => runtime.engine.pollNow();
            connection.addEventListener('change', onChange);
            this.register(() => connection.removeEventListener('change', onChange));
        }
    }

    /**
     * Stable per-installation id, handed to the SDK.
     *
     * Drive marks an in-progress upload with the uid of the client that started
     * it. Keeping ours stable lets the SDK recognise a draft this installation
     * abandoned - after a crash, say - and clean it up on its own, instead of
     * stopping to ask whether another device's upload may be overwritten.
     *
     * Kept in Obsidian's local storage, which is per vault and per device,
     * rather than in `data.json`: a vault copied to a new device by hand
     * carries its `data.json` along, and two devices sharing one id could
     * discard each other's uploads in progress.
     */
    private installationId(): string {
        const stored = this.storedInstallationId();
        if (stored) {
            return stored;
        }
        const id = crypto.randomUUID();
        this.app.saveLocalStorage(CLIENT_UID_KEY, id);
        return id;
    }

    private storedInstallationId(): string | null {
        const stored = this.app.loadLocalStorage(CLIENT_UID_KEY) as unknown;
        return typeof stored === 'string' && stored ? stored : null;
    }

    private pluginDir(): string {
        return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    }

    private pluginFile(name: string): string {
        return `${this.pluginDir()}/${name}`;
    }
}

/** What makes a conflict copy identifiable: the hostname on desktop, the platform on mobile. */
function defaultDeviceName(): string {
    if (Platform.isIosApp) {
        return Platform.isTablet ? 'iPad' : 'iPhone';
    }
    if (Platform.isAndroidApp) {
        return Platform.isTablet ? 'Android tablet' : 'Android phone';
    }
    try {
        const os = window.require('os') as { hostname(): string };
        return os.hostname();
    } catch {
        return 'this device';
    }
}

/** What the device list shows this device as running on. */
function platformName(): string {
    if (Platform.isIosApp) {
        return Platform.isTablet ? 'iPad' : 'iPhone';
    }
    if (Platform.isAndroidApp) {
        return Platform.isTablet ? 'Android tablet' : 'Android phone';
    }
    if (Platform.isMacOS) {
        return 'macOS';
    }
    if (Platform.isWin) {
        return 'Windows';
    }
    return Platform.isLinux ? 'Linux' : 'Desktop';
}

/** A pause or resume asked from another device, as this device's notice puts it. */
function requestNotice(request: DeviceRequest): string {
    const by = request.byName ? `"${request.byName}"` : 'another device';
    return `syncing on this device was ${request.state === 'paused' ? 'paused' : 'resumed'} from ${by}.`;
}

/** The mobile header button: a spinning sync icon while the note transfers, else the dot. */
function renderNoteAction(action: HTMLElement, note: NoteIndicator): void {
    action.empty();
    action.toggleClass('proton-drive-sync-spin', note.transferring);
    if (note.transferring) {
        setIcon(action, 'refresh-cw');
    } else {
        action.createSpan({ cls: `proton-drive-sync-note-dot mod-${note.state}` });
    }
    setTooltip(action, note.text);
    action.setAttr('aria-label', note.text);
}
