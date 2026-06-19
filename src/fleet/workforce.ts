/**
 * workforce.ts — the talent pool + earned résumé (HR-1).
 *
 * A standing, long-running record per worker that outlives any one session or
 * project: which roles it can play, its skills/llms/tools, and a RÉSUMÉ built
 * incrementally from real signals (task_complete, consensus votes,
 * scope_violation, cost) — earned, not self-asserted. This is what lets the
 * org layer recall a proven worker, weight routing by reputation, and report
 * performance up the chain.
 *
 * Pure core (applyOutcome / foldOutcomes) + fs persistence under
 * `~/.autoclaw/workforce/<agent_id>.json`. `now` injectable for tests; no vscode.
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §9.2.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fsp = fs.promises;

/** A worker's standing availability. */
export type WorkerStatus = 'available' | 'engaged' | 'benched' | 'retired';

/** The earned work-history record. */
export interface Resume {
  projects: string[];
  tasks_completed: number;
  tasks_failed: number;
  reviews_passed: number;
  reviews_failed: number;
  scope_violations: number;
  /** Running mean of review scores (0..5); 0 when none recorded. */
  avg_review_score: number;
  /** Count of review scores folded into avg_review_score (for the running mean). */
  reviews_scored: number;
  specialties_proven: string[];
}

/** A standing worker in the talent pool. */
export interface Worker {
  agent_id: string;
  display_name?: string;
  origin_tool?: string;
  roles_can_play: string[];
  skills: string[];
  llms: string[];
  tools: string[];
  /** The template this worker was spawned from, if any (its "DNA"). */
  spun_from_template?: string;
  resume: Resume;
  status: WorkerStatus;
  trust: string;
  created_at: string;
  last_engaged?: string;
}

/** A single performance signal folded into a résumé. */
export type Outcome =
  | { kind: 'task_complete'; project?: string; specialty?: string }
  | { kind: 'task_failed'; project?: string }
  | { kind: 'review_passed'; score?: number }
  | { kind: 'review_failed'; score?: number }
  | { kind: 'scope_violation' };

/** A fresh, empty résumé. */
export function emptyResume(): Resume {
  return {
    projects: [], tasks_completed: 0, tasks_failed: 0,
    reviews_passed: 0, reviews_failed: 0, scope_violations: 0,
    avg_review_score: 0, reviews_scored: 0, specialties_proven: [],
  };
}

/** Pure: apply one outcome to a résumé, returning a NEW résumé. */
export function applyOutcome(resume: Resume, outcome: Outcome): Resume {
  const r: Resume = {
    ...resume,
    projects: [...resume.projects],
    specialties_proven: [...resume.specialties_proven],
  };
  const addProject = (p?: string) => { if (p && !r.projects.includes(p)) { r.projects.push(p); } };
  const foldScore = (score?: number) => {
    if (typeof score === 'number' && Number.isFinite(score)) {
      r.avg_review_score = (r.avg_review_score * r.reviews_scored + score) / (r.reviews_scored + 1);
      r.reviews_scored += 1;
    }
  };
  switch (outcome.kind) {
    case 'task_complete':
      r.tasks_completed += 1; addProject(outcome.project);
      if (outcome.specialty && !r.specialties_proven.includes(outcome.specialty)) {
        r.specialties_proven.push(outcome.specialty);
      }
      break;
    case 'task_failed':
      r.tasks_failed += 1; addProject(outcome.project);
      break;
    case 'review_passed':
      r.reviews_passed += 1; foldScore(outcome.score);
      break;
    case 'review_failed':
      r.reviews_failed += 1; foldScore(outcome.score);
      break;
    case 'scope_violation':
      r.scope_violations += 1;
      break;
  }
  return r;
}

