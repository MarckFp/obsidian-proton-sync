/**
 * Runs tasks with a fixed number in flight.
 *
 * Transfers are capped rather than fired all at once because Proton rate-limits
 * per session, and a first sync of a large vault is exactly the workload that
 * would trip it — the guidelines single out parallelism limits as something a
 * third-party client is expected to implement.
 *
 * Failures are captured per task instead of rejecting the batch, so one
 * unreadable file cannot abandon the rest of a sync.
 */
export async function runPooled<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number,
    onError: (error: unknown, index: number) => void,
): Promise<void> {
    const limit = Math.max(1, concurrency);
    let next = 0;

    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (true) {
            const index = next++;
            const task = tasks[index];
            if (!task) {
                return;
            }
            try {
                await task();
            } catch (error) {
                onError(error, index);
            }
        }
    });

    await Promise.all(workers);
}

/**
 * A FIFO gate that lets at most `concurrency` tasks through at once.
 *
 * Where {@link runPooled} owns a fixed list of tasks, a limiter is shared by
 * tasks that only sometimes need the scarce resource: a full sync checks every
 * file quickly, and only the few that need a transfer queue up here. The limit
 * may be a function, read each time a slot frees or a task arrives, so it can
 * rise and fall while tasks wait.
 */
export class Limiter {
    private active = 0;
    private readonly waiting: (() => void)[] = [];
    private readonly limit: () => number;

    constructor(concurrency: number | (() => number)) {
        this.limit = typeof concurrency === 'number' ? () => concurrency : concurrency;
    }

    async run<T>(task: () => Promise<T>): Promise<T> {
        // Behind anyone already waiting, even if the limit has just risen,
        // so the queue keeps its order.
        if (this.waiting.length > 0 || this.active >= this.capacity()) {
            const turn = new Promise<void>((resolve) => this.waiting.push(resolve));
            this.pump();
            await turn;
        } else {
            this.active++;
        }
        try {
            return await task();
        } finally {
            this.active--;
            this.pump();
        }
    }

    /** Let waiting tasks in while there is room. */
    private pump(): void {
        while (this.waiting.length > 0 && this.active < this.capacity()) {
            this.active++;
            this.waiting.shift()!();
        }
    }

    private capacity(): number {
        return Math.max(1, this.limit());
    }
}
