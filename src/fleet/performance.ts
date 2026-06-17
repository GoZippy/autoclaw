/**
 * performance.ts — performance roll-up reports + reputation routing (HR-3).
 *
 * The HR layer turns the earned résumé (HR-1, workforce.ts) into two things:
 *
 *  1. A **reputation score** derived purely from a worker's work history —
 *     pass/fail tasks, review outcomes, average review score, and scope
 *     violations — squashed into a bounded, monotonic [0, 1) signal. This is
 *     the number {@link rankByReputation} sorts by, and the number
 *     `RunnerRegistry.getPreferred` would consult so a proven worker is
 *     preferred for the work it's good at and a repeat scope-violator drops in
 *     the order (the wiring into the registry is a follow-up; this module is the
 *     scorer).
 *
 *  2. A **performance roll-up** — per-agent rows, fleet totals, a
 *     human-readable summary, and attention flags — that flows up the chain
 *     (supervisor → director → you), as described in
 *     docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §9.4.
 *
 * Everything here is a pure function over plain objects: no fs, no vscode, no
 * clock, no randomness — same inputs → same output (fully unit-testable). The
 * caller stamps `generated_at` on the report; this module never reads the clock.
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §9.4.
 */

import type { Worker, Resume } from './workforce';

// ---------------------------------------------------------------------------
// Reputation scoring
// ---------------------------------------------------------------------------

/**
 * Derive a worker's reputation from its résumé as a bounded score in [0, 1).
 *
 * The raw merit is a weighted tally of earned signals:
 *
 * ```
 * raw = tasks_completed
 *     + 2   * reviews_passed
 *     -       tasks_failed
 *     - 1.5 * reviews_failed
 *     - 3   * scope_violations
 *     + (avg_review_score - 2.5) * reviews_scored * 0.5   // reward above-average reviews
 * ```
 *
 * Reviews passed are weighted more heavily than raw task completions (a peer
 * vouched for the work); scope violations are penalised hardest (they break the
 * coexistence contract). The `avg_review_score` term is anchored at the 2.5
 * midpoint of the 0..5 scale and scaled by how many scores were folded in, so
 * consistently above-average reviews lift the score and below-average ones drag
 * it down — but only in proportion to how much review evidence exists.
 *
 * The raw merit is then squashed into [0, 1):
 *
 * ```
 * raw <= 0 ? 0 : raw / (raw + 5)
 * ```
 *
 * This is monotonic (more merit → higher score) and asymptotic to 1 (never
 * reaches it). A spotless newcomer — every counter zero — scores exactly 0:
 * unproven, NOT negative. A worker whose penalties outweigh its credits also
 * floors at 0; reputation never goes below zero.
 */
export function reputationScore(worker: Worker): number {
  const r: Resume = worker.resume;
  const raw =
    r.tasks_completed +
    2 * r.reviews_passed -
    r.tasks_failed -
    1.5 * r.reviews_failed -
    3 * r.scope_violations +
    (r.avg_review_score - 2.5) * r.reviews_scored * 0.5;

  if (raw <= 0) { return 0; }
  return raw / (raw + 5);
}

// ---------------------------------------------------------------------------
// Reputation ranking (what getPreferred would consult)
// ---------------------------------------------------------------------------

/** A worker paired with its computed reputation score. */
export interface RankedWorker {
  worker: Worker;
  score: number;
}

/**
 * Rank workers by reputation, highest first. When `opts.role` is given, only
 * workers whose `roles_can_play` includes that role (case-insensitive) are kept
 * — so the caller can ask "rank everyone who can review" and get the proven
 * reviewers on top.
 *
 * Ties (equal scores) break deterministically by `agent_id` ascending. This is
 * the ordering `RunnerRegistry.getPreferred` would consult to prefer proven
 * workers and let repeat violators sink (registry wiring is a follow-up).
 */
export function rankByReputation(workers: Worker[], opts: { role?: string } = {}): RankedWorker[] {
  const role = opts.role?.toLowerCase();
  const pool = role
    ? workers.filter(w => (w.roles_can_play ?? []).some(r => r.toLowerCase() === role))
    : workers;

  return pool
    .map(worker => ({ worker, score: reputationScore(worker) }))
    .sort((a, b) =>
      b.score - a.score || a.worker.agent_id.localeCompare(b.worker.agent_id),
    );
}

