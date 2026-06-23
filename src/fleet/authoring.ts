/**
 * authoring.ts — UI-driven fleet.json / needs.json authoring (Follow-up #2).
 *
 * The fleet manifest *resolver* (architecture.ts) and the pending-tray *admit*
 * core (pending.ts) both READ + mutate `fleet.json`, but nothing ever AUTHORS a
 * starter manifest from the agents the user already has. Role election
 * (architecture.ts / needs.ts) therefore has nothing to read on a fresh project:
 * `fleet.json` is absent, so every agent resolves to `generalist` and the
 * orchestrator is only guessed from `can_orchestrate`.
 *
 * This module is the authoring floor the panel/commands call to:
 *   - scaffold a starter `fleet.json` from the currently-detected agents,
 *     MERGING with any existing manifest so a user's hand-set roles are never
 *     clobbered (existing entries preserved; only missing agents added),
 *   - upsert a single agent's manifest entry (role / agent_type / reports_to),
 *   - set the manifest `orchestrator`,
 *   - (re)generate `needs.json` so role election + the panel "what's needed"
 *     view have a vector to read.
 *
 * It is pure of `vscode` (fs + path only, via the writers it imports) so it
 * unit-tests in plain Node/Mocha, and it REUSES `pending.ts`
 * (read/writeFleetManifest, fleetPath) and `needs.ts` (gatherNeedsInput,
 * computeNeeds, writeNeeds) rather than re-implementing their persistence.
 *
 * See docs/FLEET_ARCHITECTURE.md and docs/ideas/FLEET-FEDERATION-SELF-HEALING.md.
 */

import * as path from 'path';
import {
  readFleetManifest,
  writeFleetManifest,
  fleetPath,
} from './pending';
import type {
  FleetManifest,
  FleetAgentDecl,
  FleetAgentType,
} from './architecture';
import {
  gatherNeedsInput,
  computeNeeds,
  writeNeeds,
  needsPath,
  type PlannedLane,
  type NeedsVector,
} from './needs';
import {
  normalizeRole,
  resolveAgentRole,
  type CanonicalRole,
} from '../roles';

const SCHEMA_VERSION = '1.0';

/** The fabric worker types a manifest entry's `agent_type` may carry. */
const KNOWN_AGENT_TYPES: ReadonlySet<FleetAgentType> = new Set<FleetAgentType>([
  'coder', 'runner', 'auditor', 'supervisor', 'assistant', 'governance',
]);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * One detected agent the scaffolder seeds an entry from. This is the small,
 * source-agnostic shape the caller adapts the registry / beacon rows into, so
 * this module never depends on `comms.ts` or `beacons.ts` directly. Every field
 * but `id` is an optional hint.
 */
export interface DetectedAgent {
  /** Stable agent id (e.g. `claude-code`, `kilocode`, `hermes`). */
  id: string;
  /** Explicit role string from the registry / beacon, when present. */
  role?: string | null;
  /** Fabric worker taxonomy hint (`agent_type`). */
  agent_type?: string | null;
  /** True when the agent may coordinate others (drives orchestrator pick). */
  can_orchestrate?: boolean;
}

