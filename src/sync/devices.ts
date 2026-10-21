import { NodeType, NodeWithSameNameExistsValidationError } from '@protontech/drive-sdk';

import { DEVICES_FOLDER } from '../settings';
import { sha1Hex } from '../util/hash';
import type { Logger } from '../util/logger';
import type { DriveIO, UploadSource } from './drive';
import type { SyncStatus, SyncSummary } from './engine/types';

/**
 * The vault's device list: every device that syncs the vault with this
 * plugin keeps a note of itself in a hidden folder at the root of the synced
 * Drive folder, and the others can leave it a request there, to pause, resume
 * or stop syncing.
 *
 * Each device writes only its own record, `device-<id>.json`; requests for it
 * go in a file of their own, `request-<id>.json`. Drive has no way to update
 * a file only if nobody changed it since it was read, so one shared list would
 * lose whichever of two devices' updates landed first; with one writer per
 * file, nothing is lost. A request is acted on once, when the device next
 * checks: the latest one wins, and a device paused from elsewhere can still be
 * resumed by hand.
 *
 * It asks devices to cooperate; it cannot make them. Versions of the plugin
 * from before the list, Proton's own apps, and anything else signed in to the
 * account neither list themselves nor read requests, and anyone with access to
 * the folder can write to it. Ending a device's access for good takes
 * changing the Proton password, or revoking its session in Proton's account
 * settings.
 */

const RECORD_PREFIX = 'device-';
const REQUEST_PREFIX = 'request-';
const SUFFIX = '.json';

/** The layout of both files, written into each so a later version can tell what it reads. */
const FORMAT = 1;

/** While a device syncs, its record is written again this often, so its last sync on the list stays current. */
export const RECORD_EVERY_MS = 60 * 60 * 1000;
/** And never more often than this, however often its status changes: each write is a new revision on Drive. */
export const RECORD_GAP_MS = 5 * 60 * 1000;
/** A change waits this long before it is written, for others to join it, such as the rest of a name being typed. */
const RECORD_SETTLE_MS = 10 * 1000;

/** What a device can be asked to do. */
export type DeviceState = 'active' | 'paused' | 'removed';

/** How a device stands, as it last recorded: its sync status, or removed once it acted on a removal. */
export type DeviceStatus = SyncStatus | 'removed';

/** What a device says about itself. Only that device writes it. */
export type DeviceRecord = {
    id: string;
    name: string;
    platform: string;
    pluginVersion: string;
    /** The Proton account it syncs with. */
    account: string | null;
    /** When it first put itself on the list. */
    since: number;
    /** When it last wrote this record. */
    seen: number;
    lastSyncedAt: number | null;
    status: DeviceStatus;
    /** The `at` of the last request it acted on; see {@link DeviceRequest}. */
    handled: number;
};

/** What another device asked of this one. */
export type DeviceRequest = {
    state: DeviceState;
    /**
     * When it was asked, always later than any request before it for the same
     * device, whatever the clocks of the devices that asked; see
     * {@link nextRequestAt}. A device acts on a request newer than the last
     * one it handled.
     */
    at: number;
    /** The device that asked, by id and by name. */
    by: string;
    byName: string;
};

/** A device on the list: its record, and the last request left for it. Either may be missing. */
export type DeviceEntry = { id: string; record: DeviceRecord | null; request: DeviceRequest | null };

/** This device, as it puts itself on the list. */
export type DeviceIdentity = Pick<DeviceRecord, 'id' | 'name' | 'platform' | 'pluginVersion' | 'account'>;

/** Statuses worth recording. Others are passing (syncing), or leave no way to reach Drive (signed out, locked). */
const RECORDED: ReadonlySet<DeviceStatus> = new Set<DeviceStatus>(['idle', 'paused', 'error', 'offline', 'waiting-for-wifi', 'removed']);

/**
 * Whether a device's record is worth writing again: for any change the list
 * would show, and otherwise hourly while it syncs, so that its last sync there
 * stays current without a revision on Drive every time Drive is checked.
 */
export function recordDue(last: DeviceRecord | null, next: DeviceRecord, now = Date.now()): boolean {
    if (!RECORDED.has(next.status)) {
        return false;
    }
    if (last === null) {
        return true;
    }
    const shown: (keyof DeviceRecord)[] = ['name', 'platform', 'pluginVersion', 'account', 'status', 'handled'];
    if (shown.some((key) => last[key] !== next[key])) {
        return true;
    }
    return next.lastSyncedAt !== last.lastSyncedAt && now - last.seen >= RECORD_EVERY_MS;
}

/**
 * The `at` for a new request to a device: now, or just after the last request
 * left for it or handled by it, when a clock somewhere is ahead. Without that,
 * a resume asked from a device whose clock is behind would read as older than
 * the pause it answers, and never be acted on.
 */
