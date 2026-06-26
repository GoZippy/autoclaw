/**
 * supervisorLease.ts — single active supervisor + standby failover (SH-2).
 *
 * Only ONE supervisor may run the HEAL phase at a time, or two orchestrator
 * hosts (two IDEs with the extension) would race on recovery. This is a
 * heartbeat-renewed lease, same mutex shape as a task claim: the first holder
 * wins; while its heartbeat stays fresh it keeps the role; if it goes stale a
 * standby (the next host to tick) steals the lease and becomes supervisor —
 * self-healing the healer.
 *
 * E1b (ELECTION track): the durable source of truth is now the versioned
 * `comms/cluster-map.json` (see clusterMap.ts), of which the lease is the
 * `active_manager` sub-object. `acquireSupervisorRole`/`readSupervisorLease`/
 * `releaseSupervisorRole` keep their EXACT public contract — `AcquireResult` and
 * the flat `SupervisorLease` shape are unchanged — but operate on the cluster
 * map underneath and PROJECT it back down to the flat lease for every caller
 * (the L1 gate, the L4 chip, board refresh). For one release they also MIRROR
 * the flat lease to the legacy `comms/supervisor.lock.json` (compat shim), and
 * READ falls back to that legacy file when no cluster map exists yet (migration
 * with no takeover blip — the in-flight legacy holder is adopted as-is).
 *
 * fs-only (no vscode), `now` injectable. The (epoch, term) ordering, fencing,
 * and the create-exclusive wx-lock around the read-modify-write land in E1c;
 * this slice carries epoch/term inertly (preserved across writes, not yet
 * bumped) so the change is a storage-format + compat move, not new election
 * semantics. See docs/ideas/DISTRIBUTED-COORDINATION-MESH.md §3.1/§3.2.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  type ClusterMap,
  type Membership,
  activeManagerFromLease,
  toSupervisorLease,
  clusterMapFromLease,
  coerceClusterMap,
  emptyClusterMap,
  bumpTerm,
  appendFenced,
  clearFenced,
  isFenced,
  applyMembership,
} from './clusterMap';

const fsp = fs.promises;

const COMMS_REL = path.join('.autoclaw', 'orchestrator', 'comms');

/** Default lease lifetime — a holder is stale once its heartbeat is older. */
export const SUPERVISOR_TTL_MS = 90_000;

/**
 * Orphan-lock reaping TTL for the E1c wx-lock. MUCH smaller than
 * SUPERVISOR_TTL_MS: the lock only guards a sub-millisecond read-modify-write, so
 * a crash inside the critical section must free acquisition fast — not freeze the
 * whole cluster for a lease lifetime. Orthogonal to SUPERVISOR_TTL_MS (which
 * governs lease staleness / who may steal the role).
 */
export const CLUSTER_MAP_LOCK_TTL_MS = 5_000;

/** The on-disk supervisor lease (the flat projection of `active_manager`). */
export interface SupervisorLease {
  /** The holding loop-instance id. */
  holder: string;
  /** When the role was first acquired (preserved across renewals). */
  acquired_at: string;
  /** Last heartbeat — freshness is measured from this. */
  heartbeat: string;
  /** When the lease goes stale if not renewed. */
  expires: string;
}

/** Result of an acquire attempt. */
export interface AcquireResult {
  /** True ⇒ the caller is the active supervisor and should run HEAL. */
  isSupervisor: boolean;
  /** The current holder id (the caller, when isSupervisor). */
  holder: string;
  /** True when the caller stole a stale lease from a previous holder. */
  stole: boolean;
}

/** Legacy flat lease path (compat mirror; still the read-fallback source). */
export function supervisorLeasePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, COMMS_REL, 'supervisor.lock.json');
}

/** Path to the versioned cluster map — the E1 durable source of truth. */
export function clusterMapPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, COMMS_REL, 'cluster-map.json');
}

// ---------------------------------------------------------------------------
// Legacy flat-lease read/write (compat layer)
// ---------------------------------------------------------------------------

