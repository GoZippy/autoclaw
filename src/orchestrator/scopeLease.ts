/**
 * scopeLease.ts — CL-4: first-class file-scope leases.
 *
 * An agent session declares the file globs it is actively editing. Peers (and
 * the panel) read the leases; when two DIFFERENT sessions hold OVERLAPPING
 * globs, that surfaces as a `scope_violation` finding (the protocol already
 * names the type — this gives it a producer) instead of a silent clobber. This
 * is the structural fix for the two-windows-editing-one-file collisions that
 * keep happening when sessions share a checkout.
 *
 * Leases are TTL'd. Stored at
 * `.autoclaw/orchestrator/comms/leases/<agent>-<session>.json`.
 *
 * Pure overlap detection ({@link detectConflicts}/{@link globsOverlap}) + IO
 * (declare/read/release/gc), so the matching logic unit-tests without a
 * filesystem. No vscode imports.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const fsp = fs.promises;

/** A declared file-scope lease. */
export interface ScopeLease {
  agent_id: string;
  session_id: string;
  /** File globs the session is actively editing (e.g. "src/extension.ts", "src/panel/**"). */
  globs: string[];
  branch?: string;
  note?: string;
  created_at: string;
  expires_at: string;
}

/** One detected overlap between two different sessions' leases. */
export interface ScopeConflict {
  a: { agent_id: string; session_id: string; branch?: string };
  b: { agent_id: string; session_id: string; branch?: string };
  glob_a: string;
  glob_b: string;
}

/** Default lease lifetime (refresh by re-declaring). */
export const DEFAULT_LEASE_TTL_MS = 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/*  Glob overlap — deterministic heuristic, no dependency                     */
/* -------------------------------------------------------------------------- */

function normGlob(glob: string): string {
  return glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim();
}
function hasWildcard(glob: string): boolean {
  return /[*?[\]]/.test(glob);
}
/** The literal path portion of a glob before its first wildcard. */
function literalPrefix(glob: string): string {
  const star = glob.search(/[*?[\]]/);
  return (star === -1 ? glob : glob.slice(0, star)).replace(/\/+$/, '');
}
function isUnderPrefix(prefix: string, full: string): boolean {
  if (!prefix) { return true; } // e.g. "**" — matches everything
  return full === prefix || full.startsWith(prefix + '/') || full.startsWith(prefix);
}

/**
 * Conservative overlap test: do two declared globs plausibly match a common
 * path? Equal globs overlap; a literal file under the other's wildcard prefix
 * overlaps (`src/**` vs `src/foo.ts`, `src/panel/**` vs `src/panel/x.ts`); two
 * wildcards whose prefixes nest overlap (`src/**` vs `src/panel/**`). Errs
 * toward flagging — a false "conflict" is a cheap nudge; a missed clobber is
 * expensive.
 */
export function globsOverlap(g1: string, g2: string): boolean {
  const a = normGlob(g1), b = normGlob(g2);
  if (!a || !b) { return false; }
  if (a === b) { return true; }
  const wa = hasWildcard(a), wb = hasWildcard(b);
  if (!wa && !wb) { return false; } // two distinct literal files never overlap
  const pa = literalPrefix(a), pb = literalPrefix(b);
  if (!wa && wb) { return isUnderPrefix(pb, a); } // literal a under wildcard b
  if (wa && !wb) { return isUnderPrefix(pa, b); } // literal b under wildcard a
  return isUnderPrefix(pa, pb) || isUnderPrefix(pb, pa); // both wildcards: nested prefixes
}

function firstOverlap(globsA: readonly string[], globsB: readonly string[]): { a: string; b: string } | null {
  for (const ga of globsA) {
    for (const gb of globsB) {
      if (globsOverlap(ga, gb)) { return { a: ga, b: gb }; }
    }
  }
  return null;
}

/**
 * Pure conflict detection: every pair of leases from DIFFERENT sessions whose
 * globs overlap, one conflict per lease-pair (the first overlapping glob pair).
 * Expired leases are ignored.
 */
