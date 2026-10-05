import type { Logger } from '../../util/logger';
import type { DriveIO, RemoteTree } from '../drive';
import { ancestorPaths, basename, joinPath, parentPath, PathFilter, replacePrefix, splitExtension } from '../paths';
import type { SyncState } from '../state';
import type { RemoteState } from '../types';
import type { VaultIO } from '../vault';
import { NodeWithSameNameExistsValidationError } from '@protontech/drive-sdk';
import { byDepth, renameInTree } from './helpers';
import type { ConflictEvent, EngineEnvironment } from './types';

/** What the case-clash handling needs from the engine. */
export type CaseClashHost = {
    readonly state: SyncState;
    filter(): PathFilter;
    readonly vault: VaultIO;
    drive(): DriveIO;
    readonly environment: EngineEnvironment;
    readonly configDir: string;
    readonly logger: Logger;
    findRemoteFolder(path: string): Promise<string | undefined>;
    findByName(path: string): Promise<RemoteState | undefined>;
    reportConflict(event: ConflictEvent): void;
};

/**
 * Names that differ only in letter case, on a filesystem that cannot keep
 * them apart: Windows, macOS, iOS and usually Android. Drive can, so clashes
 * are settled there, by renaming the newcomer; see {@link CaseClashes.settleTree}.
 */
export class CaseClashes {
    /** Probed once; see {@link isCaseInsensitive}. */
    private caseInsensitive: boolean | null = null;
    /** Case clashes already reported in this session, so a full sync does not repeat the notice. */
    private readonly reportedCaseClashes = new Set<string>();

    constructor(private readonly host: CaseClashHost) {}

    /**
     * Paths that collide with another when letter case is ignored.
     *
     * Drive, like Linux and Android, keeps `Note.md` and `note.md` apart; the
     * filesystems of Windows, macOS and iOS do not, and there both names reach
     * the same file. Syncing such a pair would download one over the other on
     * every pass, so neither is touched until one is renamed, and the user is
     * told which.
     */
    findCollisions(paths: Set<string>): Set<string> {
        // Folded per prefix, not only per path: `Notes/a.md` and `notes/b.md`
        // differ as paths, but on this filesystem both folders are one.
        const spellings = new Map<string, Set<string>>();
        for (const path of paths) {
            for (const prefix of [...ancestorPaths(path), path]) {
                const folded = prefix.toLowerCase();
                spellings.set(folded, (spellings.get(folded) ?? new Set()).add(prefix));
            }
        }

        const collisions = new Set<string>();
        for (const path of paths) {
            if ([...ancestorPaths(path), path].some((prefix) => spellings.get(prefix.toLowerCase())!.size > 1)) {
                collisions.add(path);
            }
        }
        for (const group of spellings.values()) {
            if (group.size < 2) {
                continue;
            }
            const names = [...group].sort();
            const key = names.join('\n');
            if (this.reportedCaseClashes.has(key)) {
                continue;
            }
            this.reportedCaseClashes.add(key);
            this.host.logger.warn(
                `Not syncing ${names.map((name) => `"${name}"`).join(' and ')}: their names differ only in letter ` +
                    'case, which this device cannot tell apart, and they could not be settled. Rename one of them.',
            );
            this.host.reportConflict({ path: names[0], reason: 'case-collision', outcome: 'not-synced' });
        }
        return collisions;
    }