async function readLeaseFile(file: string): Promise<SupervisorLease | null> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const o = JSON.parse(raw.replace(/^﻿/, '')) as SupervisorLease;
    return o && typeof o.holder === 'string' && typeof o.heartbeat === 'string' ? o : null;
  } catch {
    return null;
  }
}

/** Plain write of the legacy flat lease — byte-identical to the pre-E1b output. */
async function writeLeaseFile(file: string, lease: SupervisorLease): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(lease, null, 2) + '\n', 'utf8');
}

function isStale(lease: SupervisorLease, now: number, ttlMs: number): boolean {
  const hb = Date.parse(lease.heartbeat);
  return !Number.isFinite(hb) || now - hb > ttlMs;
}

// ---------------------------------------------------------------------------
// Cluster-map read (with legacy fallback) + write (with compat mirror)
// ---------------------------------------------------------------------------

/**
 * Read the cluster map. Prefers `cluster-map.json`; when it is absent or
 * unparseable, falls back to the legacy `supervisor.lock.json` and synthesizes a
 * map from it (migration — adopts the in-flight legacy holder with NO takeover
 * blip so the L4 chip never flickers to "none" on the first post-upgrade tick).
 * Returns null only when NEITHER file yields a usable lease.
 *
 * COMPAT-WINDOW RECONCILIATION: during the one release where a pre-E1b peer may
 * coexist, that peer takes over ONLY by writing the legacy `supervisor.lock.json`
 * with a fresher heartbeat (it never touches `cluster-map.json`). So when BOTH
 * files exist and the mirror is strictly newer than the map's active manager AND
 * names a different holder, that is an external steal we must honor — otherwise
 * an E1b host would self-renew over a pre-E1b host's takeover and split-brain
 * (double active manager → double dispatch/HEAL). In pure-E1b operation the map
 * and mirror are written together, so the mirror is never newer and this is inert.
 */
async function readClusterMapWithFallback(workspaceRoot: string): Promise<ClusterMap | null> {
  let map: ClusterMap | null = null;
  try {
    const raw = await fsp.readFile(clusterMapPath(workspaceRoot), 'utf8');
    map = coerceClusterMap(JSON.parse(raw.replace(/^﻿/, '')));
  } catch {
    // map stays null — fall back to the legacy lease below
  }
  const legacy = await readLeaseFile(supervisorLeasePath(workspaceRoot));

  if (!map) {
    return legacy ? clusterMapFromLease(legacy) : null;
  }
  const active = map.active_manager;
  if (legacy && !active) {
    // Map has no usable active (e.g. a malformed active_manager) but a legacy
    // holder is live — adopt it rather than reporting "no supervisor".
    return clusterMapFromLease(legacy);
  }
  if (legacy && active && legacy.holder !== active.instance_id) {
    const mapHb = Date.parse(active.lease_heartbeat);
    const legHb = Date.parse(legacy.heartbeat);
    if (Number.isFinite(legHb) && (!Number.isFinite(mapHb) || legHb > mapHb)) {
      // A strictly-newer mirror under a different holder = an external takeover.
      return clusterMapFromLease(legacy);
    }
  }
  return map;
}

let writeSeq = 0;
let lockReapSeq = 0;

/**
 * Publish a cluster map AND mirror its flat lease to the legacy file. The map
 * is written atomically (same-dir temp + rename) so a concurrent reader never
 * sees a half-written map; the mirror is a plain write that stays byte-identical
 * to the pre-E1b `supervisor.lock.json` for the one compat release.
 */
async function writeMapAndMirror(workspaceRoot: string, map: ClusterMap): Promise<void> {
  const mapFile = clusterMapPath(workspaceRoot);
  await fsp.mkdir(path.dirname(mapFile), { recursive: true });
  const tmp = `${mapFile}.tmp-${process.pid}-${++writeSeq}`;
  await fsp.writeFile(tmp, JSON.stringify(map, null, 2) + '\n', 'utf8');
  try {
    await fsp.rename(tmp, mapFile);
  } catch (err) {
    // Never leak the temp on a rename failure (win32 EPERM/EBUSY when a reader
    // or AV holds the destination open). Caller catches and degrades to standby.
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }
  // Compat mirror — keep the legacy flat lease for one release.
  const lease = toSupervisorLease(map);
  if (lease) {
    await writeLeaseFile(supervisorLeasePath(workspaceRoot), lease);
  }
}

