/**
 * fleetBrief.ts — CL-5: `fleet.brief`, one read for full situational awareness.
 *
 * A single artifact an agent reads at session start that answers two questions:
 * "what should I do?" and "what should I avoid?". It folds together, from the
 * file-based comms tree, the things that are otherwise four separate reads:
 *
 *   - **sessions** — every live/known session and what it self-reports it is
 *     doing (current_task / branch / file_scope), from the per-session heartbeat
 *     sidecars CL-1's announce stamps the {@link SessionDescriptor} fields onto.
 *   - **claimable_top** — the top N unclaimed, dependency-satisfied tasks from
 *     the board snapshot (`board.json`), i.e. what is free to pick up.
 *   - **lane counts** — in-flight / awaiting-review / stuck totals from the same
 *     board, for a one-glance health read.
 *   - **scope_conflicts** — overlapping live file-scope leases (CL-4), i.e. the
 *     files a peer is editing that this session should steer clear of.
 *   - **awaiting_me** — shared-inbox SIGNALS actionable for this session
 *     ({@link isActionableForMe}), with loop telemetry / auto-nudges / a
 *     session's own messages filtered out.
 *
 * The fleet digest (`fleet-status.json`) is the conceptual seed; this extends it
 * with per-agent current_task + file_scope + the *real* (non-auto) awaiting set.
 *
 * Pure IO + composition over existing modules — no vscode import, every missing
 * file tolerated (→ empty), never throws. Unit-testable against a temp comms tree.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  isActionableForMe,
  type CommsMessage,
  type SessionDescriptor,
} from './coordination';
import {
  readLeases,
  detectConflicts,
  type ScopeConflict,
} from './scopeLease';

const fsp = fs.promises;

/* -------------------------------------------------------------------------- */
/*  Output shape                                                              */
/* -------------------------------------------------------------------------- */

/** A session as surfaced on the brief — the CL-1 descriptor fields plus liveness. */
export interface BriefSession {
  agent_id: string;
  session_id: string;
  status?: string;
  /** What the session self-reports it is doing (one line). */
  current_task?: string | null;
  /** The git branch the session is working on. */
  branch?: string | null;
  /** File globs the session has declared it is editing (mirrors its CL-4 lease). */
  file_scope?: string[];
  /** ISO timestamp of the session's last heartbeat. */
  last_seen: string;
  /** True when that heartbeat is fresh (within {@link LIVE_WINDOW_MS}). */
  live: boolean;
}

/** A claimable task as carried over from the board snapshot. */
export interface BriefClaimable {
  task_id: string;
  title?: string;
  sprint?: number;
  priority?: 'high' | 'medium' | 'low';
  files?: string[];
}

/** Everything an agent needs for situational awareness in one read. */
export interface FleetBrief {
  generated_at: string;
  /** Echoed identity of the reader, when supplied — handy for "awaiting_me". */
  self?: { agent_id: string; session_id?: string };
  /** Every known session, freshest-per-(agent,session), newest first. */
  sessions: BriefSession[];
  /** Top N claimable tasks from the board (what is free to pick up). */
  claimable_top: BriefClaimable[];
  /** Board lane totals for a one-glance health read. */
  in_flight_count: number;
  awaiting_review_count: number;
  stuck_count: number;
  /** Overlapping live file-scope leases — what to avoid editing. */
  scope_conflicts: ScopeConflict[];
  /** Shared-inbox SIGNALS actionable for `self` (excludes telemetry/auto/own). */
  awaiting_me: CommsMessage[];
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** A heartbeat fresher than this counts as a live session. Matches the board's
 *  HEARTBEAT_OFFLINE_MS so "live" here agrees with the board's owner-health. */
export const LIVE_WINDOW_MS = 5 * 60_000;

/** Default cap on the claimable list — the brief is a "what's free" strip, not the board. */
export const CLAIMABLE_TOP_DEFAULT = 8;

/* -------------------------------------------------------------------------- */
/*  Path helpers                                                              */
/* -------------------------------------------------------------------------- */

function orchestratorDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator');
}
function commsDir(workspaceRoot: string): string {
  return path.join(orchestratorDir(workspaceRoot), 'comms');
}
function boardJsonPath(workspaceRoot: string): string {
  return path.join(orchestratorDir(workspaceRoot), 'board.json');
}
function heartbeatsDir(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'heartbeats');
}
function sharedInboxDir(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'inboxes', 'shared');
}
function fleetBriefPath(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'fleet-brief.json');
}

