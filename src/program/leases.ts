/**
 * leases.ts — Scope-lease primitive (MP-2 / task LS-1).
 *
 * A *scope lease* is a DISTINCT primitive from a task-claim
 * (see docs/MULTI_PROJECT_ORCHESTRATION_REVIEW.md §2.1, §3.6, §4):
 *   - A task-claim is fast (≈10 s), contention-oriented, and answers
 *     "I own work item X".
 *   - A scope lease is human-paced (≈30 min, heartbeat-renewed) and answers
 *     "I hold an editing lease over `src/payments/**` for the next 30 min".
 * A task-claim *implies* a scope lease, but a long editing session can hold a
 * scope lease with no task claim at all — so they intentionally live apart and
 * keep different TTLs.
 *
 * Leases are homed in the program plane (machine-global, repo-agnostic) at
 * `~/.autoclaw/programs/<program_id>/leases.json` so cross-project sessions can
 * all see the same lease set.
 *
 * Design: vscode-free, pure Node FS I/O — fully unit-testable. `now` is
 * injectable everywhere (default `Date.now()` resolved inside each function,
 * never at module load) for deterministic tests.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { programDir } from '../program-plane';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export type Exclusivity = 'exclusive' | 'shared-read';

export interface Lease {
  lease_id: string;
  project: string;
  owner: string;
  session_id: string;
  role: string;
  task_id?: string;
  /** Path globs this lease covers (e.g. `src/payments/**`). */
  scope: string[];
  exclusivity: Exclusivity;
  /** ISO timestamp the lease was granted. */
  lease_granted: string;
  /** ISO timestamp the lease expires (passive expiry). */
  lease_expires: string;
  /** ISO timestamp of the last heartbeat. */
  heartbeat: string;
  heartbeat_interval_sec: number;
  released: boolean;
}

export interface LeasesDoc {
  schema_version: '1.0';
  updated_at: string;
  leases: Lease[];
}

/** Fields a caller supplies when asking for a lease. */
export interface LeaseRequest {
  project: string;
  owner: string;
  session_id: string;
  role: string;
  scope: string[];
  exclusivity: Exclusivity;
  task_id?: string;
  /** Lease lifetime in seconds. Defaults to {@link DEFAULT_TTL_SEC}. */
  ttl_sec?: number;
  /** Heartbeat cadence in seconds. Defaults to {@link DEFAULT_HEARTBEAT_INTERVAL_SEC}. */
  heartbeat_interval_sec?: number;
}

export interface AcquireResult {
  granted: boolean;
  lease?: Lease;
  /** lease_ids of LIVE leases this request conflicted with (only when denied). */
  conflictsWith?: string[];
}

export interface NowOpts {
  /** Injected clock in epoch ms. Defaults to `Date.now()`. */
  now?: number;
}

/** Default scope-lease TTL: 30 minutes (per §2.1). */
export const DEFAULT_TTL_SEC = 30 * 60;
/** Default heartbeat cadence: 2 minutes (per §2.1 table). */
export const DEFAULT_HEARTBEAT_INTERVAL_SEC = 120;

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

export function leasesPath(homeDir: string, programId: string): string {
  return path.join(programDir(homeDir, programId), 'leases.json');
}

// ---------------------------------------------------------------------------
// Reads / writes
// ---------------------------------------------------------------------------

function emptyDoc(): LeasesDoc {
  return { schema_version: '1.0', updated_at: new Date(0).toISOString(), leases: [] };
}

/** Read the leases doc. Tolerates a missing file (returns an empty doc). */
export async function readLeases(homeDir: string, programId: string): Promise<LeasesDoc> {
  try {
    const raw = await fsPromises.readFile(leasesPath(homeDir, programId), 'utf8');
    const doc = JSON.parse(raw.replace(/^﻿/, '')) as LeasesDoc;
    if (!Array.isArray(doc.leases)) { doc.leases = []; }
    return doc;
  } catch {
    return emptyDoc();
  }
}

