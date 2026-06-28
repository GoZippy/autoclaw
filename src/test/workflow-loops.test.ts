/**
 * workflow-loops.test.ts — unit tests for the WL-1.2 loop executor.
 *
 * All tests run offline with the mock model provider and refusing command
 * runner. No real shell commands are executed.
 */

import * as assert from 'assert';

import { runLoopNode } from '../workflows/loops';
import {
  RunState,
  defaultMockModelProvider,
  refusingCommandRunner,
  type NodeContext,
  type WorkflowNode,
} from '../workflows/state';

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'loop',
    type: 'loop',
    kind: 'retry',
    config: { maxIterations: 3 },
    ...overrides,
  };
}

function makeCtx(node: WorkflowNode, opts: { iteration?: number; costCents?: number; shouldHalt?: () => boolean } = {}): NodeContext {
  const run = new RunState({ runId: 'r', workflowId: 'w', startedAt: '2026-06-27T00:00:00.000Z' });
  run.costCents = opts.costCents ?? 0;
  return {
    node,
    run,
    deps: {
      workspaceRoot: '/tmp',
      now: () => '2026-06-27T00:00:00.000Z',
      newRunId: () => 'run-test',
      commandRunner: refusingCommandRunner,
      modelProvider: defaultMockModelProvider,
      persistLedger: false,
      shouldHalt: opts.shouldHalt,
    },
    upstream: {},
    iteration: opts.iteration,
  };
}

suite('workflow loops — retry pattern', () => {
  test('exits immediately if the body succeeds on the first attempt', async () => {
    const node = makeNode({ config: { maxIterations: 3 } });
    const result = await runLoopNode(makeCtx(node), async () => ({
      status: 'completed',
      output: { done: true },
      summary: 'body succeeded',
    }));
    assert.strictEqual(result.status, 'completed');
    assert.ok(result.summary?.includes('1 iteration'));
  });

  test('retries and reports no-progress after repeated same failure type', async () => {
    const node = makeNode({ config: { maxIterations: 10 } });
    let calls = 0;
    const result = await runLoopNode(makeCtx(node), async () => {
      calls++;
      return { status: 'failed' as const, failureType: 'test_failure', summary: 'still failing' };
    });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failureType, 'irreducible_or_needs_human');
    // Exits on no-progress: first call + MAX_SAME_FAILURE (2) repeats = 3 total.
    assert.ok(result.summary?.includes('no progress'), `summary: ${result.summary}`);
    assert.strictEqual(calls, 3, 'expected exit after first call + MAX_SAME_FAILURE repeats');
  });

  test('no-progress: same failure type repeated exits early', async () => {
    const node = makeNode({ config: { maxIterations: 5 } });
    let calls = 0;
    const result = await runLoopNode(makeCtx(node), async () => {
      calls++;
      return { status: 'failed' as const, failureType: 'compile_error', summary: 'still failing' };
    });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failureType, 'irreducible_or_needs_human');
    // Should exit after MAX_SAME_FAILURE (2) repeats, not after maxIterations.
    assert.ok(calls < 5, `expected early exit, got ${calls} calls`);
  });
});

suite('workflow loops — budget enforcement', () => {
  test('exits with budget_exhausted when cost ceiling is reached', async () => {
    const node = makeNode({ config: { maxIterations: 5, maxCostCents: 10 } });
    const result = await runLoopNode(makeCtx(node, { costCents: 50 }), async () => ({
      status: 'completed',
      output: {},
      summary: 'ok',
    }));
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failureType, 'budget_exhausted');
  });
});

suite('workflow loops — human-required short-circuit', () => {
  test('exits immediately on human-required failure', async () => {
    const node = makeNode({ config: { maxIterations: 3 } });
    const result = await runLoopNode(makeCtx(node), async () => ({
      status: 'failed' as const,
      failureType: 'irreducible_or_needs_human',
      summary: 'needs human',
    }));
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failureType, 'irreducible_or_needs_human');
  });
});

suite('workflow loops — halt signal', () => {
  test('halts mid-loop when shouldHalt returns true', async () => {
    const node = makeNode({ config: { maxIterations: 3 } });
    let calls = 0;
    const result = await runLoopNode(
      makeCtx(node, { shouldHalt: () => calls >= 1 }),
      async () => {
        calls++;
        // Fail so the loop continues to the next iteration where shouldHalt triggers.
        return { status: 'failed' as const, failureType: 'test_failure', summary: 'fail' };
      },
    );
    assert.ok(calls >= 1, 'body should have been called at least once');
    assert.strictEqual(result.status, 'failed', `expected failed, got ${result.status}: ${result.summary}`);
    assert.strictEqual(result.failureType, 'irreducible_or_needs_human');
    assert.ok(calls <= 2, `expected halt after at most 2 body calls, got ${calls}`);
  });
});
