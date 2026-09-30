import type { ApiClient } from './account';
import type { Logger } from './account/logger';

/**
 * Ask Proton to end the current session: `DELETE /auth/v4`, what Proton's
 * own clients call on sign-out. Afterwards neither the access token nor the
 * refresh token works, wherever copies of them may be.
 *
 * Resolves whether Proton confirmed it; never throws, since signing out has
 * to finish locally either way.
 */
export async function revokeSession(apiClient: ApiClient, logger: Logger): Promise<boolean> {
    try {
        const response = await apiClient.authenticatedRequest(`${apiClient.baseUrlWithProtocol}/auth/v4`, {
            method: 'DELETE',
            throwHttpErrors: false,
        });
        if (response.ok) {
            logger.info('Ended the Proton session');
            return true;
        }
        logger.warn(`Proton did not end the session (HTTP ${response.status}); forgetting it here anyway`);
    } catch (error) {
        logger.warn('Could not reach Proton to end the session; forgetting it here anyway', error);
    }
    return false;
}