/**
 * Build a `{ agent_id → reputation }` map from the talent pool, shaped for
 * `RunnerRegistry.getPreferred({ reputationByRunnerId })` (HRW-2). Runner ids
 * match agent ids (e.g. `claude-code`, `kilocode`, `hermes`), so this is a
 * direct feed: higher reputation → preferred runner.
 */
export function reputationMapFromWorkers(workers: Worker[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const w of workers) { map[w.agent_id] = reputationScore(w); }
  return map;
}

// ---------------------------------------------------------------------------
// Performance roll-up
// ---------------------------------------------------------------------------

/** One agent's row in a performance report. */
export interface AgentPerfRow {
  agent_id: string;
  tasks_completed: number;
  tasks_failed: number;
  reviews_passed: number;
  reviews_failed: number;
  scope_violations: number;
  avg_review_score: number;
  reputation: number;
  status: string;
}

/** A roll-up performance report for a fleet of workers. */
export interface PerformanceReport {
  /** Stamped by the caller, NOT here (compute stays pure/deterministic). */
  generated_at?: string;
  fleet: {
    workers: number;
    tasks_completed: number;
    tasks_failed: number;
    scope_violations: number;
  };
  /** Per-agent rows, sorted by reputation desc (tie-break agent_id asc). */
  agents: AgentPerfRow[];
  /** Human-readable roll-up: a header line plus one line per agent. */
  lines: string[];
  /** Attention items, e.g. "kilo: 2 scope violations", "x: 3 failed tasks". */
  flags: string[];
}

/** Round a reputation/score to 2 decimals for stable, readable output. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Roll a fleet of workers up into a performance report (§9.4): per-agent rows
 * with reputation (via {@link reputationScore}), fleet totals, a human-readable
 * `lines` summary (a header line + one line per agent, e.g.
 * "hermes: 6 done, 1 failed, rep 0.62"), and `flags` for attention items —
 * any scope violation (>= 1) and high failure (tasks_failed >= 2).
 *
 * Deterministic: agents are sorted by reputation desc (tie-break agent_id asc),
 * and so are the flags. No clock, no fs — the caller stamps `generated_at`.
 */
export function rollUp(workers: Worker[]): PerformanceReport {
  const ranked = rankByReputation(workers);

  const agents: AgentPerfRow[] = ranked.map(({ worker, score }) => {
    const r = worker.resume;
    return {
      agent_id: worker.agent_id,
      tasks_completed: r.tasks_completed,
      tasks_failed: r.tasks_failed,
      reviews_passed: r.reviews_passed,
      reviews_failed: r.reviews_failed,
      scope_violations: r.scope_violations,
      avg_review_score: round2(r.avg_review_score),
      reputation: round2(score),
      status: worker.status,
    };
  });

  const fleet = {
    workers: agents.length,
    tasks_completed: agents.reduce((s, a) => s + a.tasks_completed, 0),
    tasks_failed: agents.reduce((s, a) => s + a.tasks_failed, 0),
    scope_violations: agents.reduce((s, a) => s + a.scope_violations, 0),
  };

  const header =
    `Fleet: ${fleet.workers} worker(s), ${fleet.tasks_completed} task(s) done, ` +
    `${fleet.tasks_failed} failed, ${fleet.scope_violations} scope violation(s)`;
  const lines = [
    header,
    ...agents.map(a =>
      `${a.agent_id}: ${a.tasks_completed} done, ${a.tasks_failed} failed, rep ${a.reputation.toFixed(2)}`,
    ),
  ];

  const flags: string[] = [];
  for (const a of agents) {
    if (a.scope_violations >= 1) {
      flags.push(`${a.agent_id}: ${a.scope_violations} scope violation(s)`);
    }
    if (a.tasks_failed >= 2) {
      flags.push(`${a.agent_id}: ${a.tasks_failed} failed task(s)`);
    }
  }

  return { fleet, agents, lines, flags };
}
