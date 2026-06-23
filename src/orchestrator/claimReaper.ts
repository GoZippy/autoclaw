/**
 * claimReaper.ts — CL-3: release claims abandoned by dead sessions.
 *
 * A claim is "reapable" only when BOTH hold:
 *   1. its owning SESSION is dead — no fresh heartbeat for the claim's
 *      `session_id` (legacy claims without one fall back to agent-level
 *      liveness); and
 *   2. it is expired — past `expires_at`, or `claimed_at` + TTL.
 *
 * Reaping MOVES the claim file to `claims/_reaped/` (preserved for audit) so the
 * task becomes claimable again, and emits a `finding_report`. It is RELEASE-ONLY:
 * it never touches live work, dispatches, sessions, or git — which is why it is
 * safe to run unattended, distinct from the HEAL phase (which acts on live state
 * and stays gated). A live session's claim is never reaped even if "expired" —
 * the owner is alive and working.
 *
 * Pure planner ({@link planReap}) + IO ({@link reapDeadClaims}) so the decision
 * unit-tests without a filesystem. The session-vs-agent liveness rule mirrors
 * board.ts's `owner_healthy` (see the session-aware-liveness change).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { HEARTBEAT_OFFLINE_MS, CLAIM_TTL_DEFAULT_MS } from './board';

const fsp = fs.promises;

/** A claim record as the reaper needs it (subset of the on-disk claim file). */
export interface ReapableClaim {
  task_id: string;
  claimed_by: string;
  session_id?: string;
  claimed_at?: string;
  expires_at?: string;
  ttl_ms?: number;
  /** Source filename under `claims/` — used for the archival move. */
  file: string;
}

/** Minimal heartbeat shape for liveness. */
export interface HeartbeatLite {
  agent_id: string;
  session_id?: string;
  timestamp: string;
  status?: string;
}

/** One reap decision (a claim the planner judged abandoned). */
export interface ReapDecision {
  task_id: string;
  owner: string;
  session_id?: string;
  file: string;
  reason: string;
}

/** What {@link reapDeadClaims} returns. */
export interface ReapReport {
  scanned: number;
  reaped: ReapDecision[];
  /** True when decisions were actually applied (files moved + findings emitted). */
  applied: boolean;
}

export interface ReapOptions {
  now?: number;
  /** Apply the plan (move files + emit findings). Default false = dry run. */
  apply?: boolean;
}

/** Sessions + agents that currently have a fresh, non-halted heartbeat. */
export function liveFromHeartbeats(
  heartbeats: readonly HeartbeatLite[],
  now: number,
): { sessions: Set<string>; agents: Set<string> } {
  const sessions = new Set<string>();
  const agents = new Set<string>();
  for (const hb of heartbeats) {
    if (!hb?.timestamp) { continue; }
    if (hb.status === 'halted' || hb.status === 'offline') { continue; }
    const age = now - Date.parse(hb.timestamp);
    if (!Number.isFinite(age) || age >= HEARTBEAT_OFFLINE_MS) { continue; }
    if (hb.session_id) { sessions.add(hb.session_id); }
    if (hb.agent_id) { agents.add(hb.agent_id); }
  }
  return { sessions, agents };
}

function isExpired(claim: ReapableClaim, now: number): boolean {
  if (claim.expires_at) {
    const t = Date.parse(claim.expires_at);
    if (Number.isFinite(t)) { return t < now; }
  }
  const base = claim.claimed_at ? Date.parse(claim.claimed_at) : NaN;
  if (!Number.isFinite(base)) { return false; } // no time info → never auto-reap
  return base + (claim.ttl_ms ?? CLAIM_TTL_DEFAULT_MS) < now;
}

function isOwnerDead(
  claim: ReapableClaim,
  live: { sessions: Set<string>; agents: Set<string> },
): boolean {
  return claim.session_id
    ? !live.sessions.has(claim.session_id) // session-aware (matches board.ts)
    : !live.agents.has(claim.claimed_by);  // legacy claim → agent-level fallback
}

/**
 * Pure planner: which claims are reapable (owner session dead AND claim expired).
 * Order-stable; ignores claims missing a task_id or source file.
 */
