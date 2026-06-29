/**
 * reviewfleet/roster.ts — RF-1: capability scan that produces a ranked
 * reviewer roster.
 *
 * This module scans three source planes:
 *   1. Runner adapters (RunnerRegistry.detect → listActive)
 *   2. Local/LAN LLM providers (LlmRegistry.detect → list)
 *   3. Remote agent beacons (readAllBeacons)
 *
 * It is CONTRACT-INDEPENDENT: it does NOT reference ScaffoldVariant,
 * ScaffoldScore, or any scaffold reward/routing type. Those belong to
 * later RF phases.
 *
 * The injectable `RosterDeps` interface allows fully offline unit-testing —
 * callers supply stubbed scanners that never hit the network. The
 * `defaultRosterDeps` factory wires the REAL RunnerRegistry / LlmRegistry /
 * beacons for production use.
 */

import type { Locality as LlmLocality } from '../llm/types';

/* -------------------------------------------------------------------------- */
/*  Public types                                                               */
/* -------------------------------------------------------------------------- */

export type ReviewerKind = 'runner' | 'model' | 'remote';

/**
 * Locality of the reviewer. Mirrors the LLM type's Locality so callers
 * can use a single enum across both planes.
 */
export type Locality = 'local' | 'lan' | 'cloud';

/** Cost tier: free = local/offline model; cheap = small cheap model; paid = cloud session/API. */
export type CostTier = 'free' | 'cheap' | 'paid';

/**
 * Broad strength signal: 'cheap' = fast/triage (small/local model or unknown
 * remote); 'strong' = suitable for final/authoritative review.
 */
export type Strength = 'cheap' | 'strong';

/** One candidate reviewer for the tiered review router (RF-2+). */
export interface ReviewerCapacity {
  /** Runner id, 'providerId:model', or remote agent_id. */
  id: string;
  kind: ReviewerKind;
  /** Machine or host identifier when known. */
  host?: string;
  locality: Locality;
  /** free = local model (no API cost); cheap = small/cheap model; paid = cloud session. */
  costTier: CostTier;
  /** cheap = triage/fast; strong = final validator. */
  strength: Strength;
  healthy: boolean;
  /** Reputation factor from buildReputationPreference when available [0.5–1.0]. */
  reputation?: number;
  /** Short, content-free descriptor for logging/UI. */
  detail?: string;
}

/* -------------------------------------------------------------------------- */
/*  Injectable scanner deps (enables offline unit-testing)                    */
/* -------------------------------------------------------------------------- */

/** Slim runner descriptor returned by scanRunners. */
export interface RunnerScanRow {
  id: string;
  enabled: boolean;
}

/** Slim LLM provider descriptor returned by scanLocalModels. */
export interface ModelScanRow {
  providerId: string;
  model: string;
  locality: Locality;
}

/** Slim remote agent descriptor returned by scanRemote. */
export interface RemoteScanRow {
  agent_id: string;
  host?: string;
  healthy: boolean;
}

/**
 * Injectable scanner functions. Each scanner may throw — the roster builder
 * wraps every call so a failure contributes nothing to the roster and never
 * propagates to the caller.
 */
export interface RosterDeps {
  /**
   * Return all detected runners with their enabled flag.
   * Typically: RunnerRegistry.detect() → listActive() or list().
   */
  scanRunners: () => Promise<RunnerScanRow[]>;
  /**
   * Return LLM providers and their primary model + locality.
   * Typically: LlmRegistry.detect() then LlmRegistry.list() → map.
   */
  scanLocalModels: () => Promise<ModelScanRow[]>;
  /**
   * Return fresh remote beacons (non-stale, non-LAN-untrusted).
   */
  scanRemote: () => Promise<RemoteScanRow[]>;
  /**
   * Optional: return reputation scores keyed by id (runner id or agent_id).
   * From buildReputationPreference(workspaceRoot).reputationByRunnerId.
   */
  reputationById?: () => Promise<Record<string, number>>;
}

/* -------------------------------------------------------------------------- */
/*  Heuristics                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Runner ids that call a cloud LLM session (not just relay to a local model).
 * These are known to involve a hosted API → costTier='paid', locality='cloud'.
 */
const CLOUD_RUNNER_IDS = new Set([
  'claude-code', 'codex', 'cursor', 'kiro', 'gemini-cli',
]);

/**
 * Infer locality for a runner id. Runners that drive a cloud-hosted agent IDE
 * are 'cloud'; local executors that run on-machine are 'local'.
 */
