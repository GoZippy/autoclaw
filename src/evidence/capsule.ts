/**
 * capsule.ts — Evidence capsules: stable run handles for review cycles.
 *
 * Borrowed from openclaw/crabbox's run-handle + failure-capsule pattern
 * (validated 2026-06-13; see docs/IDEAS_LOG.md §N). Crabbox gives every run a
 * stable `run_...` id you can `attach`/`events`/`logs` after completion, and a
 * `capsule from-actions … → replay` bundle that re-runs a failed CI run. We had
 * the *inputs* (ConsensusResult.gate_checks, acceptance commands) but threw the
 * result away after evaluate — the verifier had nothing to re-inspect.
 *
 * An EvidenceCapsule is that durable bundle: a stable run_id, the consensus
 * verdict, the acceptance *recipe* (checks) AND *results* (gate_checks), machine-
 * readable timing, and artifact pointers. A fresh-context verifier (reviewer ≠
 * author) can read a capsule to ground its vote in evidence, and replay just the
 * failed gates without re-running the whole review. Local-first: capsules are
 * files in the comms tree, same as the reputation ledger.
 */

import * as fs from 'fs';
import * as path from 'path';
import { runAcceptanceChecks } from '../orchestrate';
import type {
  AcceptanceCheck,
  GateCheckResult,
  ConsensusResult,
  ValidationVerdict,
} from '../orchestrate';

/** Where a capsule came from. 'consensus' = a review cycle; others = an ingested run. */
export type CapsuleSource = 'consensus' | 'autobuild' | 'ci' | 'manual' | string;

const fsPromises = fs.promises;

/** Capsule store, relative to the comms-tree root — beside `consensus/active`. */
export const RESULTS_SUBDIR = path.join('consensus', 'results');
/** The active-votes dir, relative to the comms-tree root (for artifact pointers). */
export const ACTIVE_SUBDIR = path.join('consensus', 'active');

/** Machine-readable timing, mirroring crabbox's `--timing-json` (ms). */
export interface CapsuleTiming {
  /** Wall-clock to evaluate consensus + run gates, when measured. */
  total_ms?: number;
  /** Sum of acceptance-check durations (from gate_checks). */
  gate_ms?: number;
}

/**
 * A durable, re-inspectable bundle for one review cycle (one consensus
 * evaluation of one task). The `run_id` is the stable handle.
 */
export interface EvidenceCapsule {
  /** Stable handle for this review cycle, e.g. "run-20260613T101500-3f9a1c". */
  run_id: string;
  /** Provenance — 'consensus' for a review cycle, or an ingested-run source. */
  source: CapsuleSource;
  task_id: string;
  sprint: number;

  /** The consensus verdict and counts (the decision). */
  final_verdict: ValidationVerdict;
  status: ConsensusResult['status'];
  rounds: number;
  votes_count: number;
  /** Agents whose self-votes were excluded (verifier independence). */
  excluded_self_review?: string[];

  /** The acceptance *recipe* — enough to replay (crabbox capsule-replay). */
  acceptance_checks?: AcceptanceCheck[];
  /** The acceptance *results* run by the gate (the instrument output). */
  gate_checks?: GateCheckResult[];
  /** True iff a gate ran and every check passed; undefined when no gate ran. */
  gates_passed?: boolean;

  timing?: CapsuleTiming;

  /** Pointers a verifier can follow back to source evidence. */
  artifacts: {
    /** Where this capsule was written, relative to the workspace. */
    capsule_path: string;
    /** Where the per-agent vote files live, relative to the workspace. */
    votes_dir: string;
  };

  /** Task author (excluded from review) and the agent that evaluated. */
  author_agent_id?: string;
  evaluated_by?: string;

  evaluated_at: string;
}

/**
 * Mint a stable, sortable run handle. Compact ISO timestamp + 6 hex of entropy,
 * so two evaluations in the same second don't collide. crabbox-style `run-` prefix.
 */
export function newRunId(now: Date = new Date(), rand: () => number = Math.random): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const suffix = Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0');
  return `run-${ts}-${suffix}`;
}

/** Filename-safe form of a task id (capsules are `<taskId>-<runId>.json`). */
function safeTaskId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Build a capsule from a consensus result (pure — no I/O). Carries both the
 * acceptance recipe (for replay) and the results, plus derived timing.
 */
