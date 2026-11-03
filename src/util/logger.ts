
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

function looksLikeName(value: string): boolean {
    if (!/[A-Za-z]/.test(value)) {
        return false;
    }
    const core = value.replace(/[.,;:)\]}]+$/, '');
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
        const safeArgs = args.map((arg) => {
            if (typeof arg === "string") {
                return redactNames(arg);
            }
            if (arg instanceof Error) {
                const copy = new Error(redactNames(arg.message));
                copy.name = arg.name;
                return copy;
            }
            return arg;
        });

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
