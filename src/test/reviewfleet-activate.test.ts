/**
 * reviewfleet-activate.test.ts — offline unit tests for the RF-4d
 * ReviewFleetController.
 *
 * ALL deps are injected fakes. No real filesystem, no real LLM, no real model
 * scan, no real timers.  The fake runWatcher returns immediately (or after a
 * controlled microtask delay) so tests are deterministic and instant.
 *
 * Tests cover:
 *  1. enabled=false → started:true, reason includes 'DORMANT', runWatcher
 *     receives enabled:false.
 *  2. enabled=true + budgetCents=50 → started:true; fake received enabled:true,
 *     budget flowed into buildWatcherDeps, shouldStop function was passed.
 *  3. Double start while watcher still pending → second call returns
 *     { started:false, reason:'review fleet already running' }.
 *  4. stop() sets the shouldStop() closure to true.
 *  5. Empty roster → still starts (warning logged AND runWatcher called).
 *  6. isRunning()/status() reflect lifecycle: running → resolved → not running.
 */

import * as assert from 'assert';

import {
  ReviewFleetController,
  type ReviewFleetActivateConfig,
  type ReviewFleetActivateDeps,
} from '../reviewfleet/activate';
import type { ReviewerCapacity } from '../reviewfleet/roster';
import type { ReviewFleetWatcherDeps, StartWatcherOpts } from '../reviewfleet/watcher';

/* -------------------------------------------------------------------------- */
/*  Fake builders                                                              */
/* -------------------------------------------------------------------------- */

/** A single healthy local reviewer. */
function makeReviewer(id = 'fake:model'): ReviewerCapacity {
  return {
    id,
    kind: 'model',
    locality: 'local',
    costTier: 'free',
    strength: 'cheap',
    healthy: true,
  };
}

/**
 * Minimal ReviewFleetWatcherDeps stub. The controller only cares about the
 * shape — it spreads watcherDeps into the StartWatcherOpts passed to
 * runWatcher, so all fields need to be present but content doesn't matter.
 */
function makeWatcherDeps(): ReviewFleetWatcherDeps {
  return {
    deps: {
      roster: [],
      dispatchReviewer: async () => ({ reviewerId: 'fake', vote: 'approve' as const, costCents: 0 }),
      writeVote: async () => { /* no-op */ },
      now: () => '2026-06-29T00:00:00.000Z',
    },
    scanPendingRequests: async () => [],
    markProcessed: async () => { /* no-op */ },
  };
}

/**
 * Build a complete fake ReviewFleetActivateDeps with controlled behaviours.
 *
 * @param opts.runWatcherImpl  Override the runWatcher implementation.
 * @param opts.rosterResult    What buildRoster resolves to.
 * @param opts.capturedWatcherArgs  Array that will be mutated with each opts
 *        object passed to runWatcher.
 * @param opts.capturedBuildWatcherArgs  Captures each call to buildWatcherDeps.
 */
function makeFakeDeps(opts: {
  runWatcherImpl?: (o: StartWatcherOpts) => Promise<{ cycles: number; summaries: unknown[] }>;
  rosterResult?: ReviewerCapacity[];
  capturedWatcherArgs?: StartWatcherOpts[];
  capturedBuildWatcherArgs?: Parameters<ReviewFleetActivateDeps['buildWatcherDeps']>[0][];
  logs?: string[];
} = {}): ReviewFleetActivateDeps {
  const capturedWatcherArgs = opts.capturedWatcherArgs ?? [];
  const capturedBuildWatcherArgs = opts.capturedBuildWatcherArgs ?? [];
  const logs = opts.logs ?? [];

  return {
    buildRoster: async (_workspaceRoot: string): Promise<ReviewerCapacity[]> =>
      opts.rosterResult ?? [makeReviewer()],

    buildWatcherDeps: (args): ReviewFleetWatcherDeps => {
      capturedBuildWatcherArgs.push(args);
      return makeWatcherDeps();
    },

    runWatcher: async (o: StartWatcherOpts): Promise<{ cycles: number; summaries: unknown[] }> => {
      capturedWatcherArgs.push(o);
      if (opts.runWatcherImpl) {
        return opts.runWatcherImpl(o);
      }
      // Instant resolve — dormant or single-shot
      return { cycles: 0, summaries: [] };
    },

    log: (msg: string) => {
      logs.push(msg);
    },
  };
}

