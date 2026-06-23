/**
 * taskLedger.ts — a durable, append-only record of completed work.
 *
 * The orchestrator's `board.json` is a *live* snapshot and claim files under
 * `comms/claims/` are DELETED the moment a task completes, so once a task is
 * done there is no on-disk evidence it ever happened. This module adds the
 * missing durable ledger: every `task_complete` appends one JSON line to
 * `.autoclaw/orchestrator/comms/task-ledger.jsonl`, which the panel reads back
 * to populate a "Done" lane and a per-agent completed-work history.
 *
 * Design notes:
 *  - Self-contained: no `vscode` import, no cross-module imports. Pure Node fs +
 *    path, so it is unit-testable without booting the Electron host.
 *  - Append-only JSONL (one object per line). Appending is atomic-enough for a
 *    single-writer-per-line workload and survives concurrent appends from
 *    different processes far better than rewriting a JSON array.
 *  - Tolerant reads: a missing file → `[]`; a malformed line is skipped, never
 *    throws (a half-written tail line must not blank the whole history).
 *  - Cross-platform: every path is built with `path.join`; the comms dir is
 *    created on demand so the first completion in a fresh project still records.
 */
import * as fs from 'fs';
import * as path from 'path';

/** The ledger file name, relative to the comms root. */
export const TASK_LEDGER_FILE = 'task-ledger.jsonl';

/** One durable completed-work record. Mirrors what a `task_complete` carries. */
export interface TaskLedgerEntry {
  /** The task that was completed (e.g. "B1", "T-42"). */
  task_id: string;
  /** The agent that reported the completion. */
  agent_id: string;
  /** The reporting agent's session id, when known. */
  session_id?: string;
  /** ISO-8601 timestamp the completion was recorded. */
  completed_at: string;
  /** Sprint the task belonged to, when known. */
  sprint?: number;
  /** Human-readable task title / summary, when known. */
  title?: string;
  /** Review outcome at record time, when known (e.g. "approved", "pending"). */
  review_status?: string;
  /** Branch the work landed on, when known (carried for drill-down parity). */
  branch?: string;
}

/** A minimal claim shape: only what the rollup needs. Matches `claims/<id>.json`
 *  on disk (`claimed_by` canonical, `agent` legacy) so callers can pass the raw
 *  parsed claim objects straight through. */
export interface LedgerClaim {
  task_id: string;
  claimed_by?: string;
  /** Legacy claim field (cf. comms.readClaimAuthor). */
  agent?: string;
}

/** The slice of `board.json` the rollup reads (assignments in flight / review). */
export interface LedgerBoard {
  in_flight?: Array<{ task_id: string; claimed_by: string }>;
  awaiting_review?: Array<{ task_id: string; author: string }>;
}