function runnerLocality(id: string): Locality {
  return CLOUD_RUNNER_IDS.has(id) ? 'cloud' : 'local';
}

/**
 * Infer strength from a model id. Heuristic: large-context or flagship
 * suffixes ('70b', '405b', 'large', 'plus', 'ultra', 'pro', 'max', 'turbo',
 * '32b', 'yi-34b', etc.) suggest 'strong'; everything else is 'cheap' (triage).
 */
function modelStrength(model: string): Strength {
  const m = model.toLowerCase();
  if (
    /\b(70b|72b|34b|32b|405b|671b|large|plus|ultra|pro|max|turbo|instruct-v3|qwen2|mistral-large)\b/.test(m)
  ) {
    return 'strong';
  }
  return 'cheap';
}

/* -------------------------------------------------------------------------- */
/*  buildReviewerRoster                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Scan all three reviewer planes and merge into a deduped ReviewerCapacity
 * roster. Each scanner is wrapped so a throw contributes nothing and never
 * propagates. Dedup is by id (last-write-wins within a plane; plane order:
 * runners → models → remote).
 */
export async function buildReviewerRoster(
  deps: RosterDeps,
): Promise<ReviewerCapacity[]> {
  // Fetch reputation map first (optional — ignored if absent or throws).
  let repMap: Record<string, number> = {};
  if (deps.reputationById) {
    try {
      repMap = await deps.reputationById();
    } catch {
      repMap = {};
    }
  }

  const byId = new Map<string, ReviewerCapacity>();

  // ── Plane 1: runners ────────────────────────────────────────────────────
  let runners: RunnerScanRow[] = [];
  try {
    runners = await deps.scanRunners();
  } catch {
    runners = [];
  }

  for (const r of runners) {
    const loc = runnerLocality(r.id);
    const entry: ReviewerCapacity = {
      id: r.id,
      kind: 'runner',
      locality: loc,
      costTier: loc === 'cloud' ? 'paid' : 'free',
      strength: loc === 'cloud' ? 'strong' : 'cheap',
      healthy: r.enabled,
      detail: `runner:${r.id}`,
    };
    if (repMap[r.id] !== undefined) { entry.reputation = repMap[r.id]; }
    byId.set(r.id, entry);
  }

  // ── Plane 2: local/LAN models ───────────────────────────────────────────
  let models: ModelScanRow[] = [];
  try {
    models = await deps.scanLocalModels();
  } catch {
    models = [];
  }

  for (const m of models) {
    const entryId = `${m.providerId}:${m.model}`;
    const loc: Locality = m.locality; // already typed as Locality
    // LAN box = free (self-hosted), likely a larger model → 'strong'.
    // Local small model → 'cheap'. Cloud-locality model → 'paid'+'strong'.
    let costTier: CostTier;
    let strength: Strength;
    if (loc === 'cloud') {
      costTier = 'paid';
      strength = 'strong';
    } else if (loc === 'lan') {
      costTier = 'free';
      strength = 'strong'; // LAN box assumed to be big
    } else {
      costTier = 'free';
      strength = modelStrength(m.model);
    }
    const entry: ReviewerCapacity = {
      id: entryId,
      kind: 'model',
      locality: loc,
      costTier,
      strength,
      healthy: true, // scanLocalModels only returns detected providers
      detail: `${m.providerId}/${m.model}`,
    };
    if (repMap[entryId] !== undefined) { entry.reputation = repMap[entryId]; }
    byId.set(entryId, entry);
  }

  // ── Plane 3: remote beacons ─────────────────────────────────────────────
  let remotes: RemoteScanRow[] = [];
  try {
    remotes = await deps.scanRemote();
  } catch {
    remotes = [];
  }

  for (const rb of remotes) {
    // Remote agents are on LAN or cloud; without more info, default to 'lan'.
    // Strength unknown for remote → 'cheap' (conservative).
    const entry: ReviewerCapacity = {
      id: rb.agent_id,
      kind: 'remote',
      host: rb.host,
      locality: 'lan',
      costTier: 'free',
      strength: 'cheap',
      healthy: rb.healthy,
      detail: rb.host ? `remote@${rb.host}` : 'remote-agent',
    };
    if (repMap[rb.agent_id] !== undefined) { entry.reputation = repMap[rb.agent_id]; }
    // Only insert if not already present from runners/models (runners win).
    if (!byId.has(rb.agent_id)) {
      byId.set(rb.agent_id, entry);
    }
  }

  return Array.from(byId.values());
}

