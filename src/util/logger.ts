
/**
 * Whether note names and paths may appear in log messages.
 *
 * Off by default: the log buffer is readable by every other plugin, printed to
 * the console, and copied into bug reports by "Copy sync log". Note names are
 * the user's data, so they are replaced by a stable token (`«file a1b2c3»`) that
 * still lets two messages about the same note be matched up. Turn it on in the
 * settings when a report needs the real names.
 */
let showNames = false;

export function setLogShowsNames(value: boolean): void {
    showNames = value;
}

/** A short, stable stand-in for a name, so two lines about the same note still match. */
function token(value: string): string {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `«file ${(hash >>> 0).toString(16).padStart(8, '0').slice(0, 6)}»`;
}

/** A quoted name or path, or a bare token, replaced by its token; prose is left alone. */
const QUOTED = /"([^"\n]+)"|'([^'\n]+)'/g;
const TOKEN = /[^\s"']+/g;
/** Drive node uids are opaque, but long, stable, and they identify a file across devices. */
const NODE_UID = /[A-Za-z0-9_+/=~-]{60,}/g;

/**
 * A host, as opposed to a file name.
 *
 * `drive-api.proton.me` is not the user's data and redacting it makes a bug
 * report undiagnosable, so it is left alone. Two labels are ambiguous
 * (`note.md` is a file, `proton.me` is a host), so only three or more are
 * treated as a host; the vault's own names almost never look like that.
 */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){2,}[a-z]{2,24}$/i;

function looksLikeName(value: string): boolean {
    if (!/[A-Za-z]/.test(value)) {
        return false;
    }
    const core = value.replace(/[.,;:)\]}]+$/, '');
    // A URL, a host, or an API path names an endpoint, not a note. Vault paths
    // are relative (`Projekty/Trisula.md`); a leading slash is Drive's API.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(core) || core.startsWith('/') || HOST.test(core)) {
        return false;
    }
    return core.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(core);
}

/** Replace anything that looks like a vault path or a file name. */
export function redactNames(text: string): string {
    if (showNames) {
        return text;
    }
    // Whole quoted strings first, so a name with spaces inside stays one name.
    const quoted = text.replace(QUOTED, (match, double, single) => {
        const inner = String(double ?? single ?? '');
        return looksLikeName(inner) ? token(inner) : match;
    });
    const withoutUids = quoted.replace(NODE_UID, '«node»');
    return withoutUids.replace(TOKEN, (match) => (looksLikeName(match) ? token(match) : match));
}

/** An error with its message and stack redacted — the stack kept, not thrown away. */
function redactError(error: Error): Error {
    const copy = new Error(redactNames(error.message));
    copy.name = redactNames(error.name);
    // A bug report starts at the stack. Dropping it made the redacted log
    // useless for the case the log exists for, so redact it instead.
    if (typeof error.stack === 'string') {
        copy.stack = redactNames(error.stack);
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) {
        (copy as { cause?: unknown }).cause = redactArgument(cause);
    }
    return copy;
}

/**
 * A log argument with the names inside it redacted and its shape kept.
 *
 * Errors used to lose their stack, and plain objects were passed through
 * untouched, so an SDK error carrying a path in a field went into the buffer
 * and onto the clipboard as it was.
 */
export function redactArgument(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
        return redactNames(value);
    }
    if (value instanceof Error) {
        return redactError(value);
    }
    if (depth >= 2) {
        // Deep enough: an SDK object graph is not worth walking, and its
        // credentials are not in the log's scope.
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactArgument(item, depth + 1));
    }
    if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        const copy: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value)) {
            copy[key] = redactArgument(inner, depth + 1);
        }
        return copy;
    }
    return value;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogEntry = {
    time: number;
    level: LogLevel;
    scope: string;
    message: string;
};

/**
 * Console logger that also keeps the most recent entries in a ring buffer so
 * the settings tab can show a sync log without the user opening devtools.
 *
 * Doubles as the SDK's `Telemetry` logger: `getLogger(scope)` matches the
 * shape `ProtonDriveClient` and the vendored account module expect.
 */
export class Logger {
    private static readonly BUFFER_SIZE = 500;

    private readonly buffer: LogEntry[] = [];

    constructor(
        private minLevel: LogLevel = 'info',
        private readonly scope = 'proton-drive-sync',
        private readonly root?: Logger,
    ) {}

    getLogger(scope: string): Logger {
        const root = this.root ?? this;
        return new Logger(this.minLevel, `${this.scope}:${scope}`, root);
    }

    setLevel(level: LogLevel): void {
        this.minLevel = level;
        if (this.root) {
            this.root.setLevel(level);
        }
    }

    getEntries(): readonly LogEntry[] {
        return (this.root ?? this).buffer;
    }

    debug(message: string, ...args: unknown[]): void {
        this.write('debug', message, args);
    }

    info(message: string, ...args: unknown[]): void {
        this.write('info', message, args);
    }

    warn(message: string, ...args: unknown[]): void {
        this.write('warn', message, args);
    }

    error(message: string, ...args: unknown[]): void {
        this.write('error', message, args);
    }

    private write(level: LogLevel, message: string, args: unknown[]): void {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
            return;
        }

        const safeMessage = redactNames(message);
        const safeArgs = args.map((arg) => redactArgument(arg));

        const entry: LogEntry = { time: Date.now(), level, scope: this.scope, message: safeMessage };
        const target = this.root ?? this;
        target.buffer.push(entry);
        if (target.buffer.length > Logger.BUFFER_SIZE) {
            target.buffer.splice(0, target.buffer.length - Logger.BUFFER_SIZE);
        }

        // Info and debug go to `console.debug`, which devtools hides unless
        // "Verbose" is on, so routine sync chatter stays out of the console
        // while remaining a click away. The settings tab shows the same entries.
        const prefix = `[${this.scope}]`;
        if (level === 'error') {
            console.error(prefix, safeMessage, ...safeArgs);
        } else if (level === 'warn') {
            console.warn(prefix, safeMessage, ...safeArgs);
        } else {
            console.debug(prefix, safeMessage, ...safeArgs);
        }
    }
}

/** Entries as plain text, one per line, oldest first, for copying out of the app. */
export function formatLogEntries(entries: readonly LogEntry[]): string {
    return entries
        .map((entry) => `${new Date(entry.time).toISOString()} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}`)
        .join('\n');
}
