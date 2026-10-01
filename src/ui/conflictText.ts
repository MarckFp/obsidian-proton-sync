import type { ConflictEvent } from '../sync/engine';
import { basename } from '../sync/paths';
import type { ConflictReason } from '../sync/types';

/** How a conflict came about, as the end of "<file>: …". Shared by the notice and the conflicts dialog. */
export const REASON_TEXT: Record<ConflictReason, string> = {
    'both-modified': 'edited here and on another device',
    'both-created': 'created here and on another device',
    'deleted-remotely-modified-locally': 'deleted on another device but edited here',
    'deleted-locally-modified-remotely': 'deleted here but edited on another device',
    'case-collision': 'has the same name as another file apart from letter case, which this device cannot tell apart',
};

/** How it was settled. */
export function outcomeText(event: ConflictEvent): string {
    switch (event.outcome) {
        case 'kept-both':
            return `both kept, the other version is "${basename(event.copyPath ?? '')}"`;
        case 'merged':
            return 'the edits were merged';
        case 'kept-local':
            return 'this device’s version was kept';
        case 'kept-remote':
            return 'the version from Drive was kept';
        case 'deferred':
            return 'waiting for you to choose';
        case 'renamed':
            return `the other was renamed on Drive to "${basename(event.copyPath ?? '')}", and both are synced`;
        case 'not-synced':
            return 'neither is synced until one of them is renamed';
    }
}
