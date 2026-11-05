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
    /**
     * Put the shared methods back and take the trap getters off the instance.
     *
     * Without this a reload leaves the replacements in place, calling the
     * *first* instance, and the `Symbol.for` guard then stops the new instance
     * from installing its own — so its report never sees a hit. Called from
     * `onunload`; safe to call twice.
     */
    uninstall: () => void;
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
 * Idempotent while installed: a second call reuses the first wiring, so the
 * wrappers never nest. {@link TripwireReport.uninstall} undoes it, and must run
 * in `onunload` — otherwise a reload keeps calling the old instance's report.
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
    const report: TripwireReport = { selfId, hits: [], uninstall: () => undefined };

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
    /** What we took over, so `uninstall` can put it back and only ours. */
    const originals: [method: string, original: unknown][] = [];
    let installedByUs = false;
    if (storage && !storage[INSTALLED]) {
        storage[INSTALLED] = true;
        installedByUs = true;
        for (const method of ['getSecret', 'peekSecret', 'listSecrets']) {
            const original = storage[method];
            if (typeof original !== 'function') {
                continue;
            }
            originals.push([method, original]);
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
    /** The getters we defined, so `uninstall` removes ours and not a real field. */
    const trapped: [name: string, getter: () => undefined][] = [];
    for (const name of traps) {
        if (Object.prototype.hasOwnProperty.call(instance, name)) {
            continue;
        }
        const getter = (): undefined => {
            const by = callerPlugin(stackOf(), selfId);
            // Our own modules never read these names any more; anything that
            // does is either an old build or someone looking for credentials.
            record({ at: Date.now(), wire: `plugin.${name}`, by });
            return undefined;
        };
        Object.defineProperty(instance, name, {
            configurable: true,
            enumerable: false,
            get: getter,
        });
        trapped.push([name, getter]);
    }

    let removed = false;
    const uninstall = (): void => {
        if (removed) {
            return;
        }
        removed = true;
        for (const [method, original] of originals) {
            storage[method] = original;
        }
        originals.length = 0;
        if (installedByUs) {
            // A reload must be able to install its own wiring, pointing at the
            // instance that is now loaded.
            delete storage[INSTALLED];
            installedByUs = false;
        }
        for (const [name, getter] of trapped) {
            const descriptor = Object.getOwnPropertyDescriptor(instance, name);
            if (descriptor?.get === getter) {
                Reflect.deleteProperty(instance, name);
            }
        }
        trapped.length = 0;
    };

    report.uninstall = uninstall;
    return report;
}
