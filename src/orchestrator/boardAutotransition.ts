/**
 * boardAutotransition.ts — move tasks across board lanes automatically from
 * observed coordination signals, instead of relying on manual status edits.
 *
 * `boardWriter` already INFERS lane for display, but the persisted
 * `state.json` task status stayed stale (and `state.tasks` is often empty). This
 * reconciles `state.tasks[].status` each tick from live signals:
 *   - a claim   → `in_progress`
 *   - consensus/active (review opened) → `in_review`
 *   - consensus/resolved `approved`    → `merged`
 *
 * Forward-only (never downgrades a lane), never touches `blocked`, and idempotent
 * (re-running with the same signals yields no transitions). The pure
 * {@link computeTaskTransitions} is unit-tested; {@link applyBoardAutoTransition}
 * does the filesystem read-modify-write, best-effort.
 */

import * as path from 'path';
import { promises as fsp } from 'fs';

import { classifyConsensusActive, ConsensusActiveEntry } from './consensusActiveScan';

/** Board lane values (mirrors BoardTask['status'] in board.ts). */
export type BoardStatus = 'open' | 'claimed' | 'in_progress' | 'in_review' | 'merged' | 'done' | 'blocked';

/** Forward-progress rank; higher = further along. `blocked` is sentinel (excluded). */
const RANK: Record<BoardStatus, number> = {
  open: 0, claimed: 1, in_progress: 2, in_review: 3, merged: 4, done: 4, blocked: -1,
};

export interface TaskStatusTransition {
  taskId: string;
  oldStatus?: BoardStatus;
  newStatus: BoardStatus;
  signal: 'dispatch' | 'review_opened' | 'consensus_approved';
  reason: string;
}

export interface AutoTransitionInputs {
  /** Current tasks from state.json (id + optional status). */
  tasks: Array<{ id: string; status?: string }>;
  /** Task ids with an active claim (→ in_progress). */
  claimedTaskIds: Set<string>;
  /** Task ids with a consensus/active review (→ in_review). */
  reviewTaskIds: Set<string>;
  /** Task ids whose consensus resolved `approved` (→ merged). */
  approvedTaskIds: Set<string>;
}

function asStatus(s: string | undefined): BoardStatus | undefined {
  return s && s in RANK ? (s as BoardStatus) : undefined;
}

/**
 * Compute the forward-only status transitions implied by the signals. Considers
 * the union of known tasks + tasks referenced by any signal (so an empty
 * `state.tasks` still gets populated from live work). Never downgrades a lane and
 * never changes a `blocked` task.
 */
export function computeTaskTransitions(inputs: AutoTransitionInputs): TaskStatusTransition[] {
  const current = new Map<string, BoardStatus | undefined>();
  for (const t of inputs.tasks) {
    if (t && typeof t.id === 'string' && t.id) { current.set(t.id, asStatus(t.status)); }
  }
  const allIds = new Set<string>([
    ...current.keys(),
    ...inputs.claimedTaskIds,
    ...inputs.reviewTaskIds,
    ...inputs.approvedTaskIds,
  ]);

  const out: TaskStatusTransition[] = [];
  for (const id of allIds) {
    const cur = current.get(id);
    if (cur === 'blocked') { continue; } // never auto-move a blocked task

    // Highest applicable target wins (approved > review > claim).
    let target: BoardStatus | null = null;
    let signal: TaskStatusTransition['signal'] | null = null;
    let reason = '';
    if (inputs.approvedTaskIds.has(id)) {
      target = 'merged'; signal = 'consensus_approved'; reason = 'consensus approved';
    } else if (inputs.reviewTaskIds.has(id)) {
      target = 'in_review'; signal = 'review_opened'; reason = 'peer review opened';
    } else if (inputs.claimedTaskIds.has(id)) {
      target = 'in_progress'; signal = 'dispatch'; reason = 'claimed by an agent';
    }
    if (target === null) { continue; }

    const curRank = cur ? RANK[cur] : RANK.open;
    if (RANK[target] <= curRank) { continue; } // forward-only + idempotent

    out.push({ taskId: id, oldStatus: cur, newStatus: target, signal: signal!, reason });
  }
  // Deterministic order for stable journals/tests.
  out.sort((a, b) => a.taskId.localeCompare(b.taskId));
  return out;
}

// ---------------------------------------------------------------------------
// IO applier
// ---------------------------------------------------------------------------

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

export interface ApplyResult {
  transitions: TaskStatusTransition[];
}

/**
 * Read live signals + state.json, compute transitions, and persist them to
 * state.json atomically. Best-effort: returns `{ transitions: [] }` on any read
 * failure and never throws. `now` is injectable for deterministic stamping.
 */
export async function applyBoardAutoTransition(
  workspaceRoot: string,
  opts: { nowIso?: string } = {},
): Promise<ApplyResult> {
  const orch = path.join(workspaceRoot, '.autoclaw', 'orchestrator');
  const comms = path.join(orch, 'comms');
  const statePath = path.join(orch, 'state.json');

  // Claims: comms/claims/<task-id>.json — id is the basename.
  const claimFiles = await listJson(path.join(comms, 'claims'));
  const claimedTaskIds = new Set(claimFiles.map((f) => f.replace(/\.json$/, '')));

  // consensus/active: stubs + votes → all referenced task ids are "in review".
  const activeDir = path.join(comms, 'consensus', 'active');
  const activeEntries: ConsensusActiveEntry[] = [];
  for (const f of await listJson(activeDir)) {
    activeEntries.push({ name: f, json: await readJson(path.join(activeDir, f)) });
  }
  const scan = classifyConsensusActive(activeEntries);
  const reviewTaskIds = new Set<string>([...scan.votesByTask.keys(), ...scan.awaitingReview]);

  // consensus/resolved: <task>.json with { task_id, verdict }.
  const resolvedDir = path.join(comms, 'consensus', 'resolved');
  const approvedTaskIds = new Set<string>();
  for (const f of await listJson(resolvedDir)) {
    const rec = await readJson<{ task_id?: string; verdict?: string }>(path.join(resolvedDir, f));
    const tid = typeof rec?.task_id === 'string' && rec.task_id ? rec.task_id : f.replace(/\.json$/, '');
    if (rec?.verdict === 'approved' && tid) { approvedTaskIds.add(tid); }
  }

  const state = (await readJson<{ tasks?: Array<{ id: string; status?: string }>; [k: string]: unknown }>(statePath)) ?? {};
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];

  const transitions = computeTaskTransitions({ tasks, claimedTaskIds, reviewTaskIds, approvedTaskIds });
  if (transitions.length === 0) {
    return { transitions };
  }

  // Apply to state.tasks (create entries for signal-only tasks).
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const tr of transitions) {
    const existing = byId.get(tr.taskId);
    if (existing) { existing.status = tr.newStatus; }
    else { const nt = { id: tr.taskId, status: tr.newStatus }; byId.set(tr.taskId, nt); tasks.push(nt); }
  }
  state.tasks = tasks;
  state.last_updated = opts.nowIso ?? new Date().toISOString();

  // Atomic-ish write (temp + rename; copy fallback for Windows EEXIST).
  const tmp = path.join(orch, `.state-autotrans-${process.pid}.json`);
  try {
    await fsp.mkdir(orch, { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fsp.rename(tmp, statePath).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST' || err.code === 'EPERM') {
        await fsp.copyFile(tmp, statePath);
        await fsp.unlink(tmp).catch(() => undefined);
      } else { throw err; }
    });
  } catch {
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    return { transitions: [] }; // write failed — report nothing applied
  }
  return { transitions };
}
