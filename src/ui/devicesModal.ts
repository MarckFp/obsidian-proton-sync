import { type App, ButtonComponent, ExtraButtonComponent, Modal, Notice, setIcon, Setting } from 'obsidian';

import {
    type DeviceEntry,
    type DeviceRequest,
    type DeviceState,
    type DeviceStatus,
    RECORD_EVERY_MS,
    standingOf,
} from '../sync/devices';
import { ConfirmModal } from './confirmModal';
import { timeAgo } from './syncStatus';

/** What the dialog needs: the vault's device list, and ways to change it. */
export type DevicesHost = {
    /** This device, which is marked, and managed from its own settings rather than from here. */
    selfId: string;
    list(): Promise<DeviceEntry[]>;
    /** Leave a request for a device. */
    ask(entry: DeviceEntry, state: DeviceState): Promise<void>;
    forget(id: string): Promise<void>;
};

/**
 * Another device's last sync is overdue after this long: the hour this device
 * allows itself, plus the hour by which a device's record may lag behind it.
 */
const OVERDUE_AFTER_MS = 60 * 60 * 1000 + RECORD_EVERY_MS;

/** A device not heard from in this long can be forgotten, whether or not it acted on a removal. */
const FORGETTABLE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const ASKED: Record<DeviceState, string> = {
    paused: 'Asked to pause. It will the next time it checks Drive.',
    active: 'Asked to resume. It will the next time it checks Drive.',
    removed: 'Asked to stop syncing and sign out. It will the next time it checks Drive.',
};

const RECORDED: Partial<Record<DeviceStatus, string>> = {
    idle: 'Syncing',
    paused: 'Paused',
    error: 'Syncing, but its last attempt failed',
    offline: 'Offline',
    'waiting-for-wifi': 'Waiting for Wi-Fi',
    removed: 'Removed: signed out, and syncs again only once someone signs in on it',
};

/**
 * Every device that syncs the vault with this plugin, as each last recorded:
 * its name, platform and account, how it stands, and when it last synced, in
 * green, or in red once that is overdue.
 *
 * Other devices can be paused, resumed or removed from here. Each acts on it
 * the next time it checks Drive, which for one that is closed is when it next
 * opens. A removed device signs out, and syncs again only once someone signs
 * in on it; devices on versions from before the list, and Proton's own apps,
 * do not list themselves and ignore all of this.
 */
export class DevicesModal extends Modal {
    private entries: DeviceEntry[] | 'loading' | Error = 'loading';

    constructor(
        app: App,
        private readonly host: DevicesHost,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.setTitle('Devices syncing this vault');
        void this.load();
    }

    override onClose(): void {
        this.contentEl.empty();
    }

    private async load(): Promise<void> {
        this.entries = 'loading';
        this.render();
        try {
            this.entries = await this.host.list();
        } catch (error) {
            this.entries = error instanceof Error ? error : new Error(String(error));
        }
        this.render();
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();
        const header = contentEl.createDiv({ cls: 'proton-drive-sync-list-header' });
        header.createSpan({
            cls: 'proton-drive-sync-muted',
            text:
                'Devices list themselves here when they sync. Older versions of this plugin, and Proton’s own ' +
                'apps, do not, and ignore what is asked here.',
        });
        new ExtraButtonComponent(header)
            .setIcon('refresh-cw')
            .setTooltip('List the devices again')
            .onClick(() => void this.load());

        const say = (text: string) => contentEl.createEl('p', { cls: 'proton-drive-sync-muted', text });
        if (this.entries === 'loading') {
            say('Listing devices…');
            return;
        }
        if (this.entries instanceof Error) {
            say(`Could not list the devices: ${this.entries.message}`);
            return;
        }
        if (this.entries.length === 0) {
            say('No device has listed itself yet. Each one does shortly after it syncs.');
            return;
        }
        const list = contentEl.createDiv({ cls: 'proton-drive-sync-list' });
        const self = this.host.selfId;
        const sorted = [...this.entries].sort(
            (a, b) => Number(b.id === self) - Number(a.id === self) || (b.record?.seen ?? 0) - (a.record?.seen ?? 0),
        );
        for (const entry of sorted) {
            this.renderEntry(list, entry);
        }
        contentEl.createEl('p', {
            cls: 'proton-drive-sync-muted',
            text:
                'This asks devices to cooperate; it cannot make them. To cut a device off for good, change your ' +
                'Proton password, or revoke its session in Proton’s account settings under Security.',
        });
    }

