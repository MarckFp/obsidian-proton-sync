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

        const entry: LogEntry = { time: Date.now(), level, scope: this.scope, message };
        const target = this.root ?? this;
        target.buffer.push(entry);
        if (target.buffer.length > Logger.BUFFER_SIZE) {
            target.buffer.splice(0, target.buffer.length - Logger.BUFFER_SIZE);
        }

        const prefix = `[${this.scope}]`;
        if (level === 'error') {
            console.error(prefix, message, ...args);
        } else if (level === 'warn') {
            console.warn(prefix, message, ...args);
        } else if (level === 'debug') {
            console.debug(prefix, message, ...args);
        } else {
            console.log(prefix, message, ...args);
        }
    }
}
