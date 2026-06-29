/**
 * reviewfleet-watcher.test.ts — offline unit tests for RF-4b watcher loop.
 *
 * All IO seams are stubbed. No real filesystem, no real LLM, no real timers
 * (sleep is injected as an instant no-op).
 *
 * Tests cover:
 *  1. DORMANT gate: enabled=false (or omitted) → cycles=0, scan never called.
 *  2. runReviewFleetCycle processes every request and calls markProcessed once each.
 *  3. Per-request error isolation: one request throwing leaves others processed;
 *     the errored request is NOT markProcessed.
 *  4. defaultScaffold() is invoked when a request carries no scaffold.
 *  5. Built-in safe default scaffold is used when no defaultScaffold injected.
 *  6. Bounded loop with shouldStop: exactly N cycles run before stopping.
 *  7. humanRequired tally: empty roster → router → humanRequired counted.
 */

import * as assert from 'assert';

import {
  runReviewFleetCycle,
  startReviewFleetWatcher,
  type PendingReviewRequest,
  type ReviewFleetWatcherDeps,
  type StartWatcherOpts,
} from '../reviewfleet/watcher';
import type { ReviewFleetDeps, ReviewVerdict, AutomatedVote } from '../reviewfleet/service';
import type { ReviewerCapacity } from '../reviewfleet/roster';
import type { ScaffoldVariant } from '../workflows/scaffolds/types';

/* -------------------------------------------------------------------------- */
/*  Fixture builders                                                           */
/* -------------------------------------------------------------------------- */

/** A ScaffoldVariant that routes to tier1-local with gatesFirst. */
function makeScaffold(id = 'sc-1'): ScaffoldVariant {
  return {
    schema: 'autoclaw.scaffold.v1' as const,
    id,
    workflowId: 'wf-test',
    taskIntent: 'code',
    routerProfile: 'balanced',
    toolLaneIds: [],
    createdAt: '2026-06-29T00:00:00.000Z',
    review: {
      tier: 'tier1-local',
      reviewerIndependence: 'same-model',
      gatesFirst: false,
    },
  };
}