    /** Whether this vault's filesystem folds letter case; probed by asking for the config folder spelled the other way. */
    async isCaseInsensitive(): Promise<boolean> {
        if (this.host.environment.caseInsensitive !== undefined) {
            return this.host.environment.caseInsensitive;
        }
        if (this.caseInsensitive === null) {
            const { configDir } = this.host;
            const swapped = [...configDir]
                .map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()))
                .join('');
            try {
                this.caseInsensitive = swapped !== configDir && (await this.host.vault.exists(swapped));
            } catch {
                this.caseInsensitive = false;
            }
        }
        return this.caseInsensitive;
    }

    /**
     * Which spelling owns each name, folded to lower case: the one with a sync
     * record first, then the one in the vault (`localPaths`). Covers every
     * prefix, so folders are claimed along with the files in them.
     */
    claimants(localPaths: string[]): Map<string, string> {
        const claimants = new Map<string, string>();
        const claim = (path: string) => {
            for (const prefix of [...ancestorPaths(path), path]) {
                const folded = prefix.toLowerCase();
                if (!claimants.has(folded)) {
                    claimants.set(folded, prefix);
                }
            }
        };
        for (const record of this.host.state.entries()) {
            claim(record.path);
        }
        for (const path of localPaths) {
            claim(path);
        }
        return claimants;
    }

    /**
     * Settle names on Drive that this device cannot keep apart, before the
     * full sync compares anything.
     *
     * Drive tells `Note.md` from `note.md`; Windows, macOS, iOS and usually
     * Android do not, and there both names reach the same file. Left alone, one
     * would be downloaded over the other. So the spelling that already owns the
     * name keeps it (the one with a sync record, else the one in the vault, else
     * whichever comes first), and every other spelling is renamed on Drive,
     * where that is always safe, to "note (case conflict).md". Both then sync
     * normally on every device, and the user is told. Folders are settled first,
     * so a folder renamed this way takes its files along.
     */
    async settleTree(tree: RemoteTree, local: { files: string[]; folders: string[] }): Promise<void> {
        if (!(await this.isCaseInsensitive())) {
            return;
        }
        const claimants = this.claimants([...local.folders, ...local.files]);
        const treePaths = [...tree.folders.keys(), ...tree.files.keys()].sort(byDepth);
        for (const path of treePaths) {
            const folderUid = tree.folders.get(path);
            const uid = folderUid ?? tree.files.get(path)?.nodeUid;
            if (uid === undefined || this.host.filter().isExcludedWithAncestors(path)) {
                // Re-keyed under a folder renamed earlier in this loop, or not synced.
                continue;
            }
            const folded = path.toLowerCase();
            const owner = claimants.get(folded);
            if (owner === undefined) {
                claimants.set(folded, path);
                continue;
            }
            if (owner === path) {
                continue;
            }
            const renamed = await this.renameForCase(uid, path, owner, folderUid !== undefined, claimants);
            if (renamed !== null) {
                renameInTree(tree, path, renamed);
            }
        }
    }

    /**
     * The same, for paths arriving one at a time from Drive's events: a path
     * with no record whose name, or any folder above it, clashes with a
     * recorded one is renamed on Drive first, and the pass goes on with its new
     * name.
     */
    async settleIn(paths: Set<string>): Promise<Set<string>> {
        const claimants = this.claimants([]);
        const settled = new Set<string>();
        for (const path of paths) {
            if (this.host.state.get(path)) {
                settled.add(path);
                continue;
            }
            const resolved = await this.resolve(path, claimants);
            const clash = [...ancestorPaths(resolved), resolved].find((prefix) => {
                const owner = claimants.get(prefix.toLowerCase());
                return owner !== undefined && owner !== prefix;
            });
            if (clash === undefined) {
                settled.add(resolved);
                continue;
            }
            // Could not be settled. Looking it up here would find the other
            // spelling's file, so it is left out rather than compared wrongly.
            const owner = claimants.get(clash.toLowerCase())!;
            const key = [clash, owner].sort().join('\n');
            if (!this.reportedCaseClashes.has(key)) {
                this.reportedCaseClashes.add(key);
                this.host.logger.warn(`Not syncing "${path}": it clashes with "${owner}" apart from letter case`);
                this.host.reportConflict({ path: owner, reason: 'case-collision', outcome: 'not-synced' });
            }
        }
        return settled;
    }

    /** `path`, or where it lives after the part of it that clashes was renamed on Drive. */
    async resolve(path: string, claimants: Map<string, string>): Promise<string> {
        const prefixes = [...ancestorPaths(path), path];
        for (const [index, prefix] of prefixes.entries()) {
            const owner = claimants.get(prefix.toLowerCase());
            if (owner === undefined || owner === prefix) {
                continue;
            }
            const isFolder = index < prefixes.length - 1;
            let uid: string | undefined;
            try {
                uid = isFolder
                    ? await this.host.findRemoteFolder(prefix)
                    : (await this.host.findByName(prefix))?.nodeUid;
            } catch (error) {
                this.host.logger.debug(`Could not look up "${prefix}" to settle a case clash`, error);
            }
            if (uid === undefined) {
                // Not on Drive, so not this device's to rename.
                return path;
            }
            const renamed = await this.renameForCase(uid, prefix, owner, isFolder, claimants);
            return renamed === null ? path : replacePrefix(path, prefix, renamed);
        }
        return path;
    }

    /**
     * Rename a node on Drive to "<name> (case conflict)", numbered if that is
     * taken. Returns the new path, or null if it could not be renamed.
     */
    private async renameForCase(
        nodeUid: string,
        path: string,
        owner: string,
        isFolder: boolean,
        claimants: Map<string, string>,
    ): Promise<string | null> {
        const name = basename(path);
        const { stem, extension } = isFolder ? { stem: name, extension: '' } : splitExtension(name);
        for (let n = 1; n <= 20; n++) {
            const candidate = `${stem} (case conflict${n === 1 ? '' : ` ${n}`})${extension}`;
            const target = joinPath(parentPath(path), candidate);
            if (claimants.has(target.toLowerCase())) {
                continue;
            }
            try {
                await this.host.drive().renameNode(nodeUid, candidate);
            } catch (error) {
                if (error instanceof NodeWithSameNameExistsValidationError) {
                    continue;
                }
                this.host.logger.warn(`Could not rename "${path}" on Drive to settle a case clash with "${owner}"`, error);
                return null;
            }
            claimants.set(target.toLowerCase(), target);
            this.host.logger.warn(
                `"${path}" and "${owner}" differ only in letter case, which this device cannot tell apart; ` +
                    `renamed "${path}" to "${target}" on Drive`,
            );
            this.host.reportConflict({ path: owner, reason: 'case-collision', outcome: 'renamed', copyPath: target });
            return target;
        }
        return null;
    }
}
