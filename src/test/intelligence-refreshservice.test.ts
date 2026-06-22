/**
 * intelligence-refreshservice.test.ts — unit tests for the standalone per-host
 * context refresh service (Channel C, tick-based).
 *
 * The timer and the refresh action are injected, so the loop is tested
 * deterministically with no real timers and no backend:
 *  - the interval is clamped to the 1-minute floor;
 *  - tickNow runs the refresh and counts completed ticks;
 *  - overlapping ticks are skipped (no concurrent refresh);
 *  - the injected timer callback drives ticks;
 *  - stop() halts further ticks and clears the timer (idempotent).
 */

import * as assert from 'assert';

import {
  startIntelligenceRefreshService,
  MIN_REFRESH_INTERVAL_MS,
} from '../intelligence/refreshService';
import { WriteHostContextResult } from '../intelligence/hostContext';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function result(writtenIds: string[] = []): WriteHostContextResult {
  return {
    written: writtenIds.map((id) => ({ id, path: `/tmp/${id}` })),
    failed: [],
    targetsDetected: writtenIds.length,
    degraded: false,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setImmediate(r));

/** Capture the interval callback instead of arming a real timer. */
function fakeTimer() {
  const state: { cb: (() => void) | null; cleared: boolean } = { cb: null, cleared: false };
  return {
    state,
    setIntervalFn: ((cb: () => void) => {
      state.cb = cb;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }),
    clearIntervalFn: (() => {
      state.cleared = true;
    }),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('intelligence-refreshservice', function () {
  test('clamps the interval to the 1-minute floor', () => {
    const t = fakeTimer();
    const svc = startIntelligenceRefreshService({
      workspaceRoot: '/ws',
      intervalMs: 1000, // below the floor
      tickOnStart: false,
      refresh: async () => result(),
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    assert.strictEqual(svc.intervalMs, MIN_REFRESH_INTERVAL_MS);
    svc.stop();
  });

  test('tickNow runs the refresh and counts completed ticks', async () => {
    const t = fakeTimer();
    let calls = 0;
    const svc = startIntelligenceRefreshService({
      workspaceRoot: '/ws',
      tickOnStart: false,
      refresh: async () => {
        calls += 1;
        return result(['cursor']);
      },
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    const res = await svc.tickNow();
    assert.ok(res && res.written.length === 1);
    assert.strictEqual(calls, 1);
    assert.strictEqual(svc.ticks, 1);
    assert.ok(svc.lastTickAt, 'lastTickAt set');
    svc.stop();
  });

  test('skips overlapping ticks (no concurrent refresh)', async () => {
    const t = fakeTimer();
    const gate = deferred<WriteHostContextResult>();
    let calls = 0;
    const svc = startIntelligenceRefreshService({
      workspaceRoot: '/ws',
      tickOnStart: false,
      refresh: () => {
        calls += 1;
        return gate.promise;
      },
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    const p1 = svc.tickNow(); // in flight, awaiting the gate
    const second = await svc.tickNow(); // must skip while the first is running
    assert.strictEqual(second, null, 'overlapping tick is skipped');
    assert.strictEqual(calls, 1, 'refresh called once');
    gate.resolve(result(['kiro']));
    await p1;
    assert.strictEqual(svc.ticks, 1);
    svc.stop();
  });

  test('the injected timer callback drives ticks', async () => {
    const t = fakeTimer();
    let calls = 0;
    const svc = startIntelligenceRefreshService({
      workspaceRoot: '/ws',
      tickOnStart: false,
      refresh: async () => {
        calls += 1;
        return result();
      },
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    assert.ok(t.state.cb, 'a timer callback was registered');
    t.state.cb!();
    await flush();
    assert.strictEqual(calls, 1);
    assert.strictEqual(svc.ticks, 1);
    svc.stop();
  });

  test('stop halts further ticks and clears the timer (idempotent)', async () => {
    const t = fakeTimer();
    let calls = 0;
    const svc = startIntelligenceRefreshService({
      workspaceRoot: '/ws',
      tickOnStart: false,
      refresh: async () => {
        calls += 1;
        return result();
      },
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    svc.stop();
    assert.strictEqual(svc.running, false);
    assert.strictEqual(t.state.cleared, true, 'timer cleared');
    const after = await svc.tickNow();
    assert.strictEqual(after, null, 'tickNow after stop is a no-op');
    assert.strictEqual(calls, 0);
    svc.stop(); // idempotent — must not throw
  });

  test('tickOnStart runs one immediate tick', async () => {
    const t = fakeTimer();
    let calls = 0;
    const svc = startIntelligenceRefreshService({
      workspaceRoot: '/ws',
      refresh: async () => {
        calls += 1;
        return result();
      },
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    await flush();
    assert.strictEqual(calls, 1, 'one immediate tick on start');
    assert.strictEqual(svc.ticks, 1);
    svc.stop();
  });
});
