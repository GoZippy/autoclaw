/**
 * needs.ts — "What the project needs right now" (SA-1).
 *
 * Derives a small needs vector — which roles the backlog wants that the live
 * fleet doesn't currently cover, plus open lanes, staleness pressure, and
 * unclaimed findings — so an arriving agent can self-elect the role the project
 * is short on (role election, SA-2) and the panel can show a "what's needed" view.
 *
 * `computeNeeds` is a pure function over plain objects (fully unit-testable).
 * `gatherNeedsInput` is the thin fs adapter that reads the JSON sources already
 * on disk (board.json, fleet.json, reconcile-report.json, beacons); the plan
 * lanes are injected by the caller, which already parses the sprint YAMLs.
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §4.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readAllBeacons, BEACON_TTL_MS } from './beacons';
import type { FleetManifest } from './architecture';

const fsp = fs.promises;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A planned lane (from a plan-summary YAML, parsed + injected by the caller). */
export interface PlannedLane {
  lane: string;
  /** The role this lane wants filled. */
  role?: string;
  required_capabilities?: string[];
  /** Count of unclaimed, dependency-satisfied tasks in this lane. */
  unclaimed: number;
}

/** A currently-live agent (from heartbeats / beacons). */
export interface LiveAgent {
  agent_id: string;
  role?: string;
  /** True when its presence signal is older than the freshness window. */
  stale?: boolean;
}

/** A claim whose owner has gone stale (recovery pressure). */
export interface StaleClaim {
  task_id: string;
  owner: string;
}

/** Inputs to computeNeeds — everything optional, deny-by-default to empty. */
export interface NeedsInput {
  plannedLanes?: PlannedLane[];
  /** Roles the user's fleet.json declares the team should have. */
  declaredRoles?: string[];
  liveAgents?: LiveAgent[];
  staleClaims?: StaleClaim[];
  /** Count of open/unactioned reconcile findings nobody has picked up. */
  unclaimedFindings?: number;
}

/** The derived needs vector. */
export interface NeedsVector {
  /** Stamped by writeNeeds, not computeNeeds (keeps compute pure/deterministic). */
  generated_at?: string;
  /** Lanes with at least one unclaimed task. */
  open_lanes: PlannedLane[];
  /** Roles the backlog/team wants minus roles covered by a fresh live agent. */
  role_coverage_gap: string[];
  /** Claims whose owner went stale — feeds the self-healing supervisor. */
  staleness_pressure: StaleClaim[];
  /** Open findings count. */
  unclaimed_findings: number;
  /** Human one-liner for the panel narration. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Pure compute
// ---------------------------------------------------------------------------

/**
 * Compute the needs vector. Pure: same inputs → same output (no clock, no fs).
 *
 * role_coverage_gap = (roles wanted by open lanes ∪ roles declared by the user)
 *                     − (roles played by a live agent with a fresh signal)
 */
export function computeNeeds(input: NeedsInput): NeedsVector {
  const plannedLanes = input.plannedLanes ?? [];
  const openLanes = plannedLanes.filter(l => (l.unclaimed ?? 0) > 0);

  const wanted = new Set<string>();
  for (const l of openLanes) {
    if (l.role) { wanted.add(l.role.toLowerCase()); }
  }
  for (const r of input.declaredRoles ?? []) {
    if (r) { wanted.add(r.toLowerCase()); }
  }

  const covered = new Set<string>();
  for (const a of input.liveAgents ?? []) {
    if (!a.stale && a.role) { covered.add(a.role.toLowerCase()); }
  }

  const gap = [...wanted].filter(r => !covered.has(r)).sort();
  const staleness = input.staleClaims ?? [];
  const findings = input.unclaimedFindings ?? 0;

  const parts: string[] = [];
  if (gap.length) { parts.push(`needs ${gap.join(', ')}`); }
  if (openLanes.length) { parts.push(`${openLanes.length} open lane(s)`); }
  if (staleness.length) { parts.push(`${staleness.length} stalled claim(s)`); }
  if (findings) { parts.push(`${findings} open finding(s)`); }
  const summary = parts.length ? parts.join('; ') : 'fully staffed — no open needs';

  return {
    open_lanes: openLanes,
    role_coverage_gap: gap,
    staleness_pressure: staleness,
    unclaimed_findings: findings,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Path to the needs file under an `.autoclaw/` dir. */
export function needsPath(autoclawDir: string): string {
  return path.join(autoclawDir, 'orchestrator', 'needs.json');
}

/** Write the needs vector, stamping `generated_at`. `now` is injectable. */
export async function writeNeeds(
  autoclawDir: string,
  needs: NeedsVector,
  opts: { now?: number } = {},
): Promise<string> {
  const file = needsPath(autoclawDir);
  const stamped: NeedsVector = {
    ...needs,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
  };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(stamped, null, 2) + '\n', 'utf8');
  return file;
}

/** Read the needs vector. Returns null if missing or malformed. */
export async function readNeeds(autoclawDir: string): Promise<NeedsVector | null> {
  try {
    const raw = await fsp.readFile(needsPath(autoclawDir), 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as NeedsVector;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// fs adapter — gather inputs from the JSON sources already on disk
// ---------------------------------------------------------------------------

interface BoardDoc {
  in_flight?: Array<{ task_id?: string; claimed_by?: string; owner_healthy?: boolean }>;
}
interface ReconcileDoc { drifts?: unknown[] }

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}

/**
 * Build a NeedsInput from the on-disk JSON sources. `plannedLanes` is injected
 * by the caller (it already parses the sprint YAMLs); everything else is read
 * here best-effort:
 *   - declaredRoles    ← fleet.json agents[].role
 *   - liveAgents       ← beacons (machine + workspace), staleness from TTL
 *   - staleClaims      ← board.json in_flight where owner_healthy === false
 *   - unclaimedFindings← reconcile-report.json drifts length
 */
export async function gatherNeedsInput(
  autoclawDir: string,
  opts: { plannedLanes?: PlannedLane[]; now?: number; ttlMs?: number } = {},
): Promise<NeedsInput> {
  const orch = path.join(autoclawDir, 'orchestrator');

  const manifest = await readJson<FleetManifest>(path.join(orch, 'fleet.json'));
  const declaredRoles = manifest?.agents
    ? Object.values(manifest.agents).map(a => a?.role).filter((r): r is string => !!r)
    : [];

  const ttlMs = opts.ttlMs ?? BEACON_TTL_MS;
  const beacons = await readAllBeacons({
    commsDir: path.join(orch, 'comms'),
    includeStale: true,
    now: opts.now,
    ttlMs,
  });
  const liveAgents: LiveAgent[] = beacons.map(b => ({
    agent_id: b.agent_id,
    ...(b.role ? { role: b.role } : {}),
    stale: b.stale,
  }));

  const board = await readJson<BoardDoc>(path.join(orch, 'board.json'));
  const staleClaims: StaleClaim[] = (board?.in_flight ?? [])
    .filter(t => t.owner_healthy === false && t.task_id)
    .map(t => ({ task_id: t.task_id as string, owner: t.claimed_by ?? 'unknown' }));

  const reconcile = await readJson<ReconcileDoc>(path.join(orch, 'reconcile-report.json'));
  const unclaimedFindings = Array.isArray(reconcile?.drifts) ? reconcile!.drifts!.length : 0;

  return {
    ...(opts.plannedLanes ? { plannedLanes: opts.plannedLanes } : {}),
    declaredRoles,
    liveAgents,
    staleClaims,
    unclaimedFindings,
  };
}
