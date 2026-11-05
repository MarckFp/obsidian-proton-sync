/**
 * The plugin's live state, kept out of the plugin instance on purpose.
 *
 * `app.plugins.plugins["proton-drive-sync"]` is reachable from every other
 * plugin in the vault, and anything hanging off it — the session, its tokens,
 * the authenticated Drive client, the log buffer with note names — is one
 * property lookup away. Keeping these in module scope means the only way in is
 * through the plugin's narrow methods, none of which hand back credentials.
 *
 * SECURITY.md records what this closes and what it cannot: another plugin in
 * the same process can still read the vault and the network stack.
 */
import type { ConflictEvent } from './sync/engine/types';
import type { PluginWatchReport } from './security/pluginWatch';
import type { TripwireReport } from './security/tripwire';
import type { PermissionFinding } from './security/permissions';
import type { IntegrityResult } from './security/selfIntegrity';
import type { ConflictHistory } from './sync/conflictHistory';
import type { DeviceList } from './sync/devices';
import type { SyncEngine } from './sync/engine';
import type { SyncState } from './sync/state';
import type { ProtonSession } from './proton/session';
import type { PinProtectedSlot } from './proton/pinLock';
import type { Logger } from './util/logger';

const runtime = {
    session: null as unknown as ProtonSession,
    state: null as unknown as SyncState,
    conflictHistory: null as unknown as ConflictHistory,
    engine: null as unknown as SyncEngine,
    devices: null as unknown as DeviceList,
    sessionSlot: null as unknown as PinProtectedSlot,
    clientUid: "",
    logger: null as unknown as Logger,
    pendingConflicts: [] as ConflictEvent[],
    /** The last scan of the plugins installed alongside this one; see security/pluginWatch.ts. */
    pluginWatch: null as PluginWatchReport | null,
    /** Permission problems found at this start; see security/permissions.ts. */
    securityFindings: [] as PermissionFinding[],
    /** Whether this plugin's own code changed without a version change; see security/selfIntegrity.ts. */
    selfIntegrity: null as IntegrityResult | null,
    /** Everything that has reached for the sign-in since this start; see security/tripwire.ts. */
    tripwire: null as TripwireReport | null,
    /**
     * The synced folder and the folders above it. Read on every start, so the
     * saved Drive cache is allowed to keep them; see persistentCache.nodeScope.
     */
    cacheParents: new Set<string>(),
};

/** The live runtime. Throws nothing: every field is wired during `onload`. */
export function getRuntime(): typeof runtime {
    return runtime;
}