/** Unlink a file; true when it is gone afterward (unlinked or already absent). */
async function unlinkResolved(file: string): Promise<boolean> {
  try {
    await fsp.unlink(file);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

// ---------------------------------------------------------------------------
// E1c wx-lock — create-exclusive serialization of the cluster-map RMW
// ---------------------------------------------------------------------------

/** The create-exclusive lock file guarding the cluster-map read-modify-write. */
function clusterMapLockPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, COMMS_REL, 'cluster-map.json.lock');
}

/**
 * Acquire the create-exclusive RMW lock guarding cluster-map.json — the exact
 * `open(_, 'wx')` (O_CREAT|O_EXCL) primitive from claim.ts. Returns the held
 * handle on success, or null when another window holds a FRESH lock (the loser
 * stands by this tick). A crashed holder's orphan lock (mtime older than
 * CLUSTER_MAP_LOCK_TTL_MS) is reaped once and re-raced honestly via wx, so a live
 * contender still wins cleanly and a crash inside the section cannot deadlock.
 */
async function acquireMapLock(workspaceRoot: string, now: number): Promise<fs.promises.FileHandle | null> {
  const lockPath = clusterMapLockPath(workspaceRoot);
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    return await fsp.open(lockPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { throw err; }
  }
  // The lock exists — reap it only if its holder appears to have crashed (stale mtime).
  const st = await fsp.stat(lockPath).catch(() => null);
  if (!st || now - st.mtimeMs < CLUSTER_MAP_LOCK_TTL_MS) {
    return null; // a fresh holder owns the RMW → stand by this tick
  }
  // CLAIM the reap ATOMICALLY via rename to a private name. unlink-then-open is NOT
  // atomic across two concurrent reapers (both could unlink + re-open + win); rename
  // has exactly one winner — the source can be moved only once, so a second reaper's
  // rename fails (ENOENT) and it stands by. This closes the double-winner split-brain.
  const reapPath = `${lockPath}.reap-${process.pid}-${++lockReapSeq}`;
  try {
    await fsp.rename(lockPath, reapPath);
  } catch {
    return null; // lost the reap race (another window reaped/renewed it) → stand by
  }
  await fsp.unlink(reapPath).catch(() => undefined); // discard the orphan we now own
  try {
    return await fsp.open(lockPath, 'wx'); // re-race honestly for the fresh lock
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') { return null; }
    throw err; // win32 EPERM/EBUSY → caller catches and degrades to standby
  }
}

