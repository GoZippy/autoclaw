/**
 * clusterMap.ts — the versioned cluster map (E1a, ELECTION track).
 *
 * The cluster map is the single versioned source of truth for "who is the
 * active orchestrator (manager), who are the hot standbys, who is in the
 * monitor set, and which deposed managers are fenced." It is a strict SUPERSET
 * of today's `SupervisorLease` (src/orchestrator/supervisorLease.ts): the lease
 * becomes the `active_manager` sub-object, so the migration is a rename+nest,
 * not a rewrite. See docs/ideas/DISTRIBUTED-COORDINATION-MESH.md §3.1/§3.2.
 *
 * THIS MODULE IS PURE: no `fs`, no `vscode`, no `Date.now()` — `now` is always
 * injected, exactly like the merge core in `lmd/gossip.ts` and the lease helpers
 * in `supervisorLease.ts`. All the fs glue (reading/writing cluster-map.json,
 * the wx-lock, and the backward-compat mirror of supervisor.lock.json) lands
 * LATER in supervisorLease.ts (E1b/E1c) and delegates to these pure helpers.
 * Keeping this file pure makes the (epoch, term) ordering, the bump rules, the
 * fencing append, and the lease projection trivially unit-testable in isolation.
 *
 * Ordering is by integer **(epoch, term)** — NEVER timestamps — so clock skew
 * between hosts can never reorder two valid maps (the failure mode the charter
 * calls out). The merge rule generalizes the freshest-wins merge already shipped
 * in `RemoteHealthTracker.merge` (lmd/gossip.ts) from a `lastHeartbeatAt`
 * timestamp compare to an integer (epoch, term) lexicographic compare.
 */

import type { SupervisorLease } from './supervisorLease';

/** Current cluster-map schema version (for forward migration). */
export const CLUSTER_MAP_VERSION = 1 as const;

/**
 * The active manager — the supervisor lease, renamed+nested. The four lease
 * fields map 1:1: holder→instance_id, heartbeat→lease_heartbeat,
 * expires→lease_expires, acquired_at→acquired_at (preserved across renewals).
 */
export interface ActiveManager {
  /** Holding loop-instance id (= SupervisorLease.holder). NOT an agent id. */
  instance_id: string;
  /** Optional agent id, when the manager is also a named agent. */
  agent_id?: string;
  /** Optional host machine id, for cross-machine display. */
  machine_id?: string;
  /** When the role was first acquired (preserved across renewals). */
  acquired_at: string;
  /** Last heartbeat — freshness is measured from this (= SupervisorLease.heartbeat). */
  lease_heartbeat: string;
  /** When the lease goes stale if not renewed (= SupervisorLease.expires). */
  lease_expires: string;
}

/** A hot standby — ranked for promotion when the active goes stale. */
export interface Standby {
  instance_id: string;
  agent_id?: string;
  machine_id?: string;
  /** Promotion rank score (roleElection.scoreNeed × freshness); higher wins. */
  score: number;
  /** ISO timestamp this standby was last seen. */
  last_seen: string;
}

/** A deposed active manager, fenced so it stands down on its next read. */
export interface FencedEntry {
  /** The deposed instance id. */
  instance_id: string;
  /** The term the holder was deposed FROM (the term it had held). */
  fenced_at_term: number;
  /** ISO timestamp it was fenced. */
  fenced_at: string;
}

