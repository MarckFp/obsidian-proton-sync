/**
 * What Proton's API has been answering, as seen by every request the plugin
 * sends (all of them pass through `obsidianFetch`).
 *
 * Kept for two uses: the engine slows its transfers when Proton starts
 * answering 429 (too many requests), and the sync panel can show how many
 * requests the plugin makes, which is what Proton's rate limits count.
 */
export class RequestStats {
    /** Times of recent requests, oldest first, trimmed to the last hour. */
    private readonly times: number[] = [];
    private lastRateLimitAt: number | null = null;

    constructor(private readonly now: () => number = () => Date.now()) {}

    record(status: number): void {
        const time = this.now();
        this.times.push(time);
        this.trim(time);
        if (status === 429) {
            this.lastRateLimitAt = time;
        }
    }

    /** When Proton last answered "too many requests", or null. */
    lastRateLimited(): number | null {
        return this.lastRateLimitAt;
    }

    /** Requests sent in the last hour. */
    lastHour(): number {
        this.trim(this.now());
        return this.times.length;
    }

    /** For tests. */
    reset(): void {
        this.times.length = 0;
        this.lastRateLimitAt = null;
    }

    private trim(now: number): void {
        while (this.times.length > 0 && now - this.times[0] > 60 * 60_000) {
            this.times.shift();
        }
    }
}

export const requestStats = new RequestStats();
