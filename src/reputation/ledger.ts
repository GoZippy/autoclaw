/**
 * ledger.ts — Per-agent track-record ledger (REP-1, V4_PLAN §P5).
 *
 * Records the outcome of each reviewed task (which agent did it, the consensus
 * verdict, whether the acceptance gate passed, phase, optional duration/cost)
 * to an append-only JSONL log, and aggregates it into a per-agent reputation
 * the router can later prefer (REP-2). The data sources already exist —
 * consensus verdicts (evaluateConsensus), gate results (gate_checks), and
 * durations (metrics) — so this is a join, not new instrumentation.
 *
 * "Prefer agents that succeeded at similar tasks before" — but cold-start safe:
 * a brand-new agent gets a neutral prior, never a penalty (so onboarding is
 * never discouraged). Local-first: the ledger is a file in the comms tree.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TaskPhase, ValidationVerdict } from '../orchestrate';

const fsPromises = fs.promises;

/** Append-only ledger location (workspace-relative). */
export const REPUTATION_DIR_REL = path.join('.autoclaw', 'orchestrator', 'comms', 'reputation');
export const OUTCOMES_FILE = 'outcomes.jsonl';

/** One reviewed-task outcome. Optional fields are recorded when available. */
export interface TaskOutcome {
  task_id: string;
  /** The agent whose work was reviewed (the task's claimant/author). */
  agent_id: string;
  /** Task capability tags, when known at record time (enables per-capability stats). */
  capabilities?: string[];
  phase?: TaskPhase;
  verdict: ValidationVerdict;
  /** Acceptance-gate result: true/false when a gate ran, undefined when none. */
  gate_passed?: boolean;
  duration_ms?: number;
  cost_usd?: number;
  rework_rounds?: number;
  timestamp: string;
}

/**
 * Success = the work was approved AND the acceptance gate did not fail. A red
 * gate is never a success even if the votes approved (the gate is authoritative
 * — votes cannot approve over a red check).
 */
export function isSuccess(o: TaskOutcome): boolean {
  return o.verdict === 'approved' && o.gate_passed !== false;
}

/** Append one outcome to the ledger. Best-effort caller; creates the dir. */
export async function recordTaskOutcome(workspaceRoot: string, outcome: TaskOutcome): Promise<void> {
  const dir = path.join(workspaceRoot, REPUTATION_DIR_REL);
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.appendFile(path.join(dir, OUTCOMES_FILE), JSON.stringify(outcome) + '\n', 'utf8');
}

/** Read the ledger, optionally filtered. Missing/unreadable file ⇒ []. */
export async function readTrackRecord(
  workspaceRoot: string,
  filter?: { agent_id?: string; capability?: string; since?: string }
): Promise<TaskOutcome[]> {
  const file = path.join(workspaceRoot, REPUTATION_DIR_REL, OUTCOMES_FILE);
  let text: string;
  try { text = await fsPromises.readFile(file, 'utf8'); } catch { return []; }
  const out: TaskOutcome[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) { continue; }
    let o: TaskOutcome;
    try { o = JSON.parse(t) as TaskOutcome; } catch { continue; }
    if (filter?.agent_id && o.agent_id !== filter.agent_id) { continue; }
    if (filter?.capability && !(o.capabilities ?? []).includes(filter.capability)) { continue; }
    if (filter?.since && o.timestamp < filter.since) { continue; }
    out.push(o);
  }
  return out;
}

export interface CapabilityRep { samples: number; successes: number; success_rate: number; }

export interface AgentReputation {
  agent_id: string;
  samples: number;
  successes: number;
  success_rate: number;            // successes / samples; 0 when no samples
  avg_duration_ms?: number;
  by_capability: Record<string, CapabilityRep>;
}

/** Aggregate raw outcomes into per-agent reputation (overall + per-capability). */
export function aggregateReputation(records: TaskOutcome[]): Map<string, AgentReputation> {
  const map = new Map<string, AgentReputation>();
  const dur = new Map<string, { sum: number; n: number }>();

  for (const o of records) {
    let rep = map.get(o.agent_id);
    if (!rep) {
      rep = { agent_id: o.agent_id, samples: 0, successes: 0, success_rate: 0, by_capability: {} };
      map.set(o.agent_id, rep);
    }
    rep.samples++;
    const ok = isSuccess(o);
    if (ok) { rep.successes++; }

    for (const cap of o.capabilities ?? []) {
      const c = rep.by_capability[cap] ?? { samples: 0, successes: 0, success_rate: 0 };
      c.samples++;
      if (ok) { c.successes++; }
      rep.by_capability[cap] = c;
    }

    if (typeof o.duration_ms === 'number' && o.duration_ms >= 0) {
      const d = dur.get(o.agent_id) ?? { sum: 0, n: 0 };
      d.sum += o.duration_ms; d.n++;
      dur.set(o.agent_id, d);
    }
  }

  for (const rep of map.values()) {
    rep.success_rate = rep.samples > 0 ? rep.successes / rep.samples : 0;
    for (const c of Object.values(rep.by_capability)) {
      c.success_rate = c.samples > 0 ? c.successes / c.samples : 0;
    }
    const d = dur.get(rep.agent_id);
    if (d && d.n > 0) { rep.avg_duration_ms = d.sum / d.n; }
  }
  return map;
}

/** Convenience: read + aggregate the reputation for a single agent. */
export async function getAgentReputation(
  workspaceRoot: string,
  agentId: string
): Promise<AgentReputation | undefined> {
  const records = await readTrackRecord(workspaceRoot, { agent_id: agentId });
  return aggregateReputation(records).get(agentId);
}

/**
 * Cold-start neutral prior for the reputation multiplier: slight benefit of the
 * doubt (below a proven-perfect agent's 1.0, above a proven-poor one), so a
 * brand-new agent is never penalized but a proven-great agent still edges it out.
 */
export const REPUTATION_NEUTRAL = 0.9;

/**
 * Pure soft multiplier in [0.5, 1.0] for the scorer (REP-2). Returns the
 * neutral prior when there's no agent record or fewer than `minSamples`
 * relevant outcomes (avoids overreacting to one result); otherwise maps
 * success_rate∈[0,1] → [0.5,1.0]. Prefers per-capability history when a
 * `capability` is given and present; falls back to the agent's overall rate.
 */
export function reputationFactor(
  rep: AgentReputation | undefined,
  capability?: string,
  minSamples = 3
): number {
  if (!rep) { return REPUTATION_NEUTRAL; }
  let samples = rep.samples;
  let rate = rep.success_rate;
  if (capability) {
    const c = rep.by_capability[capability];
    if (c && c.samples > 0) { samples = c.samples; rate = c.success_rate; }
  }
  if (samples < minSamples) { return REPUTATION_NEUTRAL; }
  return 0.5 + 0.5 * rate;
}
