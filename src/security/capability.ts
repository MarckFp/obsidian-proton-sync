/**
 * Proof that a sensitive action came from this plugin's own UI.
 *
 * The plugin's methods are reachable from every other plugin through
 * `app.plugins.plugins["proton-drive-sync"]`. Credentials are no longer among
 * them, but capability is: `shareNote()` makes a public link to a note, and
 * that is exfiltration without ever touching a token. So the actions that
 * reach the user's data or account ask for a value only our own UI can supply.
 *
 * The token lives in module scope. A hostile plugin cannot import this module
 * (each plugin is its own bundle), and it cannot guess the value, so calling
 * those methods directly fails; our modals pass it because they import it.
 */
const token = () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const UI_TOKEN = token();

/** Handed to this plugin's own UI only. */
export function uiProof(): string {
    return UI_TOKEN;
}

export class CapabilityError extends Error {
    constructor(what: string) {
        super(`Refusing ${what}: it was not asked for from this plugin's own interface`);
        this.name = 'CapabilityError';
    }
}

/** Throws unless `proof` came from {@link uiProof}. */
export function requireUi(proof: string | undefined, what: string): void {
    if (proof !== UI_TOKEN) {
        throw new CapabilityError(what);
    }
}
