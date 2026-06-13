/**
 * budget.test.ts — Cost-as-instrument ceiling (crabbox cost-guardrail pattern).
 *
 * Covers: ceiling config read (disabled when absent/empty), the pure
 * evaluateBudget decision, wall-clock arming idempotency, checkBudget rollup
 * (injected spend + clock), and enforceBudget engaging the HALT switch exactly
 * once on breach (injected halt/isHalted — no real fleet state touched).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  readBudgetCeiling,
  evaluateBudget,
  armBudgetClock,
  resetBudgetClock,
  checkBudget,
  enforceBudget,
  BUDGET_FILE_REL,
} from '../budget';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-budget-'));
}

function writeCeiling(root: string, c: unknown): void {
  const file = path.join(root, BUDGET_FILE_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c), 'utf8');
}

suite('Budget — ceiling config', () => {
  test('absent / empty / malformed ⇒ undefined (disabled)', async () => {
    const root = makeRoot();
    assert.strictEqual(await readBudgetCeiling(root), undefined);
    writeCeiling(root, {});
    assert.strictEqual(await readBudgetCeiling(root), undefined);
    fs.writeFileSync(path.join(root, BUDGET_FILE_REL), '{not json', 'utf8');
    assert.strictEqual(await readBudgetCeiling(root), undefined);
  });

  test('keeps only valid bounds', async () => {
    const root = makeRoot();
    writeCeiling(root, { max_spend_usd: 5, max_wallclock_ms: -1, junk: true });
    assert.deepStrictEqual(await readBudgetCeiling(root), { max_spend_usd: 5 });
  });
});

suite('Budget — evaluateBudget (pure)', () => {
  test('within when under both bounds', () => {
    const r = evaluateBudget({ max_spend_usd: 10, max_wallclock_ms: 1000 }, { spend_usd: 4, wallclock_ms: 500 });
    assert.strictEqual(r.within, true);
    assert.deepStrictEqual(r.breaches, []);
  });

  test('spend breach reported', () => {
    const r = evaluateBudget({ max_spend_usd: 1 }, { spend_usd: 2.5 });
    assert.strictEqual(r.within, false);
    assert.match(r.breaches[0], /spend \$2\.50 exceeds cap \$1\.00/);
  });

  test('time breach only counts when wallclock is known', () => {
    assert.strictEqual(evaluateBudget({ max_wallclock_ms: 100 }, { spend_usd: 0 }).within, true);
    assert.strictEqual(evaluateBudget({ max_wallclock_ms: 100 }, { spend_usd: 0, wallclock_ms: 200 }).within, false);
  });
});

suite('Budget — wall-clock arming', () => {
  test('armBudgetClock is idempotent (first write wins)', async () => {
    const root = makeRoot();
    const first = await armBudgetClock(root, new Date('2026-06-13T00:00:00Z'));
    const second = await armBudgetClock(root, new Date('2026-06-13T05:00:00Z'));
    assert.strictEqual(first, '2026-06-13T00:00:00.000Z');
    assert.strictEqual(second, first);
    await resetBudgetClock(root);
    const third = await armBudgetClock(root, new Date('2026-06-13T09:00:00Z'));
    assert.strictEqual(third, '2026-06-13T09:00:00.000Z');
  });
});

suite('Budget — checkBudget', () => {
  test('disabled ⇒ within, no ledger read', async () => {
    const root = makeRoot();
    const s = await checkBudget(root, { readSpendUsd: async () => { throw new Error('should not read'); } });
    assert.deepStrictEqual(s, { enabled: false, within: true, spend_usd: 0, breaches: [] });
  });

  test('rolls up injected spend against the cap', async () => {
    const root = makeRoot();
    writeCeiling(root, { max_spend_usd: 3 });
    const under = await checkBudget(root, { readSpendUsd: async () => 2 });
    assert.strictEqual(under.within, true);
    const over = await checkBudget(root, { readSpendUsd: async () => 4 });
    assert.strictEqual(over.within, false);
    assert.strictEqual(over.enabled, true);
  });

  test('measures wall-clock from the armed epoch', async () => {
    const root = makeRoot();
    writeCeiling(root, { max_wallclock_ms: 60_000 });
    await armBudgetClock(root, new Date('2026-06-13T00:00:00Z'));
    const s = await checkBudget(root, { now: new Date('2026-06-13T00:02:00Z'), readSpendUsd: async () => 0 });
    assert.strictEqual(s.wallclock_ms, 120_000);
    assert.strictEqual(s.within, false); // 120s > 60s cap
  });
});

suite('Budget — enforceBudget engages HALT', () => {
  test('breach halts exactly once with a reason', async () => {
    const root = makeRoot();
    writeCeiling(root, { max_spend_usd: 1 });
    const reasons: string[] = [];
    const s = await enforceBudget(root, {
      readSpendUsd: async () => 5,
      isHalted: () => false,
      halt: async (r) => { reasons.push(r); },
    });
    assert.strictEqual(s.within, false);
    assert.strictEqual(reasons.length, 1);
    assert.match(reasons[0], /budget ceiling exceeded/);
  });

  test('does not re-halt when already halted', async () => {
    const root = makeRoot();
    writeCeiling(root, { max_spend_usd: 1 });
    const reasons: string[] = [];
    await enforceBudget(root, { readSpendUsd: async () => 5, isHalted: () => true, halt: async (r) => { reasons.push(r); } });
    assert.strictEqual(reasons.length, 0);
  });

  test('within budget never halts', async () => {
    const root = makeRoot();
    writeCeiling(root, { max_spend_usd: 100 });
    let halted = false;
    await enforceBudget(root, { readSpendUsd: async () => 1, isHalted: () => false, halt: async () => { halted = true; } });
    assert.strictEqual(halted, false);
  });

  test('disabled budget never halts', async () => {
    const root = makeRoot();
    let halted = false;
    const s = await enforceBudget(root, { isHalted: () => false, halt: async () => { halted = true; } });
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(halted, false);
  });
});
