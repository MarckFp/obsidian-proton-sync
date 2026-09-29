// Must be first: the SDK and its crypto reach for runtime APIs that older
// Electron builds lack, and they fail deep inside a transfer rather than at
// load time.
import './polyfills';

import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';

import { Credentials } from './proton/credentials';
import { decryptLegacySession, ObsidianSecretSlot } from './proton/secretStore';
import { ProtonSession } from './proton/session';
import { DEFAULT_SETTINGS, type PluginSettings } from './settings';
import { SyncEngine, type ConflictEvent, type SyncSummary } from './sync/engine';
import { SyncState } from './sync/state';
import { Logger } from './util/logger';
import { showConflictNotice } from './ui/conflictNotice';
import { ConflictsModal } from './ui/conflictsModal';
import { ProtonDriveSyncSettingsTab } from './ui/settingsTab';
import { SetupModal } from './ui/setupModal';
import { StatusBar } from './ui/statusBar';

/** Where 0.1.0 kept the session; migrated into secret storage on first load. */
const LEGACY_SESSION_FILE = 'session.json';
const STATE_FILE = 'sync-state.json';
/** Local-storage key for the installation id; see {@link ProtonDriveSyncPlugin.installationId}. */
const CLIENT_UID_KEY = 'proton-drive-sync-client-uid';

/** Conflicts found within this long of each other share one notice. */
const CONFLICT_NOTICE_DELAY_MS = 1500;

export default class ProtonDriveSyncPlugin extends Plugin {
    // Obsidian declares `settings?: unknown` on Plugin; this narrows it.
    declare settings: PluginSettings;
    logger!: Logger;
    session!: ProtonSession;
    state!: SyncState;
    engine!: SyncEngine;

    private statusBar!: StatusBar;
    private pendingConflicts: ConflictEvent[] = [];
    private conflictNoticeTimer: number | null = null;

    override async onload(): Promise<void> {
        await this.loadSettings();

        this.logger = new Logger(this.settings.logLevel);
        this.statusBar = new StatusBar(this.addStatusBarItem(), () => void this.engine.syncNow());

        const clientUid = this.installationId();
        const protonLogger = this.logger.getLogger('proton');
        const credentials = new Credentials(
            new ObsidianSecretSlot(this.app.secretStorage, `proton-drive-sync-session-${clientUid}`),
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
        this.engine = new SyncEngine(
            this.app,
            this.state,
            this.settings,
            this.logger.getLogger('sync'),
            {
                onChange: (summary) => this.onSyncChange(summary),
                onConflict: (event) => this.onConflict(event),
            },
            { configDir: this.app.vault.configDir, pluginDir: this.pluginDir() },
        );

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

    override async onunload(): Promise<void> {
        if (this.conflictNoticeTimer !== null) {
            window.clearTimeout(this.conflictNoticeTimer);
        }
        await this.engine.stop();
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
            await this.session.init();
        } catch (error) {
            this.logger.error('Could not restore the Proton session', error);
            this.statusBar.update({ ...this.engine.getSummary(), status: 'signed-out' });
            return;
        }

        if (!this.session.isSignedIn()) {
            this.statusBar.update({ ...this.engine.getSummary(), status: 'signed-out' });
            return;
        }
        if (!this.settings.remoteFolderUid) {
            this.statusBar.update({ ...this.engine.getSummary(), status: 'not-configured' });
            return;
        }

        await this.state.load(this.session.accountEmail ?? null, this.settings.remoteFolderUid);
        await this.engine.start(this.session.getClient(), this.settings.remoteFolderUid);
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
            name: 'Sync now',
            callback: () => {
                if (!this.isConfigured()) {
                    this.openSetup();
                    return;
                }
                void this.engine.syncNow();
            },
        });

        this.addCommand({
            id: 'open-setup',
            name: 'Set up Proton Drive Sync',
            callback: () => this.openSetup(),
        });

        this.addCommand({
            id: 'show-conflicts',
            name: 'Show sync conflicts',
            callback: () => new ConflictsModal(this.app, this).open(),
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
        this.statusBar.update(summary);
    }

    /**
     * Collect conflicts briefly before telling the user, so a sync that finds
     * twenty of them shows one notice, not twenty.
     */
    private onConflict(event: ConflictEvent): void {
        this.pendingConflicts.push(event);
        if (this.conflictNoticeTimer !== null) {
            return;
        }
        this.conflictNoticeTimer = window.setTimeout(() => {
            this.conflictNoticeTimer = null;
            showConflictNotice(this.app, this.pendingConflicts.splice(0), () =>
                new ConflictsModal(this.app, this).open(),
            );
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
