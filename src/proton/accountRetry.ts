import type { Logger } from '../util/logger';
import { isTransientAccountError } from './account/transient';

/**
 * Run an account request, trying again after each of `waits` while Proton
 * cannot be reached (see {@link isTransientAccountError}). Resolves with the
 * result, or undefined once the waits are used up; any other error is thrown
 * at once, since trying again would get the same answer.
 */
export async function withAccountRetry<T>(
    task: () => Promise<T>,
    waits: readonly number[],
    logger: Logger,
    what: string,
): Promise<T | undefined> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await task();
        } catch (error) {
            if (!isTransientAccountError(error)) {
                throw error;
            }
            const wait = waits[attempt];
            if (wait === undefined) {
                logger.warn(`Could not reach Proton for ${what}`, error);
                return undefined;
            }
            logger.debug(`Could not reach Proton for ${what}; trying again`, error);
            await new Promise((resolve) => window.setTimeout(resolve, wait));
        }
    }
}
