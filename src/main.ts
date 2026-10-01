// Must be first: the SDK and its crypto reach for runtime APIs that older
// Electron builds lack, and they fail deep inside a transfer rather than at
// load time.
import './polyfills';

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
import { decryptLegacySession, ObsidianSecretSlot } from './proton/secretStore';
import { ProtonSession } from './proton/session';
import { DEFAULT_SETTINGS, type PluginSettings } from './settings';
import { SyncEngine, type ConflictEvent, type OpenEditor, type SyncPlan, type SyncSummary } from './sync/engine';
import { SyncState } from './sync/state';
import { formatLogEntries, Logger } from './util/logger';
import { compareConflictCopyOf, compareWithConflictCopy, compareWithVersion, conflictPairsFor } from './ui/compare';
import { showConflictNotice } from './ui/conflictNotice';
import { ConflictsModal } from './ui/conflictsModal';
import { FirstSyncModal } from './ui/firstSyncModal';
import { PinFormModal, UnlockModal } from './ui/pinModals';
import { ReloadModal } from './ui/reloadModal';
import { CONFLICT_POLICIES, ProtonDriveSyncSettingsTab } from './ui/settingsTab';
import { SetupModal } from './ui/setupModal';
import { StatusBar } from './ui/statusBar';
import { SYNC_PANEL_VIEW, SyncPanelView } from './ui/syncPanel';
import { type NoteIndicator, noteIndicator, statusIcon, statusLabel } from './ui/syncStatus';

/** Where 0.1.0 kept the session; migrated into secret storage on first load. */
const LEGACY_SESSION_FILE = 'session.json';
const STATE_FILE = 'sync-state.json';
const CONFLICT_HISTORY_FILE = 'conflict-history.json';
/** Local-storage key for the installation id; see {@link ProtonDriveSyncPlugin.installationId}. */
const CLIENT_UID_KEY = 'proton-drive-sync-client-uid';

/** Conflicts found within this long of each other share one notice. */
const CONFLICT_NOTICE_DELAY_MS = 1500;

