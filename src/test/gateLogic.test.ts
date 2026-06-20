/**
 * gateLogic.test.ts — pure feature-gate decision logic.
 */

import * as assert from 'assert';
import { FEATURE_DEFINITIONS } from '../licensing/features';
import { decideGate, type GateEntitlementInput } from '../licensing/gateLogic';

const free: GateEntitlementInput = { effectiveTier: 'free', reason: 'free', hasByoKey: false };
const trial: GateEntitlementInput = { effectiveTier: 'pro', reason: 'trial', hasByoKey: false, trialEndsAt: 1 };
const expiredFree: GateEntitlementInput = { effectiveTier: 'free', reason: 'free', hasByoKey: false, trialEndsAt: 1 };
const proLicensed: GateEntitlementInput = { effectiveTier: 'pro', reason: 'licensed', hasByoKey: false };
const teamsLicensed: GateEntitlementInput = { effectiveTier: 'teams', reason: 'licensed', hasByoKey: false };
const enterpriseLicensed: GateEntitlementInput = { effectiveTier: 'enterprise', reason: 'licensed', hasByoKey: false };

suite('gateLogic — decideGate', () => {
  test('free feature is allowed with no license', () => {
    const d = decideGate(FEATURE_DEFINITIONS['core.doctor'], free);
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(d.reason, 'free');
  });

  test('pro feature is allowed during the trial', () => {
    const d = decideGate(FEATURE_DEFINITIONS['pro.orchestrate.advanced'], trial);
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(d.reason, 'trial');
  });

  test('pro feature denied after trial w/o license → trial-expired + fallback', () => {
    const d = decideGate(FEATURE_DEFINITIONS['pro.orchestrate.advanced'], expiredFree);
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.reason, 'trial-expired');
    assert.strictEqual(d.fallbackFeature, 'core.launchSkill');
  });

  test('pro feature denied with no trial ever → missing-license', () => {
    const d = decideGate(FEATURE_DEFINITIONS['pro.reports.prEvidence'], free);
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.reason, 'missing-license');
    assert.strictEqual(d.fallbackFeature, 'core.reports.basicMarkdown');
  });

  test('pro feature allowed with a pro license', () => {
    const d = decideGate(FEATURE_DEFINITIONS['pro.mateam.launch'], proLicensed);
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(d.reason, 'licensed');
  });

  test('team feature denied with only a pro license', () => {
    const d = decideGate(FEATURE_DEFINITIONS['team.sharedMemory'], proLicensed);
    assert.strictEqual(d.allowed, false);
  });

  test('team feature allowed with a teams license', () => {
    const d = decideGate(FEATURE_DEFINITIONS['team.sharedMemory'], teamsLicensed);
    assert.strictEqual(d.allowed, true);
  });

  test('enterprise feature allowed only with enterprise', () => {
    assert.strictEqual(decideGate(FEATURE_DEFINITIONS['enterprise.sso'], teamsLicensed).allowed, false);
    assert.strictEqual(decideGate(FEATURE_DEFINITIONS['enterprise.sso'], enterpriseLicensed).allowed, true);
  });

  test('hosted feature allowed via BYO key when allowByoForHosted', () => {
    const byo: GateEntitlementInput = { effectiveTier: 'free', reason: 'free', hasByoKey: true };
    const def = FEATURE_DEFINITIONS['team.cloudRelay']; // hostedCost: true
    assert.strictEqual(decideGate(def, byo, { allowByoForHosted: true }).reason, 'hosted-byo');
    // Without the flag, BYO does not satisfy the gate.
    assert.strictEqual(decideGate(def, byo, {}).allowed, false);
  });
});
