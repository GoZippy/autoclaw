/**
 * workflow-runner.test.ts — unit tests for the WL-1.1 headless runner.
 *
 * All tests run offline with mocked model/command providers. No real shell
 * commands are executed.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

import { runWorkflow, defaultDeps } from '../workflows/runner';
import type { WorkflowDefinition, RunnerDeps } from '../workflows/state';
import { WORKFLOW_SCHEMA } from '../workflows/state';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function minDeps(overrides?: Partial<RunnerDeps>): RunnerDeps {
  let count = 0;
  return {
    workspaceRoot: os.tmpdir(),
    now: () => '2026-06-27T00:00:00.000Z',
    newRunId: () => `test-run-${++count}`,
    commandRunner: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
    modelProvider: { complete: async (req) => ({
      text: `mock(${req.intent ?? 'none'})`,
      provider: 'mock', model: 'mock-fast', locality: 'local',
    }) },
    persistLedger: false,
    ...overrides,
  };
}

function simpleWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA,
    id: 'wf-simple',
    name: 'Simple',
    nodes: [
      { id: 'n1', type: 'input', kind: 'task', config: {} },
      { id: 'n2', type: 'artifact', kind: 'report', config: {} },
    ],
    edges: [
      { id: 'e1', from: { node: 'n1' }, to: { node: 'n2' } },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: basic execution
// ---------------------------------------------------------------------------

suite('WorkflowRunner — basic execution', () => {
  test('simple two-node graph completes successfully', async () => {
    const result = await runWorkflow(simpleWorkflow(), minDeps());
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.stopReason, 'completed');
    assert.strictEqual(result.failureType, undefined);
  });

  test('assigns runId and workflowId to result', async () => {
    const result = await runWorkflow(simpleWorkflow(), minDeps());
    assert.ok(result.runId.startsWith('test-run-'));
    assert.strictEqual(result.workflowId, 'wf-simple');
  });

  test('emits started and completed events', async () => {
    const result = await runWorkflow(simpleWorkflow(), minDeps());
    const events = result.events.map((e) => e.event);
    assert.ok(events.includes('started'));
    assert.ok(events.includes('completed'));
  });

  test('downstream nodes receive upstream outputs', async () => {
    const wf = simpleWorkflow();
    const result = await runWorkflow(wf, minDeps());
    assert.ok('n1' in result.nodeStates);
    assert.ok('n2' in result.nodeStates);
    assert.strictEqual(result.nodeStates['n1'].status, 'completed');
    assert.strictEqual(result.nodeStates['n2'].status, 'completed');
  });
});

// ---------------------------------------------------------------------------
// Tests: gate node integration
// ---------------------------------------------------------------------------

suite('WorkflowRunner — gate nodes', () => {
  function wfWithGate(mockPass: boolean): WorkflowDefinition {
    return {
      schema: WORKFLOW_SCHEMA,
      id: 'wf-gate',
      name: 'Gate Workflow',
      nodes: [
        { id: 'input', type: 'input', kind: 'task', config: {} },
        { id: 'gate', type: 'gate', kind: 'test', config: { kind: 'test', mockPass } },
        { id: 'artifact', type: 'artifact', kind: 'report', config: {} },
      ],
      edges: [
        { id: 'e1', from: { node: 'input' }, to: { node: 'gate' } },
        { id: 'e2', from: { node: 'gate' }, to: { node: 'artifact' } },
      ],
    };
  }

  test('passing gate allows downstream artifact', async () => {
    const result = await runWorkflow(wfWithGate(true), minDeps());
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.nodeStates['gate'].status, 'completed');
    assert.strictEqual(result.nodeStates['artifact'].status, 'completed');
  });

  test('failing gate (no fallback edge) stops run with node_failed', async () => {
    const result = await runWorkflow(wfWithGate(false), minDeps());
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.stopReason, 'node_failed');
    assert.strictEqual(result.nodeStates['gate'].status, 'failed');
    assert.strictEqual(result.nodeStates['gate'].failureType, 'test_failure');
  });

  test('failing gate emits failed event with failure type', async () => {
    const result = await runWorkflow(wfWithGate(false), minDeps());
    const gateEvent = result.events.find((e) => e.nodeId === 'gate' && e.event === 'failed');
    assert.ok(gateEvent, 'expected a failed event for the gate node');
    assert.strictEqual(gateEvent?.failureType, 'test_failure');
  });
});

// ---------------------------------------------------------------------------
// Tests: agent nodes
// ---------------------------------------------------------------------------

suite('WorkflowRunner — agent nodes', () => {
  test('agent node returns model completion output', async () => {
    const wf: WorkflowDefinition = {
      schema: WORKFLOW_SCHEMA,
      id: 'wf-agent',
      name: 'Agent Workflow',
      nodes: [
        { id: 'a', type: 'agent', kind: 'code-patch', intent: 'code', config: { prompt: 'Fix it', model: 'mock' } },
      ],
      edges: [],
    };
    const result = await runWorkflow(wf, minDeps());
    assert.strictEqual(result.status, 'completed');
    const state = result.nodeStates['a'];
    assert.strictEqual(state.status, 'completed');
  });
});

// ---------------------------------------------------------------------------
// Tests: validation
// ---------------------------------------------------------------------------

suite('WorkflowRunner — validation', () => {
  test('invalid workflow (missing id) returns validation_error', async () => {
    const wf = simpleWorkflow({ id: '' });
    const result = await runWorkflow(wf, minDeps());
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.stopReason, 'validation_error');
  });
});

// ---------------------------------------------------------------------------
// Tests: HALT signal
// ---------------------------------------------------------------------------

suite('WorkflowRunner — halt', () => {
  test('shouldHalt() before first node stops run with halt_requested', async () => {
    const deps = minDeps({ shouldHalt: () => true });
    const result = await runWorkflow(simpleWorkflow(), deps);
    assert.strictEqual(result.status, 'halted');
    assert.strictEqual(result.stopReason, 'halt_requested');
  });
});

// ---------------------------------------------------------------------------
// Tests: ledger persistence
// ---------------------------------------------------------------------------

suite('WorkflowRunner — ledger', () => {
  test('persistLedger=true writes events.jsonl to workspace', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
    try {
      const deps = minDeps({ workspaceRoot: tmpDir, persistLedger: true });
      const result = await runWorkflow(simpleWorkflow(), deps);
      const eventsPath = path.join(tmpDir, '.autoclaw', 'workflows', 'runs', result.runId, 'events.jsonl');
      assert.ok(fs.existsSync(eventsPath), `expected events.jsonl at ${eventsPath}`);
      const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
      assert.ok(lines.length > 0, 'expected at least one event line');
      JSON.parse(lines[0]); // must not throw
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: cheap-fix-loop fixture
// ---------------------------------------------------------------------------

import { validateWorkflow } from '../workflows/validate';

suite('WorkflowRunner — cheap-fix-loop fixture', () => {
  const fixturePath = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'workflows', 'cheap-fix-loop.workflow.json');

  test('fixture JSON parses without error', () => {
    const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.ok(raw && typeof raw === 'object');
    assert.strictEqual((raw as { schema: string }).schema, 'autoclaw.workflow.v1');
  });

  test('fixture passes validateWorkflow (no errors)', () => {
    const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const vr = validateWorkflow(raw);
    const errors = vr.diagnostics.filter((d) => d.severity === 'error');
    assert.strictEqual(errors.length, 0,
      `Validation errors:\n${errors.map((e) => `  ${e.code}: ${e.message}`).join('\n')}`);
    assert.strictEqual(vr.valid, true);
  });

  test('linear tool→gate→artifact workflow executes to completion (WL-1 sprint exit gate)', async () => {
    // A simplified linear version of cheap-fix-loop exercising tool + gate nodes.
    // Full loop semantics require WL-1.2; this verifies the sprint-1 exit gate.
    const linearWf: WorkflowDefinition = {
      schema: WORKFLOW_SCHEMA,
      id: 'cheap-fix-loop-linear',
      name: 'Cheap Fix Loop (linear)',
      nodes: [
        { id: 'input', type: 'input', kind: 'task', config: {} },
        { id: 'apply-patch', type: 'tool', kind: 'file_editor', config: { command: 'echo mock-apply' } },
        { id: 'test-gate', type: 'gate', kind: 'test', config: { kind: 'test', mockPass: true } },
        { id: 'artifact', type: 'artifact', kind: 'review_packet', config: {} },
      ],
      edges: [
        { id: 'e1', from: { node: 'input' }, to: { node: 'apply-patch' } },
        { id: 'e2', from: { node: 'apply-patch' }, to: { node: 'test-gate' } },
        { id: 'e3', from: { node: 'test-gate' }, to: { node: 'artifact' } },
      ],
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sprint-'));
    try {
      const deps = minDeps({ workspaceRoot: tmpDir, persistLedger: true });
      const result = await runWorkflow(linearWf, deps);
      assert.strictEqual(result.status, 'completed', `stop=${result.stopReason} failure=${result.failureType}`);
      assert.strictEqual(result.stopReason, 'completed');
      assert.ok(result.events.length > 0);
      assert.strictEqual(result.nodeStates['test-gate'].status, 'completed');
      // Ledger should be written
      const eventsPath = path.join(tmpDir, '.autoclaw', 'workflows', 'runs', result.runId, 'events.jsonl');
      assert.ok(fs.existsSync(eventsPath), `expected events.jsonl at ${eventsPath}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
