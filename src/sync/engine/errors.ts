/** Thrown inside a pass to make it decide a path again, or leave it for later. */

/** The local file changed between the decision and the step that would have replaced or deleted it. */
export class LocalChangedError extends Error {
    constructor(path: string) {
        super(`"${path}" changed here while it was being synced; deciding again`);
        this.name = 'LocalChangedError';
    }
}

/**
 * A download for a note with unsaved typing in its editor was merged into the
 * editor, or left for the conflict policy, instead of written to disk. The
 * path is decided again once the editor has saved.
 */
export class EditorBusyError extends Error {
    constructor(path: string, merged: boolean) {
        super(
            merged
                ? `Merged the version of "${path}" from Drive into the open editor; it syncs once saved`
                : `"${path}" has unsaved edits that overlap the version from Drive; deciding again once saved`,
        );
        this.name = 'EditorBusyError';
    }
}

/** The Drive file moved on to a new revision between the decision and trashing it. */
export class RemoteChangedError extends Error {
    constructor(path: string) {
        super(`"${path}" was changed on Drive since this pass looked; not removing it`);
        this.name = 'RemoteChangedError';
    }
}
