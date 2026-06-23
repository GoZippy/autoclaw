/**
 * fleetDigest.ts — FLEET-DIGEST: one small, stable file an agent reads each
 * SYNC instead of re-walking beacons + every inbox + claims + board.json.
 *
 * Today a joining or looping agent must re-derive the whole fleet picture on
 * every cycle: read the registry, walk all heartbeats, scan every inbox + the
 * shared inbox + `_state/`, read the claims directory, and parse `board.json`.
 * FLEET-DIGEST collapses that into a single canonical artifact
 * (`fleet-status.json`) the orchestrator/panel writes once and every agent
 * reads once.
 *
 * Design constraints (so it stays unit-testable like `webview-render.ts`):
 *   - PURE. No `vscode` import, no `fs`, no network, no top-level side effects.
 *   - Deterministic. `buildFleetDigest` takes the timestamp as an ARGUMENT — it
 *     never calls `Date.now()` itself. Same input + same timestamp ⇒ byte-for-byte
 *     identical output.
 *   - DERIVED, not parallel. The digest is computed from the SAME render model the
 *     Fleet panel already builds (`FleetDashboardModel`, optionally carrying the
 *     orchestrator `board` the panel attaches as `{ ...model, board }`). There is
 *     no second data path to drift against.
 *
 * The writer (a later, separate stage) gathers the model exactly as the panel
 * does, calls {@link buildFleetDigest} + {@link serializeFleetDigest}, and writes
 * the result to {@link FLEET_STATUS_REL_PATH}.
 */

import type { FleetDashboardModel } from '../views/fleetViewModel';
import type { BoardModel } from '../orchestrator/board';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Schema version of the digest envelope. Pinned — bump only on a
 * breaking shape change so readers can guard on it.
 */
export const FLEET_DIGEST_SCHEMA_VERSION = 1 as const;

/**
 * Workspace-relative path the digest is written to. A single file an agent
 * reads each SYNC in place of re-walking the whole comms tree.
 */
export const FLEET_STATUS_REL_PATH =
  '.autoclaw/orchestrator/comms/fleet-status.json';

// ---------------------------------------------------------------------------
// Input model
// ---------------------------------------------------------------------------

/**
 * The input {@link buildFleetDigest} consumes: the Fleet panel's render model,
 * optionally extended with the orchestrator `board` the panel attaches before
 * posting to its webview (`{ ...model, board }` in `managerPanel.refresh`).
 *
 * We accept the board as optional so a host with no orchestrator loop still
 * produces a valid (board-empty) digest.
 */
