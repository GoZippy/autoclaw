// ZIPPY OPEN MATERIAL
//
// Pure feature-gate decision — NO `vscode` import, so it unit-tests directly.
// GateService is the vscode wrapper that resolves the effective entitlement and
// shows the (single, polite) upgrade prompt; the decision itself lives here.

import type { FeatureDefinition, FeatureId } from './features';
import { type LicenseTier, tierRank } from './license';

/** The slice of the effective entitlement the gate decision needs. */
export interface GateEntitlementInput {
  effectiveTier: LicenseTier;
  reason: 'free' | 'trial' | 'licensed' | 'byo-hosted' | 'expired-license';
  hasByoKey: boolean;
  /** Present once a trial has ever started — distinguishes expired vs never-licensed. */
  trialEndsAt?: number;
}

export type GateReason =
  | 'free'
  | 'trial'
  | 'licensed'
  | 'hosted-byo'
  | 'tier-too-low'
  | 'trial-expired'
  | 'missing-license';

export interface GateDecision {
  allowed: boolean;
  reason: GateReason;
  fallbackFeature?: FeatureId;
}

/** Decide whether `def` is unlocked for the given effective entitlement. */
export function decideGate(
  def: FeatureDefinition,
  eff: GateEntitlementInput,
  options: { allowByoForHosted?: boolean } = {},
): GateDecision {
  if (tierRank(eff.effectiveTier) >= tierRank(def.minimumTier)) {
    const reason: GateReason =
      eff.reason === 'trial' ? 'trial' : eff.reason === 'licensed' ? 'licensed' : 'free';
    return { allowed: true, reason };
  }

  if (def.hostedCost && options.allowByoForHosted && eff.hasByoKey) {
    return { allowed: true, reason: 'hosted-byo' };
  }

  return {
    allowed: false,
    reason: eff.trialEndsAt ? 'trial-expired' : 'missing-license',
    fallbackFeature: def.fallbackFeature,
  };
}
