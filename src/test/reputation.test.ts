/**
 * reputation.test.ts — REP-1 track-record ledger (V4_PLAN §P5).
 *
 * Covers: record/read round-trip + filters, the success rule, aggregation
 * (overall + per-capability + avg duration), and the cold-start-safe
 * reputationFactor multiplier.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  recordTaskOutcome,
  readTrackRecord,
  isSuccess,
  aggregateReputation,
  getAgentReputation,
  reputationFactor,
  REPUTATION_NEUTRAL,
  REPUTATION_DIR_REL,
  OUTCOMES_FILE,
} from '../reputation';
import type { TaskOutcome } from '../reputation';

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-rep-'));
}

function outcome(overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    task_id: 'T1',
    agent_id: 'kilocode',
    verdict: 'approved',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

suite('Reputation — record & read', () => {
  test('recordTaskOutcome appends and readTrackRecord round-trips', async () => {
    const root = makeTmpRoot();
    await recordTaskOutcome(root, outcome({ task_id: 'A' }));
    await recordTaskOutcome(root, outcome({ task_id: 'B', agent_id: 'cursor' }));
    const all = await readTrackRecord(root);
    assert.strictEqual(all.length, 2);
    assert.ok(fs.existsSync(path.join(root, REPUTATION_DIR_REL, OUTCOMES_FILE)));
  });

  test('readTrackRecord filters by agent and capability', async () => {
    const root = makeTmpRoot();
    await recordTaskOutcome(root, outcome({ agent_id: 'kilocode', capabilities: ['go'] }));
    await recordTaskOutcome(root, outcome({ agent_id: 'kilocode', capabilities: ['typescript'] }));
    await recordTaskOutcome(root, outcome({ agent_id: 'cursor', capabilities: ['go'] }));
    assert.strictEqual((await readTrackRecord(root, { agent_id: 'kilocode' })).length, 2);
    assert.strictEqual((await readTrackRecord(root, { capability: 'go' })).length, 2);
    assert.strictEqual((await readTrackRecord(root, { agent_id: 'kilocode', capability: 'go' })).length, 1);
  });

  test('missing ledger ⇒ [] and malformed lines are skipped', async () => {
    const root = makeTmpRoot();
    assert.deepStrictEqual(await readTrackRecord(root), []);
    const dir = path.join(root, REPUTATION_DIR_REL);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, OUTCOMES_FILE), `${JSON.stringify(outcome())}\n{bad json\n\n`);
    assert.strictEqual((await readTrackRecord(root)).length, 1);
  });
});

suite('Reputation — success rule', () => {
  test('approved + gate not failed = success; everything else = not', () => {
    assert.strictEqual(isSuccess(outcome({ verdict: 'approved' })), true);
    assert.strictEqual(isSuccess(outcome({ verdict: 'approved', gate_passed: true })), true);
    assert.strictEqual(isSuccess(outcome({ verdict: 'approved', gate_passed: false })), false, 'red gate is never a success');
    assert.strictEqual(isSuccess(outcome({ verdict: 'needs_changes' })), false);
    assert.strictEqual(isSuccess(outcome({ verdict: 'blocked' })), false);
    assert.strictEqual(isSuccess(outcome({ verdict: 'abstain' })), false);
  });
});

suite('Reputation — aggregation', () => {
  test('overall + per-capability success rates and average duration', () => {
    const recs: TaskOutcome[] = [
      outcome({ agent_id: 'k', verdict: 'approved', capabilities: ['go'], duration_ms: 100 }),
      outcome({ agent_id: 'k', verdict: 'needs_changes', capabilities: ['go'], duration_ms: 300 }),
      outcome({ agent_id: 'k', verdict: 'approved', capabilities: ['typescript'] }),
      outcome({ agent_id: 'c', verdict: 'approved' }),
    ];
    const reps = aggregateReputation(recs);
    const k = reps.get('k')!;
    assert.strictEqual(k.samples, 3);
    assert.strictEqual(k.successes, 2);
    assert.ok(Math.abs(k.success_rate - 2 / 3) < 1e-9);
    assert.strictEqual(k.by_capability['go'].samples, 2);
    assert.ok(Math.abs(k.by_capability['go'].success_rate - 0.5) < 1e-9);
    assert.strictEqual(k.by_capability['typescript'].success_rate, 1);
    assert.strictEqual(k.avg_duration_ms, 200); // (100 + 300) / 2
    assert.strictEqual(reps.get('c')!.success_rate, 1);
  });

  test('getAgentReputation reads + aggregates one agent', async () => {
    const root = makeTmpRoot();
    await recordTaskOutcome(root, outcome({ agent_id: 'k', verdict: 'approved' }));
    await recordTaskOutcome(root, outcome({ agent_id: 'k', verdict: 'blocked' }));
    const rep = await getAgentReputation(root, 'k');
    assert.ok(rep);
    assert.strictEqual(rep!.samples, 2);
    assert.strictEqual(rep!.success_rate, 0.5);
    assert.strictEqual(await getAgentReputation(root, 'nobody'), undefined);
  });
});

suite('Reputation — reputationFactor (cold-start safe)', () => {
  test('no record or too-few samples ⇒ neutral prior', () => {
    assert.strictEqual(reputationFactor(undefined), REPUTATION_NEUTRAL);
    const sparse = aggregateReputation([outcome({ agent_id: 'k' }), outcome({ agent_id: 'k' })]).get('k');
    assert.strictEqual(reputationFactor(sparse), REPUTATION_NEUTRAL, '2 samples < default minSamples 3');
  });

  test('with enough samples, maps success_rate → [0.5, 1.0]', () => {
    const perfect = aggregateReputation(
      Array.from({ length: 5 }, () => outcome({ agent_id: 'k', verdict: 'approved' }))
    ).get('k');
    assert.strictEqual(reputationFactor(perfect), 1.0);

    const awful = aggregateReputation(
      Array.from({ length: 5 }, () => outcome({ agent_id: 'k', verdict: 'blocked' }))
    ).get('k');
    assert.strictEqual(reputationFactor(awful), 0.5);
  });

  test('prefers per-capability history when present', () => {
    const recs: TaskOutcome[] = [
      // Strong overall, but weak on "security-review" specifically.
      ...Array.from({ length: 4 }, () => outcome({ agent_id: 'k', verdict: 'approved', capabilities: ['go'] })),
      ...Array.from({ length: 4 }, () => outcome({ agent_id: 'k', verdict: 'needs_changes', capabilities: ['security-review'] })),
    ];
    const rep = aggregateReputation(recs).get('k');
    assert.strictEqual(reputationFactor(rep, 'security-review'), 0.5, 'weak on this capability');
    assert.strictEqual(reputationFactor(rep, 'go'), 1.0, 'strong on this capability');
  });
});
