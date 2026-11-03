/**
 * Proton hosts only.
 *
 * The transport is one choke point for account and Drive traffic, and nothing
 * else in the plugin has any business reaching the network. A guard here means
 * a change in the SDK, or a future careless call, cannot quietly send anything
 * — a token, a name, a file — to a host that is not Proton's.
 *
 * Parsed rather than pattern-matched: `proton.me.evil.example` starts with the
 * right text and is not Proton.
 */
const PROTON_DOMAINS = ['proton.me', 'proton.ch'];

export function isProtonUrl(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    return PROTON_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function assertProtonUrl(url: string): void {
    if (isProtonUrl(url)) {
        return;
    }
    let host = 'that host';
    try {
        host = new URL(url).host;
    } catch {
        // Not a URL at all; the message below is enough.
    }
    throw new Error(`Refusing a request to ${host}: this plugin only talks to Proton`);
}
