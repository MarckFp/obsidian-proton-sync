export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError(signal));
            return;
        }

        const timeout = window.setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        const onAbort = () => {
            window.clearTimeout(timeout);
            reject(abortError(signal));
        };

        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

// LOCAL CHANGE (not upstream): `signal.reason` is typed `any`; rejecting with
// it as-is may reject with a non-Error. The default reason, a DOMException, is
// an Error, so the usual case is unchanged.
function abortError(signal: AbortSignal | undefined): Error {
    const reason: unknown = signal?.reason;
    return reason instanceof Error ? reason : new Error('Aborted', { cause: reason });
}
