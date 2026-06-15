/**
 * support.test.ts — pure scheduling logic for the non-invasive support prompts.
 */

import * as assert from 'assert';
import {
  defaultState,
  epochDay,
  recordActiveDay,
  milestonesUpTo,
  dueMilestone,
  askKindFor,
  SupportState,
} from '../support/schedule';

function withDays(activeDays: number, over: Partial<SupportState> = {}): SupportState {
  return { ...defaultState(), activeDays, ...over };
}

suite('support: active-day counting', () => {
  test('epochDay floors ms to UTC day', () => {
    assert.strictEqual(epochDay(0), 0);
    assert.strictEqual(epochDay(86_400_000), 1);
    assert.strictEqual(epochDay(86_400_000 + 5), 1);
    assert.strictEqual(epochDay(86_400_000 * 100 + 12_345), 100);
  });

  test('first activity sets firstUseDay and increments to 1', () => {
    const s = recordActiveDay(defaultState(), 1000);
    assert.strictEqual(s.activeDays, 1);
    assert.strictEqual(s.firstUseDay, 1000);
    assert.strictEqual(s.lastActiveDay, 1000);
  });

  test('same day is idempotent (no double count, same object)', () => {
    const s1 = recordActiveDay(defaultState(), 1000);
    const s2 = recordActiveDay(s1, 1000);
    assert.strictEqual(s2.activeDays, 1);
    assert.strictEqual(s2, s1);
  });

  test('a new day increments the count', () => {
    let s = recordActiveDay(defaultState(), 1000);
    s = recordActiveDay(s, 1001);
    s = recordActiveDay(s, 1002);
    assert.strictEqual(s.activeDays, 3);
    assert.strictEqual(s.firstUseDay, 1000);
    assert.strictEqual(s.lastActiveDay, 1002);
  });
});

suite('support: milestones', () => {
  test('none before day 15', () => {
    assert.deepStrictEqual(milestonesUpTo(0), []);
    assert.deepStrictEqual(milestonesUpTo(14), []);
  });

  test('15, 30, then every 90', () => {
    assert.deepStrictEqual(milestonesUpTo(15), [15]);
    assert.deepStrictEqual(milestonesUpTo(29), [15]);
    assert.deepStrictEqual(milestonesUpTo(30), [15, 30]);
    assert.deepStrictEqual(milestonesUpTo(89), [15, 30]);
    assert.deepStrictEqual(milestonesUpTo(90), [15, 30, 90]);
    assert.deepStrictEqual(milestonesUpTo(180), [15, 30, 90, 180]);
    assert.deepStrictEqual(milestonesUpTo(275), [15, 30, 90, 180, 270]);
  });
});

suite('support: dueMilestone', () => {
  test('nothing due before day 15', () => {
    assert.strictEqual(dueMilestone(withDays(14)), null);
  });

  test('day 15 is due when never prompted', () => {
    assert.strictEqual(dueMilestone(withDays(15)), 15);
  });

  test('after prompting at 15, nothing due until 30', () => {
    assert.strictEqual(dueMilestone(withDays(20, { lastPromptAtActiveDay: 15 })), null);
    assert.strictEqual(dueMilestone(withDays(30, { lastPromptAtActiveDay: 15 })), 30);
  });

  test('returns the highest un-prompted milestone (no spamming each one)', () => {
    // User crossed 15, 30, 90 without a prompt firing — only the latest is due.
    assert.strictEqual(dueMilestone(withDays(95)), 90);
  });

  test('every-90 cadence keeps firing', () => {
    assert.strictEqual(dueMilestone(withDays(180, { lastPromptAtActiveDay: 90 })), 180);
    assert.strictEqual(dueMilestone(withDays(270, { lastPromptAtActiveDay: 180 })), 270);
  });

  test('dismissedForever silences everything', () => {
    assert.strictEqual(dueMilestone(withDays(360, { dismissedForever: true })), null);
  });
});

suite('support: askKindFor', () => {
  test('early milestones lead with a review ask', () => {
    assert.strictEqual(askKindFor(15, withDays(15)), 'rate');
    assert.strictEqual(askKindFor(30, withDays(30)), 'rate');
  });

  test('already reviewed -> early milestones ask to donate instead', () => {
    assert.strictEqual(askKindFor(15, withDays(15, { reviewed: true })), 'donate');
    assert.strictEqual(askKindFor(30, withDays(30, { reviewed: true })), 'donate');
  });

  test('90+ rotates donate / pro / rate', () => {
    const s = withDays(400);
    assert.strictEqual(askKindFor(90, s), 'donate');
    assert.strictEqual(askKindFor(180, s), 'pro');
    assert.strictEqual(askKindFor(270, s), 'rate');
    assert.strictEqual(askKindFor(360, s), 'donate');
  });

  test('a rotated review slot becomes donate once reviewed', () => {
    const s = withDays(400, { reviewed: true });
    assert.strictEqual(askKindFor(270, s), 'donate');
  });
});