/** Release the RMW lock: close the handle FIRST (win32), then unlink — both best-effort. */
async function releaseMapLock(workspaceRoot: string, fd: fs.promises.FileHandle): Promise<void> {
  await fd.close().catch(() => undefined);
  await fsp.unlink(clusterMapLockPath(workspaceRoot)).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Public lease API (contract-identical to pre-E1b)
// ---------------------------------------------------------------------------

/**
 * Try to become (or stay) the active supervisor.
 *
 *  - No active manager → acquire it (isSupervisor true).
 *  - Held by me        → renew (bump heartbeat/expiry), isSupervisor true.
 *  - Held by another, fresh → not supervisor (stand by).
 *  - Held by another, stale → steal it (isSupervisor true, stole true).
 *
 * The four cases and the `AcquireResult` they return are byte-identical to the
 * pre-E1b lease; only the storage moved to the cluster map (plus the compat
 * mirror + read-fallback). epoch/term are carried through untouched in this
 * slice — the steal does not yet bump term or fence the deposed holder (E1c).
 *
 * With `opts.fencing` (autoclaw.cluster.fencing, OFF by default) this delegates to
 * the E1c path: the same four-case decision serialized by a create-exclusive
 * wx-lock, with LIVE epoch/term, deposed-holder fencing, and self-fence stand-down.
 * With the flag OFF the body below is byte-identical to E1b: the non-atomic
 * read-then-write race is still tolerated (the loser overwrites next tick; the
 * duplicate HEAL is idempotent).
 */
export async function acquireSupervisorRole(
  workspaceRoot: string,
  holderId: string,
  opts: { now?: number; ttlMs?: number; fencing?: boolean; membership?: Membership } = {},
): Promise<AcquireResult> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? SUPERVISOR_TTL_MS;
  if (opts.fencing) {
    return acquireSupervisorRoleFenced(workspaceRoot, holderId, now, ttlMs, opts.membership);
  }
  // `membership` is honored ONLY on the fenced path: the START LOOP roster write
  // must ride the wx-lock so monitors/standbys/quorum stay consistent with the
  // elected active_manager in one atomic publish (E2b). The non-fenced E1b path
  // (no lock) ignores it, unchanged.
  const map = await readClusterMapWithFallback(workspaceRoot);
  const existing = map ? toSupervisorLease(map) : null;
  const base = map ?? emptyClusterMap();

  const nowIso = new Date(now).toISOString();
  const expIso = new Date(now + ttlMs).toISOString();

  if (!existing) {
    const active = activeManagerFromLease({ holder: holderId, acquired_at: nowIso, heartbeat: nowIso, expires: expIso });
    await writeMapAndMirror(workspaceRoot, { ...base, active_manager: active });
    return { isSupervisor: true, holder: holderId, stole: false };
  }

  if (existing.holder === holderId) {
    // Renew — preserve acquired_at exactly as the pre-E1b `{ ...existing }` spread did.
    const active = activeManagerFromLease({ ...existing, heartbeat: nowIso, expires: expIso });
    await writeMapAndMirror(workspaceRoot, { ...base, active_manager: active });
    return { isSupervisor: true, holder: holderId, stole: false };
  }

  if (isStale(existing, now, ttlMs)) {
    const active = activeManagerFromLease({ holder: holderId, acquired_at: nowIso, heartbeat: nowIso, expires: expIso });
    await writeMapAndMirror(workspaceRoot, { ...base, active_manager: active });
    return { isSupervisor: true, holder: holderId, stole: true };
  }

  // A fresh lease held by someone else — stand by.
  return { isSupervisor: false, holder: existing.holder, stole: false };
}

/**
 * E1c fencing path (behind autoclaw.cluster.fencing). The same four-case decision
 * as E1b, but (1) serialized end-to-end by the create-exclusive wx-lock so two
 * windows can never both read the same base and double-bump the term; (2) with
 * LIVE epoch/term — a fresh acquire and a steal bump the term (via bumpTerm, which
 * co-bumps epoch), a renew bumps NEITHER; (3) a steal fences the deposed holder at
 * its OLD term (appendFenced BEFORE bumpTerm); (4) a self-fenced holder stands
 * down on its next read and never renews itself back into power.
 */