/**
 * Write the leases doc atomically (tmp file + rename) and stamp `updated_at`.
 * `now` is injectable for deterministic tests.
 */
export async function writeLeases(
  homeDir: string,
  programId: string,
  doc: LeasesDoc,
  opts: NowOpts = {}
): Promise<void> {
  const now = opts.now ?? Date.now();
  doc.updated_at = new Date(now).toISOString();
  const dir = programDir(homeDir, programId);
  await fsPromises.mkdir(dir, { recursive: true });
  const target = leasesPath(homeDir, programId);
  const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsPromises.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
  await fsPromises.rename(tmp, target);
}

// ---------------------------------------------------------------------------
// Lifecycle predicates (all `now`-injectable)
// ---------------------------------------------------------------------------

/** A lease is expired once `now` passes its `lease_expires`. */
export function isExpired(lease: Lease, now: number): boolean {
  return now > Date.parse(lease.lease_expires);
}

/**
 * A lease is stale when its heartbeat is older than 2× its heartbeat interval.
 * Stale leases are reclaimable even before passive expiry.
 */
export function isStale(lease: Lease, now: number): boolean {
  const maxAgeMs = 2 * lease.heartbeat_interval_sec * 1000;
  return now - Date.parse(lease.heartbeat) > maxAgeMs;
}

/** A lease is live when it is neither released nor expired. */
export function isLive(lease: Lease, now: number): boolean {
  return !lease.released && !isExpired(lease, now);
}

// ---------------------------------------------------------------------------
// Glob-intersection helper
// ---------------------------------------------------------------------------

/**
 * Conservative glob-intersection test (no `minimatch` dependency in this repo,
 * so we hand-roll a deliberately over-eager check — when unsure we report an
 * intersection, since a false "they overlap" only costs parallelism while a
 * false "they don't" would let two exclusive editors corrupt each other).
 *
 * Two scope arrays intersect if ANY glob from `a` intersects ANY glob from `b`.
 * Two single globs intersect when, comparing their literal (pre-wildcard) path
 * prefixes segment-by-segment:
 *   - every compared segment matches (equal, or one side is a `*`/`**` wildcard
 *     segment), AND
 *   - one prefix is a prefix of the other (so `src/payments/**` overlaps
 *     `src/payments/gateways/**`, and `src/**` overlaps anything under `src/`).
 */
export function scopesIntersect(a: string[], b: string[]): boolean {
  for (const ga of a) {
    for (const gb of b) {
      if (globsIntersect(ga, gb)) { return true; }
    }
  }
  return false;
}

/** Normalize a glob into comparable path segments (drops trailing `/**`). */
function segments(glob: string): string[] {
  const norm = glob.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = norm.split('/').filter(Boolean);
  // Drop a trailing recursive `**` — `src/payments/**` is "everything under
  // src/payments", so its literal prefix is `src/payments`.
  while (parts.length > 0 && parts[parts.length - 1] === '**') { parts.pop(); }
  return parts;
}

function segMatches(x: string, y: string): boolean {
  if (x === y) { return true; }
  // A `*` or `**` segment, or any segment containing a wildcard char, is
  // treated as matching the opposing literal (conservative).
  if (x === '*' || x === '**' || y === '*' || y === '**') { return true; }
  if (x.includes('*') || y.includes('*') || x.includes('?') || y.includes('?')) { return true; }
  return false;
}