/** Pure: fold many outcomes onto a starting résumé (left-to-right). */
export function foldOutcomes(start: Resume, outcomes: Outcome[]): Resume {
  return outcomes.reduce(applyOutcome, start);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function workforceDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.autoclaw', 'workforce');
}
export function workerPath(agentId: string, homeDir: string = os.homedir()): string {
  return path.join(workforceDir(homeDir), `${agentId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

export async function readWorker(agentId: string, homeDir?: string): Promise<Worker | null> {
  try {
    const raw = await fsp.readFile(workerPath(agentId, homeDir), 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as Worker;
  } catch {
    return null;
  }
}

export async function writeWorker(worker: Worker, homeDir?: string): Promise<string> {
  const file = workerPath(worker.agent_id, homeDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(worker, null, 2) + '\n', 'utf8');
  return file;
}

export async function listWorkers(homeDir?: string): Promise<Worker[]> {
  const dir = workforceDir(homeDir);
  let files: string[];
  try { files = await fsp.readdir(dir); } catch { return []; }
  const out: Worker[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) { continue; }
    try {
      const raw = await fsp.readFile(path.join(dir, f), 'utf8');
      const w = JSON.parse(raw.replace(/^﻿/, '')) as Worker;
      if (w && typeof w.agent_id === 'string') { out.push(w); }
    } catch { /* skip malformed */ }
  }
  return out;
}

export interface UpsertInput {
  agent_id: string;
  display_name?: string;
  origin_tool?: string;
  roles_can_play?: string[];
  skills?: string[];
  llms?: string[];
  tools?: string[];
  spun_from_template?: string;
  trust?: string;
  status?: WorkerStatus;
}

/**
 * Create a worker record if absent, or merge declared fields onto an existing
 * one (the résumé is preserved — it is only changed via recordOutcome).
 */
export async function upsertWorker(input: UpsertInput, opts: { now?: number; homeDir?: string } = {}): Promise<Worker> {
  const now = new Date(opts.now ?? Date.now()).toISOString();
  const existing = await readWorker(input.agent_id, opts.homeDir);
  const worker: Worker = existing
    ? {
        ...existing,
        ...(input.display_name ? { display_name: input.display_name } : {}),
        ...(input.origin_tool ? { origin_tool: input.origin_tool } : {}),
        ...(input.roles_can_play ? { roles_can_play: input.roles_can_play } : {}),
        ...(input.skills ? { skills: input.skills } : {}),
        ...(input.llms ? { llms: input.llms } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.spun_from_template ? { spun_from_template: input.spun_from_template } : {}),
        ...(input.trust ? { trust: input.trust } : {}),
        ...(input.status ? { status: input.status } : {}),
      }
    : {
        agent_id: input.agent_id,
        ...(input.display_name ? { display_name: input.display_name } : {}),
        ...(input.origin_tool ? { origin_tool: input.origin_tool } : {}),
        roles_can_play: input.roles_can_play ?? [],
        skills: input.skills ?? [],
        llms: input.llms ?? [],
        tools: input.tools ?? [],
        ...(input.spun_from_template ? { spun_from_template: input.spun_from_template } : {}),
        resume: emptyResume(),
        status: input.status ?? 'available',
        trust: input.trust ?? 'off',
        created_at: now,
      };
  await writeWorker(worker, opts.homeDir);
  return worker;
}

/**
 * Record a performance outcome against a worker's résumé (read-modify-write).
 * Stamps `last_engaged`. A worker that was `engaged` returns to `available`
 * after a terminal outcome. Creates the worker if absent.
 */
export async function recordOutcome(
  agentId: string,
  outcome: Outcome,
  opts: { now?: number; homeDir?: string } = {},
): Promise<Worker> {
  const now = new Date(opts.now ?? Date.now()).toISOString();
  const worker = (await readWorker(agentId, opts.homeDir)) ?? (await upsertWorker({ agent_id: agentId }, opts));
  worker.resume = applyOutcome(worker.resume, outcome);
  worker.last_engaged = now;
  if (worker.status === 'engaged') { worker.status = 'available'; }
  await writeWorker(worker, opts.homeDir);
  return worker;
}

/** Set a worker's standing status (available/engaged/benched/retired). */
export async function setWorkerStatus(agentId: string, status: WorkerStatus, homeDir?: string): Promise<Worker | null> {
  const worker = await readWorker(agentId, homeDir);
  if (!worker) { return null; }
  worker.status = status;
  await writeWorker(worker, homeDir);
  return worker;
}
