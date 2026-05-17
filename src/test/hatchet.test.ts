import * as assert from 'assert';
import {
  registerWorkflow,
  triggerWorkflow,
  getWorkflowStatus,
  listWorkflowRuns,
  registerAutoclawPipeline,
} from '../hatchet';

// Reset singleton between suites by re-importing isn't straightforward in CJS;
// tests rely on unique workflow names to avoid cross-test pollution.

suite('Hatchet durable workflow adapter (in-memory fallback)', () => {

  test('registerWorkflow + triggerWorkflow returns a runId', async () => {
    registerWorkflow({
      name: 'test:echo',
      steps: [
        { name: 'echo', handler: async (input) => ({ echoed: input.msg }) },
      ],
    });
    const runId = await triggerWorkflow('test:echo', { msg: 'hello' });
    assert.ok(typeof runId === 'string' && runId.startsWith('run-'));
  });

  test('triggerWorkflow rejects unknown workflow names', async () => {
    await assert.rejects(
      () => triggerWorkflow('no-such-workflow'),
      /Unknown workflow/,
    );
  });

  test('workflow reaches succeeded status after async execution', async () => {
    registerWorkflow({
      name: 'test:simple',
      steps: [
        { name: 'step1', handler: async () => ({ done: true }) },
      ],
    });
    const runId = await triggerWorkflow('test:simple', {});
    // Give the setImmediate queue a tick to run
    await new Promise(resolve => setImmediate(resolve));
    const run = await getWorkflowStatus(runId);
    assert.ok(run !== null);
    assert.strictEqual(run!.status, 'succeeded');
    assert.deepStrictEqual(run!.stepResults['step1'], { done: true });
  });

  test('step results from prior steps are visible via ctx.stepResults', async () => {
    let seenPriorResult: unknown;
    registerWorkflow({
      name: 'test:chain',
      steps: [
        { name: 'first', handler: async (input) => ({ value: input.base }) },
        {
          name: 'second',
          depends_on: ['first'],
          handler: async (_input, ctx) => {
            seenPriorResult = ctx.stepResults['first'];
            return { doubled: (ctx.stepResults['first'] as { value: number }).value * 2 };
          },
        },
      ],
    });
    const runId = await triggerWorkflow('test:chain', { base: 7 });
    await new Promise(resolve => setImmediate(resolve));
    // Need extra tick for second step after first completes
    await new Promise(resolve => setImmediate(resolve));
    const run = await getWorkflowStatus(runId);
    assert.strictEqual(run!.status, 'succeeded');
    assert.deepStrictEqual(seenPriorResult, { value: 7 });
    assert.deepStrictEqual(run!.stepResults['second'], { doubled: 14 });
  });

  test('failing step transitions workflow to failed status', async () => {
    registerWorkflow({
      name: 'test:fail',
      steps: [
        { name: 'boom', handler: async () => { throw new Error('intentional failure'); } },
      ],
    });
    const runId = await triggerWorkflow('test:fail', {});
    await new Promise(resolve => setImmediate(resolve));
    const run = await getWorkflowStatus(runId);
    assert.strictEqual(run!.status, 'failed');
    assert.ok(run!.error?.includes('intentional failure'));
  });

  test('step timeout causes workflow to fail', async () => {
    registerWorkflow({
      name: 'test:timeout',
      steps: [
        {
          name: 'slow',
          timeout_ms: 10,
          handler: async () => new Promise(resolve => setTimeout(resolve, 5000)),
        },
      ],
    });
    const runId = await triggerWorkflow('test:timeout', {});
    // Wait long enough for the 10ms timeout to fire
    await new Promise(resolve => setTimeout(resolve, 50));
    const run = await getWorkflowStatus(runId);
    assert.strictEqual(run!.status, 'failed');
    assert.ok(run!.error?.includes('timed out'));
  });

  test('getWorkflowStatus returns null for unknown runId', async () => {
    const run = await getWorkflowStatus('run-doesnotexist');
    assert.strictEqual(run, null);
  });

  test('listWorkflowRuns returns all runs when no filter', async () => {
    registerWorkflow({
      name: 'test:list-a',
      steps: [{ name: 's', handler: async () => ({}) }],
    });
    const r1 = await triggerWorkflow('test:list-a', {});
    const r2 = await triggerWorkflow('test:list-a', {});
    const all = listWorkflowRuns();
    const ids = all.map(r => r.runId);
    assert.ok(ids.includes(r1));
    assert.ok(ids.includes(r2));
  });

  test('listWorkflowRuns filters by workflowName', async () => {
    registerWorkflow({
      name: 'test:list-b',
      steps: [{ name: 's', handler: async () => ({}) }],
    });
    registerWorkflow({
      name: 'test:list-c',
      steps: [{ name: 's', handler: async () => ({}) }],
    });
    const rb = await triggerWorkflow('test:list-b', {});
    await triggerWorkflow('test:list-c', {});
    const filtered = listWorkflowRuns('test:list-b');
    assert.ok(filtered.every(r => r.workflowName === 'test:list-b'));
    assert.ok(filtered.some(r => r.runId === rb));
  });

  test('run record includes started_at and finished_at after completion', async () => {
    registerWorkflow({
      name: 'test:timestamps',
      steps: [{ name: 's', handler: async () => ({}) }],
    });
    const runId = await triggerWorkflow('test:timestamps', {});
    await new Promise(resolve => setImmediate(resolve));
    const run = await getWorkflowStatus(runId);
    assert.ok(run!.started_at.length > 0);
    assert.ok(run!.finished_at && run!.finished_at.length > 0);
  });

  test('run record stores original input', async () => {
    registerWorkflow({
      name: 'test:input-store',
      steps: [{ name: 's', handler: async () => ({}) }],
    });
    const input = { foo: 'bar', num: 42 };
    const runId = await triggerWorkflow('test:input-store', input);
    const run = await getWorkflowStatus(runId);
    assert.deepStrictEqual(run!.input, input);
  });

  // ---------------------------------------------------------------------------
  // Built-in pipeline
  // ---------------------------------------------------------------------------

  test('registerAutoclawPipeline registers and runs all 4 steps', async () => {
    registerAutoclawPipeline();
    const runId = await triggerWorkflow('autoclaw:sprint-pipeline', { manifest: 'test-manifest' });
    // 4 sequential steps — run several ticks
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const run = await getWorkflowStatus(runId);
    assert.strictEqual(run!.status, 'succeeded');
    assert.ok('plan' in run!.stepResults);
    assert.ok('assign' in run!.stepResults);
    assert.ok('review' in run!.stepResults);
    assert.ok('merge' in run!.stepResults);
    assert.deepStrictEqual((run!.stepResults['plan'] as Record<string, unknown>).manifest, 'test-manifest');
    assert.deepStrictEqual((run!.stepResults['merge'] as Record<string, unknown>).status, 'merged');
  });
});
