/**
 * intelligence-watchservice.test.ts — unit tests for the always-on incremental
 * code re-index watch service.
 *
 * The timer and the re-index action are injected, so the debounce/coalescing
 * logic is tested deterministically with no real timers and no backend:
 *  - makeShouldIndex includes source files and EXCLUDES `.autoclaw/`, ignored
 *    dirs, and non-source extensions (the feedback-loop guard);
 *  - a change debounces to exactly one re-index; multiple changes coalesce;
 *  - ignored paths schedule nothing;
 *  - a change during an in-flight run schedules a single follow-up;
 *  - stop() halts further runs and clears the timer; debounce is clamped.
 */

import * as assert from 'assert';

import {
  startIndexWatchService,
  makeShouldIndex,
} from '../intelligence/watchService';
import { defaultConfig } from '../intelligence/config';

const flush = () => new Promise((r) => setImmediate(r));

function fakeTimer() {
  const state: { cb: (() => void) | null; cleared: number } = { cb: null, cleared: 0 };
  return {
    state,
    setTimeoutFn: ((cb: () => void) => { state.cb = cb; return 1 as unknown as ReturnType<typeof setTimeout>; }),
    clearTimeoutFn: (() => { state.cleared++; state.cb = null; }),
    fire() { const cb = state.cb; state.cb = null; if (cb) { cb(); } },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

suite('intelligence-watchservice', function () {
  suite('makeShouldIndex (feedback-loop guard)', function () {
    const cfg = (() => {
      const c = defaultConfig();
      c.rag.fileExtensions = ['.ts', '.js'];
      c.rag.ignoredDirs = ['node_modules', 'out'];
      return c;
    })();
    const should = makeShouldIndex(cfg);

    test('includes source files', function () {
      assert.strictEqual(should('/ws/src/a.ts'), true);
      assert.strictEqual(should('C:\\ws\\src\\b.js'), true, 'windows separators');
    });
    test('excludes .autoclaw/ (prevents index→write→watch loop)', function () {
      assert.strictEqual(should('/ws/.autoclaw/vector/db.sqlite'), false);
      assert.strictEqual(should('/ws/.autoclaw/learnings/x.ts'), false, 'even a .ts under .autoclaw');
    });
    test('excludes ignored dirs + non-source extensions', function () {
      assert.strictEqual(should('/ws/node_modules/p/a.ts'), false);
      assert.strictEqual(should('/ws/out/a.js'), false);
      assert.strictEqual(should('/ws/src/readme.md'), false);
      assert.strictEqual(should(''), false);
    });
  });

  suite('debounce / coalescing', function () {
    test('a change debounces to exactly one re-index', async function () {
      const t = fakeTimer();
      let runs = 0;
      const svc = startIndexWatchService({
        workspaceRoot: '/ws', reindex: async () => { runs++; },
        shouldIndex: () => true, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
      });
      svc.notifyChange('a.ts');
      assert.strictEqual(svc.pending, true);
      assert.ok(t.state.cb, 'timer armed');
      t.fire();
      await flush();
      assert.strictEqual(runs, 1);
      assert.strictEqual(svc.runs, 1);
      assert.strictEqual(svc.pending, false);
      svc.stop();
    });

    test('multiple changes before fire coalesce into one run', async function () {
      const t = fakeTimer();
      let runs = 0;
      const svc = startIndexWatchService({
        workspaceRoot: '/ws', reindex: async () => { runs++; },
        shouldIndex: () => true, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
      });
      svc.notifyChange('a.ts');
      svc.notifyChange('b.ts');
      svc.notifyChange('c.ts');
      t.fire();
      await flush();
      assert.strictEqual(runs, 1, 'coalesced');
      svc.stop();
    });

    test('ignored paths schedule nothing', function () {
      const t = fakeTimer();
      const svc = startIndexWatchService({
        workspaceRoot: '/ws', reindex: async () => { /* noop */ },
        shouldIndex: (p) => p.endsWith('.ts'), setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
      });
      svc.notifyChange('/ws/.autoclaw/db.sqlite');
      svc.notifyChange('readme.md');
      assert.strictEqual(svc.pending, false);
      assert.strictEqual(t.state.cb, null, 'no timer armed');
      svc.stop();
    });

    test('a change during an in-flight run schedules one follow-up', async function () {
      const t = fakeTimer();
      const gate = deferred<void>();
      let runs = 0;
      const svc = startIndexWatchService({
        workspaceRoot: '/ws',
        reindex: () => { runs++; return runs === 1 ? gate.promise : Promise.resolve(); },
        shouldIndex: () => true, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
      });
      svc.notifyChange('a.ts');
      t.fire(); // start run #1 (awaits gate)
      await flush();
      assert.strictEqual(runs, 1, 'run #1 in flight');
      svc.notifyChange('b.ts'); // arrives mid-run → pending, no new timer yet
      assert.strictEqual(t.state.cb, null, 'no timer armed while in flight');
      gate.resolve(); // finish run #1 → should re-arm for the pending change
      await flush();
      assert.ok(t.state.cb, 'follow-up timer armed after run #1');
      t.fire();
      await flush();
      assert.strictEqual(runs, 2, 'one follow-up run');
      svc.stop();
    });

    test('stop halts further runs and clears the timer', function () {
      const t = fakeTimer();
      const svc = startIndexWatchService({
        workspaceRoot: '/ws', debounceMs: 10, reindex: async () => { /* noop */ },
        shouldIndex: () => true, setTimeoutFn: t.setTimeoutFn, clearTimeoutFn: t.clearTimeoutFn,
      });
      svc.notifyChange('a.ts');
      svc.stop();
      assert.strictEqual(svc.running, false);
      assert.ok(t.state.cleared >= 1, 'timer cleared on stop');
      svc.notifyChange('b.ts'); // after stop → ignored, arms nothing
      assert.strictEqual(t.state.cb, null, 'no timer armed after stop');
      svc.stop(); // idempotent — must not throw
    });
  });
});