export interface FleetDigestModel extends FleetDashboardModel {
  /** The orchestrator agendaboard, when one was written to `board.json`. */
  board?: BoardModel;
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/** One agent's collapsed status line in the digest. */
export interface FleetDigestAgent {
  id: string;
  /** Coarse health/work state, mirrored from the panel card. */
  status: string;
  /** Role string, mirrored from the panel card. */
  role: string;
  /** Model the agent is currently running, when the model carried one. */
  current_llm?: string;
  /** Tasks this agent has claimed but not finished. */
  inflight: number;
  /** Tasks this agent authored that are now awaiting review (done-but-unmerged). */
  done: number;
}

/** Fleet-wide claims rollup. */
export interface FleetDigestClaims {
  /** Total distinct claimed tasks across the fleet. */
  total: number;
  /** Claimed-task count keyed by claiming agent id (sorted-key object). */
  by_agent: Record<string, number>;
}

/** Board lane counts, mirrored from `board.json`. Zeros when no board. */
export interface FleetDigestLanes {
  claimable: number;
  in_flight: number;
  awaiting_review: number;
  stuck: number;
}

/** The full FLEET-DIGEST envelope written to `fleet-status.json`. */
export interface FleetDigest {
  /** Pinned schema version — readers guard on this. */
  schema_version: typeof FLEET_DIGEST_SCHEMA_VERSION;
  /** ISO timestamp; supplied by the caller, never `Date.now()` here. */
  generated_at: string;
  /** The agent id the source model was rendered "for". */
  self_agent_id: string;
  /** Short, stable fleet-phase label (see {@link deriveCycle}). */
  cycle: string;
  /** Total tracked agents. */
  agent_count: number;
  /** Count of agents in a working state (alive + has a current task). */
  live_count: number;
  /** Messages awaiting the self agent's reply right now. */
  awaiting_you: number;
  agents: FleetDigestAgent[];
  claims: FleetDigestClaims;
  lanes: FleetDigestLanes;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Read an optional `current_llm`/`currentLlm` off a panel card without widening
 * the public card type. The panel's `AgentCard` does not declare a model field
 * today, but the model the writer hands us may carry one (e.g. from the agent's
 * heartbeat). Read it defensively and omit it when absent.
 */
function readCurrentLlm(card: unknown): string | undefined {
  if (!card || typeof card !== 'object') { return undefined; }
  const c = card as Record<string, unknown>;
  const v = c.current_llm ?? c.currentLlm;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Normalize a number|string timestamp to a stable ISO string. */
function toIso(timestamp: number | string): string {
  if (typeof timestamp === 'string') { return timestamp; }
  return new Date(timestamp).toISOString();
}

/**
 * Derive a short, stable fleet-phase label from already-computed counts. Kept
 * coarse on purpose so it doesn't churn on every heartbeat.
 *
 *  - `idle`        — no tracked agents.
 *  - `reviewing`   — at least one review is open.
 *  - `working`     — at least one agent is live and tasks are in flight.
 *  - `waiting`     — agents present but nothing in flight and no reviews.
 */
function deriveCycle(
  agentCount: number,
  inFlight: number,
  awaitingReview: number,
): string {
  if (agentCount === 0) { return 'idle'; }
  if (awaitingReview > 0) { return 'reviewing'; }
  if (inFlight > 0) { return 'working'; }
  return 'waiting';
}

/**
 * Collapse the Fleet panel's render model into a small, stable digest.
 *
 * Pure + deterministic: the caller passes `timestamp` (no `Date.now()` here),
 * so the same `(model, timestamp)` pair always yields the same object.
 *
 * @param model     The panel render model, optionally carrying the orchestrator
 *                  `board` (the same shape `managerPanel.refresh` posts).
 * @param timestamp ISO string or epoch-ms the digest was generated at.
 */
export function buildFleetDigest(
  model: FleetDigestModel,
  timestamp: number | string,
): FleetDigest {
  const cards = model.cards ?? [];
  const board = model.board;

  // Per-agent "done, awaiting review" = reviews this agent authored.
  const doneByAgent = new Map<string, number>();
  for (const r of board?.awaiting_review ?? []) {
    if (!r?.author) { continue; }
    doneByAgent.set(r.author, (doneByAgent.get(r.author) ?? 0) + 1);
  }

  // Claims rollup is derived from the same per-card claimed-task lists the panel
  // already resolved — no separate read of the claims directory.
  const byAgent: Record<string, number> = {};
  let claimsTotal = 0;

  const agents: FleetDigestAgent[] = cards.map(card => {
    const claimed = card.detail?.claimedTasks ?? [];
    const inflight = claimed.length;
    if (inflight > 0) {
      byAgent[card.agentId] = inflight;
      claimsTotal += inflight;
    }
    const currentLlm = readCurrentLlm(card);
    const agent: FleetDigestAgent = {
      id: card.agentId,
      status: card.state,
      role: card.role ?? '',
      inflight,
      done: doneByAgent.get(card.agentId) ?? 0,
    };
    if (currentLlm !== undefined) { agent.current_llm = currentLlm; }
    return agent;
  });
  // Stable order so the serialized digest is deterministic regardless of the
  // model's card ordering.
  agents.sort((a, b) => a.id.localeCompare(b.id));

  const lanes: FleetDigestLanes = {
    claimable: board?.claimable?.length ?? 0,
    in_flight: board?.in_flight?.length ?? 0,
    awaiting_review: board?.awaiting_review?.length ?? 0,
    stuck: board?.stuck?.length ?? 0,
  };

  // Live count: prefer the panel's already-computed presence rollup.
  const liveCount = model.presence?.working ?? 0;

  return {
    schema_version: FLEET_DIGEST_SCHEMA_VERSION,
    generated_at: toIso(timestamp),
    self_agent_id: model.selfAgentId ?? '',
    cycle: deriveCycle(agents.length, lanes.in_flight, lanes.awaiting_review),
    agent_count: agents.length,
    live_count: liveCount,
    awaiting_you: (model.awaitingYou ?? []).length,
    agents,
    claims: { total: claimsTotal, by_agent: sortObjectKeys(byAgent) },
    lanes,
  };
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/** Return a new object whose keys are sorted, for stable JSON output. */
function sortObjectKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(obj).sort()) { out[k] = obj[k]; }
  return out;
}

/**
 * Canonical JSON serialization of a digest: keys sorted recursively, 2-space
 * indent, and a trailing newline. Two structurally-equal digests always
 * serialize to the identical string, so writers can no-op on an unchanged
 * digest and readers can diff cleanly.
 */
export function serializeFleetDigest(digest: FleetDigest): string {
  return JSON.stringify(digest, sortedReplacer, 2) + '\n';
}

/**
 * A `JSON.stringify` replacer that emits object keys in sorted order. Arrays
 * are passed through unchanged (their order is meaningful and already stable).
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) { out[k] = src[k]; }
    return out;
  }
  return value;
}
