import type { Logger } from '../../util/logger';
import { requestStats } from '../../util/requestStats';

/**
 * Transfers run at a pace found as they go, up to the user's setting: a pass
 * starts at a couple at a time, adds one after every few that finish, and
 * halves the moment Proton answers "too many requests", climbing again only
 * after a cool-down. Big syncs get fast without anyone tuning a number, and
 * back off on their own when Proton asks.
 */
const START_TRANSFERS = 2;
const RAMP_EVERY = 4;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

export class TransferPace {
    private limit: number;
    private sinceRamp = 0;
    /** The rate-limit answer the pace last reacted to. */
    private rateLimitSeen: number | null = requestStats.lastRateLimited();

    constructor(
        /** The user's setting: the most transfers at once. */
        private readonly max: () => number,
        private readonly logger: Logger,
    ) {
        this.limit = Math.min(START_TRANSFERS, Math.max(1, max()));
    }

    /** Transfers allowed at once right now. */
    current(): number {
        return this.limit;
    }

    /**
     * After each transfer: halve the pace if Proton has answered "too many
     * requests" since the last adjustment, otherwise add one every few
     * transfers, up to the user's setting and never during the cool-down.
     */
    afterTransfer(): void {
        const max = Math.max(1, this.max());
        const limited = requestStats.lastRateLimited();
        if (limited !== null && limited !== this.rateLimitSeen) {
            this.rateLimitSeen = limited;
            this.limit = Math.max(1, Math.floor(this.limit / 2));
            this.sinceRamp = 0;
            this.logger.info(`Proton asked to slow down; ${this.limit} transfer(s) at a time for now`);
            return;
        }
        this.limit = Math.min(this.limit, max);
        this.sinceRamp++;
        const coolingDown = limited !== null && Date.now() - limited < RATE_LIMIT_COOLDOWN_MS;
        if (!coolingDown && this.sinceRamp >= RAMP_EVERY && this.limit < max) {
            this.limit++;
            this.sinceRamp = 0;
            this.logger.debug(`${this.limit} transfer(s) at a time`);
        }
    }
}
