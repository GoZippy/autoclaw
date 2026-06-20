import * as assert from 'assert';
import { RunnerRegistry } from '../runners/registry';
import type { DispatchOptions, DispatchResult, Runner } from '../runners/types';
import { dispatchViaRegistry } from '../runners/dispatchViaRegistry';

interface DispatchSpy { calls: DispatchOptions[]; }

/** Fake runner exercising only id + detect(found) + dispatch(). */
function fakeRunner(
  id: string,
  spy: DispatchSpy,
  result: Partial<DispatchResult> = {},
): Runner {
  return {
    id,
    async detect() { return { found: true as const, version: '1.0.0', endpoint: 'local' }; },
    async dispatch(opts: DispatchOptions): Promise<DispatchResult> {
      spy.calls.push(opts);
      return {
        ok: true,
        sessionId: `${id}-sess`,
        exitCode: 0,
        finishedAt: '2026-06-20T00:00:00.000Z',
        durationMs: 1234,
        tokens: { input: 100, output: 200 },
        ...result,
      };
    },
  } as unknown as Runner;
}

async function regWith(runners: Runner[]): Promise<RunnerRegistry> {
  const reg = new RunnerRegistry();
  for (const r of runners) { reg.register(r); }
  await reg.detect();
  return reg;
}

suite('dispatchViaRegistry — reachable runner dispatch contract', () => {

  test('explicit runnerId dispatches through that runner', async () => {
    const spyA: DispatchSpy = { calls: [] };
    const spyB: DispatchSpy = { calls: [] };
    const reg = await regWith([fakeRunner('a', spyA), fakeRunner('b', spyB)]);

    const outcome = await dispatchViaRegistry(reg, {
      runnerId: 'b',
      prompt: 'do the thing',
      workingDir: '/tmp/ws',
    });

    assert.ok(outcome);
    assert.strictEqual(outcome!.runnerId, 'b');
    assert.strictEqual(spyB.calls.length, 1);
    assert.strictEqual(spyA.calls.length, 0);
    assert.strictEqual(spyB.calls[0].prompt, 'do the thing');
    assert.strictEqual(spyB.calls[0].trust, 'auto', 'defaults trust to auto');
    assert.strictEqual(spyB.calls[0].workingDir, '/tmp/ws');
  });

  test('no runnerId falls back to the preference order (getPreferred)', async () => {
    const spyA: DispatchSpy = { calls: [] };
    const spyB: DispatchSpy = { calls: [] };
    const reg = await regWith([fakeRunner('a', spyA), fakeRunner('b', spyB)]);

    // No explicit id / cost / reputation → first registered active runner wins.
    const outcome = await dispatchViaRegistry(reg, { prompt: 'p', workingDir: '/w' });

    assert.ok(outcome);
    assert.strictEqual(outcome!.runnerId, 'a');
    assert.strictEqual(spyA.calls.length, 1);
  });

  test('unknown explicit runnerId returns null (no throw)', async () => {
    const spyA: DispatchSpy = { calls: [] };
    const reg = await regWith([fakeRunner('a', spyA)]);
    const outcome = await dispatchViaRegistry(reg, {
      runnerId: 'nope', prompt: 'p', workingDir: '/w',
    });
    assert.strictEqual(outcome, null);
    assert.strictEqual(spyA.calls.length, 0);
  });

  test('onResult receives the resolved runner id + result', async () => {
    const spyA: DispatchSpy = { calls: [] };
    const reg = await regWith([fakeRunner('a', spyA)]);
    const seen: Array<{ id: string; tokens?: { input: number; output: number } }> = [];

    await dispatchViaRegistry(reg, {
      runnerId: 'a', prompt: 'p', workingDir: '/w',
      onResult: (id, result) => { seen.push({ id, tokens: result.tokens }); },
    });

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].id, 'a');
    assert.deepStrictEqual(seen[0].tokens, { input: 100, output: 200 });
  });

  test('a throwing onResult never breaks the dispatch (best-effort sink)', async () => {
    const spyA: DispatchSpy = { calls: [] };
    const reg = await regWith([fakeRunner('a', spyA)]);
    const outcome = await dispatchViaRegistry(reg, {
      runnerId: 'a', prompt: 'p', workingDir: '/w',
      onResult: () => { throw new Error('sink blew up'); },
    });
    assert.ok(outcome, 'dispatch still resolves despite onResult throwing');
    assert.strictEqual(outcome!.result.ok, true);
  });
});