/* -------------------------------------------------------------------------- */
/*  Generic readers — tolerate every missing file                            */
/* -------------------------------------------------------------------------- */

function stripBom(s: string): string {
  return s.replace(/^﻿/, '');
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(stripBom(await fsp.readFile(filePath, 'utf8'))) as T;
  } catch {
    return null;
  }
}

async function listJson(dir: string): Promise<string[]> {
  try {
    const names = await fsp.readdir(dir);
    return names.filter(n => {
      const base = path.basename(n); // confine to dir (no traversal)
      return base === n && base.endsWith('.json') && !base.startsWith('_');
    });
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  Sessions — every heartbeat sidecar with the CL-1 descriptor fields        */
/* -------------------------------------------------------------------------- */

/** A heartbeat as it appears on disk, with the CL-1 self-describe additions. */
type HeartbeatOnDisk = SessionDescriptor & {
  // base heartbeat carries these too; we read defensively.
  agent_id?: string;
  session_id?: string;
  timestamp?: string;
};

/**
 * Read every session from the heartbeats directory. Reads ALL files (primary
 * `<agent>.json` + per-session `<agent>-<session>.json` sidecars) because agent
 * ids may contain dashes, then dedupes by (agent_id, session_id) keeping the
 * freshest heartbeat — so a session is one row carrying its latest self-report.
 * Heartbeats with no session_id key on the agent alone (legacy/agent-level).
 */
async function readSessions(workspaceRoot: string, now: number): Promise<BriefSession[]> {
  const dir = heartbeatsDir(workspaceRoot);
  const byKey = new Map<string, HeartbeatOnDisk>();
  for (const name of await listJson(dir)) {
    const hb = await readJson<HeartbeatOnDisk>(path.join(dir, name));
    if (!hb || !hb.agent_id || !hb.timestamp) { continue; }
    const key = `${hb.agent_id}|${hb.session_id ?? ''}`;
    const prev = byKey.get(key);
    if (!prev || new Date(hb.timestamp).getTime() > new Date(prev.timestamp!).getTime()) {
      byKey.set(key, hb);
    }
  }

  const sessions: BriefSession[] = [];
  for (const hb of byKey.values()) {
    const ageMs = now - new Date(hb.timestamp!).getTime();
    const stale = !Number.isFinite(ageMs) || ageMs >= LIVE_WINDOW_MS;
    const dead = hb.status === 'halted' || hb.status === 'offline';
    sessions.push({
      agent_id: hb.agent_id!,
      session_id: hb.session_id ?? '',
      ...(hb.status !== undefined ? { status: hb.status } : {}),
      ...(hb.current_task !== undefined ? { current_task: hb.current_task } : {}),
      ...(hb.branch !== undefined ? { branch: hb.branch } : {}),
      ...(Array.isArray(hb.file_scope) ? { file_scope: hb.file_scope } : {}),
      last_seen: hb.timestamp!,
      live: !stale && !dead,
    });
  }
  // Newest-seen first, then a stable tiebreak on agent id.
  sessions.sort(
    (a, b) =>
      new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime() ||
      a.agent_id.localeCompare(b.agent_id),
  );
  return sessions;
}

/* -------------------------------------------------------------------------- */
/*  Board snapshot — claimable + lane counts                                  */
/* -------------------------------------------------------------------------- */

/** Only the lanes the brief surfaces (a subset of board.ts's BoardModel). */
interface BoardSnapshot {
  claimable?: BriefClaimable[];
  in_flight?: unknown[];
  awaiting_review?: unknown[];
  stuck?: unknown[];
}

interface BoardLanes {
  claimable_top: BriefClaimable[];
  in_flight_count: number;
  awaiting_review_count: number;
  stuck_count: number;
}

async function readBoardLanes(workspaceRoot: string, topN: number): Promise<BoardLanes> {
  const board = await readJson<BoardSnapshot>(boardJsonPath(workspaceRoot));
  const claimable = Array.isArray(board?.claimable) ? board!.claimable! : [];
  return {
    claimable_top: claimable.slice(0, topN).map(c => ({
      task_id: c.task_id,
      ...(c.title !== undefined ? { title: c.title } : {}),
      ...(c.sprint !== undefined ? { sprint: c.sprint } : {}),
      ...(c.priority !== undefined ? { priority: c.priority } : {}),
      ...(Array.isArray(c.files) ? { files: c.files } : {}),
    })),
    in_flight_count: Array.isArray(board?.in_flight) ? board!.in_flight!.length : 0,
    awaiting_review_count: Array.isArray(board?.awaiting_review) ? board!.awaiting_review!.length : 0,
    stuck_count: Array.isArray(board?.stuck) ? board!.stuck!.length : 0,
  };
}

/* -------------------------------------------------------------------------- */
/*  Awaiting-me — shared-inbox signals actionable for self                    */
/* -------------------------------------------------------------------------- */

async function readAwaitingMe(
  workspaceRoot: string,
  selfAgentId?: string,
  selfSessionId?: string,
): Promise<CommsMessage[]> {
  if (!selfAgentId) { return []; } // no identity → nothing is "awaiting me"
  const dir = sharedInboxDir(workspaceRoot);
  const out: CommsMessage[] = [];
  for (const name of await listJson(dir)) {
    const msg = await readJson<CommsMessage>(path.join(dir, name));
    if (!msg) { continue; }
    if (isActionableForMe(msg, selfAgentId, selfSessionId)) { out.push(msg); }
  }
  // Oldest first — the longest-waiting ask leads.
  out.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/*  buildFleetBrief / writeFleetBrief                                         */
/* -------------------------------------------------------------------------- */

export interface BuildFleetBriefOptions {
  /** Clock for deterministic tests. */
  now?: number;
  /** Reader's agent id — required for a populated `awaiting_me`. */
  selfAgentId?: string;
  /** Reader's session id — lets a sibling-session message of the same agent count. */
  selfSessionId?: string;
  /** Cap on `claimable_top` (default {@link CLAIMABLE_TOP_DEFAULT}). */
  topN?: number;
}

/**
 * Assemble a {@link FleetBrief} from the comms tree: session heartbeats (with
 * the CL-1 descriptor fields), the board snapshot lanes, the live file-scope
 * leases (CL-4 overlap detection), and the shared inbox (signals actionable for
 * self). Every input is read defensively — a missing tree yields an empty brief
 * and never throws.
 */
export async function buildFleetBrief(
  workspaceRoot: string,
  opts: BuildFleetBriefOptions = {},
): Promise<FleetBrief> {
  const now = opts.now ?? Date.now();
  const topN = opts.topN ?? CLAIMABLE_TOP_DEFAULT;

  const [sessions, lanes, leases, awaiting_me] = await Promise.all([
    readSessions(workspaceRoot, now),
    readBoardLanes(workspaceRoot, topN),
    readLeases(workspaceRoot),
    readAwaitingMe(workspaceRoot, opts.selfAgentId, opts.selfSessionId),
  ]);

  const scope_conflicts = detectConflicts(leases, now);

  return {
    generated_at: new Date(now).toISOString(),
    ...(opts.selfAgentId
      ? { self: { agent_id: opts.selfAgentId, ...(opts.selfSessionId ? { session_id: opts.selfSessionId } : {}) } }
      : {}),
    sessions,
    claimable_top: lanes.claimable_top,
    in_flight_count: lanes.in_flight_count,
    awaiting_review_count: lanes.awaiting_review_count,
    stuck_count: lanes.stuck_count,
    scope_conflicts,
    awaiting_me,
  };
}

/**
 * Write the brief to `.autoclaw/orchestrator/comms/fleet-brief.json` (building
 * it first when not supplied). Returns the path. Best-effort: creates the comms
 * dir if missing.
 */
export async function writeFleetBrief(
  workspaceRoot: string,
  brief?: FleetBrief,
): Promise<string> {
  const b = brief ?? (await buildFleetBrief(workspaceRoot));
  const dest = fleetBriefPath(workspaceRoot);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, JSON.stringify(b, null, 2) + '\n', 'utf8');
  return dest;
}