/* -------------------------------------------------------------------------- */
/*  rankReviewers                                                              */
/* -------------------------------------------------------------------------- */

export interface RankOptions {
  tier: 'tier1-local' | 'tier2-strong';
}

/**
 * Pure ranking function — does not mutate the input array.
 *
 * tier1-local: keep healthy + (locality local or lan) + costTier free or cheap.
 *   Sort: cheaper cost first (free < cheap), then higher reputation first,
 *   then stable (preserve original order for ties).
 *
 * tier2-strong: keep healthy + strength 'strong'.
 *   Sort: higher reputation first, then prefer non-cloud-cost (local/lan
 *   over cloud), then stable.
 */
export function rankReviewers(
  roster: ReviewerCapacity[],
  opts: RankOptions,
): ReviewerCapacity[] {
  const COST_ORDER: Record<CostTier, number> = { free: 0, cheap: 1, paid: 2 };
  const LOC_ORDER: Record<Locality, number> = { local: 0, lan: 1, cloud: 2 };

  if (opts.tier === 'tier1-local') {
    const candidates = roster.filter(
      (r) =>
        r.healthy &&
        (r.locality === 'local' || r.locality === 'lan') &&
        (r.costTier === 'free' || r.costTier === 'cheap'),
    );
    return [...candidates].sort((a, b) => {
      // 1. cheapest cost first
      const costDiff = COST_ORDER[a.costTier] - COST_ORDER[b.costTier];
      if (costDiff !== 0) { return costDiff; }
      // 2. higher reputation first (missing rep = 0 = worst)
      const repA = a.reputation ?? 0;
      const repB = b.reputation ?? 0;
      return repB - repA;
    });
  }

  // tier2-strong
  const candidates = roster.filter((r) => r.healthy && r.strength === 'strong');
  return [...candidates].sort((a, b) => {
    // 1. higher reputation first
    const repA = a.reputation ?? 0;
    const repB = b.reputation ?? 0;
    const repDiff = repB - repA;
    if (repDiff !== 0) { return repDiff; }
    // 2. prefer local/lan over cloud (lower locality order = better)
    return LOC_ORDER[a.locality] - LOC_ORDER[b.locality];
  });
}

/* -------------------------------------------------------------------------- */
/*  defaultRosterDeps — wires REAL scanners for production                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a RosterDeps that wires the real RunnerRegistry, LlmRegistry, beacon
 * reader, and buildReputationPreference. Every scanner is wrapped in try/catch
 * so a failure yields [] — the roster degrades gracefully.
 *
 * @param workspaceRoot - absolute path to the workspace (used for beacons +
 *   reputation ledger). commsDir is derived as
 *   `<workspaceRoot>/.autoclaw/orchestrator/comms`.
 */
export function defaultRosterDeps(workspaceRoot: string): RosterDeps {
  return {
    scanRunners: async () => {
      try {
        const { createDefaultRunnerRegistry } = await import('../runners/defaultRegistry');
        const reg = createDefaultRunnerRegistry({ workingDir: workspaceRoot });
        const results = await reg.detect();
        // detect() returns RegisteredRunner[]; listActive() filters enabled ones.
        return reg.listActive().map((e) => ({ id: e.runner.id, enabled: e.enabled }));
      } catch {
        return [];
      }
    },

    scanLocalModels: async () => {
      try {
        const { LlmRegistry } = await import('../llm/registry');
        const reg = new LlmRegistry({ workspaceRoot });
        await reg.detect();
        return reg.list().map((p) => ({
          providerId: p.id,
          model: p.defaultModel ?? 'auto',
          // LlmProvider.capabilities.locality is typed as 'local'|'lan'|'cloud'
          // (same as our Locality) — direct cast is safe.
          locality: p.capabilities.locality as Locality,
        }));
      } catch {
        return [];
      }
    },

    scanRemote: async () => {
      try {
        const path = await import('path');
        const { readAllBeacons, isDiscoveredUntrusted } = await import('../fleet/beacons');
        const commsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
        const rows = await readAllBeacons({ commsDir });
        return rows
          .filter((r) => !r.stale && !isDiscoveredUntrusted(r))
          .map((r) => ({
            agent_id: r.agent_id,
            host: r.host,
            healthy: !r.stale,
          }));
      } catch {
        return [];
      }
    },

    reputationById: async () => {
      try {
        const { buildReputationPreference } = await import('../runners/reputationPreference');
        const pref = await buildReputationPreference(workspaceRoot);
        return pref.reputationByRunnerId ?? {};
      } catch {
        return {};
      }
    },
  };
}