/** Per-agent workload + completed-work rollup, shaped for the agent card. */
export interface AgentWorkload {
  agentId: string;
  /** Tasks this agent currently holds (claimed or in-flight, not yet done). */
  assigned: number;
  /** Subset of `assigned` that the board reports as actively in flight. */
  inProgress: number;
  /** All-time completed tasks recorded for this agent in the ledger. */
  doneTotal: number;
  /** Completed today (since local-day midnight relative to `now`). */
  doneToday: number;
  /** Most-recent completions for this agent, newest first (capped by caller). */
  recentCompleted: TaskLedgerEntry[];
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Absolute path to the ledger file for a given comms root. */
export function taskLedgerPath(commsRoot: string): string {
  return path.join(commsRoot, TASK_LEDGER_FILE);
}

/**
 * Append one completion record to the durable ledger.
 *
 * Creates the comms directory if it does not yet exist. A trailing newline is
 * always written so the next append starts on a fresh line — this keeps the
 * file valid JSONL even across many independent appends. Never throws on a
 * missing parent dir; surfaces only genuine I/O failures to the caller (which
 * the extension swallows, as completion recording is best-effort).
 */
export function appendTaskCompletion(commsRoot: string, entry: TaskLedgerEntry): void {
  // Defensive normalize: completed_at must always be present and ISO-ish.
  const record: TaskLedgerEntry = {
    ...entry,
    completed_at: entry.completed_at || new Date().toISOString(),
  };
  fs.mkdirSync(commsRoot, { recursive: true });
  fs.appendFileSync(taskLedgerPath(commsRoot), JSON.stringify(record) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read and parse the ledger, oldest-first (file order).
 *
 * Tolerant by design: a missing file returns `[]`; blank lines and malformed
 * lines (e.g. a partially-flushed tail) are skipped rather than thrown — one
 * bad line must never erase the whole history. A leading UTF-8 BOM is stripped.
 */
export function readTaskLedger(commsRoot: string): TaskLedgerEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(taskLedgerPath(commsRoot), 'utf8');
  } catch {
    return []; // missing file (or unreadable) → empty history
  }
  const out: TaskLedgerEntry[] = [];
  for (const line of raw.replace(/^﻿/, '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    try {
      const obj = JSON.parse(trimmed) as Partial<TaskLedgerEntry>;
      // Require the two load-bearing fields; skip anything else.
      if (typeof obj.task_id === 'string' && typeof obj.agent_id === 'string') {
        out.push({
          ...obj,
          task_id: obj.task_id,
          agent_id: obj.agent_id,
          completed_at: typeof obj.completed_at === 'string' ? obj.completed_at : '',
        });
      }
    } catch {
      // skip a malformed / half-written line
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

/** Resolve the owning agent of a claim, canonical field first then legacy. */
function claimOwner(c: LedgerClaim): string | undefined {
  return c.claimed_by ?? c.agent ?? undefined;
}

/** Local-day key (YYYY-MM-DD) for an ISO timestamp, relative to `now`'s zone.
 *  Returns '' for an unparseable timestamp so it never matches "today". */
function localDayKey(iso: string | undefined, ref: Date): string {
  if (!iso) { return ''; }
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) { return ''; }
  // Compare in the same (local) frame as `ref` so "today" matches the operator's
  // wall clock, not UTC. toDateString() is locale-stable for equality checks.
  return t.toDateString() === ref.toDateString() ? ref.toDateString() : t.toDateString();
}

/**
 * Build a per-agent workload rollup from the durable ledger plus live claims
 * and the board snapshot.
 *
 *  - `assigned`    — distinct tasks the agent holds: live claims it owns ∪ board
 *                    in-flight tasks claimed by it. (Completed tasks are removed
 *                    from claims/board by the orchestrator, so this is "open".)
 *  - `inProgress`  — subset of `assigned` the board reports as `in_flight`.
 *  - `doneTotal`   — ledger entries authored by the agent (all time).
 *  - `doneToday`   — ledger entries whose `completed_at` falls on `now`'s day.
 *  - `recentCompleted` — the agent's completions newest-first, capped to
 *                    `recentLimit` (default 5).
 *
 * Returns a map keyed by agentId. Agents appear if they have *either* open work
 * *or* a completion on record, so an agent that only ever finished work still
 * shows a history.
 */
export function summarizeByAgent(
  ledger: readonly TaskLedgerEntry[],
  claims: readonly LedgerClaim[] = [],
  board: LedgerBoard | null = null,
  opts: { now?: Date; recentLimit?: number } = {}
): Record<string, AgentWorkload> {
  const now = opts.now ?? new Date();
  const recentLimit = opts.recentLimit ?? 5;
  const todayKey = now.toDateString();

  // agentId → { assigned task-ids, in-progress task-ids }
  const assignedByAgent = new Map<string, Set<string>>();
  const inProgressByAgent = new Map<string, Set<string>>();

  const addAssigned = (agentId: string, taskId: string): void => {
    if (!assignedByAgent.has(agentId)) { assignedByAgent.set(agentId, new Set()); }
    assignedByAgent.get(agentId)!.add(taskId);
  };
  const addInProgress = (agentId: string, taskId: string): void => {
    if (!inProgressByAgent.has(agentId)) { inProgressByAgent.set(agentId, new Set()); }
    inProgressByAgent.get(agentId)!.add(taskId);
  };

  // Live claims → assigned.
  for (const c of claims) {
    const owner = claimOwner(c);
    if (owner && c.task_id) { addAssigned(owner, c.task_id); }
  }
  // Board in-flight → assigned + in-progress.
  for (const t of board?.in_flight ?? []) {
    if (t.claimed_by && t.task_id) {
      addAssigned(t.claimed_by, t.task_id);
      addInProgress(t.claimed_by, t.task_id);
    }
  }
  // Board awaiting-review → still "assigned" to its author until merged (the
  // author owns the open review cycle), but not "in progress".
  for (const t of board?.awaiting_review ?? []) {
    if (t.author && t.task_id) { addAssigned(t.author, t.task_id); }
  }

  // Ledger completions grouped per agent, newest first.
  const completionsByAgent = new Map<string, TaskLedgerEntry[]>();
  for (const e of ledger) {
    if (!completionsByAgent.has(e.agent_id)) { completionsByAgent.set(e.agent_id, []); }
    completionsByAgent.get(e.agent_id)!.push(e);
  }
  for (const list of completionsByAgent.values()) {
    list.sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime());
  }

  const out: Record<string, AgentWorkload> = {};
  const allAgents = new Set<string>([
    ...assignedByAgent.keys(),
    ...completionsByAgent.keys(),
  ]);
  for (const agentId of allAgents) {
    const assigned = assignedByAgent.get(agentId) ?? new Set<string>();
    const inProgress = inProgressByAgent.get(agentId) ?? new Set<string>();
    const completions = completionsByAgent.get(agentId) ?? [];
    const doneToday = completions.filter(e => localDayKey(e.completed_at, now) === todayKey).length;
    out[agentId] = {
      agentId,
      assigned: assigned.size,
      inProgress: inProgress.size,
      doneTotal: completions.length,
      doneToday,
      recentCompleted: completions.slice(0, recentLimit),
    };
  }
  return out;
}

/**
 * Flatten the ledger into Done-lane cards, newest first, capped to `limit`.
 * Convenience for the board renderer so it does not re-sort the raw ledger.
 */
export function recentCompletions(
  ledger: readonly TaskLedgerEntry[],
  limit = 30
): TaskLedgerEntry[] {
  return [...ledger]
    .sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())
    .slice(0, limit);
}
