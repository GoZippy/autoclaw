/**
 * router.ts — AF-9: capability-aware, score-based task router.
 *
 * `routing.ts` (AF-3) ranks agents by a Jaccard overlap of capability/type
 * tags. That answers "who is the best *kind* of agent" but not "who should
 * take THIS task right now given trust, language, current load, and cost".
 *
 * This module implements the score formula the orchestrate skill promises
 * (skills/orchestrate + DESIGN.md §3 Gap C):
 *
 *   score(agent, task) =
 *       capability_match     // coverage of required caps by effective tags
 *     × language_match       // task language supported?
 *     × trust_score          // trust level, GATED for criticality-1
 *     × idle_factor          // 1 - load/capacity (0 ⇒ busy ⇒ ineligible)
 *     × cost_factor          // cheaper agents score higher
 *     × phase_factor         // plan/review favour trust; grade favours cost
 *
 * The highest eligible score wins. When no agent is eligible the caller is
 * told to fall back to round-robin and a warning is recorded in `notes`
 * (matching the skill's documented contract).
 *
 * Pure + `vscode`-free so it unit-tests in plain Mocha. It deliberately layers
 * ON TOP of `routing.ts` (it reuses the agent-type tag expansion) rather than
 * replacing it — `rankAgentsForCapabilities` stays the answer for type-only
 * routing (e.g. reviewer selection).
 */

import type { TrustLevel } from '../comms';
import type { AgentType, TaskCriticality, TaskPhase } from './routerTypes';
import { agentTypeProfile } from './agentTypes';

/* -------------------------------------------------------------------------- */
/*  Inputs                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The agent shape the router scores. A `RegisteredAgent` (comms.ts) satisfies
 * this structurally; a `capability_offer` payload can be adapted via
 * {@link agentsFromOffers}. Every field except `id` is optional so a sparsely
 * described agent still routes (with a lower, honest score).
 */
export interface SchedulableAgent {
  id: string;
  agent_type?: AgentType;
  capabilities?: string[];
  languages_supported?: string[];
  trust_level?: TrustLevel;
  /** Max tasks this agent runs in parallel (capacity). Defaults to 1. */
  max_parallel_tasks?: number;
  /** Current in-flight task count (from heartbeat queue_depth / active claims). */
  current_load?: number;
  /** Estimated per-task cost in USD (from cost_budget or a capability_offer). */
  estimated_cost_usd?: number;
  /** Explicit availability flag from a capability_offer; absent ⇒ available. */
  available?: boolean;
}

/** The subset of a planned task the router needs. */
export interface SchedulableTask {
  id: string;
  required_capabilities?: string[];
  /** Primary language of the work, matched against `languages_supported`. */
  language?: string;
  /** 1 = CRITICAL (gates low-trust agents), 2 = MAJOR, 3 = ROUTINE. */
  criticality?: TaskCriticality;
  /** plan/review prefer a strong (high-trust) agent; grade prefers a cheap one. */
  phase?: TaskPhase;
}

/* -------------------------------------------------------------------------- */
/*  Outputs                                                                   */
/* -------------------------------------------------------------------------- */

/** The per-factor breakdown for one agent against one task. */
export interface RouteScore {
  agent_id: string;
  /** Composite score; 0 means ineligible. Higher is better. */
  score: number;
  capability_match: number;
  language_match: number;
  trust_score: number;
  idle_factor: number;
  cost_factor: number;
  phase_factor: number;
  eligible: boolean;
  reason: string;
}

/** The routing decision for a task. */
export interface RouteResult {
  task_id: string;
  /** The chosen agent id, or undefined when no agent is eligible. */
  chosen?: string;
  /** Every candidate's score, best first. */
  scores: RouteScore[];
  /** True when the caller should fall back to round-robin (no eligible agent). */
  fallback: boolean;
  /** Human-readable warnings (e.g. why a fallback happened). */
  notes: string[];
}

/* -------------------------------------------------------------------------- */
/*  Scoring primitives                                                        */
/* -------------------------------------------------------------------------- */

/** Trust level → numeric weight (0..1). */
const TRUST_WEIGHT: Record<TrustLevel, number> = {
  untrusted: 0,
  low: 0.4,
  medium: 0.7,
  high: 1,
};