export function planReap(
  claims: readonly ReapableClaim[],
  heartbeats: readonly HeartbeatLite[],
  now: number,
): ReapDecision[] {
  const live = liveFromHeartbeats(heartbeats, now);
  const out: ReapDecision[] = [];
  for (const c of claims) {
    if (!c.task_id || !c.file) { continue; }
    if (!isOwnerDead(c, live)) { continue; } // owner alive → never reap
    if (!isExpired(c, now)) { continue; }     // within TTL → grace window
    out.push({
      task_id: c.task_id,
      owner: c.claimed_by,
      session_id: c.session_id,
      file: c.file,
      reason: `owner ${c.session_id ? `session ${c.session_id}` : `(legacy ${c.claimed_by})`} has no fresh heartbeat and the claim is expired`,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  IO                                                                        */
/* -------------------------------------------------------------------------- */

function commsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
}

function stripBom(s: string): string {
  return s.replace(/^﻿/, '');
}

async function readClaimFiles(workspaceRoot: string): Promise<ReapableClaim[]> {
  const dir = path.join(commsDir(workspaceRoot), 'claims');
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out: ReapableClaim[] = [];
  for (const f of names) {
    if (!f.endsWith('.json')) { continue; }
    try {
      const c = JSON.parse(stripBom(await fsp.readFile(path.join(dir, f), 'utf8')));
      const owner = c.claimed_by ?? c.agent;
      const id = c.task_id ?? path.basename(f, '.json');
      if (!owner || !id) { continue; }
      out.push({
        task_id: id, claimed_by: owner, session_id: c.session_id,
        claimed_at: c.claimed_at, expires_at: c.expires_at, ttl_ms: c.ttl_ms, file: f,
      });
    } catch { /* skip malformed */ }
  }
  return out;
}

async function readHeartbeatFiles(workspaceRoot: string): Promise<HeartbeatLite[]> {
  const dir = path.join(commsDir(workspaceRoot), 'heartbeats');
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out: HeartbeatLite[] = [];
  for (const f of names) {
    if (!f.endsWith('.json')) { continue; }
    try {
      const h = JSON.parse(stripBom(await fsp.readFile(path.join(dir, f), 'utf8')));
      if (h?.agent_id && h.timestamp) {
        out.push({ agent_id: h.agent_id, session_id: h.session_id, timestamp: h.timestamp, status: h.status });
      }
    } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Scan claims, decide which are abandoned, and (when `apply`) archive each to
 * `claims/_reaped/` + emit a `finding_report`. Best-effort and idempotent: a
 * claim file that vanishes between plan and move is skipped, never throws.
 */
export async function reapDeadClaims(workspaceRoot: string, opts: ReapOptions = {}): Promise<ReapReport> {
  const now = opts.now ?? Date.now();
  const apply = opts.apply ?? false;

  const [claims, heartbeats] = await Promise.all([
    readClaimFiles(workspaceRoot),
    readHeartbeatFiles(workspaceRoot),
  ]);
  const decisions = planReap(claims, heartbeats, now);

  if (!apply || decisions.length === 0) {
    return { scanned: claims.length, reaped: decisions, applied: apply && decisions.length > 0 };
  }

  const claimsDir = path.join(commsDir(workspaceRoot), 'claims');
  const reapedDir = path.join(claimsDir, '_reaped');
  const sharedInbox = path.join(commsDir(workspaceRoot), 'inboxes', 'shared');
  await fsp.mkdir(reapedDir, { recursive: true });
  await fsp.mkdir(sharedInbox, { recursive: true });

  const ts = new Date(now);
  const fileTs = ts.toISOString().replace(/[:.]/g, '-');
  const applied: ReapDecision[] = [];

  for (const d of decisions) {
    // Archive the claim (move, don't delete — auditable + reversible). If the
    // file vanished (raced), skip without emitting a finding.
    try {
      await fsp.rename(path.join(claimsDir, d.file), path.join(reapedDir, `${fileTs}-${d.file}`));
    } catch {
      continue;
    }
    applied.push(d);
    const frag = crypto.randomBytes(3).toString('hex');
    const msg = {
      id: `msg-${crypto.randomUUID()}`,
      from: 'claim-reaper',
      to: 'shared',
      type: 'finding_report',
      timestamp: ts.toISOString(),
      requires_response: false,
      task_id: d.task_id,
      payload: {
        recovery_kind: 'reap_dead_claim',
        task_id: d.task_id,
        owner: d.owner,
        session_id: d.session_id,
        reason: d.reason,
        finding: `Released abandoned claim on ${d.task_id} (owner ${d.owner} session dead + claim expired); the task is claimable again. Claim archived to claims/_reaped/.`,
      },
    };
    try {
      await fsp.writeFile(
        path.join(sharedInbox, `${fileTs}-finding_report-claim-reaper-${frag}.json`),
        JSON.stringify(msg, null, 2) + '\n',
        'utf8',
      );
    } catch { /* finding is best-effort */ }
  }

  return { scanned: claims.length, reaped: applied, applied: true };
}
