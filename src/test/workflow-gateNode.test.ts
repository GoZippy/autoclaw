/**
 * workflow-gateNode.test.ts — Unit tests for the WL-1 node executors:
 * the gate adapter (WL-1.3) plus the tool and model node seams.
 *
 * These exercise the executors directly (without the orchestration engine) so
 * the gate→failure-taxonomy mapping, command-backed gating, and mockable
 * provider seams are pinned independently of the runner.
 */

import * as assert from 'assert';
import * as os from 'os';

import {
  RunState,
  defaultMockModelProvider,
  refusingCommandRunner,
  type RunnerDeps,
  type NodeContext,
  type WorkflowNode,
  type CommandResult,
  type CommandRunner,
} from '../workflows/state';
import { runGateNode, type GateNodeConfig } from '../workflows/nodes/gateNode';
import { runToolNode, type ToolNodeConfig } from '../workflows/nodes/toolNode';
import { runModelNode } from '../workflows/nodes/modelNode';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    workspaceRoot: os.tmpdir(),
    now: () => '2026-06-27T00:00:00.000Z',
    newRunId: () => 'run-test',
    commandRunner: refusingCommandRunner,
    modelProvider: defaultMockModelProvider,
    persistLedger: false,
    ...overrides,
  };
}

function makeCtx(
  node: Partial<WorkflowNode>,
  opts: { deps?: Partial<RunnerDeps>; upstream?: Record<string, unknown>; iteration?: number; costCents?: number } = {}
): NodeContext {
  const run = new RunState({ runId: 'r', workflowId: 'w', startedAt: '2026-06-27T00:00:00.000Z', ledger: null });
  if (opts.costCents) { run.costCents = opts.costCents; }
  const full: WorkflowNode = {
    id: node.id ?? 'n1',
    type: node.type ?? 'gate',
    kind: node.kind ?? 'test',
    config: node.config ?? {},
    ...node,
  };
  return { node: full, run, deps: makeDeps(opts.deps), upstream: opts.upstream ?? {}, iteration: opts.iteration };
}

function cmd(result: Partial<CommandResult>): CommandRunner {
  return async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, ...result });
}

/** A command runner that fails the first N calls, then succeeds. */
function failFirst(n: number): CommandRunner {
  let calls = 0;
  return async () => {
    calls++;
    return calls <= n
      ? { exitCode: 1, stdout: '', stderr: 'fail', durationMs: 1 }
      : { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 };
  };
}

// ---------------------------------------------------------------------------
// Gate node — deterministic mock verdicts
// ---------------------------------------------------------------------------

suite('workflow gateNode — mock verdict', () => {
  test('mockPass=true completes', async () => {
    const cfg: GateNodeConfig = { kind: 'acceptance', mockPass: true };
    const r = await runGateNode(makeCtx({ type: 'gate', config: cfg }));
    assert.strictEqual(r.status, 'completed');
  });

  test('mockPass=false fails and maps the failure type', async () => {
    const r = await runGateNode(makeCtx({ type: 'gate', config: { kind: 'test', mockPass: false } }));
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.failureType, 'test_failure');
  });
});

// ---------------------------------------------------------------------------
// Gate node — command-backed (compile/test/acceptance) via mock runner
// ---------------------------------------------------------------------------

suite('workflow gateNode — command-backed', () => {
  test('test gate passes when command exits 0', async () => {
    const r = await runGateNode(makeCtx(
      { type: 'gate', config: { kind: 'test', command: 'npm test' } },
      { deps: { commandRunner: cmd({ exitCode: 0 }) } }
    ));
    assert.strictEqual(r.status, 'completed');
  });

  test('test gate fails → test_failure when command exits non-zero', async () => {
    const r = await runGateNode(makeCtx(
      { type: 'gate', config: { kind: 'test', command: 'npm test' } },
      { deps: { commandRunner: cmd({ exitCode: 1 }) } }
    ));
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.failureType, 'test_failure');
  });

  test('compile gate fails → compile_error', async () => {
    const r = await runGateNode(makeCtx(
      { type: 'gate', config: { kind: 'compile', command: 'tsc' } },
      { deps: { commandRunner: cmd({ exitCode: 2 }) } }
    ));
    assert.strictEqual(r.failureType, 'compile_error');
  });

  test('timeout maps to budget_exhausted', async () => {
    const r = await runGateNode(makeCtx(
      { type: 'gate', config: { kind: 'test', command: 'npm test' } },
      { deps: { commandRunner: cmd({ exitCode: 0, timedOut: true }) } }
    ));
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.failureType, 'budget_exhausted');
  });

  test('review gate with no command/mock requires a human', async () => {
    const r = await runGateNode(makeCtx({ type: 'gate', config: { kind: 'review' } }));
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.failureType, 'irreducible_or_needs_human');
  });
});

// ---------------------------------------------------------------------------
// Gate node — budget & schema (no command)
// ---------------------------------------------------------------------------

