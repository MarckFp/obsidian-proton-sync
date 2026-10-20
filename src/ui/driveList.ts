/**
 * Something listed from Drive for a dialog: a note's versions, or the vault's
 * files in Drive's trash. The sync panel keeps it listed, so a dialog opens on
 * it at once and follows along as it is listed again. A listing under way, or
 * one that fails, leaves the last one in place, with the error beside it.
 */
export class DriveList<T> {
    /** The last listing that succeeded; undefined until one has. */
    items: T | undefined = undefined;
    /** Why the latest listing failed, if it did; cleared by one that succeeds. */
    error: Error | null = null;
    /** Whether a listing is under way. */
    loading = false;
    /** Counts listings asked for, so an answer overtaken by a later one is dropped. */
    private request = 0;
    private readonly listeners = new Set<() => void>();

    /** List again. The latest listing asked for wins: an earlier one answering after it is ignored. */
    async load(list: () => Promise<T>): Promise<void> {
        const request = ++this.request;
        this.loading = true;
        this.changed();
        try {
            const items = await list();
            if (request === this.request) {
                this.items = items;
                this.error = null;
            }
        } catch (error) {
            if (request === this.request) {
                this.error = error instanceof Error ? error : new Error(String(error));
            }
        }
        if (request === this.request) {
            this.loading = false;
            this.changed();
        }
    }

    /**
     * Show `items` instead, after a change made from here, such as restoring
     * one of them. A listing under way may predate the change, so it is dropped.
     */
    set(items: T): void {
        this.request++;
        this.items = items;
        this.error = null;
        this.loading = false;
        this.changed();
    }

    /** Forget the listing, which is not of anything that can be shown any more; an answer on its way is dropped. */
    clear(): void {
        if (this.items === undefined && this.error === null && !this.loading) {
            return;
        }
        this.request++;
        this.items = undefined;
        this.error = null;
        this.loading = false;
        this.changed();
    }

    /** Call `listener` after every change, until the function returned is called. */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private changed(): void {
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}
