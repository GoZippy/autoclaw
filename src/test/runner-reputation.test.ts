import * as assert from 'assert';
import { RunnerRegistry } from '../runners/registry';
import type { Runner } from '../runners/types';
import { reputationMapFromWorkers } from '../fleet/performance';
import { emptyResume, type Worker } from '../fleet/workforce';

/** Minimal fake runner — only id + detect(found:true) are exercised here. */
function fakeRunner(id: string): Runner {
  return {
    id,
    async detect() { return { found: true as const, version: '1.0.0', endpoint: 'local' }; },
  } as unknown as Runner;
}

async function regWith(ids: string[]): Promise<RunnerRegistry> {
  const reg = new RunnerRegistry();
  for (const id of ids) { reg.register(fakeRunner(id)); }
  await reg.detect(); // flips enabled=true so listActive() includes them
  return reg;
}

function worker(agent_id: string, over: Partial<Worker['resume']> = {}): Worker {
  return {
    agent_id, roles_can_play: ['coder'], skills: [], llms: [], tools: [],
    resume: { ...emptyResume(), ...over }, status: 'available', trust: 'off',
    created_at: '2026-06-17T00:00:00.000Z',
  };
}

suite('Runner reputation weighting (HRW-2)', () => {

  test('getPreferred picks the highest-reputation runner', async () => {
    const reg = await regWith(['claude-code', 'kilocode', 'hermes']);
    const chosen = reg.getPreferred({
      reputationByRunnerId: { 'claude-code': 0.3, 'kilocode': 0.9, 'hermes': 0.5 },
    });
    assert.ok(chosen);
    assert.strictEqual(chosen!.id, 'kilocode');
  });

  test('reputation is a no-op when no map is supplied (back-compat)', async () => {
    const reg = await regWith(['a', 'b']);
    // No reputation + no cost/latency/explicit/workspace → falls through to the
    // first active runner (registration order). Reputation must not change this.
    const chosen = reg.getPreferred({});
    assert.strictEqual(chosen!.id, 'a');
  });

  test('a reputation tie defers to the next criterion (cost)', async () => {
    const reg = await regWith(['a', 'b']);
    const chosen = reg.getPreferred({
      reputationByRunnerId: { a: 0.5, b: 0.5 },   // tie → defer
      costByRunnerId: { a: 100, b: 10 },          // b is cheaper → wins
    });
    assert.strictEqual(chosen!.id, 'b');
  });

  test('explicit/workspace still outrank reputation', async () => {
    const reg = await regWith(['a', 'b', 'c']);
    const chosen = reg.getPreferred({
      explicitRunnerId: 'c',
      reputationByRunnerId: { a: 0.9, b: 0.1, c: 0.1 },
    });
    assert.strictEqual(chosen!.id, 'c', 'explicit beats reputation');
  });

  test('reputationMapFromWorkers maps agent_id → reputationScore', () => {
    const proven = worker('vet', { tasks_completed: 10, reviews_passed: 5 });
    const rookie = worker('new');
    const map = reputationMapFromWorkers([proven, rookie]);
    assert.ok(map['vet'] > 0);
    assert.strictEqual(map['new'], 0);
    assert.ok(map['vet'] > map['new']);
  });
});