/** Options for {@link scaffoldFleetManifest}. */
export interface ScaffoldOptions {
  /**
   * Agent id to set as the manifest `orchestrator`. When omitted, the existing
   * manifest's orchestrator is kept; if none exists, the first detected agent
   * with `can_orchestrate` is chosen (when autoPickOrchestrator), else unset.
   */
  orchestrator?: string;
  /**
   * When false (default true) the scaffolder does NOT pick an orchestrator
   * automatically — it only honours an explicit `orchestrator` opt or a
   * pre-existing manifest value. Set false to keep the field unset until the
   * user designates one.
   */
  autoPickOrchestrator?: boolean;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Per-agent disposition from a scaffold pass. */
export interface ScaffoldAgentOutcome {
  agent_id: string;
  /** `added` = newly seeded; `preserved` = pre-existing entry left untouched. */
  disposition: 'added' | 'preserved';
  /** The role on the entry after the pass (seeded default or preserved value). */
  role: string;
  /** The agent_type on the entry after the pass, when one is set. */
  agent_type?: string;
}

/** What {@link scaffoldFleetManifest} wrote, for callers + a UI summary. */
export interface ScaffoldResult {
  /** Absolute path of the written `fleet.json`. */
  path: string;
  /** The full manifest after merge + write. */
  manifest: FleetManifest;
  /** Per-agent breakdown of added vs preserved. */
  agents: ScaffoldAgentOutcome[];
  /** Ids of agents newly seeded by this pass. */
  added: string[];
  /** Ids of agents whose existing entries were preserved unchanged. */
  preserved: string[];
  /** The orchestrator after the pass (or null when unset). */
  orchestrator: string | null;
  /** Human one-liner for a toast / log. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate an untrusted agent id. Agent ids land in `fleet.json` keys and feed
 * filename derivation elsewhere, so reject anything that could traverse a path
 * or smuggle separators. Returns the trimmed id.
 */
export function assertValidAgentId(raw: string): string {
  const id = (raw ?? '').trim();
  if (!id) { throw new Error('agentId is required'); }
  // Allow only the safe id alphabet (letters, digits, dot, dash, underscore)
  // and reject path traversal / separators / whitespace. `claude-code` is ok;
  // `../x`, `a/b`, `a b`, `.`, `..` are all rejected.
  if (id === '.' || id === '..'
    || id !== path.basename(id)
    || /[\\/\s]/.test(id)
    || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`invalid agentId "${raw}"`);
  }
  return id;
}

/**
 * Validate a role string against the canonical taxonomy. A canonical role (or a
 * recognised synonym/hint that normalizes to one) is accepted and returned as
 * its display string. The empty string is rejected (callers omit `role` instead
 * of passing ''). Throws on a value that normalizes only to `generalist`
 * WITHOUT being a generalist itself — i.e. an unrecognised label — so the UI
 * can surface "not a known role" rather than silently writing a custom chip.
 */
export function assertValidRole(raw: string): string {
  const s = (raw ?? '').trim();
  if (!s) { throw new Error('role must be a non-empty string'); }
  const canonical = normalizeRole(s);
  // `normalizeRole` maps unknowns to 'generalist'. Treat that as invalid unless
  // the caller literally asked for generalist.
  if (canonical === 'generalist' && s.toLowerCase().replace(/[^a-z]/g, '') !== 'generalist') {
    throw new Error(`unknown role "${raw}" (expected a canonical role or synonym)`);
  }
  return s;
}

/**
 * Coerce an `agent_type` hint to a known fabric type, defaulting unknown /
 * absent hints to `coder` (matching architecture.ts `resolveType`).
 */
function defaultAgentType(hint?: string | null): FleetAgentType {
  const h = (hint ?? '').trim();
  if (h && KNOWN_AGENT_TYPES.has(h as FleetAgentType)) { return h as FleetAgentType; }
  return 'coder';
}

/**
 * Derive a sensible default role for a detected agent: its registry/beacon
 * signal resolved via the canonical taxonomy. Falls back to `generalist`.
 */
function defaultRoleFor(agent: DetectedAgent): CanonicalRole {
  return resolveAgentRole({
    role: agent.role,
    agent_type: agent.agent_type,
    can_orchestrate: agent.can_orchestrate,
  });
}

// ---------------------------------------------------------------------------
// Scaffold (merge)
// ---------------------------------------------------------------------------

/**
 * Scaffold / refresh `fleet.json` from the currently-detected agents.
 *
 * MERGE semantics — the user is authoritative:
 *   - An agent already present in `fleet.json` is PRESERVED verbatim (its
 *     hand-set role / agent_type / reports_to are never touched).
 *   - An agent missing from `fleet.json` is ADDED with a sensible default role
 *     (its resolved canonical role) + agent_type (its fabric type, else coder).
 *   - The orchestrator is set from opts -> existing manifest -> first
 *     can_orchestrate detected agent (when autoPickOrchestrator), else unset.
 *
 * Persists via {@link writeFleetManifest} and returns the written manifest plus
 * an added/preserved summary.
 *
 * @param autoclawDir Absolute path of the workspace `.autoclaw` dir.
 * @param agents      The currently-detected agents to seed entries from.
 */
export async function scaffoldFleetManifest(
  autoclawDir: string,
  agents: readonly DetectedAgent[],
  opts: ScaffoldOptions = {},
): Promise<ScaffoldResult> {
  const existing = await readFleetManifest(autoclawDir);
  const baseAgents: Record<string, FleetAgentDecl> = { ...(existing?.agents ?? {}) };

  const outcomes: ScaffoldAgentOutcome[] = [];
  const added: string[] = [];
  const preserved: string[] = [];

  // De-dupe detected agents by id (a registry + beacon may both report one).
  const seen = new Set<string>();
  for (const a of agents) {
    const id = assertValidAgentId(a.id);
    if (seen.has(id)) { continue; }
    seen.add(id);

    const prior = baseAgents[id];
    if (prior) {
      // Preserve the user's entry untouched.
      preserved.push(id);
      outcomes.push({
        agent_id: id,
        disposition: 'preserved',
        role: prior.role ?? 'generalist',
        ...(prior.agent_type ? { agent_type: prior.agent_type } : {}),
      });
      continue;
    }

    const role = defaultRoleFor(a);
    const agent_type = defaultAgentType(a.agent_type);
    baseAgents[id] = { role, agent_type };
    added.push(id);
    outcomes.push({ agent_id: id, disposition: 'added', role, agent_type });
  }

  // Decide the orchestrator: explicit opt -> existing -> first can_orchestrate.
  const present = new Set(Object.keys(baseAgents));
  let orchestrator: string | undefined = existing?.orchestrator;
  if (opts.orchestrator) {
    orchestrator = assertValidAgentId(opts.orchestrator);
  } else if (!orchestrator && (opts.autoPickOrchestrator ?? true)) {
    const picked = agents.find(a => a.can_orchestrate && present.has(a.id.trim()));
    if (picked) { orchestrator = picked.id.trim(); }
  }
  // Drop a stale orchestrator that isn't actually in the manifest.
  if (orchestrator && !present.has(orchestrator)) { orchestrator = undefined; }

  const manifest: FleetManifest = {
    schema_version: existing?.schema_version ?? SCHEMA_VERSION,
    ...(orchestrator ? { orchestrator } : {}),
    agents: baseAgents,
  };

  const written = await writeFleetManifest(autoclawDir, manifest);

  const parts: string[] = [];
  parts.push(`added ${added.length}`);
  parts.push(`preserved ${preserved.length}`);
  if (orchestrator) { parts.push(`orchestrator=${orchestrator}`); }
  const summary = parts.join(', ');

  return {
    path: written,
    manifest,
    agents: outcomes,
    added,
    preserved,
    orchestrator: orchestrator ?? null,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Single-entry upsert
// ---------------------------------------------------------------------------

/** Fields settable on a single manifest entry via {@link setAgentManifestEntry}. */
export interface ManifestEntryPatch {
  role?: string;
  agent_type?: string;
  reports_to?: string;
}

/**
 * Upsert ONE agent's manifest entry (read-merge-write). Only the supplied
 * fields are changed; any other fields on an existing entry are preserved.
 * `role` is validated against the taxonomy; `reports_to` is validated as an
 * agent id. Returns the full manifest after the write.
 *
 * @param autoclawDir Absolute path of the workspace `.autoclaw` dir.
 * @param agentId     The agent whose entry to set.
 * @param patch       The fields to set (all optional, but at least one is used).
 */
export async function setAgentManifestEntry(
  autoclawDir: string,
  agentId: string,
  patch: ManifestEntryPatch,
): Promise<FleetManifest> {
  const id = assertValidAgentId(agentId);

  const delta: FleetAgentDecl = {};
  if (patch.role !== undefined) { delta.role = assertValidRole(patch.role); }
  if (patch.agent_type !== undefined) {
    const t = patch.agent_type.trim();
    if (t) { delta.agent_type = t; }
  }
  if (patch.reports_to !== undefined) {
    delta.reports_to = assertValidAgentId(patch.reports_to);
  }

  const existing = await readFleetManifest(autoclawDir);
  const base: FleetManifest = existing ?? { schema_version: SCHEMA_VERSION, agents: {} };
  const next: FleetManifest = {
    ...base,
    schema_version: base.schema_version ?? SCHEMA_VERSION,
    agents: {
      ...(base.agents ?? {}),
      [id]: { ...(base.agents?.[id] ?? {}), ...delta },
    },
  };
  await writeFleetManifest(autoclawDir, next);
  return next;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Set the manifest `orchestrator` field (read-merge-write). The id is validated
 * but NOT required to already be in `agents` — the resolver
 * (`resolveOrchestrator`) ignores a manifest orchestrator that isn't present,
 * so a designation made before the agent's entry exists is harmless and becomes
 * effective once that agent is admitted. Returns the manifest after the write.
 */
export async function setManifestOrchestrator(
  autoclawDir: string,
  agentId: string,
): Promise<FleetManifest> {
  const id = assertValidAgentId(agentId);
  const existing = await readFleetManifest(autoclawDir);
  const base: FleetManifest = existing ?? { schema_version: SCHEMA_VERSION, agents: {} };
  const next: FleetManifest = {
    ...base,
    schema_version: base.schema_version ?? SCHEMA_VERSION,
    orchestrator: id,
    agents: { ...(base.agents ?? {}) },
  };
  await writeFleetManifest(autoclawDir, next);
  return next;
}

// ---------------------------------------------------------------------------
// needs.json
// ---------------------------------------------------------------------------

/** Options for {@link generateNeedsFile}. */
export interface GenerateNeedsOptions {
  /** Planned lanes the caller parsed from the sprint YAMLs (injected). */
  plannedLanes?: PlannedLane[];
  /** Injectable clock for deterministic tests. */
  now?: number;
  /** Beacon freshness window override. */
  ttlMs?: number;
}

/** What {@link generateNeedsFile} wrote. */
export interface GenerateNeedsResult {
  /** Absolute path of the written `needs.json`. */
  path: string;
  /** The computed needs vector (with `generated_at` stamped). */
  needs: NeedsVector;
}

/**
 * (Re)generate `needs.json` by REUSING the needs pipeline from needs.ts:
 *   gatherNeedsInput (fs adapter) -> computeNeeds (pure) -> writeNeeds (persist).
 *
 * This adds no needs logic of its own — it is the one-call wrapper the
 * scaffold/authoring command invokes so role election + the panel's
 * "what's needed" view always have a fresh vector to read after the user
 * authors / refreshes the fleet.
 *
 * @param autoclawDir Absolute path of the workspace `.autoclaw` dir.
 */
export async function generateNeedsFile(
  autoclawDir: string,
  opts: GenerateNeedsOptions = {},
): Promise<GenerateNeedsResult> {
  const input = await gatherNeedsInput(autoclawDir, {
    ...(opts.plannedLanes ? { plannedLanes: opts.plannedLanes } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
  const needs = computeNeeds(input);
  const written = await writeNeeds(autoclawDir, needs, {
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  // Mirror the generated_at that writeNeeds stamped into the returned vector.
  return {
    path: written,
    needs: { ...needs, generated_at: new Date(opts.now ?? Date.now()).toISOString() },
  };
}

// Re-export the path helpers callers commonly want alongside these writers.
export { fleetPath, needsPath };
