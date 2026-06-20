/**
 * trialLogic.test.ts — pure 7-day trial state logic.
 */

import * as assert from 'assert';
import {
  TRIAL_DAYS,
  DAY_MS,
  type TrialState,
  computeTrialStatus,
  startedTrialState,
  consumedIfExpiredState,
  mergeTrialStates,
} from '../licensing/trialLogic';

const T0 = 1_700_000_000_000; // fixed clock (ms)

suite('trialLogic', () => {
  test('a never-started trial is inactive + not started', () => {
    const s: TrialState = { trialConsumed: false };
    const status = computeTrialStatus(s, T0);
    assert.strictEqual(status.started, false);
    assert.strictEqual(status.active, false);
    assert.strictEqual(status.consumed, false);
  });

  test('startedTrialState starts a 7-day window from now', () => {
    const next = startedTrialState({ trialConsumed: false }, T0)!;
    assert.ok(next);
    assert.strictEqual(next.firstMeaningfulUseAt, T0);
    assert.strictEqual(next.trialEndsAt, T0 + TRIAL_DAYS * DAY_MS);
    const status = computeTrialStatus(next, T0);
    assert.strictEqual(status.active, true);
    assert.strictEqual(status.started, true);
    assert.strictEqual(status.daysRemaining, TRIAL_DAYS);
  });

  test('a second start does NOT reset an already-started trial', () => {
    const started = startedTrialState({ trialConsumed: false }, T0)!;
    // One day later, "start" again — must be a no-op (returns null).
    assert.strictEqual(startedTrialState(started, T0 + DAY_MS), null);
  });

  test('a consumed trial never restarts (reinstall resistance)', () => {
    assert.strictEqual(startedTrialState({ trialConsumed: true }, T0), null);
  });

  test('daysRemaining counts down and floors at expiry', () => {
    const started = startedTrialState({ trialConsumed: false }, T0)!;
    assert.strictEqual(computeTrialStatus(started, T0 + DAY_MS).daysRemaining, TRIAL_DAYS - 1);
    // 6.5 days in → 1 day remaining (ceil).
    assert.strictEqual(computeTrialStatus(started, T0 + 6.5 * DAY_MS).daysRemaining, 1);
    const expired = computeTrialStatus(started, T0 + 8 * DAY_MS);
    assert.strictEqual(expired.active, false);
    assert.strictEqual(expired.consumed, true);
    assert.strictEqual(expired.daysRemaining, 0);
  });

  test('mergeTrialStates is reset-resistant: more-restrictive wins', () => {
    const fresh: TrialState = { trialConsumed: false }; // e.g. wiped globalState
    const mirrorConsumed: TrialState = { trialConsumed: true, firstMeaningfulUseAt: T0, trialEndsAt: T0 + TRIAL_DAYS * DAY_MS };
    // Clearing globalState must NOT grant a new trial — the mirror's consumed wins.
    assert.strictEqual(mergeTrialStates(fresh, mirrorConsumed).trialConsumed, true);
    // Earliest start + earliest end win across the two copies.
    const a: TrialState = { trialConsumed: false, firstMeaningfulUseAt: T0 + DAY_MS, trialEndsAt: T0 + 9 * DAY_MS };
    const b: TrialState = { trialConsumed: false, firstMeaningfulUseAt: T0, trialEndsAt: T0 + 7 * DAY_MS };
    const m = mergeTrialStates(a, b);
    assert.strictEqual(m.firstMeaningfulUseAt, T0);
    assert.strictEqual(m.trialEndsAt, T0 + 7 * DAY_MS);
    // consumed is true if EITHER is consumed.
    assert.strictEqual(mergeTrialStates({ trialConsumed: true }, { trialConsumed: false }).trialConsumed, true);
  });

  test('consumedIfExpiredState flips consumed once expired, else no-op', () => {
    const started = startedTrialState({ trialConsumed: false }, T0)!;
    assert.strictEqual(consumedIfExpiredState(started, T0 + DAY_MS), null); // still active
    const consumed = consumedIfExpiredState(started, T0 + 8 * DAY_MS);
    assert.ok(consumed);
    assert.strictEqual(consumed!.trialConsumed, true);
    // Idempotent: already consumed → null.
    assert.strictEqual(consumedIfExpiredState(consumed!, T0 + 9 * DAY_MS), null);
  });
});
