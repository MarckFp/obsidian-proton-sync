import type { App } from 'obsidian';

import type { Logger } from '../util/logger';

/**
 * Tripwires on the ways another plugin would reach this plugin's sign-in.
 *
 * Nothing here can stop a determined attacker — one process, one language, and
 * a plugin that saves a reference to an API before this runs, or reads the file
 * on disk, never touches a wire. What it does is make the ordinary attempt
 * visible and attributable: the moment another plugin calls the secret storage
 * or reaches for a field that looks like credentials, the stack says which
 * plugin it was, and the plugin says so.
 *
 * Two kinds of wire:
 *
 * - the shared `app.secretStorage` object, whose methods every plugin gets the
 *   same reference to, so wrapping them catches later calls;
 * - trap getters on this plugin's own instance for the names a hostile plugin
 *   would try first (`session`, `client`, `credentials`…), which are gone from
 *   the instance since the runtime moved to module scope.
 */
export type TripwireHit = {
    at: number;
    /** What was touched: `secretStorage.getSecret`, `plugin.session`, … */
    wire: string;
    /** The plugin whose code appears in the stack; null when it is not a plugin's own file. */
    by: string | null;
    /** The secret ids asked for, when the wire carries them. */
    ids?: string[];
};

export type TripwireReport = {
    /** Set by whoever installed the tripwires, so its own calls are not reported. */
    selfId: string;
    hits: TripwireHit[];
};

const INSTALLED = Symbol.for('proton-drive-sync.tripwire');
const OWN_IDS = /^proton-drive-sync/;

/**
 * Plugin ids named in a stack trace, nearest frame first.
 *
 * Obsidian names a plugin's own frames `plugin:<id>:<line>:<col>`, and has also
 * used a file path for the same code; both are matched, because a tripwire that
 * only knows one spelling is a tripwire that misses.
 */
const PLUGIN_FRAME = /plugin:([A-Za-z0-9._-]+):|\/plugins\/([^/)\s]+)\/main\.js/g;

export function pluginIdsInStack(stack: string): string[] {
    const ids: string[] = [];
    for (const match of stack.matchAll(PLUGIN_FRAME)) {
        const id = match[1] ?? match[2];
        if (id && !ids.includes(id)) {
            ids.push(id);
        }
    }
    return ids;
}

/** The plugin that called, ignoring this plugin's own frames. */
export function callerPlugin(stack: string, selfId: string): string | null {
    return pluginIdsInStack(stack).find((id) => id !== selfId) ?? null;
}

function stackOf(): string {
    return new Error('tripwire').stack ?? '';
}

/**
 * Wrap the shared secret-storage methods and add trap getters to `instance`.
 *
 * Idempotent: a second call after a reload reuses the first wiring, so the
 * wrappers never nest.
 */
export function installTripwires(options: {
    app: App;
    selfId: string;
    instance: object;
    logger: Logger;
    onHit: (hit: TripwireHit) => void;
    /** Names a hostile plugin would try on the plugin instance. */
    traps?: string[];
}): TripwireReport {
    const { app, selfId, instance, logger, onHit } = options;
    const traps = options.traps ?? ['session', 'client', 'credentials', 'engine', 'state', 'tokens', 'signIn'];
    const report: TripwireReport = { selfId, hits: [] };

    const record = (hit: TripwireHit): void => {
        report.hits.push(hit);
        if (report.hits.length > 200) {
            report.hits.splice(0, report.hits.length - 200);
        }
        logger.warn(`Something reached for the Proton sign-in: ${hit.wire} by ${hit.by ?? 'something outside a plugin'}`);
        try {
            onHit(hit);
        } catch (error) {
            // A broken notifier must not break the caller: the record above is
            // the part that matters.
            logger.error('Could not report a tripwire hit', error);
        }
    };

    // -- the shared secret storage ----------------------------------------
    const storage = app.secretStorage as unknown as Record<string, unknown> & { [INSTALLED]?: boolean };
    if (storage && !storage[INSTALLED]) {
        storage[INSTALLED] = true;
        for (const method of ['getSecret', 'peekSecret', 'listSecrets']) {
            const original = storage[method];
            if (typeof original !== 'function') {
                continue;
            }
            storage[method] = function patched(this: unknown, ...args: unknown[]) {
                const stack = stackOf();
                const by = callerPlugin(stack, selfId);
                const ids = method === 'listSecrets' ? ['*'] : args.filter((arg): arg is string => typeof arg === 'string');
                // Only our own ids, or a listing of every id, are interesting:
                // other plugins' secrets are their business, not a leak of ours.
                const touchesOurs = ids.some((id) => id === '*' || OWN_IDS.test(id));
                if (by && touchesOurs) {
                    record({ at: Date.now(), wire: `secretStorage.${method}`, by, ids });
                }
                return (original as (...inner: unknown[]) => unknown).apply(this, args);
            };
        }
    }

    // -- the plugin instance ----------------------------------------------
    for (const name of traps) {
        if (Object.prototype.hasOwnProperty.call(instance, name)) {
            continue;
        }
        Object.defineProperty(instance, name, {
            configurable: true,
            enumerable: false,
            get() {
                const by = callerPlugin(stackOf(), selfId);
                // Our own modules never read these names any more; anything that
                // does is either an old build or someone looking for credentials.
                record({ at: Date.now(), wire: `plugin.${name}`, by });
                return undefined;
            },
        });
    }

    return report;
}