export function nextRequestAt(entry: Pick<DeviceEntry, 'record' | 'request'>, now = Date.now()): number {
    return Math.max(now, (entry.request?.at ?? 0) + 1, (entry.record?.handled ?? 0) + 1);
}

/** How a device stands on the list: a request it has not picked up yet, or what it last recorded. */
export type DeviceStanding =
    | { kind: 'asked'; state: DeviceState }
    | { kind: 'recorded'; status: DeviceStatus }
    | { kind: 'unknown' };

export function standingOf(entry: Pick<DeviceEntry, 'record' | 'request'>): DeviceStanding {
    const { record, request } = entry;
    if (request && request.at > (record?.handled ?? 0)) {
        return { kind: 'asked', state: request.state };
    }
    return record ? { kind: 'recorded', status: record.status } : { kind: 'unknown' };
}

type RegistryDrive = Pick<
    DriveIO,
    'iterateChildren' | 'createFolder' | 'uploadNewFile' | 'uploadRevision' | 'downloadFile' | 'trashNode'
>;

/**
 * The device list's folder on Drive: reading and writing its files.
 *
 * The folder is made by the first device that has something to write, so a
 * vault synced before the list existed gets one as soon as a device with this
 * version syncs it. Reading never makes it.
 */
export class DeviceRegistry {
    private folderUid: string | null = null;
    /** The folder's files, by name, as last listed; null to list them again. */
    private files: Map<string, string> | null = null;

    constructor(
        private readonly drive: RegistryDrive,
        private readonly rootUid: string,
        private readonly logger: Logger,
    ) {}

    /** Learn where the folder is, from a listing of the synced folder or an event. */
    knowFolder(uid: string): void {
        if (this.folderUid !== uid) {
            this.folderUid = uid;
            this.files = null;
        }
    }

    /**
     * Take a change on Drive that is to the list, its folder or a file in it,
     * forgetting what was listed of it, since a file may have come or gone.
     * False for a change that is the vault's.
     */
    takeChange(change: { nodeUid: string; parentNodeUid?: string | undefined }): boolean {
        if (this.folderUid === null || (change.nodeUid !== this.folderUid && change.parentNodeUid !== this.folderUid)) {
            return false;
        }
        this.files = null;
        return true;
    }

    async record(id: string): Promise<DeviceRecord | null> {
        return this.read(recordName(id), parseRecord);
    }

    async request(id: string): Promise<DeviceRequest | null> {
        return this.read(requestName(id), parseRequest);
    }

    /** Write a device's record: only ever this device's own. */
    async publish(record: DeviceRecord): Promise<void> {
        await this.write(recordName(record.id), record);
    }

    /** Leave a request for a device, replacing any earlier one. */
    async ask(id: string, request: DeviceRequest): Promise<void> {
        await this.write(requestName(id), request);
    }

    /** Every device on the list, with its record and the last request left for it. */
    async list(): Promise<DeviceEntry[]> {
        const files = await this.listing(false, true);
        if (files === null) {
            return [];
        }
        const ids = new Set<string>();
        for (const name of files.keys()) {
            const id = idOf(name);
            if (id !== null) {
                ids.add(id);
            }
        }
        return Promise.all(
            [...ids].map(async (id) => ({ id, record: await this.record(id), request: await this.request(id) })),
        );
    }

    /** Take a device off the list, with any request left for it. Its files go to Drive's trash. */
    async forget(id: string): Promise<void> {
        const files = await this.listing(false, true);
        for (const name of [recordName(id), requestName(id)]) {
            const uid = files?.get(name);
            if (uid !== undefined) {
                await this.drive.trashNode(uid);
                files!.delete(name);
            }
        }
    }

    /**
     * One of the folder's files, parsed; null when it is missing, or not
     * something this version can read, which is logged. A failure to reach
     * Drive is thrown, for the caller to decide what that means.
     */
    private async read<T>(name: string, parse: (value: unknown) => T | null): Promise<T | null> {
        const uid = (await this.listing(false))?.get(name);
        if (uid === undefined) {
            return null;
        }
        const data = await this.drive.downloadFile(uid);
        let parsed: T | null = null;
        try {
            parsed = parse(JSON.parse(new TextDecoder().decode(data)));
        } catch {
            // Reported below, as for anything else unreadable.
        }
        if (parsed === null) {
            this.logger.warn(`Ignoring "${DEVICES_FOLDER}/${name}", which is not a device list file this version can read`);
        }
        return parsed;
    }