/** How often the status bar's "synced 5m ago" is brought up to date. */
const STATUS_REFRESH_MS = 30_000;

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
    logger!: Logger;
    session!: ProtonSession;
    state!: SyncState;
    conflictHistory!: ConflictHistory;
    /** Where the Proton session is kept, encrypted with the user's PIN if they set one. */
    sessionSlot!: PinProtectedSlot;
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
    engine!: SyncEngine;

    private statusBar!: StatusBar;
    /** The ribbon icon standing in for the status bar on mobile; null on desktop. */
    private ribbonIcon: HTMLElement | null = null;
    /** The sync-state button added to each note's header on mobile; see {@link updateNoteIndicators}. */
    private readonly noteActions = new WeakMap<MarkdownView, HTMLElement>();
    /** What the status bar, ribbon icon and panel currently show. */
    private summary!: SyncSummary;
    private pendingConflicts: ConflictEvent[] = [];
    private conflictNoticeTimer: number | null = null;

    override async onload(): Promise<void> {
        await this.loadSettings();

        this.logger = new Logger(this.settings.logLevel);
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
                    pendingChanges: () => this.engine.pendingChanges(),
                    activeNote: () => this.app.workspace.getActiveFile()?.path ?? null,
                    canListVersions: () => this.isConfigured() && !this.locked,
                    versionsKey: (path) => this.engine.versionsKey(path),
                    noteVersions: (path) => this.engine.noteVersions(path),
                    openVersion: (path, version) => compareWithVersion(this, path, version),
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

        const clientUid = this.installationId();
        const protonLogger = this.logger.getLogger('proton');
        this.sessionSlot = new PinProtectedSlot(
            new ObsidianSecretSlot(this.app.secretStorage, `proton-drive-sync-session-${clientUid}`),
        );
        this.rememberedUnlock = new RememberedUnlock(
            new ObsidianSecretSlot(this.app.secretStorage, `proton-drive-sync-unlock-${clientUid}`),
        );
        const credentials = new Credentials(
            this.sessionSlot,
            {
                adapter: this.app.vault.adapter,
                path: this.pluginFile(LEGACY_SESSION_FILE),
                decrypt: (payload) => decryptLegacySession(payload, protonLogger),
            },
            protonLogger,
        );
        this.session = new ProtonSession(credentials, clientUid, protonLogger);
        this.state = new SyncState(
            this.app.vault.adapter,
            this.pluginFile(STATE_FILE),
            this.logger.getLogger('state'),
        );
        this.conflictHistory = new ConflictHistory(
            this.app.vault.adapter,
            this.pluginFile(CONFLICT_HISTORY_FILE),
            this.logger.getLogger('conflicts'),
        );
        await this.conflictHistory.load();
        this.engine = new SyncEngine(
            this.app,
            this.state,
            this.settings,
            this.logger.getLogger('sync'),
            {
                onChange: (summary) => this.onSyncChange(summary),
                onConflict: (event) => this.onConflict(event),
                onSettingsAdopted: (paths) => this.onSettingsAdopted(paths),
            },
            { configDir: this.app.vault.configDir, pluginDir: this.pluginDir(), pluginId: this.manifest.id },
            {
                isMobile: Platform.isMobileApp,
                isMetered: () => networkConnection()?.type === 'cellular',
                isHidden: () => document.visibilityState === 'hidden',
                openEditor: (path) => this.openEditor(path),
            },
        );

        this.summary = this.engine.getSummary();
        this.settingsTab = new ProtonDriveSyncSettingsTab(this.app, this);
        this.addSettingTab(this.settingsTab);
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
        void this.engine.stop();
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
    async setRemoteFolder(folder: { uid: string; path: string }, options: { connect?: boolean } = {}): Promise<void> {
        const changed = folder.uid !== this.settings.remoteFolderUid;
        this.settings.remoteFolderUid = folder.uid;
        this.settings.remoteFolderPath = folder.path;
        await this.saveSettings();

        if (changed) {
            // The sync state describes the old folder, and reconciling against
            // a different tree with it would read as mass deletions on both
            // sides.
            await this.engine.stop();
            await this.state.reset();
        }
        if (options.connect ?? true) {
            await this.reconnect();
        }
    }

    isConfigured(): boolean {
        return this.session.isSignedIn() && Boolean(this.settings.remoteFolderUid);
    }

    /** Forget the sync state and compare everything afresh. Stops first, so no pass writes into the cleared state. */
    async rebuildState(): Promise<void> {
        await this.engine.stop();
        await this.state.reset();
        await this.connect();
    }

    /**
     * Pause or resume, remembering the choice across restarts.
     *
     * Resuming into a sync that has never run (paused from the first-sync
     * preview, say) shows the preview again, since nothing has changed that
     * would make it less of a surprise.
     */
    async setPaused(paused: boolean): Promise<void> {
        this.settings.paused = paused;
        await this.saveSettings();
        if (paused) {
            this.engine.pause();
            this.notify('syncing paused.');
            return;
        }
        if (
            this.isConfigured() &&
            this.state.paths().length === 0 &&
            !(await this.confirmFirstSync(this.state.wasLost()))
        ) {
            this.settings.paused = true;
            await this.saveSettings();
            return;
        }
        this.notify('syncing resumed.');
        await this.engine.resume();
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
                verify: (pin) => this.sessionSlot.unlock(pin),
                forget: () => this.sessionSlot.forget(),
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
                        this.showStatus({ ...this.engine.getSummary(), status: 'signed-out' });
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
            verify: (pin) => this.sessionSlot.verify(pin),
            apply: async (newPin) => {
                if (mode === 'remove') {
                    await this.sessionSlot.removePin();
                } else if (newPin !== null) {
                    await this.sessionSlot.setPin(newPin);
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
            this.session.isSignedIn() &&
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
        const key = this.sessionSlot.exportKey();
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
        this.logger.info(`Locked after ${this.settings.pinLockAfterMinutes} minute(s) away`);
        await this.engine.stop();
        this.session.lock();
        this.sessionSlot.lock();
        await this.rememberedUnlock.clear();
        this.showStatus({ ...this.engine.getSummary(), status: 'locked' });
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
                verify: (pin) => this.sessionSlot.verify(pin),
                apply: async () => undefined,
                onDone: resolve,
            }).open();
        });
    }

    /**
     * Sign out: with the PIN first when there is one, then ending the session
     * on Proton's side before forgetting it here.
     *
     * The chosen Drive folder, and the sync state that describes it, go too.
     * Both belong to the account being signed out of, and the next sign-in
     * may be a different one, where that folder id means nothing, or the
     * same account wanting a different folder. Nothing is deleted on Drive
     * or in the vault; signing in again and choosing a folder starts a fresh
     * first sync, which pairs up files that already match.
     */
    async signOut(): Promise<void> {
        if (!(await this.confirmPin('sign out'))) {
            return;
        }
        await this.engine.stop();
        const { revoked } = await this.session.signOut();
        this.pinEnabled = false;
        await this.rememberedUnlock.clear();
        this.settings.remoteFolderUid = null;
        this.settings.remoteFolderPath = null;
        await this.saveSettings();
        await this.state.reset();
        this.refreshSettingsTab();
        this.notify(
            revoked
                ? 'signed out, and the session was ended on Proton.'
                : 'signed out on this device, but Proton could not be reached to end the session. ' +
                      'Revoke it under account.proton.me → Security → Sessions if you need it gone now.',
        );
        await this.reconnect();
    }

    /** Everything this device logged recently, with enough context to go in a bug report. */
    async copyLog(): Promise<void> {
        const header = [
            `Proton Drive Sync ${this.manifest.version}`,
            `Obsidian ${apiVersion}, ${Platform.isMobileApp ? 'mobile' : 'desktop'}`,
            `Status: ${this.engine.getSummary().status}`,
            '',
        ];
        await navigator.clipboard.writeText(header.join('\n') + formatLogEntries(this.logger.getEntries()));
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
        this.pinEnabled = (await this.sessionSlot.protection()) === 'pin';
        this.locked = await this.sessionSlot.isLocked();
        if (this.locked && this.settings.pinLockAfterMinutes > 0) {
            // Unlocked within the time limit before Obsidian last closed.
            const remembered = await this.rememberedUnlock.load();
            if (remembered !== null && (await this.sessionSlot.unlockWithKey(remembered))) {
                this.locked = false;
                this.markActive();
            }
        }
        if (this.locked) {
            this.showStatus({ ...this.engine.getSummary(), status: 'locked' });
            if (!(await this.unlock())) {
                return;
            }
        }
        try {
            await this.session.init();
        } catch (error) {
            this.logger.error('Could not restore the Proton session', error);
            this.showStatus({ ...this.engine.getSummary(), status: 'signed-out' });
            return;
        }

        if (!this.session.isSignedIn()) {
            this.showStatus({ ...this.engine.getSummary(), status: 'signed-out' });
            return;
        }
        if (!this.settings.remoteFolderUid) {
            this.showStatus({ ...this.engine.getSummary(), status: 'not-configured' });
            return;
        }

        await this.state.load(this.session.accountEmail ?? null, this.settings.remoteFolderUid);
        if (
            !this.settings.paused &&
            this.state.paths().length === 0 &&
            !(await this.confirmFirstSync(this.state.wasLost()))
        ) {
            this.settings.paused = true;
            await this.saveSettings();
        }
        await this.engine.start(this.session.getClient(), this.settings.remoteFolderUid);
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
        this.showStatus({ ...this.engine.getSummary(), status: 'syncing' });

        let plan: SyncPlan;
        try {
            plan = await this.engine.plan(this.session.getClient(), rootUid);
        } catch (error) {
            if (stateLost) {
                // Without the record of the last sync and without a preview,
                // going ahead would bring deletions back unseen. Hold off.
                this.logger.error('Could not preview the sync after the sync state was lost; pausing', error);
                this.notify('the record of the last sync could not be read, so syncing is paused. Resume it to try again.');
                return false;
            }
            this.logger.warn('Could not preview the first sync; going ahead, since it deletes nothing', error);
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
        await this.engine.syncNow();
    }

    private openSettings(): void {
        const setting = (this.app as App & { setting?: { open(): void; openTabById(id: string): void } }).setting;
        setting?.open();
        setting?.openTabById(this.manifest.id);
    }

    /** Tear the sync down and bring it back with the current configuration. */
    async reconnect(): Promise<void> {
        await this.engine.stop();
        await this.connect();
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        this.logger.setLevel(this.settings.logLevel);
        this.engine.updateSettings(this.settings);
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

    private registerVaultEvents(): void {
        const { vault } = this.app;

        this.registerEvent(vault.on('create', (file) => this.onFileChanged(file)));
        this.registerEvent(vault.on('modify', (file) => this.onFileChanged(file)));
        this.registerEvent(
            vault.on('delete', (file) => {
                if (file instanceof TFolder) {
                    this.engine.onVaultFolderDelete(file.path);
                } else {
                    this.onFileChanged(file);
                }
            }),
        );
        this.registerEvent(
            vault.on('rename', (file, oldPath) => {
                this.engine.onVaultRename(oldPath, file.path, file instanceof TFolder);
            }),
        );
    }

    private onFileChanged(file: TAbstractFile): void {
        // Folder creation arrives here too; it is handled by the full sync,
        // since an empty folder has no content to upload.
        if (file instanceof TFile) {
            this.engine.onVaultChange(file.path);
        }
    }

    private onSyncChange(summary: SyncSummary): void {
        this.showStatus(summary);
    }

    /** Show a summary everywhere the sync's state appears. */
    private showStatus(summary: SyncSummary): void {
        this.summary = summary;
        this.statusBar.update(summary);
        this.updateNoteIndicators();
        this.refreshSettingsTab();
        if (this.ribbonIcon) {
            setIcon(this.ribbonIcon, statusIcon(summary));
            this.ribbonIcon.toggleClass('proton-drive-sync-spin', summary.status === 'syncing');
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
            this.session.isSignedIn(),
            this.session.accountEmail,
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
    async restoreVersion(path: string, data: ArrayBuffer): Promise<void> {
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
        return this.engine.noteSyncState(path, stat) === 'pending';
    }

    private indicatorFor(file: TFile): NoteIndicator {
        const state = this.engine.noteSyncState(file.path, { size: file.stat.size, mtime: file.stat.mtime });
        return noteIndicator(
            state,
            this.engine.pendingChanges().find((change) => change.path === file.path),
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
        void this.conflictHistory.add(event);
        this.pendingConflicts.push(event);
        if (this.conflictNoticeTimer !== null) {
            return;
        }
        this.conflictNoticeTimer = window.setTimeout(() => {
            this.conflictNoticeTimer = null;
            showConflictNotice(this.app, this.pendingConflicts.splice(0), {
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
                this.engine.flushPendingEdits();
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
            this.engine.pollNow();
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
        this.registerDomEvent(window, 'online', () => this.engine.pollNow());

        // Moving between Wi-Fi and mobile data, for the "Wi-Fi only" setting.
        const connection = networkConnection();
        if (connection) {
            const onChange = () => this.engine.pollNow();
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