/** Effective capability tags = declared capabilities ∪ agent-type tags. */
function effectiveTags(agent: SchedulableAgent): Set<string> {
  const type = agent.agent_type ?? 'coder';
  return new Set([...(agent.capabilities ?? []), ...agentTypeProfile(type).capabilityTags]);
}

/**
 * Coverage of the task's required capabilities by the agent's effective tags.
 * No requirements ⇒ 1 (any agent qualifies). Otherwise the fraction of
 * required tags the agent covers — so a partial match still scores, but a full
 * match always beats it.
 */
export function capabilityMatch(agent: SchedulableAgent, required: readonly string[] = []): number {
  if (required.length === 0) { return 1; }
  const tags = effectiveTags(agent);
  const covered = required.filter(c => tags.has(c)).length;
  return covered / required.length;
}

/**
 * Language fit. No language required ⇒ 1. Supported ⇒ 1. Unsupported but the
 * agent declared *some* languages ⇒ 0.25 (penalised, not eliminated — an agent
 * may still cope). Agent declared no languages ⇒ 0.6 (unknown, mild penalty).
 */
export function languageMatch(agent: SchedulableAgent, language?: string): number {
  if (!language) { return 1; }
  const langs = agent.languages_supported;
  if (!langs || langs.length === 0) { return 0.6; }
  return langs.includes(language) ? 1 : 0.25;
}

/** Trust weight (0..1). Defaults to `low` when the agent declares none. */
export function trustScore(agent: SchedulableAgent): number {
  return TRUST_WEIGHT[agent.trust_level ?? 'low'];
}

/**
 * Idle factor: 1 - load/capacity, clamped to [0,1]. At/over capacity ⇒ 0 ⇒
 * the agent is busy and therefore ineligible.
 */
export function idleFactor(agent: SchedulableAgent): number {
  const capacity = Math.max(1, agent.max_parallel_tasks ?? 1);
  const load = Math.max(0, agent.current_load ?? 0);
  return Math.max(0, Math.min(1, 1 - load / capacity));
}

/** Cost factor: cheaper is higher. `1/(1+cost)`; unknown cost ⇒ neutral 1. */
export function costFactor(agent: SchedulableAgent): number {
  const cost = agent.estimated_cost_usd;
  if (cost === undefined || cost <= 0) { return 1; }
  return 1 / (1 + cost);
}

/**
 * Phase factor. `plan`/`review` lean on trust (a strong agent), `grade` leans
 * on cost (a cheap agent), `execute`/absent are neutral. Returns a multiplier
 * derived from the already-computed trust and cost factors so the phase only
 * *re-weights* — it never introduces a new dimension.
 */
export function phaseFactor(phase: TaskPhase | undefined, trust: number, cost: number): number {
  switch (phase) {
    case 'plan':
    case 'review':
      return 0.5 + 0.5 * trust;   // up to 1 for high trust, 0.5 floor
    case 'grade':
      return 0.5 + 0.5 * cost;    // favour cheap agents
    default:
      return 1;                    // execute / unspecified
  }
}

/* -------------------------------------------------------------------------- */
/*  Eligibility gate + composite score                                        */
/* -------------------------------------------------------------------------- */

/**
 * Score one agent against one task. An ineligible agent returns `score: 0`
 * with `eligible: false` and a `reason`. Eligibility rules:
 *   - must be available (a capability_offer may set `available: false`),
 *   - must cover at least one required capability (capability_match > 0),
 *   - must have spare capacity (idle_factor > 0),
 *   - criticality-1 tasks require trust ≥ medium (DESIGN.md Gap C trust gate),
 *   - trust weight must be > 0 (untrusted agents never auto-take work).
 */
