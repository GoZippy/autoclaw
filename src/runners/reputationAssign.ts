/**
 * reputationAssign.ts — BL-7b Part 2: reputation-aware DEFAULT assignment.
 *
 * The orchestrator's `dispatchWork` broadcasts a `task_claim` tagged with
 * `assignToVendor`. When a work package carries NO explicit target
 * (`assignToVendor === 'other'`) the claim is unaddressed — any idle agent may
 * grab it. This module turns that open case into a REPUTATION-RANKED choice:
 * among the capable candidate agents, pick the one with the highest reputation
 * (newcomers get a neutral prior so they are never starved).
 *
 * Explicit, named vendors are NOT routed here — they pass through unchanged.
 * The selection is degrade-safe: an empty candidate set or a ledger read
 * failure returns `null`, and the caller keeps the original 'other' broadcast.
 *
 * `agent ids ARE runner ids` (see reputationPreference.ts), so the same
 * reputation map drives both runner-level (getPreferred) and vendor-level
 * (this module) selection.
 */

import { buildReputationPreference } from './reputationPreference';

/**
 * Neutral reputation prior for a candidate with no ledger record. Matches the
 * mid-point of `reputationFactor`'s [0.5, 1.0] range so a proven-good agent
 * (> prior) beats a newcomer, a proven-poor agent (< prior) loses to one, and
 * two newcomers tie (resolved by candidate order — deterministic).
 */
export const NEUTRAL_REPUTATION_PRIOR = 0.75;

/**
 * Pure reputation ranking: return the highest-reputation candidate.
 *
 * @param candidates  Ordered candidate vendor/runner ids. Order breaks ties
 *                    (stable, deterministic) — the FIRST candidate wins a tie.
 * @param reputationByRunnerId  Map of id → reputation factor (typically [0.5,1]).
 *                    Ids absent from the map are treated as `neutralPrior`.
 * @param neutralPrior  Score for unknown candidates. Defaults to {@link NEUTRAL_REPUTATION_PRIOR}.
 * @returns the winning candidate id, or `null` when `candidates` is empty.
 */
export function selectReputationPreferredVendor(
  candidates: string[],
  reputationByRunnerId: Record<string, number>,
  neutralPrior: number = NEUTRAL_REPUTATION_PRIOR,
): string | null {
  if (candidates.length === 0) {
    return null;
  }
  let best = candidates[0];
  let bestRep = reputationByRunnerId[candidates[0]] ?? neutralPrior;
  for (let i = 1; i < candidates.length; i++) {
    const rep = reputationByRunnerId[candidates[i]] ?? neutralPrior;
    if (rep > bestRep) {
      bestRep = rep;
      best = candidates[i];
    }
  }
  return best;
}

export interface SelectVendorOptions {
  /**
   * Pre-built reputation map. When omitted, the ledger under `workspaceRoot`
   * is read via {@link buildReputationPreference}. Tests inject this so they
   * never touch the real ledger.
   */
  reputationByRunnerId?: Record<string, number>;
  /** Score for candidates with no record. Defaults to {@link NEUTRAL_REPUTATION_PRIOR}. */
  neutralPrior?: number;
}

/**
 * Read the reputation ledger (or use an injected map) and select the
 * highest-reputation candidate. Degrade-safe: a ledger read failure falls back
 * to an empty map, so newcomers compete on the neutral prior rather than the
 * call throwing. Returns `null` for an empty candidate set.
 */
export async function selectPreferredVendorByReputation(
  workspaceRoot: string,
  candidates: string[],
  opts: SelectVendorOptions = {},
): Promise<string | null> {
  if (candidates.length === 0) {
    return null;
  }
  let reputationByRunnerId = opts.reputationByRunnerId;
  if (!reputationByRunnerId) {
    try {
      reputationByRunnerId = (await buildReputationPreference(workspaceRoot)).reputationByRunnerId ?? {};
    } catch {
      reputationByRunnerId = {};
    }
  }
  return selectReputationPreferredVendor(candidates, reputationByRunnerId, opts.neutralPrior);
}