async function acquireSupervisorRoleFenced(
  workspaceRoot: string,
  holderId: string,
  now: number,
  ttlMs: number,
  membership?: Membership,
): Promise<AcquireResult> {
  // Fold the START LOOP roster (E2b) into the map being published, under the same
  // wx-lock — so monitors/standbys/quorum are written atomically with active_manager
  // (a membership change bumps epoch). A standby (self-fence / stand-by) writes
  // NOTHING, so only the active manager persists the projection. No-op when undefined.
  const withMembership = (m: ClusterMap): ClusterMap => (membership ? applyMembership(m, membership) : m);

  const lock = await acquireMapLock(workspaceRoot, now);
  if (!lock) {
    // Another window owns the RMW this tick — stand by, write nothing. Report the
    // current holder (display-only) so the L4 chip still names the live supervisor.
    const cur = await readSupervisorLease(workspaceRoot);
    return { isSupervisor: false, holder: cur?.holder ?? holderId, stole: false };
  }
  try {
    const map = await readClusterMapWithFallback(workspaceRoot);
    const existing = map ? toSupervisorLease(map) : null;
    const base = map ?? emptyClusterMap();
    const nowIso = new Date(now).toISOString();
    const expIso = new Date(now + ttlMs).toISOString();

    if (!existing) {
      const active = activeManagerFromLease({ holder: holderId, acquired_at: nowIso, heartbeat: nowIso, expires: expIso });
      // Fresh acquire of an open role at a new term (empty base 0/0 → 1/1). clearFenced
      // is the re-admission seam: a previously-deposed holder may reclaim an ABANDONED
      // role for liveness, clearing its own stale fence as it re-enters at a higher term.
      await writeMapAndMirror(workspaceRoot, withMembership(bumpTerm(clearFenced(base, holderId), active)));
      return { isSupervisor: true, holder: holderId, stole: false };
    }

    if (existing.holder === holderId) {
      // SELF-FENCE: a deposed holder whose stale active_manager still names itself must
      // NOT renew itself back into power (that resurrects split-brain). It stands down;
      // its lease then ages out and is legitimately reclaimed via the steal branch below
      // — so fencing here blocks resurrection WITHOUT ever stranding liveness.
      if (isFenced(base, holderId)) {
        return { isSupervisor: false, holder: holderId, stole: false };
      }
      // Renew — bump NEITHER epoch nor term; refresh heartbeat/expiry in place,
      // preserving acquired_at exactly as E1b does. A membership delta still bumps epoch.
      const active = activeManagerFromLease({ ...existing, heartbeat: nowIso, expires: expIso });
      await writeMapAndMirror(workspaceRoot, withMembership({ ...base, active_manager: active }));
      return { isSupervisor: true, holder: holderId, stole: false };
    }

    if (isStale(existing, now, ttlMs)) {
      const active = activeManagerFromLease({ holder: holderId, acquired_at: nowIso, heartbeat: nowIso, expires: expIso });
      // Steal an ABANDONED (stale) role: fence the deposed holder at its OLD term FIRST,
      // then clear any prior fence on US (re-admission at a higher term) and bump. A
      // fenced holder MAY reclaim a stale role — this is the failover fencing protects.
      const fencedBase = appendFenced(base, existing.holder, now);
      await writeMapAndMirror(workspaceRoot, withMembership(bumpTerm(clearFenced(fencedBase, holderId), active)));
      return { isSupervisor: true, holder: holderId, stole: true };
    }

    // A fresh lease held by someone else — stand by (the fence, if any, is moot here).
    return { isSupervisor: false, holder: existing.holder, stole: false };
  } finally {
    await releaseMapLock(workspaceRoot, lock);
  }
}

/**
 * Release the lease iff this holder owns it (graceful shutdown).
 *
 * Clears BOTH files, deleting the legacy MIRROR FIRST (the inverse of the read
 * precedence, which reads the map first): if the second unlink then fails, the
 * surviving file is the authoritative map — never an orphan mirror the fallback
 * would resurrect into a phantom-active holder. Returns true only when the role
 * is actually released (both files gone), false on a real unlink failure — the
 * same "released ⇒ true" semantics as the pre-E1b single-file unlink.
 */
export async function releaseSupervisorRole(workspaceRoot: string, holderId: string): Promise<boolean> {
  const map = await readClusterMapWithFallback(workspaceRoot);
  const existing = map ? toSupervisorLease(map) : null;
  if (!existing || existing.holder !== holderId) { return false; }
  if (!(await unlinkResolved(supervisorLeasePath(workspaceRoot)))) { return false; }
  return unlinkResolved(clusterMapPath(workspaceRoot));
}

/** Read the current lease (panel / diagnostics) — projected from the cluster map. */
export async function readSupervisorLease(workspaceRoot: string): Promise<SupervisorLease | null> {
  const map = await readClusterMapWithFallback(workspaceRoot);
  return map ? toSupervisorLease(map) : null;
}

/**
 * Read the FULL cluster map (panel / diagnostics) — prefers cluster-map.json with
 * the legacy-lease fallback + mixed-version reconciliation. Returns the monitors[]/
 * ranked standbys[]/quorum_size the START LOOP records (E2b), which the flat
 * {@link readSupervisorLease} projection drops. null when there is no map.
 */
export async function readClusterMap(workspaceRoot: string): Promise<ClusterMap | null> {
  return readClusterMapWithFallback(workspaceRoot);
}
