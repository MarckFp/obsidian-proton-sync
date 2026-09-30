import type { DataAdapter } from 'obsidian';

import type { Logger } from '../util/logger';
import type { ConflictEvent } from './engine';

/** A conflict as it was reported, with when. */
export type ConflictRecord = ConflictEvent & { time: number };

/** Older records are dropped past this many. */
const MAX_RECORDS = 200;

/**
 * Conflicts this device has seen, newest first, kept after their notice is
 * dismissed.
 *
 * Every policy but `manual` settles a conflict on its own and says so in a
 * notice, which is gone once closed; a conflict copy made last week is easy to
 * forget. This keeps them listed in the conflicts dialog until the user clears
 * them.
 *
 * Stored in its own file in the plugin's folder, which never syncs: the list
 * is about what happened on this device. Kept apart from the sync state so
 * that rebuilding the state does not erase it.
 */
export class ConflictHistory {
    private records: ConflictRecord[] = [];

    constructor(
        private readonly adapter: DataAdapter,
        private readonly path: string,
        private readonly logger: Logger,
        private readonly now: () => number = () => Date.now(),
    ) {}

    async load(): Promise<void> {
        try {
            if (!(await this.adapter.exists(this.path))) {
                return;
            }
            const stored: unknown = JSON.parse(await this.adapter.read(this.path));
            this.records = Array.isArray(stored) ? (stored as ConflictRecord[]).filter(isRecord) : [];
        } catch (error) {
            this.logger.warn('Could not read the conflict history; starting a new one', error);
            this.records = [];
        }
    }

    /** Newest first. */
    entries(): readonly ConflictRecord[] {
        return this.records;
    }

    async add(event: ConflictEvent): Promise<void> {
        this.records.unshift({ ...event, time: this.now() });
        this.records.length = Math.min(this.records.length, MAX_RECORDS);
        await this.save();
    }

    async remove(record: ConflictRecord): Promise<void> {
        this.records = this.records.filter((candidate) => candidate !== record);
        await this.save();
    }

    async clear(): Promise<void> {
        this.records = [];
        await this.save();
    }

    private async save(): Promise<void> {
        try {
            await this.adapter.write(this.path, JSON.stringify(this.records));
        } catch (error) {
            this.logger.warn('Could not save the conflict history', error);
        }
    }
}

function isRecord(value: unknown): value is ConflictRecord {
    const record = value as Partial<ConflictRecord> | null;
    return (
        typeof record === 'object' &&
        record !== null &&
        typeof record.path === 'string' &&
        typeof record.time === 'number' &&
        typeof record.reason === 'string' &&
        typeof record.outcome === 'string'
    );
}
