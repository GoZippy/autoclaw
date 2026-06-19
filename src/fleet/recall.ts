/**
 * recall.ts — recall hooks + standing roster + graceful dismiss (HR-4).
 *
 * Closes the org loop: instead of only waiting for a worker to join, the
 * orchestrator/HR can CALL workers in to fill an establishment ("this project
 * always wants 1 reviewer + 2 coders"). For each vacancy it prefers an
 * available pooled worker (ranked by earned reputation, HR-3) and otherwise
 * hires fresh from the best-fit template (HR-2). Dismiss is the graceful
 * inverse — mark a worker retired but keep its résumé for the record.
 *
 * Pure planning core (vacancies / recallPlan / recallMessage / surplus) + thin
 * fs helpers (planRecallFromDisk / dismiss). No vscode; `now` injectable.
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §9.5.
 */

import {
  listWorkers, setWorkerStatus, type Worker,
} from './workforce';
import {
  listTemplates, bestTemplateForRole, type AgentTemplate,
} from './templates';
import { rankByReputation } from './performance';

/** A project's desired establishment: role → headcount wanted. */
export interface StandingRoster {
  project: string;
  want: Record<string, number>;
}

/** A role the establishment is short on. */
export interface Vacancy {
  role: string;
  /** How many more of this role are wanted than are currently live. */
  need: number;
}

/** One step in a recall plan. */
export type RecallAction =
  | { kind: 'recall'; role: string; agent_id: string; reputation: number }
  | { kind: 'hire'; role: string; template_id: string }
  | { kind: 'gap'; role: string; reason: string };

/**
 * Pure: the vacancies given the roster and the current live count per role.
 * `liveByRole` is normalized case-insensitively. Roles wanted but over-/fully
 * staffed produce no vacancy.
 */
export function vacancies(roster: StandingRoster, liveByRole: Record<string, number>): Vacancy[] {
  const live: Record<string, number> = {};
  for (const [k, v] of Object.entries(liveByRole)) { live[k.toLowerCase()] = v; }
  const out: Vacancy[] = [];
  for (const [role, want] of Object.entries(roster.want)) {
    const have = live[role.toLowerCase()] ?? 0;
    const need = want - have;
    if (need > 0) { out.push({ role, need }); }
  }
  return out.sort((a, b) => a.role.localeCompare(b.role));
}

/**
 * Pure: roles where the establishment is OVER-staffed (candidates to bench when
 * a sprint winds down). The inverse of {@link vacancies}.
 */
export function surplus(roster: StandingRoster, liveByRole: Record<string, number>): Vacancy[] {
  const live: Record<string, number> = {};
  for (const [k, v] of Object.entries(liveByRole)) { live[k.toLowerCase()] = v; }
  const out: Vacancy[] = [];
  for (const [role, want] of Object.entries(roster.want)) {
    const have = live[role.toLowerCase()] ?? 0;
    const over = have - want;
    if (over > 0) { out.push({ role, need: over }); }
  }
  return out.sort((a, b) => a.role.localeCompare(b.role));
}

/**
 * Pure: build a recall plan for the vacancies. For each vacancy, prefer the
 * highest-reputation AVAILABLE pooled workers who can play the role; if the pool
 * runs short, hire fresh from the best-fit template; if no template exists
 * either, emit a `gap`. A pooled worker is assigned at most once across the plan.
 */
export function recallPlan(
  vac: Vacancy[],
  pool: Worker[],
  templates: AgentTemplate[],
): RecallAction[] {
  const actions: RecallAction[] = [];
  const used = new Set<string>();

  for (const v of vac) {
    const ranked = rankByReputation(
      pool.filter(w => w.status === 'available' && !used.has(w.agent_id)),
      { role: v.role },
    );
    let filled = 0;
    for (const r of ranked) {
      if (filled >= v.need) { break; }
      used.add(r.worker.agent_id);
      actions.push({ kind: 'recall', role: v.role, agent_id: r.worker.agent_id, reputation: r.score });
      filled++;
    }
    // Pool exhausted for this role → hire fresh from a template, one per slot.
    if (filled < v.need) {
      const tmpl = bestTemplateForRole(templates, v.role);
      for (; filled < v.need; filled++) {
        if (tmpl) {
          actions.push({ kind: 'hire', role: v.role, template_id: tmpl.template_id });
        } else {
          actions.push({ kind: 'gap', role: v.role, reason: `no available worker and no template for role "${v.role}"` });
        }
      }
    }
  }
  return actions;
}

/**
 * Pure: a `task_assign` recall message (the doorbell that calls a worker in).
 * The bridge/relay/runner layer delivers it; this builds the envelope.
 */
export function recallMessage(
  agentId: string,
  role: string,
  opts: { task_id?: string; project?: string; from?: string; timestamp?: string } = {},
): Record<string, unknown> {
  return {
    from: opts.from ?? 'supervisor',
    to: agentId,
    type: 'task_assign',
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    requires_response: true,
    payload: {
      recall: true,
      role,
      ...(opts.task_id ? { task_id: opts.task_id } : {}),
      ...(opts.project ? { project: opts.project } : {}),
      reason: `Recalled to fill the ${role} establishment on ${opts.project ?? 'this project'}.`,
    },
  };
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

/**
 * Read the talent pool + templates and produce a recall plan for the roster,
 * given the current live count per role.
 */
export async function planRecallFromDisk(
  roster: StandingRoster,
  liveByRole: Record<string, number>,
  homeDir?: string,
): Promise<RecallAction[]> {
  const [pool, templates] = await Promise.all([listWorkers(homeDir), listTemplates(homeDir)]);
  return recallPlan(vacancies(roster, liveByRole), pool, templates);
}

/**
 * Graceful dismiss: mark a worker `retired` (its résumé is kept for the record).
 * Releasing leases / revoking trust is the wiring layer's job; this is the
 * standing-record half. Returns the updated worker or null if unknown.
 */
export async function dismiss(agentId: string, homeDir?: string): Promise<Worker | null> {
  return setWorkerStatus(agentId, 'retired', homeDir);
}