/** The versioned cluster map (the single source of truth). */
export interface ClusterMap {
  /** Schema version, for future migration. */
  version: typeof CLUSTER_MAP_VERSION;
  /** Bumped on ANY membership/standby/monitor/quorum/fence change. */
  epoch: number;
  /** Bumped ONLY when a new active_manager is installed (election/steal). */
  term: number;
  /** The active manager (= the supervisor lease, nested), or null when none. */
  active_manager: ActiveManager | null;
  /** Ranked standbys, sorted desc by score, tie-break ascending instance_id. */
  standbys: Standby[];
  /** Instance ids in the monitor set (START LOOP / quorum — E2). */
  monitors: string[];
  /** Advisory MAJORITY quorum threshold (floor(n/2)+1); a lone agent is quorum-of-one. Seeds T5; not an E2 election gate. */
  quorum_size: number;
  /** Deposed actives — a fenced holder stops on its next read. */
  fenced: FencedEntry[];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** An empty map at epoch 0 / term 0 with no active and a quorum-of-one. */
export function emptyClusterMap(): ClusterMap {
  return {
    version: CLUSTER_MAP_VERSION,
    epoch: 0,
    term: 0,
    active_manager: null,
    standbys: [],
    monitors: [],
    quorum_size: 1,
    fenced: [],
  };
}

/**
 * Project a legacy flat `SupervisorLease` UP into an `ActiveManager`. Used by
 * the read-fallback when only a legacy `supervisor.lock.json` exists (E1b).
 */
export function activeManagerFromLease(
  lease: SupervisorLease,
  extra?: { agent_id?: string; machine_id?: string },
): ActiveManager {
  const am: ActiveManager = {
    instance_id: lease.holder,
    acquired_at: lease.acquired_at,
    lease_heartbeat: lease.heartbeat,
    lease_expires: lease.expires,
  };
  if (extra?.agent_id) { am.agent_id = extra.agent_id; }
  if (extra?.machine_id) { am.machine_id = extra.machine_id; }
  return am;
}

/**
 * Migration helper: synthesize a cluster map from a legacy lease (or null). An
 * absent lease yields an empty map; a present one becomes the active_manager at
 * epoch 0 / term 0 — adopting the in-flight legacy holder with NO takeover blip
 * (the L4 chip never flickers to "none" on first upgrade tick).
 */
export function clusterMapFromLease(lease: SupervisorLease | null): ClusterMap {
  const base = emptyClusterMap();
  return lease ? { ...base, active_manager: activeManagerFromLease(lease) } : base;
}

/**
 * A lone agent bootstraps a quorum-of-one: install `lease` as the active
 * manager at epoch 1 / term 1, quorum_size 1, no standbys/fenced. The lone
 * agent keeps full authority as peers later arrive as standbys.
 */
export function bootstrapQuorumOfOne(
  lease: SupervisorLease,
  extra?: { agent_id?: string; machine_id?: string },
): ClusterMap {
  return bumpTerm(emptyClusterMap(), activeManagerFromLease(lease, extra));
}

// ---------------------------------------------------------------------------
// Ordering + merge — integer (epoch, term), never timestamps
// ---------------------------------------------------------------------------

/**
 * Lexicographic compare on (epoch, term): epoch dominates, term breaks ties.
 * Returns 1 if `a` is newer, -1 if `b` is newer, 0 if the same version.
 * Integer-only — clock skew can never reorder two valid maps.
 */
export function compareVersion(a: ClusterMap, b: ClusterMap): -1 | 0 | 1 {
  if (a.epoch !== b.epoch) { return a.epoch > b.epoch ? 1 : -1; }
  if (a.term !== b.term) { return a.term > b.term ? 1 : -1; }
  return 0;
}

/** True iff `a` is strictly newer than `b` by (epoch, term). */
export function isStrictlyNewer(a: ClusterMap, b: ClusterMap): boolean {
  return compareVersion(a, b) > 0;
}

/**
 * Freshest-wins merge, generalizing `RemoteHealthTracker.merge` from a
 * `lastHeartbeatAt` timestamp compare to an integer (epoch, term) compare.
 * The strictly-newer map wins WHOLE; an equal version is a no-op (keeps
 * `local`, avoiding gratuitous churn — equal (epoch, term) IS the same map
 * version, so there is nothing new to learn). An out-of-order / older incoming
 * map is dropped (the `local` incumbent is returned unchanged), exactly like
 * the gossip tracker returns `undefined` for a stale beat.
 */
export function mergeClusterMap(local: ClusterMap, incoming: ClusterMap): ClusterMap {
  return isStrictlyNewer(incoming, local) ? incoming : local;
}

// ---------------------------------------------------------------------------
// Bump helpers — pure + immutable (return fresh objects, never mutate input)
// ---------------------------------------------------------------------------

/**
 * Bump epoch on a membership change (standby joins/leaves, rank reorder,
 * monitor-set change, quorum resize, a fence append). Leaves `term` untouched.
 */
export function bumpEpoch(map: ClusterMap): ClusterMap {
  return { ...map, epoch: map.epoch + 1 };
}

/**
 * Install a new active manager (election/steal): term++ AND epoch++ (a new
 * active is also a membership change, so a term bump always co-bumps epoch).
 * The result is strictly newer than the map it was derived from, so a manager
 * change always wins the merge against the SAME base map it advanced.
 *
 * NOTE — this does NOT make a manager change dominate an UNRELATED map that
 * independently advanced epoch further: merge orders by epoch first, so two
 * standby-only `bumpEpoch`s at the old term (…→ epoch+2, term) outrank a single
 * `bumpTerm` (epoch+1, term+1). That is by design: the (epoch, term) order
 * resolves divergent histories, it does not by itself prevent them. Concurrent
 * bumps on the SAME base must not happen in the first place — the acquire path
 * serializes them with the create-exclusive wx-lock (claim.ts:91 primitive) so
 * only one writer mutates the shared cluster-map.json per tick (E1c). The order
 * is the tie-break across hosts AFTER the lock, never a substitute for it.
 *
 * This does NOT fence the outgoing active — compose with `appendFenced` BEFORE
 * calling this when the install is a steal, so the deposed holder is recorded
 * at its old term (see the steal path that E1c wires up).
 */
export function bumpTerm(map: ClusterMap, newActive: ActiveManager): ClusterMap {
  return { ...map, epoch: map.epoch + 1, term: map.term + 1, active_manager: newActive };
}

/**
 * Append a deposed holder to `fenced[]` at the map's CURRENT term (call this
 * before `bumpTerm` so the entry captures the term the holder actually held).
 * Append-only and idempotent: a holder already fenced at this same term is not
 * double-appended. Returns the input unchanged when it is a no-op.
 */
export function appendFenced(map: ClusterMap, instanceId: string, now: number): ClusterMap {
  if (map.fenced.some((f) => f.instance_id === instanceId && f.fenced_at_term === map.term)) {
    return map;
  }
  const entry: FencedEntry = {
    instance_id: instanceId,
    fenced_at_term: map.term,
    fenced_at: new Date(now).toISOString(),
  };
  return { ...map, fenced: [...map.fenced, entry] };
}

/**
 * True iff `instanceId` is currently fenced (deposed → must stand down on its
 * next read). A re-admitted holder clears its fence by re-acquiring at a higher
 * term via `clearFenced` (E1c) — this is just the membership predicate.
 */
export function isFenced(map: ClusterMap, instanceId: string): boolean {
  return map.fenced.some((f) => f.instance_id === instanceId);
}

/**
 * Clear every fence entry for `instanceId` — called when a previously-deposed
 * holder is legitimately re-admitted (re-acquires at a higher term). Returns
 * the input unchanged when there is nothing to clear.
 */
export function clearFenced(map: ClusterMap, instanceId: string): ClusterMap {
  if (!map.fenced.some((f) => f.instance_id === instanceId)) { return map; }
  return { ...map, fenced: map.fenced.filter((f) => f.instance_id !== instanceId) };
}

// ---------------------------------------------------------------------------
// Projection — cluster map ⇄ flat SupervisorLease (backward-compat seam)
// ---------------------------------------------------------------------------

/**
 * Project the active manager DOWN to a flat `SupervisorLease`, or null when
 * there is no active manager. This is the backward-compat seam: `readSupervisorLease`
 * and the L4 chip keep receiving the exact `{ holder, acquired_at, heartbeat,
 * expires }` shape they read today, with zero view-model changes (E1b).
 */
export function toSupervisorLease(map: ClusterMap): SupervisorLease | null {
  const am = map.active_manager;
  if (!am) { return null; }
  return {
    holder: am.instance_id,
    acquired_at: am.acquired_at,
    heartbeat: am.lease_heartbeat,
    expires: am.lease_expires,
  };
}

// ---------------------------------------------------------------------------
// Standby ranking — deterministic, pure
// ---------------------------------------------------------------------------

/**
 * Rank standbys for promotion: sort DESC by `score`, tie-break ASC by
 * `instance_id` (a deterministic total order so two hosts agree on the next
 * promotion without a re-election round). Returns a NEW array (input untouched).
 */
export function rankStandbys(standbys: Standby[]): Standby[] {
  return [...standbys].sort((a, b) => {
    if (b.score !== a.score) { return b.score - a.score; }
    return a.instance_id < b.instance_id ? -1 : a.instance_id > b.instance_id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Membership projection — START LOOP monitors / ranked standbys / quorum (E2a)
//
// Pure transforms (no fs/vscode/clock — `now`-derived ages are injected) that
// turn a roster of live presence signals into the cluster map's membership
// fields. The fs glue (reading beacons/heartbeats, folding the result into the
// wx-locked acquire RMW) lands in E2b. quorum_size here is ADVISORY (single-FS):
// it is RECORDED for visibility + to seed the cross-machine quorum gate (T5), it
// does NOT gate election — the wx-lock + lease are the real mutual exclusion.
// Standby ranking is likewise RECORD-only: it is the deterministic promotion
// ORDER (and display), never a gate on who may steal a stale lease.
// ---------------------------------------------------------------------------

/**
 * A live presence signal feeding the monitor set (one per ticking session).
 * `instance_id` MUST be in the loop-instance keyspace (= active_manager.instance_id
 * = LOOP_INSTANCE_ID), NOT an agent_id — the caller (E2b) owns the agent_id →
 * instance_id bridge, since heartbeats/beacons are agent_id-keyed today.
 */
export interface MonitorCandidate {
  instance_id: string;
  /** Age of the backing presence signal (heartbeat/beacon) in ms. Finite, >= 0. */
  age_ms: number;
}

/**
 * A standby candidate before scoring (the caller supplies need_score).
 * `instance_id` MUST be the loop-instance keyspace (see {@link MonitorCandidate}).
 */
export interface StandbyCandidate {
  instance_id: string;
  agent_id?: string;
  machine_id?: string;
  /** Capability/availability score from roleElection.scoreNeed (caller-computed). */
  need_score: number;
  /** Age of the backing presence signal in ms. Finite, >= 0. */
  age_ms: number;
  last_seen: string;
}

/** The membership patch produced by the projection, folded into the map by applyMembership. */
export interface Membership {
  monitors: string[];
  standbys: Standby[];
  quorum_size: number;
}

/**
 * Liveness/recency weight in [0,1]: 1 when fresh (age 0), decaying linearly to 0
 * at `ttlMs`, and 0 once stale. Clamps a negative age (clock skew) to 1. A
 * non-finite age (NaN/±Infinity) or non-positive ttl is treated as stale (0), so
 * a bad presence signal is dropped — never turned into a NaN score downstream.
 */
export function freshnessFactor(ageMs: number, ttlMs: number): number {
  if (!(ttlMs > 0) || !Number.isFinite(ageMs)) { return 0; }
  const f = 1 - ageMs / ttlMs;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** The monitor set: every LIVE (non-stale) instance id, de-duplicated and sorted. */
export function projectMonitors(entries: MonitorCandidate[], ttlMs: number): string[] {
  const live = new Set<string>();
  for (const e of entries) {
    if (e.age_ms < ttlMs) { live.add(e.instance_id); }
  }
  return [...live].sort();
}

/**
 * Project ranked standbys from candidates: exclude the active manager and any
 * stale candidate, then rank (DESC score, ASC instance_id). The persisted
 * `score` is the CAPABILITY score (need_score) — NOT need_score × freshness.
 *
 * Freshness is a liveness GATE only (a candidate past the TTL is dropped), never
 * a score multiplier. This is load-bearing for the merge-versioned map: a
 * freshness-weighted score would change on EVERY active tick as a steady peer's
 * age grows, which standbysEqual would read as a membership change and churn the
 * epoch every ~30s (corrupting the epoch-first merge ordering). A stable capability
 * score means the membership only changes when a peer actually joins/leaves or its
 * capability changes. (Freshness-weighted RANKING can return later as a churn-free
 * coarse tier or a live promotion-time tie-break; for now ranking is by capability,
 * tie-break instance_id — deterministic and stable across hosts.)
 */
export function projectStandbys(
  candidates: StandbyCandidate[],
  activeInstanceId: string | null,
  ttlMs: number,
): Standby[] {
  // De-dupe by instance_id keeping the FRESHEST signal (a session can emit both a
  // heartbeat AND a beacon) — the same Set discipline projectMonitors uses — so the
  // ranked order is a true total order over unique ids and the no-op compare is stable.
  const best = new Map<string, StandbyCandidate>();
  for (const c of candidates) {
    if (c.instance_id === activeInstanceId) { continue; }
    const prev = best.get(c.instance_id);
    if (!prev || c.age_ms < prev.age_ms) { best.set(c.instance_id, c); }
  }
  const ranked: Standby[] = [];
  for (const c of best.values()) {
    if (freshnessFactor(c.age_ms, ttlMs) <= 0) { continue; }   // stale presence → not a candidate
    if (!Number.isFinite(c.need_score)) { continue; }          // a malformed score must never poison the rank
    const s: Standby = { instance_id: c.instance_id, score: c.need_score, last_seen: c.last_seen };
    if (c.agent_id) { s.agent_id = c.agent_id; }
    if (c.machine_id) { s.machine_id = c.machine_id; }
    ranked.push(s);
  }
  return rankStandbys(ranked);
}

/**
 * Advisory MAJORITY quorum THRESHOLD = floor(n/2)+1 (a lone agent is quorum-of-one).
 * This is the number of live monitors a partition must hold to remain writable — the
 * value T5 consumes for "partition → minority read-only" (charter §3.x). It is
 * RECORDED for visibility + to seed T5; it does NOT gate election in E2, where the
 * wx-lock + lease are the real single-FS mutual exclusion. The full member COUNT, if
 * T5 needs it, is `monitors.length` (stored alongside).
 */
export function computeQuorumSize(monitorCount: number): number {
  return Math.max(1, Math.floor(monitorCount / 2) + 1);
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function standbysEqual(a: Standby[], b: Standby[]): boolean {
  if (a.length !== b.length) { return false; }
  for (let i = 0; i < a.length; i++) {
    // Compare MEMBERSHIP identity (instance_id + capability score + agent/machine id),
    // NOT `last_seen`: last_seen is a per-keepalive liveness timestamp that advances
    // every tick, so including it would churn the epoch on every renew with no real
    // membership delta. `===` (not Object.is) for score so a JSON round-trip -0 → +0
    // still compares EQUAL; NaN is unreachable (projectStandbys drops non-finite scores).
    if (a[i].instance_id !== b[i].instance_id || a[i].score !== b[i].score
      || a[i].agent_id !== b[i].agent_id
      || a[i].machine_id !== b[i].machine_id) { return false; }
  }
  return true;
}

/**
 * Fold a membership projection into the map. A membership change bumps EPOCH (a
 * membership change, never term — per the ClusterMap field contract); an
 * UNCHANGED projection returns the input map untouched, so a stable solo host
 * never churns the epoch (mirrors the no-op convention of appendFenced/clearFenced).
 * Monitors are stored sorted and standbys ranked, for a stable round-trip compare.
 */
export function applyMembership(map: ClusterMap, m: Membership): ClusterMap {
  const monitors = [...m.monitors].sort();
  const standbys = rankStandbys(m.standbys);
  if (stringArraysEqual(map.monitors, monitors)
    && standbysEqual(map.standbys, standbys)
    && map.quorum_size === m.quorum_size) {
    return map;
  }
  return bumpEpoch({ ...map, monitors, standbys, quorum_size: m.quorum_size });
}

// ---------------------------------------------------------------------------
// Validation — tolerant shape guard (pure; no I/O)
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Coerce an UNKNOWN parsed value (e.g. the result of JSON.parse) into a
 * well-formed `ClusterMap`, or null when it is not a cluster map. Defensively
 * fills missing arrays/quorum so a partially-written or older-shaped map still
 * merges safely. Pure: the fs read + BOM-strip + JSON.parse stay in the caller
 * (E1b), mirroring how `supervisorLease.readLease` tolerates bad input.
 */
export function coerceClusterMap(o: unknown): ClusterMap | null {
  if (!o || typeof o !== 'object') { return null; }
  const m = o as Record<string, unknown>;
  if (!isFiniteNumber(m.epoch) || !isFiniteNumber(m.term)) { return null; }
  const am = m.active_manager;
  let active: ActiveManager | null = null;
  if (am && typeof am === 'object') {
    const a = am as Record<string, unknown>;
    if (typeof a.instance_id === 'string') {
      active = {
        instance_id: a.instance_id,
        acquired_at: typeof a.acquired_at === 'string' ? a.acquired_at : '',
        lease_heartbeat: typeof a.lease_heartbeat === 'string' ? a.lease_heartbeat : '',
        lease_expires: typeof a.lease_expires === 'string' ? a.lease_expires : '',
      };
      if (typeof a.agent_id === 'string') { active.agent_id = a.agent_id; }
      if (typeof a.machine_id === 'string') { active.machine_id = a.machine_id; }
    }
  }
  return {
    version: CLUSTER_MAP_VERSION,
    epoch: m.epoch,
    term: m.term,
    active_manager: active,
    standbys: Array.isArray(m.standbys) ? (m.standbys as Standby[]) : [],
    monitors: Array.isArray(m.monitors) ? (m.monitors as string[]) : [],
    quorum_size: isFiniteNumber(m.quorum_size) ? m.quorum_size : 1,
    fenced: Array.isArray(m.fenced) ? (m.fenced as FencedEntry[]) : [],
  };
}