    private async write(name: string, value: DeviceRecord | DeviceRequest): Promise<void> {
        const data = new TextEncoder().encode(`${JSON.stringify({ format: FORMAT, ...value }, null, 2)}\n`);
        const source = await sourceOf(data.buffer);
        try {
            await this.writeOnce(name, source);
        } catch (error) {
            // The folder, or the file, may have gone to the trash or been
            // replaced since they were listed: look again, once.
            this.logger.debug(`Writing "${DEVICES_FOLDER}/${name}" failed; trying again with a fresh listing`, error);
            this.folderUid = null;
            this.files = null;
            await this.writeOnce(name, source);
        }
    }

    private async writeOnce(name: string, source: UploadSource): Promise<void> {
        const files = (await this.listing(true))!;
        const folderUid = this.folderUid!;
        const existing = files.get(name);
        if (existing !== undefined) {
            await this.drive.uploadRevision(existing, source);
            return;
        }
        try {
            files.set(name, (await this.drive.uploadNewFile(folderUid, name, source)).nodeUid);
        } catch (error) {
            if (!(error instanceof NodeWithSameNameExistsValidationError)) {
                throw error;
            }
            if (error.isUnfinishedUpload) {
                // Held by an upload of it that another device never finished.
                files.set(name, (await this.drive.uploadNewFile(folderUid, name, source, undefined, undefined, true)).nodeUid);
                return;
            }
            if (error.existingNodeUid === undefined) {
                throw error;
            }
            // Another device made it since the listing: write over it.
            files.set(name, error.existingNodeUid);
            await this.drive.uploadRevision(error.existingNodeUid, source);
        }
    }

    /** The folder's files by name, listed when not known or when `fresh`; null when there is no folder and `create` is off. */
    private async listing(create: boolean, fresh = false): Promise<Map<string, string> | null> {
        const folderUid = await this.folder(create);
        if (folderUid === null) {
            return null;
        }
        if (this.files === null || fresh) {
            const files = new Map<string, string>();
            for await (const { node, name } of this.drive.iterateChildren(folderUid)) {
                if (node.type === NodeType.File) {
                    files.set(name, node.uid);
                }
            }
            this.files = files;
        }
        return this.files;
    }

    private async folder(create: boolean): Promise<string | null> {
        if (this.folderUid !== null) {
            return this.folderUid;
        }
        for await (const { node, name } of this.drive.iterateChildren(this.rootUid)) {
            if (name === DEVICES_FOLDER && node.type === NodeType.Folder) {
                this.knowFolder(node.uid);
                return node.uid;
            }
        }
        if (!create) {
            return null;
        }
        try {
            this.knowFolder(await this.drive.createFolder(this.rootUid, DEVICES_FOLDER));
        } catch (error) {
            // Another device made it a moment ago.
            if (!(error instanceof NodeWithSameNameExistsValidationError) || error.existingNodeUid === undefined) {
                throw error;
            }
            this.knowFolder(error.existingNodeUid);
        }
        return this.folderUid;
    }
}

/** What the device list needs from the plugin. */
export type DeviceListHost = {
    self(): DeviceIdentity;
    /** The `at` of the last request this device acted on, kept on the device itself; 0 for none. */
    handled(): number;
    setHandled(at: number): void;
};

/**
 * This device's side of the list: keeping its record on Drive current, and
 * picking up requests other devices left for it.
 *
 * Neither may hold up syncing. A list that cannot be read, because Drive is
 * out of reach or a file is damaged, means syncing goes on as it would without
 * one; a record that cannot be written is tried again later.
 */
export class DeviceList {
    private registry: DeviceRegistry | null = null;
    /** What this device last wrote about itself, while the list has been open. */
    private written: DeviceRecord | null = null;
    /** When it last tried to, whether or not that worked. */
    private attempted = 0;
    /** A request was just acted on: write without waiting out the gap, so the device that asked sees it done. */
    private urgent = false;
    /** When it first put itself on the list, read back from its record before the first write. */
    private since: number | null = null;
    private summary: SyncSummary | null = null;
    private timer: number | null = null;
    private timerDue = 0;
    /** Writes, one after another, so a slow one cannot land after a newer one. */
    private writing: Promise<void> = Promise.resolve();

    constructor(
        private readonly host: DeviceListHost,
        private readonly logger: Logger,
    ) {}

    /** The list being kept, or null: none open, signed out, or a vault shared with others. */
    get current(): DeviceRegistry | null {
        return this.registry;
    }

    /** Keep the list in `registry`, or none. */
    open(registry: DeviceRegistry | null): void {
        this.cancel();
        this.registry = registry;
        this.written = null;
        this.attempted = 0;
        this.urgent = false;
        this.since = null;
    }

    /**
     * A request for this device that it has not acted on yet; null when there
     * is none, and also when the list cannot be read, so that syncing goes on.
     * Marked as handled as it is returned, so each is carried out once, even
     * if Obsidian closes halfway through.
     */
    async pendingRequest(): Promise<DeviceRequest | null> {
        const registry = this.registry;
        if (!registry) {
            return null;
        }
        let request: DeviceRequest | null;
        try {
            request = await registry.request(this.host.self().id);
        } catch (error) {
            this.logger.warn('Could not check the device list for requests; syncing as usual', error);
            return null;
        }
        if (!request || request.at <= this.host.handled()) {
            return null;
        }
        this.host.setHandled(request.at);
        this.urgent = true;
        this.schedule();
        return request;
    }