export function buildCapsule(
  result: ConsensusResult,
  opts: {
    run_id?: string;
    acceptance_checks?: AcceptanceCheck[];
    author_agent_id?: string;
    evaluated_by?: string;
    total_ms?: number;
    votes_dir?: string;
    capsule_path?: string;
    now?: Date;
  } = {}
): EvidenceCapsule {
  const run_id = opts.run_id ?? newRunId(opts.now);
  const gate = result.gate_checks;
  const gate_ms = gate && gate.length > 0
    ? gate.reduce((s, g) => s + (g.duration_ms || 0), 0)
    : undefined;
  const gates_passed = gate && gate.length > 0 ? gate.every(g => g.passed) : undefined;

  const votes_dir = opts.votes_dir ?? ACTIVE_SUBDIR;
  const capsule_path = opts.capsule_path
    ?? path.join(RESULTS_SUBDIR, `${safeTaskId(result.task_id)}-${run_id}.json`);

  return {
    run_id,
    source: 'consensus',
    task_id: result.task_id,
    sprint: result.sprint,
    final_verdict: result.final_verdict,
    status: result.status,
    rounds: result.rounds,
    votes_count: result.votes.length,
    excluded_self_review: result.excluded_self_review,
    acceptance_checks: opts.acceptance_checks,
    gate_checks: gate,
    gates_passed,
    timing: (opts.total_ms !== undefined || gate_ms !== undefined)
      ? { total_ms: opts.total_ms, gate_ms }
      : undefined,
    artifacts: { capsule_path, votes_dir },
    author_agent_id: opts.author_agent_id,
    evaluated_by: opts.evaluated_by,
    evaluated_at: (opts.now ?? new Date()).toISOString(),
  };
}

/**
 * Build a capsule from a raw run that did NOT go through consensus — crabbox's
 * `capsule from-actions` analog. Lets a non-review source (a failed autobuild, an
 * ingested CI log, a manual check) mint a replayable capsule. Pure — no I/O.
 *
 * The verdict defaults from the gate results when not given: a red gate ⇒
 * 'needs_changes', an all-green gate ⇒ 'approved', no gate ⇒ 'abstain'.
 */