/** Config that is fully dormant ($0, no scan). */
const DORMANT_CONFIG: ReviewFleetActivateConfig = {
  enabled: false,
  budgetCents: 0,
};

/** Config that is live (enabled + funded). */
function liveConfig(overrides: Partial<ReviewFleetActivateConfig> = {}): ReviewFleetActivateConfig {
  return {
    enabled: true,
    budgetCents: 50,
    intervalMs: 0,
    maxCycles: 1,
    agentId: 'claude-code',
    sessionId: 'sess-abc',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Yield to the microtask queue so fire-and-forget promises settle. */
async function tick(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

/* -------------------------------------------------------------------------- */
/*  Suite 1: enabled=false → DORMANT                                           */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetController — enabled=false stays DORMANT', () => {
  test('started:true, reason includes DORMANT, runWatcher received enabled:false', async () => {
    const capturedWatcherArgs: StartWatcherOpts[] = [];
    const deps = makeFakeDeps({ capturedWatcherArgs });

    const ctrl = new ReviewFleetController(deps);
    const result = await ctrl.start('/fake/workspace', DORMANT_CONFIG);

    assert.strictEqual(result.started, true, 'start() must return started:true');
    assert.ok(
      result.reason.includes('DORMANT'),
      `reason must include 'DORMANT'; got: "${result.reason}"`,
    );

    // Allow the fire-and-forget promise to settle
    await tick();

    assert.strictEqual(capturedWatcherArgs.length, 1, 'runWatcher must be called once');
    assert.strictEqual(
      capturedWatcherArgs[0].enabled,
      false,
      'runWatcher must receive enabled:false',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 2: enabled=true + budgetCents → live watcher                        */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetController — enabled=true watcher wired correctly', () => {
  test('started:true; fake received enabled:true, budget, shouldStop fn', async () => {
    const capturedWatcherArgs: StartWatcherOpts[] = [];
    const capturedBuildWatcherArgs: Parameters<ReviewFleetActivateDeps['buildWatcherDeps']>[0][] = [];
    const deps = makeFakeDeps({ capturedWatcherArgs, capturedBuildWatcherArgs });

    const ctrl = new ReviewFleetController(deps);
    const config = liveConfig({ budgetCents: 50, intervalMs: 500, maxCycles: 3 });
    const result = await ctrl.start('/proj', config);

    assert.strictEqual(result.started, true);
    assert.ok(!result.reason.includes('DORMANT'), 'reason must NOT include DORMANT when enabled');

    // Budget flowed into buildWatcherDeps
    assert.strictEqual(capturedBuildWatcherArgs.length, 1);
    assert.strictEqual(capturedBuildWatcherArgs[0].budgetCents, 50);
    assert.strictEqual(capturedBuildWatcherArgs[0].enabled, true);
    assert.strictEqual(capturedBuildWatcherArgs[0].agentId, 'claude-code');
    assert.strictEqual(capturedBuildWatcherArgs[0].sessionId, 'sess-abc');

    await tick();

    // runWatcher received enabled:true and a shouldStop function
    assert.strictEqual(capturedWatcherArgs.length, 1);
    const opts = capturedWatcherArgs[0];
    assert.strictEqual(opts.enabled, true, 'runWatcher must receive enabled:true');
    assert.strictEqual(typeof opts.shouldStop, 'function', 'shouldStop must be a function');
    assert.strictEqual(opts.maxCycles, 3);
    assert.strictEqual(opts.intervalMs, 500);
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 3: Double start → second call returns already running               */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetController — double start blocked', () => {
  test('second start while watcher pending → { started:false }', async () => {
    // Use a manually-resolved promise to keep the watcher "pending"
    let resolveWatcher!: (v: { cycles: number; summaries: unknown[] }) => void;
    const pendingPromise = new Promise<{ cycles: number; summaries: unknown[] }>((res) => {
      resolveWatcher = res;
    });

    const deps = makeFakeDeps({
      runWatcherImpl: async () => pendingPromise,
    });

    const ctrl = new ReviewFleetController(deps);

    // First start
    const first = await ctrl.start('/proj', liveConfig());
    assert.strictEqual(first.started, true);

    // Controller should be running while the promise is pending
    assert.strictEqual(ctrl.isRunning(), true, 'should be running while watcher is pending');

    // Second start — must be rejected
    const second = await ctrl.start('/proj', liveConfig());
    assert.strictEqual(second.started, false, 'second start must return started:false');
    assert.ok(
      second.reason.includes('already running'),
      `reason must include 'already running'; got: "${second.reason}"`,
    );

    // Clean up: resolve the pending watcher
    resolveWatcher({ cycles: 0, summaries: [] });
    await tick();
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 4: stop() sets shouldStop() to true                                 */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetController — stop() arms shouldStop gate', () => {
  test('shouldStop() passed to runWatcher returns true after stop() is called', async () => {
    let capturedShouldStop: (() => boolean) | undefined;

    let resolveWatcher!: (v: { cycles: number; summaries: unknown[] }) => void;
    const pendingPromise = new Promise<{ cycles: number; summaries: unknown[] }>((res) => {
      resolveWatcher = res;
    });

    const deps = makeFakeDeps({
      runWatcherImpl: async (o: StartWatcherOpts) => {
        capturedShouldStop = o.shouldStop;
        return pendingPromise;
      },
    });

    const ctrl = new ReviewFleetController(deps);
    await ctrl.start('/proj', liveConfig());

    // Give the fire-and-forget a tick to invoke runWatcher and capture shouldStop
    await tick();

    assert.ok(capturedShouldStop, 'runWatcher must have been called and shouldStop captured');
    assert.strictEqual(capturedShouldStop!(), false, 'shouldStop() must be false before stop()');

    const stopResult = ctrl.stop();
    assert.strictEqual(stopResult.stopped, true, 'stop() must return { stopped:true } while running');
    assert.strictEqual(capturedShouldStop!(), true, 'shouldStop() must be true after stop()');

    // Clean up
    resolveWatcher({ cycles: 0, summaries: [] });
    await tick();
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 5: Empty roster → still starts, warning logged                      */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetController — empty roster still starts', () => {
  test('buildRoster returning [] → warning logged AND runWatcher still called', async () => {
    const capturedWatcherArgs: StartWatcherOpts[] = [];
    const logs: string[] = [];

    const deps = makeFakeDeps({
      rosterResult: [],          // empty roster
      capturedWatcherArgs,
      logs,
    });

    const ctrl = new ReviewFleetController(deps);
    const result = await ctrl.start('/proj', liveConfig());

    assert.strictEqual(result.started, true, 'start() must succeed even with empty roster');

    await tick();

    // Warning must have been logged about empty roster
    const hasWarning = logs.some((msg) =>
      msg.toLowerCase().includes('empty') || msg.toLowerCase().includes('roster'),
    );
    assert.ok(hasWarning, `Expected a warning about empty roster; got logs: ${JSON.stringify(logs)}`);

    // runWatcher must still have been called
    assert.strictEqual(capturedWatcherArgs.length, 1, 'runWatcher must be called despite empty roster');
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 6: isRunning() / status() lifecycle                                 */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetController — isRunning / status lifecycle', () => {
  test('running=true while watcher pending, false after watcher resolves', async () => {
    let resolveWatcher!: (v: { cycles: number; summaries: unknown[] }) => void;
    const pendingPromise = new Promise<{ cycles: number; summaries: unknown[] }>((res) => {
      resolveWatcher = res;
    });

    const deps = makeFakeDeps({
      runWatcherImpl: async () => pendingPromise,
    });

    const ctrl = new ReviewFleetController(deps);
    assert.strictEqual(ctrl.isRunning(), false, 'should not be running before start()');
    assert.deepStrictEqual(ctrl.status(), { running: false });

    const config = liveConfig({ budgetCents: 99 });
    await ctrl.start('/proj', config);

    // Status should reflect running + config
    assert.strictEqual(ctrl.isRunning(), true, 'should be running after start()');
    const runningStatus = ctrl.status();
    assert.strictEqual(runningStatus.running, true);
    assert.ok(runningStatus.config, 'status().config must be set while running');
    assert.strictEqual(runningStatus.config!.budgetCents, 99);

    // Resolve the watcher promise and allow the .then() to fire
    resolveWatcher({ cycles: 2, summaries: [] });
    await tick();

    assert.strictEqual(ctrl.isRunning(), false, 'should not be running after watcher resolves');
    assert.deepStrictEqual(ctrl.status(), { running: false });
  });

  test('stop() returns { stopped:false } when not running', () => {
    const ctrl = new ReviewFleetController(makeFakeDeps());
    const result = ctrl.stop();
    assert.strictEqual(result.stopped, false, 'stop() on idle controller must return { stopped:false }');
  });
});
