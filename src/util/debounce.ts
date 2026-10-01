/**
 * Collects paths that changed and hands them over once they have been quiet for
 * `delayMs`, so a burst of editor autosaves becomes one upload.
 *
 * The timer restarts on every new path, but `maxWaitMs` caps how long a
 * continuously-edited file can hold the whole batch back — without it, typing
 * in one note indefinitely defers syncing every other note.
 */
export class PathBatcher {
    private pending = new Set<string>();
    private timer: number | null = null;
    private firstQueuedAt = 0;

    constructor(
        private delayMs: number,
        private readonly maxWaitMs: number,
        private readonly onFlush: (paths: string[]) => void,
    ) {}

    add(path: string): void {
        if (this.pending.size === 0) {
            this.firstQueuedAt = Date.now();
        }
        this.pending.add(path);
        this.schedule();
    }

    /** Change the quiet period; takes effect from the next path added. */
    setDelay(delayMs: number): void {
        this.delayMs = delayMs;
    }

    /**
     * Carry pending paths along with a rename, so a file renamed while it waits
     * is synced under its new name rather than looked up under one that no
     * longer exists.
     */
    rename(fromPath: string, toPath: string): void {
        for (const path of [...this.pending]) {
            if (path === fromPath || path.startsWith(`${fromPath}/`)) {
                this.pending.delete(path);
                this.pending.add(`${toPath}${path.slice(fromPath.length)}`);
            }
        }
    }

    /** Paths waiting to be handed over. */
    pendingPaths(): string[] {
        return [...this.pending];
    }

    /** Hand over whatever is pending right now. */
    flush(): void {
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.pending.size === 0) {
            return;
        }
        const paths = [...this.pending];
        this.pending.clear();
        this.onFlush(paths);
    }

    /** Drop anything pending without delivering it. */
    cancel(): void {
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }
        this.pending.clear();
    }

    private schedule(): void {
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
        }
        const elapsed = Date.now() - this.firstQueuedAt;
        const wait = Math.max(0, Math.min(this.delayMs, this.maxWaitMs - elapsed));
        this.timer = window.setTimeout(() => {
            this.timer = null;
            this.flush();
        }, wait);
    }
}