    private renderEntry(list: HTMLElement, entry: DeviceEntry): void {
        const { record } = entry;
        const isSelf = entry.id === this.host.selfId;
        const row = list.createDiv({ cls: 'proton-drive-sync-device' });
        const text = row.createDiv({ cls: 'proton-drive-sync-device-text' });

        const name = text.createDiv({ cls: 'proton-drive-sync-device-name', text: record?.name || 'Unknown device' });
        if (isSelf) {
            name.createSpan({ cls: 'proton-drive-sync-badge', text: 'This device' });
        }
        const facts = [
            record?.platform,
            record?.pluginVersion ? `version ${record.pluginVersion}` : undefined,
            record?.account ?? undefined,
        ].filter((fact): fact is string => Boolean(fact));
        if (facts.length > 0) {
            text.createDiv({ cls: 'proton-drive-sync-muted', text: facts.join(' · ') });
        }

        const standing = standingOf(entry);
        const status =
            standing.kind === 'asked'
                ? ASKED[standing.state]
                : standing.kind === 'recorded'
                  ? (RECORDED[standing.status] ?? standing.status)
                  : 'Has not listed itself yet.';
        text.createDiv({
            cls: 'proton-drive-sync-muted',
            text: record?.seen ? `${status} · checked in ${timeAgo(record.seen)}` : status,
        });

        if (record?.lastSyncedAt) {
            const overdue = Date.now() - record.lastSyncedAt > OVERDUE_AFTER_MS;
            const box = text.createDiv({ cls: `proton-drive-sync-last-synced${overdue ? ' mod-overdue' : ''}` });
            setIcon(box.createSpan({ cls: 'proton-drive-sync-last-synced-icon' }), overdue ? 'alert-triangle' : 'check-circle');
            box.createSpan({
                cls: 'proton-drive-sync-last-synced-text',
                text: `Last synced ${timeAgo(record.lastSyncedAt)}`,
            });
        }

        if (!isSelf) {
            this.renderActions(row.createDiv({ cls: 'proton-drive-sync-device-actions' }), entry);
        }
    }

    /**
     * Pause or Resume, whichever applies, and Remove; Forget instead for a
     * device that is gone, and also for one not heard from in a month.
     */
    private renderActions(container: HTMLElement, entry: DeviceEntry): void {
        const standing = standingOf(entry);
        const name = entry.record?.name || 'this device';
        const removed =
            (standing.kind === 'asked' && standing.state === 'removed') ||
            (standing.kind === 'recorded' && standing.status === 'removed');
        const silent = entry.record === null || Date.now() - entry.record.seen > FORGETTABLE_AFTER_MS;

        if (!removed) {
            const paused =
                (standing.kind === 'asked' && standing.state === 'paused') ||
                (standing.kind === 'recorded' && standing.status === 'paused');
            const verb = paused ? 'resume' : 'pause';
            const button = new ButtonComponent(container).setButtonText(paused ? 'Resume' : 'Pause');
            button.onClick(async () => {
                button.setDisabled(true);
                try {
                    await this.act(`Asked ${name} to ${verb}.`, () => this.host.ask(entry, paused ? 'active' : 'paused'));
                } catch (error) {
                    new Notice(`Could not ask ${name} to ${verb}: ${error instanceof Error ? error.message : String(error)}`);
                    button.setDisabled(false);
                }
            });
            new ButtonComponent(container)
                .setButtonText('Remove')
                .setDestructive()
                .onClick(() =>
                    new ConfirmModal(this.app, {
                        title: `Remove ${name}?`,
                        text:
                            `${name} stops syncing and signs out the next time it checks Drive, and syncs this vault ` +
                            'again only once someone signs in on it with the account’s password. Nothing is ' +
                            'deleted, on the device or on Drive.',
                        action: 'Remove',
                        run: () => this.act(`Asked ${name} to stop syncing and sign out.`, () => this.host.ask(entry, 'removed')),
                    }).open(),
                );
        }
        if (removed || silent) {
            new ButtonComponent(container).setButtonText('Forget').onClick(() =>
                new ConfirmModal(this.app, {
                    title: `Forget ${name}?`,
                    text: 'Takes it off this list. A device that still syncs puts itself back the next time it updates.',
                    action: 'Forget',
                    run: () => this.act(`Forgot ${name}.`, () => this.host.forget(entry.id)),
                }).open(),
            );
        }
    }

    /** Carry out an action, say so, and list the devices again; a failure is thrown, for the caller to report. */
    private async act(notice: string, run: () => Promise<void>): Promise<void> {
        await run();
        new Notice(notice);
        void this.load();
    }
}

/**
 * Shown on a device once it has acted on its removal from the list: why it
 * stopped syncing and signed out, and how to bring it back.
 */
export class DeviceRemovedModal extends Modal {
    constructor(
        app: App,
        private readonly request: DeviceRequest,
        private readonly signIn: () => void,
    ) {
        super(app);
    }

    override onOpen(): void {
        this.setTitle('This device was removed');
        const by = this.request.byName ? `"${this.request.byName}"` : 'Another device';
        this.contentEl.createEl('p', {
            text:
                `${by} removed this device from the devices syncing this vault on ` +
                `${new Date(this.request.at).toLocaleString()}, so it stopped syncing and signed out. The notes on ` +
                'this device are untouched. Sign in again to sync it.',
        });
        new Setting(this.contentEl)
            .addButton((button) => button.setButtonText('Close').onClick(() => this.close()))
            .addButton((button) =>
                button
                    .setButtonText('Sign in')
                    .setCta()
                    .onClick(() => {
                        this.close();
                        this.signIn();
                    }),
            );
    }

    override onClose(): void {
        this.contentEl.empty();
    }
}
