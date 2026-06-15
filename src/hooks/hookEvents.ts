/**
 * hookEvents.ts — Trigger-hook event types + pure event-source builders (HKS-5).
 *
 * Leaf module (no heavy imports) so emit sites (bridge consensus, autobuild
 * failure) and the hooks runtime can all share the event shape without import
 * cycles. The builders turn raw fleet state into `HookEvent`s the matcher scores:
 *   - heartbeat_stall — a heartbeat older than the threshold
 *   - claim_stale     — a claim whose owner's heartbeat is stale/absent
 *   - consensus       — the outcome of a consensus evaluation
 *   - autobuild_fail  — a workflow step exited non-zero / timed out
 *
 * All pure + deterministic (callers pass `now`) so firing semantics are fully
 * unit-testable without fs/clock.
 */

export type HookOn = 'message' | 'heartbeat_stall' | 'claim_stale' | 'consensus' | 'autobuild_fail';

export interface HookEvent {
  on: HookOn;
  payload: Record<string, unknown>;
  /**
   * Set when the event was produced by a hook/loop action. Tagged events never
   * match any rule — a hook cannot trigger a hook (spec: no self-amplification).
   */
  via_hook?: string;
}

/** Default staleness floor for heartbeat_stall / claim_stale (seconds). */
export const DEFAULT_STALL_THRESHOLD_SECONDS = 600;

function secondsSince(iso: unknown, now: number): number | undefined {
  if (typeof iso !== 'string') { return undefined; }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) { return undefined; }
  return Math.max(0, Math.round((now - t) / 1000));
}

/** One heartbeat_stall event per heartbeat older than `thresholdSeconds`. */
export function buildHeartbeatStallEvents(
  heartbeats: Array<{ agent_id?: string; timestamp?: string }>,
  now: number,
  thresholdSeconds: number = DEFAULT_STALL_THRESHOLD_SECONDS
): HookEvent[] {
  const out: HookEvent[] = [];
  for (const hb of heartbeats) {
    if (!hb.agent_id) { continue; }
    const stale = secondsSince(hb.timestamp, now);
    if (stale === undefined || stale < thresholdSeconds) { continue; }
    out.push({ on: 'heartbeat_stall', payload: { agent_id: hb.agent_id, seconds_stale: stale } });
  }
  return out;
}

/**
 * One claim_stale event per claim whose owner's heartbeat is stale beyond the
 * threshold (or absent — an unowned-but-held claim). `seconds_stale` is the
 * owner heartbeat's staleness, falling back to the claim's own age when the
 * owner has no heartbeat at all.
 */
export function buildClaimStaleEvents(
  claims: Array<{ task_id?: string; claimed_by?: string; agent_id?: string; claimed_at?: string }>,
  heartbeatByAgent: Map<string, string>,
  now: number,
  thresholdSeconds: number = DEFAULT_STALL_THRESHOLD_SECONDS
): HookEvent[] {
  const out: HookEvent[] = [];
  for (const c of claims) {
    if (!c.task_id) { continue; }
    const owner = c.claimed_by ?? c.agent_id;
    if (!owner) { continue; }
    const ownerHb = heartbeatByAgent.get(owner);
    const stale = ownerHb !== undefined
      ? secondsSince(ownerHb, now)
      : secondsSince(c.claimed_at, now); // no live owner — measure how long the claim has sat
    if (stale === undefined || stale < thresholdSeconds) { continue; }
    out.push({ on: 'claim_stale', payload: { task_id: c.task_id, agent_id: owner, seconds_stale: stale } });
  }
  return out;
}

/** A consensus event from a consensus evaluation result. */
export function buildConsensusEvent(result: {
  task_id: string;
  status?: string;
  final_verdict?: string;
  gate_checks?: Array<{ passed: boolean }>;
  author_agent_id?: string;
}): HookEvent {
  const gate_failed = (result.gate_checks ?? []).some(g => !g.passed);
  return {
    on: 'consensus',
    payload: {
      task_id: result.task_id,
      status: result.status,
      final_verdict: result.final_verdict,
      gate_failed,
      author_agent_id: result.author_agent_id,
    },
  };
}

/** An autobuild_fail event for a failed/timed-out workflow step. */
export function buildAutobuildFailEvent(workflow: string, step: string, exit_code: number | null): HookEvent {
  return { on: 'autobuild_fail', payload: { workflow, step, exit_code } };
}
