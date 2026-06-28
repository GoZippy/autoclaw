/**
 * capabilityRouting.ts — Capability-aware arm of the multi-agent recursive
 * learning loop (extends BL-7 reputation routing).
 *
 * ## Background
 *
 * `reputationPreference.ts` (BL-7) wires the overall reputation ledger into the
 * §5.5 preference order so the "best overall" runner is preferred. That works
 * well when tasks are generic, but the learning loop becomes more valuable when
 * it can say:
 *
 *   "agent A has an 80 % security success rate vs. agent B's 40 % — route this
 *    security task to A, even if their *overall* rates are similar."
 *
 * This module is the capability-specific counterpart: it scopes the reputation
 * lookup to a single capability tag (e.g. `"security"`, `"test"`, `"refactor"`)
 * so the returned `reputationByRunnerId` map reflects each agent's track record
 * for THAT capability only. Under the hood it delegates to
 * `reputationFactor(rep, capability, minSamples)`, which already implements the
 * right fallback: when an agent has no samples for the requested capability it
 * returns the neutral prior (0.9) instead of penalising them — so routing stays
 * useful even when the ledger is young.
 *
 * ### Integration points
 *
 * - Reads the outcomes ledger via `readTrackRecord` / `aggregateReputation`
 *   from `../reputation/ledger` — same source of truth as BL-7.
 * - Passes `reputationByRunnerId` to `RunnerRegistry.getPreferred` via
 *   `dispatchViaRegistry` — same §5.5 preference seam as BL-7.
 * - Callers that already use `dispatchPreferredByReputation` (overall) can
 *   switch to `dispatchPreferredForCapability` (scoped) by adding a
 *   `capability` field; the rest of the dispatch contract is unchanged.
 *
 * ### Cold-start / sparse-ledger safety
 *
 * - Empty ledger → `buildCapabilityReputationPreference` returns `{}`, which is
 *   a safe no-op: `getPreferred` falls through to the next criterion in the
 *   §5.5 order (cost, latency, registration order).
 * - An agent with fewer than `minSamples` (default 3) capability-specific
 *   outcomes receives the neutral prior (0.9) so newcomers are never penalised.
 * - An agent with zero capability-specific outcomes but enough overall outcomes
 *   falls back to their overall `success_rate` via `reputationFactor`'s
 *   documented behaviour (the `c && c.samples > 0` branch does not fire, so
 *   `samples` / `rate` stay on the overall values — but those overall samples
 *   may also be < minSamples, giving the neutral prior; see ledger.ts:196-208).
 *
 * @see src/runners/reputationPreference.ts  — overall-reputation counterpart
 * @see src/reputation/ledger.ts             — `reputationFactor`, `aggregateReputation`
 * @see docs/rfc/runner-bridge-contract.md   — §5.5 preference order
 */

import {
  readTrackRecord,
  aggregateReputation,
  reputationFactor,
} from '../reputation/ledger';
import { dispatchViaRegistry } from './dispatchViaRegistry';
import type { DispatchViaRegistryOptions, DispatchViaRegistryOutcome } from './dispatchViaRegistry';
import type { PreferenceOptions } from './types';
import type { RunnerRegistry } from './registry';

/* -------------------------------------------------------------------------- */
/*  Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface CapabilityRoutingOptions {
  /**
   * Minimum number of capability-specific outcomes before a real score is used
   * (else the neutral prior 0.9 is returned by `reputationFactor`).
   * Defaults to 3, matching the ledger's built-in default.
   */
  minSamples?: number;
}

/* -------------------------------------------------------------------------- */
/*  buildCapabilityReputationPreference                                        */
/* -------------------------------------------------------------------------- */

/**
 * Read the reputation ledger under `workspaceRoot` and build a
 * `{ reputationByRunnerId }` preference fragment scoped to a single
 * `capability` tag (e.g. `"security"`, `"test"`, `"refactor"`).
 *
 * Each agent maps to `reputationFactor(rep, capability, minSamples)`:
 * - Agents with enough capability-specific samples get a score in [0.5, 1.0]
 *   derived from their per-capability success rate.
 * - Agents below `minSamples` (or with no samples for this capability) get the
 *   neutral prior (0.9) so they are never penalised for being new to it.
 *
 * Returns `{}` when the ledger is empty — a safe no-op that leaves the
 * §5.5 default order intact (same contract as `buildReputationPreference`).
 *
 * @param workspaceRoot - absolute path to the workspace root (ledger lives
 *   under `.autoclaw/orchestrator/comms/reputation/` relative to this).
 * @param capability - the capability tag to scope the lookup to.
 * @param opts - optional overrides (e.g. `minSamples`).
 */
export async function buildCapabilityReputationPreference(
  workspaceRoot: string,
  capability: string,
  opts: CapabilityRoutingOptions = {},
): Promise<Pick<PreferenceOptions, 'reputationByRunnerId'>> {
  const records = await readTrackRecord(workspaceRoot);
  if (records.length === 0) {
    return {};
  }

  const agg = aggregateReputation(records);
  const reputationByRunnerId: Record<string, number> = {};
  const minSamples = opts.minSamples ?? 3;

  for (const [agentId, rep] of agg) {
    reputationByRunnerId[agentId] = reputationFactor(rep, capability, minSamples);
  }

  return Object.keys(reputationByRunnerId).length > 0
    ? { reputationByRunnerId }
    : {};
}

/* -------------------------------------------------------------------------- */
/*  dispatchPreferredForCapability                                             */
/* -------------------------------------------------------------------------- */

/**
 * Dispatch a unit of work to the registry's PREFERRED runner with reputation
 * scoped to `capability` folded into the §5.5 order — i.e. select by
 * capability-specific track record (among workspace/cost/latency), not an
 * explicit runner id.
 *
 * This is the capability-specific complement to `dispatchPreferredByReputation`
 * (BL-7): instead of routing to "the generally best agent", it routes to "the
 * agent with the best track record FOR THIS KIND OF TASK".
 *
 * Intentionally omits `runnerId` from the inner `dispatchViaRegistry` call so
 * the `reputation` criterion in `getPreferred`'s §5.5 order makes the
 * selection. Returns `null` (no throw) when no runner can be selected, mirroring
 * `dispatchViaRegistry`.
 *
 * @param registry - the populated `RunnerRegistry`.
 * @param opts - dispatch options extended with `workspaceRoot` and `capability`.
 *   `capability` is the task tag used to scope the ledger lookup (e.g.
 *   `"security"`, `"test"`, `"refactor"`). All other fields are forwarded
 *   unchanged to `dispatchViaRegistry`.
 */
export async function dispatchPreferredForCapability(
  registry: RunnerRegistry,
  opts: Omit<DispatchViaRegistryOptions, 'runnerId'> & {
    workspaceRoot: string;
    capability: string;
    capabilityRouting?: CapabilityRoutingOptions;
  },
): Promise<DispatchViaRegistryOutcome | null> {
  const { workspaceRoot, capability, capabilityRouting, preference, ...rest } = opts;

  const capPref = await buildCapabilityReputationPreference(
    workspaceRoot,
    capability,
    capabilityRouting,
  );

  return dispatchViaRegistry(registry, {
    ...rest,
    // Intentionally NO runnerId — let the capability-scoped reputation preference
    // drive the §5.5 `reputation` criterion in getPreferred().
    preference: { ...(preference ?? {}), ...capPref },
  });
}