export function scoreAgent(agent: SchedulableAgent, task: SchedulableTask): RouteScore {
  const capability_match = capabilityMatch(agent, task.required_capabilities);
  const language_match = languageMatch(agent, task.language);
  const trust_score = trustScore(agent);
  const idle_factor = idleFactor(agent);
  const cost_factor = costFactor(agent);
  const phase_factor = phaseFactor(task.phase, trust_score, cost_factor);

  const ineligible = (reason: string): RouteScore => ({
    agent_id: agent.id, score: 0,
    capability_match, language_match, trust_score, idle_factor, cost_factor, phase_factor,
    eligible: false, reason,
  });

  if (agent.available === false) { return ineligible('unavailable (capability_offer.available=false)'); }
  if (capability_match === 0) { return ineligible('no required capability covered'); }
  if (idle_factor === 0) { return ineligible('at or over capacity'); }
  if (trust_score === 0) { return ineligible('untrusted agent'); }
  if (task.criticality === 1 && (agent.trust_level ?? 'low') !== 'high' && (agent.trust_level ?? 'low') !== 'medium') {
    return ineligible('criticality-1 task requires trust >= medium');
  }

  const score = capability_match * language_match * trust_score * idle_factor * cost_factor * phase_factor;
  return {
    agent_id: agent.id, score,
    capability_match, language_match, trust_score, idle_factor, cost_factor, phase_factor,
    eligible: true,
    reason: 'eligible',
  };
}

/**
 * Route a single task to the best-scoring eligible agent.
 *
 * When no agent is eligible, `chosen` is undefined and `fallback` is true with
 * a `notes` warning — the caller should then round-robin (the orchestrate
 * skill's documented behaviour). Stable: equal scores keep input order.
 */
export function routeTask(
  agents: readonly SchedulableAgent[],
  task: SchedulableTask,
): RouteResult {
  const scores = agents
    .map(a => scoreAgent(a, task))
    .sort((a, b) => b.score - a.score);

  const best = scores.find(s => s.eligible && s.score > 0);
  const notes: string[] = [];
  if (!best) {
    notes.push(
      `no eligible agent for task "${task.id}" ` +
      `(required=[${(task.required_capabilities ?? []).join(',')}], ` +
      `criticality=${task.criticality ?? 2}); fall back to round-robin`,
    );
    return { task_id: task.id, scores, fallback: true, notes };
  }
  return { task_id: task.id, chosen: best.agent_id, scores, fallback: false, notes };
}

/**
 * Route many tasks, assigning each to its best agent while respecting
 * capacity: once an agent is chosen its `current_load` is incremented for
 * subsequent tasks in the same pass, so a single strong agent does not absorb
 * every task. Returns one {@link RouteResult} per task, in input order.
 */
export function routeTasks(
  agents: readonly SchedulableAgent[],
  tasks: readonly SchedulableTask[],
): RouteResult[] {
  // Work on a mutable copy of loads so we can reflect in-pass assignments.
  const liveLoad = new Map<string, number>(
    agents.map(a => [a.id, Math.max(0, a.current_load ?? 0)]),
  );
  const results: RouteResult[] = [];
  for (const task of tasks) {
    const snapshot = agents.map(a => ({ ...a, current_load: liveLoad.get(a.id) ?? 0 }));
    const result = routeTask(snapshot, task);
    if (result.chosen) {
      liveLoad.set(result.chosen, (liveLoad.get(result.chosen) ?? 0) + 1);
    }
    results.push(result);
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/*  capability_offer adapter                                                  */
/* -------------------------------------------------------------------------- */

/** The fields the router reads off a `capability_offer` message payload. */
export interface CapabilityOfferPayload {
  agent_id?: string;
  agent_type?: AgentType;
  capabilities?: string[];
  languages_supported?: string[];
  trust_level?: TrustLevel;
  max_parallel_tasks?: number;
  current_load?: number;
  estimated_cost_usd?: number;
  available?: boolean;
}

/**
 * Build {@link SchedulableAgent}s from live `capability_offer` payloads. Offers
 * without an `agent_id` are skipped. The newest offer per agent wins when
 * `offers` is already ordered oldest→newest (the caller passes them in arrival
 * order; later entries overwrite earlier ones).
 */
export function agentsFromOffers(offers: readonly CapabilityOfferPayload[]): SchedulableAgent[] {
  const byId = new Map<string, SchedulableAgent>();
  for (const o of offers) {
    if (!o.agent_id) { continue; }
    byId.set(o.agent_id, {
      id: o.agent_id,
      agent_type: o.agent_type,
      capabilities: o.capabilities,
      languages_supported: o.languages_supported,
      trust_level: o.trust_level,
      max_parallel_tasks: o.max_parallel_tasks,
      current_load: o.current_load,
      estimated_cost_usd: o.estimated_cost_usd,
      available: o.available,
    });
  }
  return [...byId.values()];
}