export function detectConflicts(leases: readonly ScopeLease[], now: number): ScopeConflict[] {
  const live = leases.filter(
    l => l && Array.isArray(l.globs) && l.globs.length > 0 && (!l.expires_at || Date.parse(l.expires_at) > now),
  );
  const out: ScopeConflict[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const A = live[i], B = live[j];
      if (A.session_id && A.session_id === B.session_id) { continue; } // same session
      const hit = firstOverlap(A.globs, B.globs);
      if (!hit) { continue; }
      out.push({
        a: { agent_id: A.agent_id, session_id: A.session_id, branch: A.branch },
        b: { agent_id: B.agent_id, session_id: B.session_id, branch: B.branch },
        glob_a: hit.a, glob_b: hit.b,
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  IO                                                                        */
/* -------------------------------------------------------------------------- */

function commsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
}
function leasesDir(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'leases');
}
function sanitize(s: string): string {
  // Drop everything but alnum/dash/underscore — neutralizes path separators AND
  // dots, so a lease filename can never contain `..` or escape the leases dir.
  return s.replace(/[^A-Za-z0-9_-]/g, '-');
}
/** One lease file per (agent, session). Re-declaring overwrites/refreshes it. */
function leaseFileName(agentId: string, sessionId: string): string {
  return `${sanitize(agentId)}-${sanitize(sessionId)}.json`;
}
function stripBom(s: string): string { return s.replace(/^﻿/, ''); }

export async function readLeases(workspaceRoot: string): Promise<ScopeLease[]> {
  const dir = leasesDir(workspaceRoot);
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out: ScopeLease[] = [];
  for (const f of names) {
    const base = path.basename(f); // confine to the leases dir (no traversal)
    if (base !== f || !base.endsWith('.json') || base.startsWith('_')) { continue; }
    try {
      const l = JSON.parse(stripBom(await fsp.readFile(path.join(dir, base), 'utf8')));
      if (l?.agent_id && l.session_id && Array.isArray(l.globs)) { out.push(l as ScopeLease); }
    } catch { /* skip malformed */ }
  }
  return out;
}

export interface DeclareScopeInput {
  agent_id: string;
  session_id: string;
  globs: string[];
  branch?: string;
  note?: string;
  ttlMs?: number;
  now?: number;
}

export interface DeclareScopeResult {
  lease: ScopeLease;
  /** Conflicts involving THIS session, if any. */
  conflicts: ScopeConflict[];
}

/** Emit a scope_violation finding for one conflict (best-effort). */
async function emitScopeViolation(workspaceRoot: string, c: ScopeConflict, now: number): Promise<void> {
  const sharedInbox = path.join(commsDir(workspaceRoot), 'inboxes', 'shared');
  await fsp.mkdir(sharedInbox, { recursive: true });
  const ts = new Date(now);
  const fileTs = ts.toISOString().replace(/[:.]/g, '-');
  const frag = crypto.randomBytes(3).toString('hex');
  const msg = {
    id: `msg-${crypto.randomUUID()}`,
    from: c.a.agent_id, session_id: c.a.session_id, to: 'shared',
    type: 'scope_violation', timestamp: ts.toISOString(), requires_response: false,
    payload: {
      finding: `Scope overlap: ${c.a.agent_id}/${c.a.session_id} ("${c.glob_a}") and ${c.b.agent_id}/${c.b.session_id} ("${c.glob_b}") both hold leases that match a common path. Coordinate before editing to avoid a clobber.`,
      a: c.a, b: c.b, glob_a: c.glob_a, glob_b: c.glob_b,
    },
  };
  await fsp.writeFile(
    path.join(sharedInbox, `${fileTs}-scope_violation-${sanitize(c.a.agent_id)}-${frag}.json`),
    JSON.stringify(msg, null, 2) + '\n', 'utf8',
  );
}

/**
 * Declare (or refresh) a session's scope lease, then check it against every
 * other session's live lease. Emits a `scope_violation` finding for each
 * conflict involving this session and returns them so the caller can warn.
 */
export async function declareScope(workspaceRoot: string, input: DeclareScopeInput): Promise<DeclareScopeResult> {
  const now = input.now ?? Date.now();
  const globs = input.globs.map(g => g.trim()).filter(Boolean);
  const lease: ScopeLease = {
    agent_id: input.agent_id,
    session_id: input.session_id,
    globs,
    branch: input.branch,
    note: input.note,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + (input.ttlMs ?? DEFAULT_LEASE_TTL_MS)).toISOString(),
  };
  await fsp.mkdir(leasesDir(workspaceRoot), { recursive: true });
  // Housekeeping: drop expired lease files on every declare so the dir stays
  // small and conflict detection never considers stale leases (no loop needed).
  await gcExpiredLeases(workspaceRoot, now);
  await fsp.writeFile(
    path.join(leasesDir(workspaceRoot), leaseFileName(input.agent_id, input.session_id)),
    JSON.stringify(lease, null, 2), 'utf8',
  );

  const all = await readLeases(workspaceRoot);
  const conflicts = detectConflicts(all, now).filter(
    c => c.a.session_id === input.session_id || c.b.session_id === input.session_id,
  );
  for (const c of conflicts) {
    // Normalize so the "a" side is always this session (clearer finding).
    const norm = c.a.session_id === input.session_id ? c : { ...c, a: c.b, b: c.a, glob_a: c.glob_b, glob_b: c.glob_a };
    await emitScopeViolation(workspaceRoot, norm, now);
  }
  return { lease, conflicts };
}

/** Release a session's lease (idempotent). */
export async function releaseScope(workspaceRoot: string, agentId: string, sessionId: string): Promise<boolean> {
  try {
    await fsp.unlink(path.join(leasesDir(workspaceRoot), leaseFileName(agentId, sessionId)));
    return true;
  } catch { return false; }
}

/** Delete expired lease files. Returns how many were reaped. Best-effort. */
export async function gcExpiredLeases(workspaceRoot: string, now: number = Date.now()): Promise<number> {
  const dir = leasesDir(workspaceRoot);
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return 0; }
  let reaped = 0;
  for (const f of names) {
    const base = path.basename(f); // confine to the leases dir (no traversal)
    if (base !== f || !base.endsWith('.json') || base.startsWith('_')) { continue; }
    try {
      const l = JSON.parse(stripBom(await fsp.readFile(path.join(dir, base), 'utf8')));
      if (l?.expires_at && Date.parse(l.expires_at) <= now) {
        await fsp.unlink(path.join(dir, base));
        reaped++;
      }
    } catch { /* skip */ }
  }
  return reaped;
}