export function captureCapsule(input: {
  task_id: string;
  source: CapsuleSource;
  sprint?: number;
  acceptance_checks?: AcceptanceCheck[];
  gate_checks?: GateCheckResult[];
  final_verdict?: ValidationVerdict;
  run_id?: string;
  now?: Date;
}): EvidenceCapsule {
  const run_id = input.run_id ?? newRunId(input.now);
  const gate = input.gate_checks;
  const gate_ms = gate && gate.length > 0 ? gate.reduce((s, g) => s + (g.duration_ms || 0), 0) : undefined;
  const gates_passed = gate && gate.length > 0 ? gate.every(g => g.passed) : undefined;
  const final_verdict = input.final_verdict
    ?? (gates_passed === false ? 'needs_changes' : gates_passed === true ? 'approved' : 'abstain');

  return {
    run_id,
    source: input.source,
    task_id: input.task_id,
    sprint: input.sprint ?? 0,
    final_verdict,
    status: 'consensus_pending', // no consensus was performed
    rounds: 0,
    votes_count: 0,
    acceptance_checks: input.acceptance_checks,
    gate_checks: gate,
    gates_passed,
    timing: gate_ms !== undefined ? { gate_ms } : undefined,
    artifacts: {
      capsule_path: path.join(RESULTS_SUBDIR, `${safeTaskId(input.task_id)}-${run_id}.json`),
      votes_dir: ACTIVE_SUBDIR,
    },
    evaluated_at: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * Run a set of acceptance checks and capture the result as a persisted, replayable
 * capsule (the `from-actions` flow end-to-end). Returns the written capsule — a red
 * result is still captured (that's the point: a durable, replayable failure).
 */
export async function captureFromChecks(
  commsDir: string,
  input: {
    task_id: string;
    source: CapsuleSource;
    checks: AcceptanceCheck[];
    sprint?: number;
    cwd?: string;
    defaultTimeoutSeconds?: number;
    now?: Date;
    exec?: (command: string, o: { cwd?: string; timeoutMs: number }) => Promise<{ exit_code: number; stdout: string }>;
  }
): Promise<EvidenceCapsule> {
  const gate_checks = await runAcceptanceChecks(input.checks, {
    cwd: input.cwd, defaultTimeoutSeconds: input.defaultTimeoutSeconds, exec: input.exec,
  });
  const capsule = captureCapsule({
    task_id: input.task_id,
    source: input.source,
    sprint: input.sprint,
    acceptance_checks: input.checks,
    gate_checks,
    now: input.now,
  });
  await writeCapsule(commsDir, capsule);
  return capsule;
}

/** Persist a capsule atomically (tmp + rename). Best-effort caller; creates the dir. */
export async function writeCapsule(commsDir: string, capsule: EvidenceCapsule): Promise<string> {
  const dir = path.join(commsDir, RESULTS_SUBDIR);
  await fsPromises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeTaskId(capsule.task_id)}-${capsule.run_id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsPromises.writeFile(tmp, JSON.stringify(capsule, null, 2), 'utf8');
  await fsPromises.rename(tmp, file);
  return file;
}

/** Read one capsule by run handle (the `crabbox logs <run-id>` analog). */
export async function readCapsule(
  commsDir: string,
  runId: string,
  taskId?: string
): Promise<EvidenceCapsule | undefined> {
  const dir = path.join(commsDir, RESULTS_SUBDIR);
  let names: string[];
  try { names = await fsPromises.readdir(dir); } catch { return undefined; }
  const wantSuffix = `-${runId}.json`;
  const prefix = taskId ? `${safeTaskId(taskId)}-` : '';
  const match = names.find(n => n.endsWith(wantSuffix) && (!prefix || n.startsWith(prefix)));
  if (!match) { return undefined; }
  try {
    const raw = (await fsPromises.readFile(path.join(dir, match), 'utf8')).replace(/^﻿/, '');
    return JSON.parse(raw) as EvidenceCapsule;
  } catch { return undefined; }
}

/** List capsule handles, newest first, optionally filtered by task (the `events` analog). */
export async function listCapsules(
  commsDir: string,
  taskId?: string
): Promise<EvidenceCapsule[]> {
  const dir = path.join(commsDir, RESULTS_SUBDIR);
  let names: string[];
  try { names = await fsPromises.readdir(dir); } catch { return []; }
  const prefix = taskId ? `${safeTaskId(taskId)}-` : '';
  const out: EvidenceCapsule[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) { continue; }
    if (prefix && !n.startsWith(prefix)) { continue; }
    try {
      const raw = (await fsPromises.readFile(path.join(dir, n), 'utf8')).replace(/^﻿/, '');
      out.push(JSON.parse(raw) as EvidenceCapsule);
    } catch { /* skip malformed */ }
  }
  out.sort((a, b) => (a.evaluated_at < b.evaluated_at ? 1 : a.evaluated_at > b.evaluated_at ? -1 : 0));
  return out;
}

/**
 * Replay the capsule's *failed* acceptance gates without re-running the whole
 * review (crabbox `capsule replay`). Returns fresh GateCheckResults plus whether
 * the replay now passes — lets a verifier confirm a fix landed, or that a red
 * gate is still red, from the durable record alone.
 *
 * Returns undefined when the capsule carried no acceptance recipe (nothing to
 * replay). When no gate had failed, replays nothing and reports passed=true.
 */
export async function replayFailedGates(
  capsule: EvidenceCapsule,
  opts: {
    cwd?: string;
    defaultTimeoutSeconds?: number;
    exec?: (command: string, o: { cwd?: string; timeoutMs: number }) => Promise<{ exit_code: number; stdout: string }>;
  } = {}
): Promise<{ replayed: GateCheckResult[]; passed: boolean } | undefined> {
  if (!capsule.acceptance_checks || capsule.acceptance_checks.length === 0) { return undefined; }
  const failedCommands = new Set(
    (capsule.gate_checks ?? []).filter(g => !g.passed).map(g => g.command)
  );
  const toReplay = failedCommands.size > 0
    ? capsule.acceptance_checks.filter(c => failedCommands.has(c.command))
    : [];
  if (toReplay.length === 0) { return { replayed: [], passed: true }; }
  const replayed = await runAcceptanceChecks(toReplay, opts);
  return { replayed, passed: replayed.every(g => g.passed) };
}

/** One-line human summary of a capsule (for logs / panel). */
export function summarizeCapsule(c: EvidenceCapsule): string {
  const gate = c.gates_passed === undefined ? 'no-gate' : c.gates_passed ? 'gate-pass' : 'GATE-FAIL';
  return `${c.run_id} ${c.task_id} → ${c.final_verdict} [${gate}, ${c.votes_count} votes]`;
}