function globsIntersect(ga: string, gb: string): boolean {
  const sa = segments(ga);
  const sb = segments(gb);
  const shorter = Math.min(sa.length, sb.length);
  // Compare the overlapping prefix segment-by-segment.
  for (let i = 0; i < shorter; i++) {
    if (!segMatches(sa[i], sb[i])) { return false; }
  }
  // All compared segments matched and one is a prefix of the other → overlap.
  // (Two empty segment lists — e.g. both `**` — also overlap: everything.)
  return true;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Conflict rule: two LIVE leases conflict when they cover the SAME `project`,
 * their scope globs intersect, AND at least one is `exclusive`. Two
 * `shared-read` leases never conflict with each other. Cross-project leases
 * never conflict regardless of scope.
 */
function conflictsWith(candidate: LeaseRequest, existing: Lease, now: number): boolean {
  // A stale lease (heartbeat past 2× interval) is reclaimable, so it no longer
  // blocks — even before its passive expiry.
  if (!isLive(existing, now) || isStale(existing, now)) { return false; }
  if (existing.project !== candidate.project) { return false; }
  if (existing.exclusivity === 'shared-read' && candidate.exclusivity === 'shared-read') {
    return false;
  }
  return scopesIntersect(candidate.scope, existing.scope);
}

/**
 * Attempt to acquire a scope lease. Runs conflict detection against all LIVE
 * leases (first writer wins). On success the new lease is appended and the doc
 * is written; on conflict nothing is written and `conflictsWith` lists the
 * blocking lease_ids.
 */
export async function acquireLease(
  homeDir: string,
  programId: string,
  request: LeaseRequest,
  opts: NowOpts = {}
): Promise<AcquireResult> {
  const now = opts.now ?? Date.now();
  const doc = await readLeases(homeDir, programId);

  const conflicts = doc.leases
    .filter(l => conflictsWith(request, l, now))
    .map(l => l.lease_id);
  if (conflicts.length > 0) {
    return { granted: false, conflictsWith: conflicts };
  }

  const ttlSec = request.ttl_sec ?? DEFAULT_TTL_SEC;
  const hbInterval = request.heartbeat_interval_sec ?? DEFAULT_HEARTBEAT_INTERVAL_SEC;
  const nowIso = new Date(now).toISOString();
  const lease: Lease = {
    lease_id: `lease_${crypto.randomUUID()}`,
    project: request.project,
    owner: request.owner,
    session_id: request.session_id,
    role: request.role,
    ...(request.task_id ? { task_id: request.task_id } : {}),
    scope: request.scope,
    exclusivity: request.exclusivity,
    lease_granted: nowIso,
    lease_expires: new Date(now + ttlSec * 1000).toISOString(),
    heartbeat: nowIso,
    heartbeat_interval_sec: hbInterval,
    released: false,
  };

  doc.leases.push(lease);
  await writeLeases(homeDir, programId, doc, { now });
  return { granted: true, lease };
}

/**
 * Renew a lease: bump its heartbeat and push `lease_expires` forward by its
 * TTL window (derived from the original granted→expires span). No-op-safe if
 * the lease is missing or already released — returns the (un)changed lease or
 * `null` if not found.
 */
export async function renewLease(
  homeDir: string,
  programId: string,
  leaseId: string,
  opts: NowOpts = {}
): Promise<Lease | null> {
  const now = opts.now ?? Date.now();
  const doc = await readLeases(homeDir, programId);
  const lease = doc.leases.find(l => l.lease_id === leaseId);
  if (!lease) { return null; }
  if (lease.released) { return lease; }

  const ttlMs = Date.parse(lease.lease_expires) - Date.parse(lease.lease_granted);
  const windowMs = ttlMs > 0 ? ttlMs : DEFAULT_TTL_SEC * 1000;
  lease.heartbeat = new Date(now).toISOString();
  lease.lease_expires = new Date(now + windowMs).toISOString();
  await writeLeases(homeDir, programId, doc, { now });
  return lease;
}

/**
 * Release a lease (sets `released: true`). No-op-safe if missing. Returns
 * `true` if a lease was found and released, `false` otherwise.
 */
export async function releaseLease(
  homeDir: string,
  programId: string,
  leaseId: string,
  opts: NowOpts = {}
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const doc = await readLeases(homeDir, programId);
  const lease = doc.leases.find(l => l.lease_id === leaseId);
  if (!lease) { return false; }
  lease.released = true;
  await writeLeases(homeDir, programId, doc, { now });
  return true;
}
