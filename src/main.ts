// Must be first: the SDK and its crypto reach for runtime APIs that older
// Electron builds lack, and they fail deep inside a transfer rather than at
// load time.
import './polyfills';

import { Notice, Plugin, TAbstractFile, TFile } from 'obsidian';

import { ProtonSession } from './proton/session';
import { DEFAULT_SETTINGS, type PluginSettings } from './settings';
import { SyncEngine, type SyncSummary } from './sync/engine';
import { SyncState } from './sync/state';
import { Logger } from './util/logger';
import { ConflictsModal } from './ui/conflictsModal';
import { ProtonDriveSyncSettingsTab } from './ui/settingsTab';
import { StatusBar } from './ui/statusBar';

const SESSION_FILE = 'session.json';
const STATE_FILE = 'sync-state.json';

export default class ProtonDriveSyncPlugin extends Plugin {
    // Obsidian declares `settings?: unknown` on Plugin; this narrows it.
    declare settings: PluginSettings;
    logger!: Logger;
    session!: ProtonSession;
    state!: SyncState;
    engine!: SyncEngine;

    private statusBar!: StatusBar;

    override async onload(): Promise<void> {
        await this.loadSettings();

        this.logger = new Logger(this.settings.logLevel);
        this.statusBar = new StatusBar(this.addStatusBarItem(), () => void this.engine.syncNow());

        this.session = new ProtonSession(
            this.app.vault.adapter,
            this.pluginFile(SESSION_FILE),
            this.settings.clientUid,
            this.logger.getLogger('proton'),
        );
        this.state = new SyncState(
            this.app.vault.adapter,
            this.pluginFile(STATE_FILE),
            this.logger.getLogger('state'),
        );
        this.engine = new SyncEngine(this.app, this.state, this.settings, this.logger.getLogger('sync'), (summary) =>
            this.onSyncChange(summary),
        );

        this.addSettingTab(new ProtonDriveSyncSettingsTab(this.app, this));
        this.registerCommands();
        this.registerVaultEvents();

        // Deferred until the workspace is ready so a first sync does not
        // compete with Obsidian opening the vault, and so the flood of vault
        // events Obsidian emits while indexing is not mistaken for user edits.
        this.app.workspace.onLayoutReady(() => {
            void this.connect();
        });
    }

    override async onunload(): Promise<void> {
        await this.engine.stop();
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
        this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<PluginSettings>);

        // Filled in on first run rather than in the defaults, because both have
        // to be stable for the life of the installation once chosen.
        let changed = false;
        if (!this.settings.clientUid) {
            this.settings.clientUid = crypto.randomUUID();
            changed = true;
        }
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
                if (!this.session.isSignedIn()) {
                    new Notice('Proton Drive Sync: sign in first, in the plugin settings.');
                    return;
                }
                if (!this.settings.remoteFolderUid) {
                    new Notice('Proton Drive Sync: choose a Drive folder first, in the plugin settings.');
                    return;
                }
                void this.engine.syncNow();
            },
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
        this.registerEvent(vault.on('delete', (file) => this.onFileChanged(file)));
        this.registerEvent(
            vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile) {
                    this.engine.onVaultRename(oldPath, file.path);
                }
            }),
        );
    }

    private onFileChanged(file: TAbstractFile): void {
        // Folders arrive here too; they are handled by the full sync, which is
        // the only pass that can tell an empty folder from a deleted one.
        if (file instanceof TFile) {
            this.engine.onVaultChange(file.path);
        }
    }

    private onSyncChange(summary: SyncSummary): void {
        this.statusBar.update(summary);
    }

    private pluginFile(name: string): string {
        const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
        return `${dir}/${name}`;
    }
}

/** The machine's hostname, which is what makes a conflict copy identifiable. */
function defaultDeviceName(): string {
    try {
        const os = window.require('os') as { hostname(): string };
        return os.hostname();
    } catch {
        return 'this device';
    }
}
