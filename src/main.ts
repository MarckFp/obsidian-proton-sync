// Must be first: the SDK and its crypto reach for runtime APIs that older
// Electron builds lack, and they fail deep inside a transfer rather than at
// load time.
import './polyfills';

import { apiVersion, type App, Notice, Platform, Plugin, setIcon, setTooltip, TAbstractFile, TFile, TFolder } from 'obsidian';

import { Credentials } from './proton/credentials';
import { PinProtectedSlot } from './proton/pinLock';
import { ConflictHistory } from './sync/conflictHistory';
import { decryptLegacySession, ObsidianSecretSlot } from './proton/secretStore';
import { ProtonSession } from './proton/session';
import { DEFAULT_SETTINGS, type PluginSettings } from './settings';
import { SyncEngine, type ConflictEvent, type SyncPlan, type SyncSummary } from './sync/engine';
import { SyncState } from './sync/state';
import { formatLogEntries, Logger } from './util/logger';
import { compareConflictCopyOf, compareWithConflictCopy, conflictPairsFor } from './ui/compare';
import { showConflictNotice } from './ui/conflictNotice';
import { ConflictsModal } from './ui/conflictsModal';
import { FirstSyncModal } from './ui/firstSyncModal';
import { PinFormModal, UnlockModal } from './ui/pinModals';
import { ReloadModal } from './ui/reloadModal';
import { CONFLICT_POLICIES, ProtonDriveSyncSettingsTab } from './ui/settingsTab';
import { SetupModal } from './ui/setupModal';
import { StatusBar } from './ui/statusBar';
import { SYNC_PANEL_VIEW, SyncPanelView } from './ui/syncPanel';
import { statusIcon, statusLabel } from './ui/syncStatus';

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
    engine!: SyncEngine;

    private statusBar!: StatusBar;
    /** The ribbon icon standing in for the status bar on mobile; null on desktop. */
    private ribbonIcon: HTMLElement | null = null;
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
                    logEntries: () => this.logger.getEntries(),
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
            },
        );

        this.summary = this.engine.getSummary();
        this.addSettingTab(new ProtonDriveSyncSettingsTab(this.app, this));
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
        if (this.isConfigured() && this.state.paths().length === 0 && !(await this.confirmFirstSync())) {
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
                    } else if (result === 'forgotten') {
                        this.locked = false;
                        this.pinEnabled = false;
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
     */
    async signOut(): Promise<void> {
        if (!(await this.confirmPin('sign out'))) {
            return;
        }
        const { revoked } = await this.session.signOut();
        this.pinEnabled = false;
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
        if (!this.settings.paused && this.state.paths().length === 0 && !(await this.confirmFirstSync())) {
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
    private async confirmFirstSync(): Promise<boolean> {
        const rootUid = this.settings.remoteFolderUid;
        if (!rootUid) {
            return true;
        }
        this.showStatus({ ...this.engine.getSummary(), status: 'syncing' });

        let plan: SyncPlan;
        try {
            plan = await this.engine.plan(this.session.getClient(), rootUid);
        } catch (error) {
            this.logger.warn('Could not preview the first sync; going ahead, since it deletes nothing', error);
            return true;
        }
        const changes = plan.uploads.length + plan.downloads.length + plan.conflicts.length + plan.removals.length;
        if (plan.localNotes === 0 || plan.remoteFiles === 0 || changes === 0) {
            return true;
        }

        const folderName = this.settings.remoteFolderPath ?? 'the Drive folder';
        const policy = CONFLICT_POLICIES[this.settings.conflictPolicy];
        return new Promise((resolve) => {
            new FirstSyncModal(this.app, plan, folderName, policy.toLowerCase(), resolve).open();
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

    /** Re-show the current summary, so "synced 5m ago" keeps counting. */
    private refreshStatus(): void {
        if (this.summary) {
            this.showStatus(this.summary);
        }
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
        this.registerDomEvent(document, 'visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.engine.flushPendingEdits();
            } else {
                this.engine.pollNow();
            }
        });
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
