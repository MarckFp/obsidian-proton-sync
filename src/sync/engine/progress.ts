import type { TransferProgress } from './types';

/** Transfers smaller than this finish too fast for progress to mean anything. */
const PROGRESS_MIN_BYTES = 1024 * 1024;

/** Share of the progress bar given to checking files; the rest is for the bytes transferred. */
const CHECK_SHARE = 0.15;

/** Progress updates are coalesced to at most one per this interval. */
const CHANGE_THROTTLE_MS = 250;

/**
 * How far the current pass is, for the status bar and the sync panel.
 *
 * A pass counts its files as checked as soon as each is decided, and weighs
 * the transfers it finds by their size, so the bar moves with the work that
 * takes time: a little for checking every file, most for the bytes moved,
 * including what large transfers in flight have sent so far. It never moves
 * back, even as newly found transfers raise the total. Changes are reported
 * through `onChange`, at most every {@link CHANGE_THROTTLE_MS}.
 */
export class PassProgress {
    private pass: { done: number; total: number; bytesQueued: number; bytesDone: number; shown: number } | null = null;
    private readonly transfers = new Map<symbol, TransferProgress>();
    private changeTimer: number | null = null;

    constructor(private readonly onChange: () => void) {}

    /** A pass over `total` files starts; a single file is not worth a count. */
    begin(total: number): void {
        this.pass = total > 1 ? { done: 0, total, bytesQueued: 0, bytesDone: 0, shown: 0 } : null;
    }

    end(): void {
        this.pass = null;
    }

    /** One more file decided. */
    checked(): void {
        if (this.pass) {
            this.pass.done++;
            this.changed();
        }
    }

    /** A transfer of `bytes` was queued; it counts towards the total once known. */
    queued(bytes: number): void {
        if (this.pass) {
            this.pass.bytesQueued += bytes;
        }
    }

    transferred(bytes: number): void {
        if (this.pass) {
            this.pass.bytesDone += bytes;
            this.changed();
        }
    }

    /** Files checked out of the total, when a pass is counting. */
    counts(): { done: number; total: number } | null {
        return this.pass ? { done: this.pass.done, total: this.pass.total } : null;
    }

    /** Report progress for a transfer of `total` bytes, if it is large enough to be worth it. */
    track(
        path: string,
        direction: TransferProgress['direction'],
        total: number | undefined,
    ): { onProgress: ((bytes: number) => void) | undefined; end: () => void } {
        if (total === undefined || total < PROGRESS_MIN_BYTES) {
            return { onProgress: undefined, end: () => undefined };
        }
        const key = Symbol(path);
        const entry: TransferProgress = { path, direction, bytes: 0, total };
        this.transfers.set(key, entry);
        return {
            onProgress: (bytes) => {
                entry.bytes = Math.min(bytes, total);
                this.changed();
            },
            end: () => {
                this.transfers.delete(key);
                this.changed();
            },
        };
    }

    largestTransfer(): TransferProgress | null {
        let largest: TransferProgress | null = null;
        for (const transfer of this.transfers.values()) {
            if (!largest || transfer.total > largest.total) {
                largest = transfer;
            }
        }
        return largest ? { ...largest } : null;
    }

    /**
     * From 0 to 1, or null between passes and while listing, when there is no
     * total to measure against.
     */
    fraction(): number | null {
        const pass = this.pass;
        if (!pass) {
            const transfer = this.largestTransfer();
            return transfer && transfer.total > 0 ? transfer.bytes / transfer.total : null;
        }
        const checks = pass.total > 0 ? pass.done / pass.total : 1;
        let fraction = checks;
        if (pass.bytesQueued > 0) {
            let inFlight = 0;
            for (const transfer of this.transfers.values()) {
                inFlight += transfer.bytes;
            }
            const bytes = Math.min(1, (pass.bytesDone + inFlight) / pass.bytesQueued);
            fraction = CHECK_SHARE * checks + (1 - CHECK_SHARE) * bytes;
        }
        pass.shown = Math.max(pass.shown, Math.min(1, fraction));
        return pass.shown;
    }

    /** Stop any report still waiting to be sent. */
    stop(): void {
        if (this.changeTimer !== null) {
            window.clearTimeout(this.changeTimer);
            this.changeTimer = null;
        }
    }

    /** Report a change, at most once per {@link CHANGE_THROTTLE_MS}. */
    changed(): void {
        if (this.changeTimer !== null) {
            return;
        }
        this.changeTimer = window.setTimeout(() => {
            this.changeTimer = null;
            this.onChange();
        }, CHANGE_THROTTLE_MS);
    }
}
