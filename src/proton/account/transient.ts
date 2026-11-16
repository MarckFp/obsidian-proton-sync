// LOCAL ADDITION (not upstream); see VENDORED.md.
import { AccountApiError } from './accountApi';
import { TimeoutError } from './http';

/**
 * Whether a failed account request is worth trying again: Proton never
 * answered (no network, a host that would not resolve, a timeout), or said it
 * was busy. Any other HTTP error is a real answer, and final.
 *
 * On Android an app in the background is often cut off from the network, so
 * requests made while the user approves the sign-in in the browser fail with
 * errors such as `UnknownHostException`. They arrive here as an
 * `AccountApiError` with no HTTP status, since there was no response at all.
 */
export function isTransientAccountError(error: unknown): boolean {
    if (error instanceof AccountApiError) {
        const status = error.httpCode;
        return status === undefined || status === 408 || status === 429 || status >= 500;
    }
    return error instanceof TimeoutError;
}
