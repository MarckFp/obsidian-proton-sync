/**
 * When to list something from Drive again, unasked: at once when it may be,
 * then each time it is due by `intervalSeconds`, which may change in between,
 * as Drive is checked less often while nothing happens and more often again
 * when something does. Never two listings at once.
 */
export class ListingSchedule {
    /** When the last listing finished; 0 for never, which makes the next one due at once. */
    private listedAt = 0;
    /** Listings under way. */
    private running = 0;
    private timer: number | null = null;
    /** When {@link timer} fires. */
    private timerDue = 0;

    constructor(
        private readonly options: {
            list: () => Promise<void>;
            intervalSeconds: () => number;
            /** Whether to list unasked now. */
            allowed: () => boolean;
        },
    ) {}

    /**
     * List now if due, or see that it happens once it is. Called whenever
     * `allowed` or the interval may have changed: a quicker pace brings the
     * next listing forward.
     */
    check(): void {
        if (!this.options.allowed()) {
            this.cancel();
            return;
        }
        if (this.running > 0) {
            return;
        }
        const due = this.listedAt + this.options.intervalSeconds() * 1000;
        const wait = due - Date.now();
        if (wait <= 0) {
            void this.listNow();
            return;
        }
        if (this.timer !== null && this.timerDue <= due) {
            return;
        }
        this.cancel();
        this.timerDue = due;
        this.timer = window.setTimeout(() => {
            this.timer = null;
            this.check();
        }, wait);
    }

    /** List now, asked for or due, then wait until the next listing is. */
    async listNow(): Promise<void> {
        this.cancel();
        this.running++;
        try {
            await this.options.list();
        } finally {
            this.running--;
            this.listedAt = Date.now();
        }
        this.check();
    }

    /** Forget the last listing, so the next is due as soon as it is allowed. */
    reset(): void {
        this.listedAt = 0;
    }

    cancel(): void {
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
