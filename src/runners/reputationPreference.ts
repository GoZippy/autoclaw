/**
 * reputationPreference.ts — BL-7: wire reputation into the live dispatch path.
 *
 * The pieces existed but were never connected: `performance.ts`/`ledger.ts`
 * compute reputation, `RunnerRegistry.getPreferred` HAS a `reputation` criterion
 * that consults `opts.reputationByRunnerId`, and `dispatchViaRegistry` forwards
 * `preference` to it — but NO production caller ever built the reputation map and
 * passed it, so the §5.5 `reputation` step was always a no-op. "Reputation-aware
 * assignment" was advertised but inert.
 *
 * This module closes that gap with two reachable, testable seams:
 *   - `buildReputationPreference` — read the reputation ledger and shape it into
 *     `{ reputationByRunnerId }` (agent ids ARE runner ids).
 *   - `dispatchPreferredByReputation` — dispatch WITHOUT an explicit runner id so
 *     the preference order actually decides, with reputation fed in. This is the
 *     reputation-aware dispatch entry point the system was missing.
 *
 * No fs/vscode coupling beyond the ledger reader; unit-testable against a mock
 * registry + a seeded ledger.
 */

import { readTrackRecord, aggregateReputation, reputationFactor } from '../reputation/ledger';
import { dispatchViaRegistry } from './dispatchViaRegistry';
import type { DispatchViaRegistryOptions, DispatchViaRegistryOutcome } from './dispatchViaRegistry';
import type { PreferenceOptions } from './types';
import type { RunnerRegistry } from './registry';

export interface ReputationPreferenceOptions {
  /** Minimum outcomes before a real score is used (else the neutral prior). */
  minSamples?: number;
}

/**
 * Read the reputation ledger under `workspaceRoot` and build a
 * `{ reputationByRunnerId }` preference fragment. Each agent maps to its bounded
 * reputation multiplier (`reputationFactor`, [0.5,1.0]); an agent with too few
 * samples gets the neutral prior so newcomers are never penalized. Returns `{}`
 * when the ledger is empty — a safe no-op that leaves the default order intact.
 */
export async function buildReputationPreference(
  workspaceRoot: string,
  opts: ReputationPreferenceOptions = {},
): Promise<Pick<PreferenceOptions, 'reputationByRunnerId'>> {
  const records = await readTrackRecord(workspaceRoot);
  if (records.length === 0) { return {}; }
  const agg = aggregateReputation(records);
  const reputationByRunnerId: Record<string, number> = {};
  for (const [agentId, rep] of agg) {
    reputationByRunnerId[agentId] = reputationFactor(rep, undefined, opts.minSamples ?? 3);
  }
  return Object.keys(reputationByRunnerId).length > 0 ? { reputationByRunnerId } : {};
}

/**
 * Dispatch a unit of work to the registry's PREFERRED runner with reputation
 * folded into the §5.5 order — i.e. select by reputation (among workspace/cost/
 * latency), not an explicit id. This is the production caller that finally makes
 * `getPreferred`'s `reputation` criterion live. Returns `null` (no throw) when no
 * runner is selectable, mirroring `dispatchViaRegistry`.
 */
export async function dispatchPreferredByReputation(
  registry: RunnerRegistry,
  opts: Omit<DispatchViaRegistryOptions, 'runnerId'> & {
    workspaceRoot: string;
    reputation?: ReputationPreferenceOptions;
  },
): Promise<DispatchViaRegistryOutcome | null> {
  const { workspaceRoot, reputation, preference, ...rest } = opts;
  const repPref = await buildReputationPreference(workspaceRoot, reputation);
  return dispatchViaRegistry(registry, {
    ...rest,
    // Intentionally NO runnerId — let the preference order (now reputation-aware) decide.
    preference: { ...(preference ?? {}), ...repPref },
  });
}
