/**
 * runner-reputation-wiring.test.ts — BL-7: reputation-aware dispatch.
 *
 * Proves the previously-inert wiring is live: the reputation ledger is read into
 * a `{ reputationByRunnerId }` map, and a preference-based dispatch routes to the
 * higher-reputation runner — the §5.5 `reputation` criterion finally deciding.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { recordTaskOutcome, type TaskOutcome } from '../reputation/ledger';
import { RunnerRegistry } from '../runners/registry';
import { buildReputationPreference, dispatchPreferredByReputation } from '../runners/reputationPreference';
import type { Runner } from '../runners/types';

function mkws(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-rep-'));
}

async function seed(ws: string, agent: string, ok: number, fail: number): Promise<void> {
  for (let i = 0; i < ok; i++) {
    const o: TaskOutcome = { task_id: `${agent}-ok-${i}`, agent_id: agent, verdict: 'approved', gate_passed: true, timestamp: '2026-06-27T00:00:00.000Z' };
    await recordTaskOutcome(ws, o);
  }
  for (let i = 0; i < fail; i++) {
    const o: TaskOutcome = { task_id: `${agent}-no-${i}`, agent_id: agent, verdict: 'needs_changes', timestamp: '2026-06-27T00:00:00.000Z' };
    await recordTaskOutcome(ws, o);
  }
}

function fakeRunner(id: string, dispatched: string[]): Runner {
  return {
    id,
    capabilities: {},
    detect: async () => ({ found: true }),
    dispatch: async () => { dispatched.push(id); return { ok: true, sessionId: 's', exitCode: 0, finishedAt: '2026-06-27T00:00:00.000Z', durationMs: 1 }; },
  } as unknown as Runner;
}

suite('BL-7 — buildReputationPreference', () => {
  test('maps agents to bounded reputation; proven > poor', async () => {
    const ws = mkws();
    try {
      await seed(ws, 'claude-code', 8, 2); // 0.8 → factor 0.9
      await seed(ws, 'kilocode', 2, 8);    // 0.2 → factor 0.6
      const pref = await buildReputationPreference(ws);
      assert.ok(pref.reputationByRunnerId, 'a reputation map is produced');
      assert.ok(pref.reputationByRunnerId!['claude-code'] > pref.reputationByRunnerId!['kilocode']);
      assert.ok(pref.reputationByRunnerId!['claude-code'] <= 1 && pref.reputationByRunnerId!['kilocode'] >= 0.5);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test('empty ledger → {} (safe no-op, default order intact)', async () => {
    const ws = mkws();
    try {
      assert.deepStrictEqual(await buildReputationPreference(ws), {});
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test('newcomer (<3 samples) gets the neutral prior, not a penalty', async () => {
    const ws = mkws();
    try {
      await seed(ws, 'newbie', 1, 0);
      const pref = await buildReputationPreference(ws);
      assert.strictEqual(pref.reputationByRunnerId!['newbie'], 0.9);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });
});

suite('BL-7 — dispatchPreferredByReputation', () => {
  test('routes to the higher-reputation runner (reputation criterion decides)', async () => {
    const ws = mkws();
    try {
      await seed(ws, 'claude-code', 8, 2);
      await seed(ws, 'kilocode', 2, 8);
      const dispatched: string[] = [];
      const reg = new RunnerRegistry();
      reg.register(fakeRunner('claude-code', dispatched));
      reg.register(fakeRunner('kilocode', dispatched));

      const out = await dispatchPreferredByReputation(reg, { prompt: 'go', workingDir: ws, workspaceRoot: ws });
      assert.ok(out, 'a runner was selected');
      assert.strictEqual(out!.runnerId, 'claude-code', 'higher reputation wins the preference order');
      assert.deepStrictEqual(dispatched, ['claude-code']);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test('with no ledger, still dispatches (falls through to a stable default)', async () => {
    const ws = mkws();
    try {
      const dispatched: string[] = [];
      const reg = new RunnerRegistry();
      reg.register(fakeRunner('only-one', dispatched));
      const out = await dispatchPreferredByReputation(reg, { prompt: 'go', workingDir: ws, workspaceRoot: ws });
      assert.ok(out);
      assert.strictEqual(out!.runnerId, 'only-one');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });
});

suite('BL-7b — reputationAwareDispatch setting', () => {
  test('package.json declares autoclaw.runners.reputationAwareDispatch', () => {
    const root = path.join(__dirname, '..', '..');
    const pkg = require(path.join(root, 'package.json'));
    const configs = pkg.contributes?.configuration;
    assert.ok(Array.isArray(configs), 'contributes.configuration should be an array');
    const orchestrationBlock = configs.find((c: { title?: string }) => c.title === 'Orchestration & AutoBuild');
    assert.ok(orchestrationBlock, 'should have Orchestration & AutoBuild block');
    const setting = orchestrationBlock.properties['autoclaw.runners.reputationAwareDispatch'];
    assert.ok(setting, 'reputationAwareDispatch setting should be declared');
    assert.strictEqual(setting.type, 'boolean');
    assert.strictEqual(setting.default, false);
    assert.ok(setting.markdownDescription, 'should have a description');
    assert.match(setting.markdownDescription, /reputation/i);
  });
});