    /** The sync's status changed: write this device's record once that is worth doing; see {@link recordDue}. */
    noteStatus(summary: SyncSummary): void {
        this.summary = summary;
        this.schedule();
    }

    /** Something about this device changed, such as its name: write its record soon. */
    noteChange(): void {
        this.schedule();
    }

    /**
     * Record that this device acted on its removal and is about to sign out,
     * so the device that asked sees it done. Straight away, and best effort:
     * signing out goes ahead whether or not this reaches Drive.
     */
    async recordRemoved(): Promise<void> {
        const record = this.recordNow('removed');
        if (record) {
            this.cancel();
            await this.write(record);
        }
    }

    private recordNow(status?: DeviceStatus): DeviceRecord | null {
        const summary = this.summary;
        if (!this.registry || (!summary && status === undefined)) {
            return null;
        }
        const now = Date.now();
        return {
            ...this.host.self(),
            since: this.since ?? now,
            seen: now,
            lastSyncedAt: summary?.lastSyncedAt ?? null,
            status: status ?? summary!.status,
            handled: this.host.handled(),
        };
    }

    private schedule(): void {
        const next = this.recordNow();
        const now = Date.now();
        if (!next || !recordDue(this.written, next, now)) {
            return;
        }
        const due = this.urgent ? now + RECORD_SETTLE_MS : Math.max(now + RECORD_SETTLE_MS, this.attempted + RECORD_GAP_MS);
        if (this.timer !== null && this.timerDue <= due) {
            return;
        }
        this.cancel();
        this.timerDue = due;
        this.timer = window.setTimeout(() => {
            this.timer = null;
            const record = this.recordNow();
            if (record && recordDue(this.written, record)) {
                void this.write(record);
            }
        }, due - now);
    }

    private write(record: DeviceRecord): Promise<void> {
        this.writing = this.writing.then(async () => {
            const registry = this.registry;
            if (!registry) {
                return;
            }
            this.attempted = Date.now();
            this.urgent = false;
            try {
                if (this.since === null) {
                    this.since = (await registry.record(record.id))?.since ?? record.seen;
                }
                const written = { ...record, since: this.since };
                await registry.publish(written);
                if (this.registry === registry) {
                    this.written = written;
                }
            } catch (error) {
                // Tried again on a later status change, no sooner than the gap allows.
                this.logger.warn('Could not update this device on the device list', error);
            }
        });
        return this.writing;
    }

    private cancel(): void {
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

function recordName(id: string): string {
    return `${RECORD_PREFIX}${id}${SUFFIX}`;
}

function requestName(id: string): string {
    return `${REQUEST_PREFIX}${id}${SUFFIX}`;
}

/** The device a file in the list is about, or null for a file that is not one of them. */
function idOf(name: string): string | null {
    if (!name.endsWith(SUFFIX)) {
        return null;
    }
    for (const prefix of [RECORD_PREFIX, REQUEST_PREFIX]) {
        if (name.startsWith(prefix) && name.length > prefix.length + SUFFIX.length) {
            return name.slice(prefix.length, -SUFFIX.length);
        }
    }
    return null;
}

const STATES: readonly DeviceState[] = ['active', 'paused', 'removed'];

function parseRecord(value: unknown): DeviceRecord | null {
    if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
        return null;
    }
    return {
        id: value.id,
        name: value.name,
        platform: text(value.platform),
        pluginVersion: text(value.pluginVersion),
        account: typeof value.account === 'string' ? value.account : null,
        since: count(value.since),
        seen: count(value.seen),
        lastSyncedAt: typeof value.lastSyncedAt === 'number' ? value.lastSyncedAt : null,
        status: typeof value.status === 'string' ? (value.status as DeviceStatus) : 'idle',
        handled: count(value.handled),
    };
}

function parseRequest(value: unknown): DeviceRequest | null {
    if (!isObject(value) || typeof value.at !== 'number' || !STATES.includes(value.state as DeviceState)) {
        return null;
    }
    return { state: value.state as DeviceState, at: value.at, by: text(value.by), byName: text(value.byName) };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A small file held in memory, as an upload. */
async function sourceOf(data: ArrayBuffer): Promise<UploadSource> {
    return {
        mediaType: 'application/json',
        size: data.byteLength,
        sha1: await sha1Hex(data),
        modificationTime: new Date(),
        thumbnails: [],
        stream: () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array(data));
                    controller.close();
                },
            }),
        replay: true,
    };
}
