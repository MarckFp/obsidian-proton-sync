/**
 * When to check Drive for changes next, at the pace Proton's own SDK uses.
 *
 * The SDK's event scheduler polls the user's own Drive every 30 seconds and
 * anything in the background every 10 minutes. This follows the same numbers
 * while keeping what the SDK's scheduler cannot do: it never goes faster than
 * 30 seconds, uses the user's setting when that is slower, and drops to the
 * background rate after a quiet spell or while the window is hidden. For a few
 * minutes after any change it checks at the fastest of those, since another
 * device is likely active. Pausing, and holding off on mobile data, stop it
 * from outside.
 */
export const PROTON_FOREGROUND_SECONDS = 30;
const PROTON_BACKGROUND_SECONDS = 10 * 60;
const ACTIVE_WINDOW_MS = 3 * 60_000;
const IDLE_AFTER_MS = 10 * 60_000;

export class PollScheduler {
    private timer: number | null = null;
    private dueAt = 0;
    /** Last time anything changed, here or on Drive. 0 for never. */
    private lastActivityAt = 0;

    constructor(
        private readonly options: {
            /** The user's "check Drive every" setting, in seconds. */
            baseSeconds: () => number;
            isHidden: () => boolean;
            onDue: () => void;
        },
    ) {}

    /** Seconds until the next check, from the setting and how active things are. */
    interval(now = Date.now()): number {
        const base = Math.max(PROTON_FOREGROUND_SECONDS, this.options.baseSeconds());
        const background = Math.max(base, PROTON_BACKGROUND_SECONDS);
        if (this.options.isHidden()) {
            return background;
        }
        const quietFor = now - this.lastActivityAt;
        if (quietFor < ACTIVE_WINDOW_MS) {
            return Math.max(PROTON_FOREGROUND_SECONDS, Math.round(base / 2));
        }
        return quietFor > IDLE_AFTER_MS ? background : base;
    }

    /** Milliseconds since anything last changed. */
    quietFor(now = Date.now()): number {
        return now - this.lastActivityAt;
    }

    /** (Re)start the timer for the next check. */
    schedule(): void {
        this.cancel();
        const seconds = this.interval();
        this.dueAt = Date.now() + seconds * 1000;
        this.timer = window.setTimeout(() => {
            this.timer = null;
            this.options.onDue();
        }, seconds * 1000);
    }

    cancel(): void {
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /**
     * Something changed. If the next check was scheduled for a quiet spell,
     * bring it forward to the active pace, since another device may well be
     * answering.
     */
    noteActivity(): void {
        this.lastActivityAt = Date.now();
        if (this.timer !== null && this.dueAt - Date.now() > this.interval() * 1000) {
            this.schedule();
        }
    }
}
