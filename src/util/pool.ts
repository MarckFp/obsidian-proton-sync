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
 * file quickly, and only the few that need a transfer queue up here.
 */
export class Limiter {
    private active = 0;
    private readonly waiting: (() => void)[] = [];

    constructor(private readonly concurrency: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= Math.max(1, this.concurrency)) {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        } else {
            this.active++;
        }
        try {
            return await task();
        } finally {
            // Hand the slot straight to the next waiter, so the count never
            // dips and lets a newcomer jump the queue.
            const next = this.waiting.shift();
            if (next) {
                next();
            } else {
                this.active--;
            }
        }
    }
}