suite('workflow gateNode — budget & schema', () => {
  test('budget gate passes under the ceiling', async () => {
    const r = await runGateNode(makeCtx(
      { type: 'gate', config: { kind: 'budget', budgetCents: 100 } },
      { costCents: 40 }
    ));
    assert.strictEqual(r.status, 'completed');
  });

  test('budget gate fails over the ceiling → budget_exhausted', async () => {
    const r = await runGateNode(makeCtx(
      { type: 'gate', config: { kind: 'budget', budgetCents: 10 } },
      { costCents: 40 }
    ));
    assert.strictEqual(r.failureType, 'budget_exhausted');
  });

  test('schema gate passes when required keys are present upstream', async () => {
    const r = await runGateNode(makeCtx(
      { type: 'gate', config: { kind: 'schema', requiredKeys: ['patch'] } },
      { upstream: { prev: { patch: 'diff', extra: 1 } } }
    ));
    assert.strictEqual(r.status, 'completed');
  });

  test('schema gate fails → artifact_invalid when a required key is missing', async () => {
    const r = await runGateNode(makeCtx(
      { type: 'gate', config: { kind: 'schema', requiredKeys: ['patch'] } },
      { upstream: { prev: { nope: true } } }
    ));
    assert.strictEqual(r.failureType, 'artifact_invalid');
  });
});

// ---------------------------------------------------------------------------
// Tool node
// ---------------------------------------------------------------------------

suite('workflow toolNode', () => {
  test('mock tool completes with output', async () => {
    const cfg: ToolNodeConfig = { kind: 'mock', mockOutput: { applied: true } };
    const r = await runToolNode(makeCtx({ type: 'tool', config: cfg }));
    assert.strictEqual(r.status, 'completed');
    assert.deepStrictEqual(r.output, { applied: true });
  });

  test('mock tool can simulate a typed failure', async () => {
    const r = await runToolNode(makeCtx({ type: 'tool', config: { kind: 'mock', mockFailure: 'tool_action_illegal' } }));
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.failureType, 'tool_action_illegal');
  });

  test('shell tool without a command → tool_format_invalid', async () => {
    const r = await runToolNode(makeCtx({ type: 'tool', config: { kind: 'shell' } }));
    assert.strictEqual(r.failureType, 'tool_format_invalid');
  });

  test('test tool maps non-zero exit to test_failure', async () => {
    const r = await runToolNode(makeCtx(
      { type: 'tool', config: { kind: 'test', command: 'npm test' } },
      { deps: { commandRunner: cmd({ exitCode: 1 }) } }
    ));
    assert.strictEqual(r.failureType, 'test_failure');
  });

  test('shell tool timeout → budget_exhausted', async () => {
    const r = await runToolNode(makeCtx(
      { type: 'tool', config: { kind: 'shell', command: 'sleep' } },
      { deps: { commandRunner: cmd({ timedOut: true }) } }
    ));
    assert.strictEqual(r.failureType, 'budget_exhausted');
  });

  test('default (refusing) runner makes a shell tool fail safely', async () => {
    const r = await runToolNode(makeCtx({ type: 'tool', config: { kind: 'shell', command: 'echo hi' } }));
    assert.strictEqual(r.status, 'failed');
  });
});

// ---------------------------------------------------------------------------
// Model node (mockable provider seam)
// ---------------------------------------------------------------------------

suite('workflow modelNode', () => {
  test('uses the default offline mock provider at zero cost', async () => {
    const r = await runModelNode(makeCtx({ type: 'agent', kind: 'model', config: { intent: 'debug' } }));
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.costCents, 0);
    assert.ok(r.model && r.model.provider === 'mock');
    assert.strictEqual(r.model!.locality, 'local');
  });

  test('escalates to a stronger model on later loop iterations', async () => {
    const first = await runModelNode(makeCtx({ type: 'agent', kind: 'model', config: {} }, { iteration: 0 }));
    const later = await runModelNode(makeCtx({ type: 'agent', kind: 'model', config: {} }, { iteration: 1 }));
    assert.strictEqual(first.model!.model, 'mock-fast');
    assert.strictEqual(later.model!.model, 'mock-strong');
  });

  test('mockResponseText overrides the produced text', async () => {
    const r = await runModelNode(makeCtx({ type: 'agent', kind: 'model', config: { mockResponseText: 'PATCH' } }));
    const out = r.output as { text: string };
    assert.strictEqual(out.text, 'PATCH');
  });
});

// ---------------------------------------------------------------------------
// failFirst helper sanity (used by the runner integration test)
// ---------------------------------------------------------------------------

suite('workflow gateNode — stateful runner helper', () => {
  test('failFirst(1) fails once then passes', async () => {
    const runner = failFirst(1);
    const a = await runner('x');
    const b = await runner('x');
    assert.strictEqual(a.exitCode, 1);
    assert.strictEqual(b.exitCode, 0);
  });
});