/** A single healthy local reviewer that always returns 'approve'. */
function makeApproveReviewer(id = 'local:test-model'): ReviewerCapacity {
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
 * Build a ReviewFleetDeps stub.
 *
 * By default: single local reviewer that approves; writeVote is a no-op that
 * captures votes; no scoreRun.
 */
function makeDeps(overrides: Partial<ReviewFleetDeps> & {
  capturedVotes?: AutomatedVote[];
} = {}): ReviewFleetDeps & { capturedVotes: AutomatedVote[] } {
  const capturedVotes: AutomatedVote[] = overrides.capturedVotes ?? [];
  return {
    roster: [makeApproveReviewer()],
    dispatchReviewer: async (reviewer: ReviewerCapacity): Promise<ReviewVerdict> => ({
      reviewerId: reviewer.id,
      vote: 'approve' as const,
      costCents: 0,
    }),
    writeVote: async (vote: AutomatedVote): Promise<void> => {
      capturedVotes.push(vote);
    },
    now: () => '2026-06-29T00:00:00.000Z',
    ...overrides,
    capturedVotes,
  };
}

/** Build a minimal ReviewFleetWatcherDeps for testing. */
function makeWatcherDeps(opts: {
  requests?: PendingReviewRequest[];
  deps?: ReviewFleetDeps;
  processedIds?: string[];
  defaultScaffold?: () => ScaffoldVariant;
  log?: (msg: string) => void;
} = {}): ReviewFleetWatcherDeps & { processedIds: string[] } {
  const processedIds: string[] = opts.processedIds ?? [];
  const requests: PendingReviewRequest[] = opts.requests ?? [];
  return {
    deps: opts.deps ?? makeDeps(),
    scanPendingRequests: async () => requests,
    markProcessed: async (id: string) => { processedIds.push(id); },
    defaultScaffold: opts.defaultScaffold,
    log: opts.log ?? (() => { /* silent */ }),
    processedIds,
  };
}

/** Instant sleep — no real timer. */
const instantSleep = async (_ms: number): Promise<void> => { /* no-op */ };

/* -------------------------------------------------------------------------- */
/*  Suite 1: DORMANT gate                                                      */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetWatcher — DORMANT gate', () => {
  test('enabled omitted → returns { cycles: 0, summaries: [] }', async () => {
    let scanCalled = false;
    const w = makeWatcherDeps({
      requests: [{ id: 'msg-1', taskId: 'T1', scaffold: makeScaffold() }],
    });
    const opts: StartWatcherOpts = {
      ...w,
      scanPendingRequests: async () => { scanCalled = true; return []; },
      sleep: instantSleep,
      // enabled intentionally omitted
    };
    const result = await startReviewFleetWatcher(opts);

    assert.strictEqual(result.cycles, 0, 'cycles must be 0 when dormant');
    assert.deepStrictEqual(result.summaries, [], 'summaries must be empty when dormant');
    assert.strictEqual(scanCalled, false, 'scanPendingRequests must NOT be called when dormant');
  });

  test('enabled=false → returns { cycles: 0 } AND scan never called', async () => {
    let scanCalled = false;
    const w = makeWatcherDeps();
    const opts: StartWatcherOpts = {
      ...w,
      scanPendingRequests: async () => { scanCalled = true; return []; },
      enabled: false,
      sleep: instantSleep,
    };
    const result = await startReviewFleetWatcher(opts);

    assert.strictEqual(result.cycles, 0);
    assert.strictEqual(scanCalled, false, 'scanPendingRequests must NOT be called when enabled=false');
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 2: runReviewFleetCycle — happy path                                  */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetWatcher — runReviewFleetCycle happy path', () => {
  test('processes all pending requests and calls markProcessed once each', async () => {
    const requests: PendingReviewRequest[] = [
      { id: 'msg-1', taskId: 'T1', scaffold: makeScaffold() },
      { id: 'msg-2', taskId: 'T2', scaffold: makeScaffold() },
      { id: 'msg-3', taskId: 'T3', scaffold: makeScaffold() },
    ];
    const w = makeWatcherDeps({ requests });
    const summary = await runReviewFleetCycle(w);

    assert.strictEqual(summary.scanned, 3);
    assert.strictEqual(summary.processed, 3);
    assert.strictEqual(summary.errors, 0);
    // Each id appears exactly once
    assert.deepStrictEqual(
      w.processedIds.slice().sort(),
      ['msg-1', 'msg-2', 'msg-3'],
    );
  });

  test('empty inbox → scanned=0, processed=0, no markProcessed calls', async () => {
    const w = makeWatcherDeps({ requests: [] });
    const summary = await runReviewFleetCycle(w);

    assert.strictEqual(summary.scanned, 0);
    assert.strictEqual(summary.processed, 0);
    assert.strictEqual(w.processedIds.length, 0);
  });

  test('voted counts requests that produced a vote (not humanRequired)', async () => {
    const requests: PendingReviewRequest[] = [
      { id: 'msg-1', taskId: 'T1', scaffold: makeScaffold() },
    ];
    const w = makeWatcherDeps({ requests });
    const summary = await runReviewFleetCycle(w);

    // The default deps (one local approver) should produce a vote
    assert.strictEqual(summary.voted, 1, 'should tally 1 voted');
    assert.strictEqual(summary.humanRequired, 0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 3: Per-request error isolation                                       */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetWatcher — per-request error isolation', () => {
  test('error on one request: errors++, NOT markProcessed; other requests still process', async () => {
    const requests: PendingReviewRequest[] = [
      { id: 'msg-good-1', taskId: 'T-good-1', scaffold: makeScaffold() },
      { id: 'msg-bad',    taskId: 'T-bad',    scaffold: makeScaffold() },
      { id: 'msg-good-2', taskId: 'T-good-2', scaffold: makeScaffold() },
    ];

    // Inject a writeVote that throws for the specific task that should fail.
    // processReviewRequest itself absorbs dispatchReviewer throws → humanRequired,
    // but a writeVote throw will propagate out of processReviewRequest.
    const deps = makeDeps({
      writeVote: async (vote: AutomatedVote): Promise<void> => {
        if (vote.task_id === 'T-bad') {
          throw new Error('simulated writeVote failure for T-bad');
        }
      },
    });

    const w = makeWatcherDeps({ requests, deps });
    const summary = await runReviewFleetCycle(w);

    assert.strictEqual(summary.scanned, 3, 'scanned must include all 3');
    assert.strictEqual(summary.errors, 1, 'errors must be 1 for the failing request');
    assert.strictEqual(summary.processed, 2, 'processed must be 2 (the two good ones)');
    // The bad message was NOT marked processed
    assert.ok(
      !w.processedIds.includes('msg-bad'),
      'msg-bad must NOT be in processedIds',
    );
    // The good messages WERE marked processed
    assert.ok(w.processedIds.includes('msg-good-1'), 'msg-good-1 must be processed');
    assert.ok(w.processedIds.includes('msg-good-2'), 'msg-good-2 must be processed');
  });

  test('cycle does not throw even when all requests fail', async () => {
    const requests: PendingReviewRequest[] = [
      { id: 'msg-a', taskId: 'T-a', scaffold: makeScaffold() },
      { id: 'msg-b', taskId: 'T-b', scaffold: makeScaffold() },
    ];
    const deps = makeDeps({
      writeVote: async (): Promise<void> => {
        throw new Error('always fails');
      },
    });
    const w = makeWatcherDeps({ requests, deps });

    let threw = false;
    let summary: Awaited<ReturnType<typeof runReviewFleetCycle>> | undefined;
    try {
      summary = await runReviewFleetCycle(w);
    } catch {
      threw = true;
    }

    assert.strictEqual(threw, false, 'runReviewFleetCycle must never throw');
    assert.ok(summary);
    assert.strictEqual(summary.errors, 2);
    assert.strictEqual(summary.processed, 0);
    assert.strictEqual(w.processedIds.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 4: defaultScaffold injection                                         */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetWatcher — defaultScaffold', () => {
  test('defaultScaffold() is called when request has no scaffold', async () => {
    let defaultScaffoldCalled = 0;
    const customScaffold = makeScaffold('custom-default');

    const requests: PendingReviewRequest[] = [
      { id: 'msg-1', taskId: 'T1' },  // no scaffold field
    ];
    const w = makeWatcherDeps({
      requests,
      defaultScaffold: () => {
        defaultScaffoldCalled += 1;
        return customScaffold;
      },
    });
    const summary = await runReviewFleetCycle(w);

    assert.strictEqual(defaultScaffoldCalled, 1, 'defaultScaffold must be called once');
    assert.strictEqual(summary.processed, 1);
  });

  test('built-in safe default scaffold is used when neither request nor watcher provides one', async () => {
    const requests: PendingReviewRequest[] = [
      { id: 'msg-1', taskId: 'T1' },  // no scaffold
    ];
    // No defaultScaffold injected either
    const w = makeWatcherDeps({ requests });
    // Should not throw — the built-in default keeps things safe
    const summary = await runReviewFleetCycle(w);

    // With the built-in default (tier1-local) and a local approver, either
    // processed or humanRequired — but never an error from missing scaffold.
    assert.strictEqual(summary.errors, 0, 'no error expected with built-in default scaffold');
    assert.strictEqual(summary.scanned, 1);
  });

  test('request scaffold takes priority over defaultScaffold', async () => {
    let defaultScaffoldCalled = 0;
    const requests: PendingReviewRequest[] = [
      { id: 'msg-1', taskId: 'T1', scaffold: makeScaffold('explicit-sc') },
    ];
    const w = makeWatcherDeps({
      requests,
      defaultScaffold: () => {
        defaultScaffoldCalled += 1;
        return makeScaffold('fallback-sc');
      },
    });
    await runReviewFleetCycle(w);

    assert.strictEqual(defaultScaffoldCalled, 0, 'defaultScaffold must NOT be called when request has scaffold');
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 5: bounded loop with shouldStop                                      */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetWatcher — bounded loop + shouldStop', () => {
  test('maxCycles=3, shouldStop returns true after 2 → exactly 2 cycles run', async () => {
    let cycleCount = 0;
    const w = makeWatcherDeps({ requests: [] });
    const opts: StartWatcherOpts = {
      ...w,
      enabled: true,
      maxCycles: 3,
      intervalMs: 0,
      sleep: instantSleep,
      shouldStop: () => cycleCount >= 2,
      scanPendingRequests: async () => {
        cycleCount += 1;
        return [];
      },
    };
    const result = await startReviewFleetWatcher(opts);

    assert.strictEqual(result.cycles, 2, 'exactly 2 cycles must run before shouldStop fires');
    assert.strictEqual(result.summaries.length, 2);
  });

  test('shouldStop returning true immediately → 0 cycles run', async () => {
    let scanCalled = false;
    const w = makeWatcherDeps();
    const opts: StartWatcherOpts = {
      ...w,
      enabled: true,
      maxCycles: 10,
      sleep: instantSleep,
      shouldStop: () => true,   // stop before first cycle
      scanPendingRequests: async () => { scanCalled = true; return []; },
    };
    const result = await startReviewFleetWatcher(opts);

    assert.strictEqual(result.cycles, 0, '0 cycles when shouldStop fires immediately');
    assert.strictEqual(scanCalled, false, 'scan must not be called when shouldStop is immediate');
  });

  test('maxCycles respected: runs exactly maxCycles when shouldStop never fires', async () => {
    let cycleCount = 0;
    const w = makeWatcherDeps();
    const opts: StartWatcherOpts = {
      ...w,
      enabled: true,
      maxCycles: 4,
      sleep: instantSleep,
      scanPendingRequests: async () => {
        cycleCount += 1;
        return [];
      },
    };
    const result = await startReviewFleetWatcher(opts);

    assert.strictEqual(result.cycles, 4, 'exactly maxCycles cycles when shouldStop never fires');
    assert.strictEqual(cycleCount, 4, 'scanPendingRequests must be called exactly maxCycles times');
  });

  test('sleep is called between cycles (not after last)', async () => {
    let sleepCalls = 0;
    const w = makeWatcherDeps({ requests: [] });
    const opts: StartWatcherOpts = {
      ...w,
      enabled: true,
      maxCycles: 3,
      sleep: async (_ms: number) => { sleepCalls += 1; },
    };
    await startReviewFleetWatcher(opts);

    // Sleep is called between cycles: after cycle 1 and after cycle 2, NOT after cycle 3.
    assert.strictEqual(sleepCalls, 2, 'sleep must be called maxCycles-1 times');
  });
});

/* -------------------------------------------------------------------------- */
/*  Suite 6: humanRequired tally                                               */
/* -------------------------------------------------------------------------- */

suite('ReviewFleetWatcher — humanRequired tally', () => {
  test('empty roster → router returns humanRequired → counted in summary', async () => {
    const requests: PendingReviewRequest[] = [
      { id: 'msg-1', taskId: 'T1', scaffold: makeScaffold() },
      { id: 'msg-2', taskId: 'T2', scaffold: makeScaffold() },
    ];
    // Empty roster — planReview has no eligible reviewer → humanRequired
    const deps = makeDeps({ roster: [] });
    const w = makeWatcherDeps({ requests, deps });
    const summary = await runReviewFleetCycle(w);

    assert.strictEqual(summary.humanRequired, 2, 'both requests should yield humanRequired');
    assert.strictEqual(summary.voted, 0, 'no automated vote when humanRequired');
    assert.strictEqual(summary.processed, 2, 'still marked processed (humanRequired is a valid result)');
    assert.strictEqual(summary.errors, 0, 'humanRequired is not an error');
  });

  test('mixed roster: some approve, some humanRequired — tallied separately', async () => {
    // Two requests: one has tier=tier1-local (resolves), one has tier=human (humanRequired)
    const scaffoldLocal = makeScaffold('sc-local');
    const scaffoldHuman: ScaffoldVariant = {
      ...makeScaffold('sc-human'),
      review: {
        tier: 'human',
        reviewerIndependence: 'human',
        gatesFirst: false,
      },
    };
    const requests: PendingReviewRequest[] = [
      { id: 'msg-local', taskId: 'T-local', scaffold: scaffoldLocal },
      { id: 'msg-human', taskId: 'T-human', scaffold: scaffoldHuman },
    ];
    const deps = makeDeps(); // one local approver
    const w = makeWatcherDeps({ requests, deps });
    const summary = await runReviewFleetCycle(w);

    assert.strictEqual(summary.scanned, 2);
    assert.strictEqual(summary.processed, 2, 'both are processed (no throws)');
    assert.strictEqual(summary.voted, 1, 'only the local one produced an automated vote');
    assert.strictEqual(summary.humanRequired, 1, 'only the human-tier one is humanRequired');
    assert.strictEqual(summary.errors, 0);
  });
});
