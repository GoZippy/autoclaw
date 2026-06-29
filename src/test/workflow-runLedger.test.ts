import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  WORKFLOW_RUN_EVENT_SCHEMA,
  WORKFLOW_SCHEMA,
  type WorkflowDefinition,
  type WorkflowRunMetadata,
} from '../workflows/types';
import { validateWorkflow } from '../workflows/validate';
import {
  appendRunEvent,
  listRuns,
  readRun,
  runEventsPath,
  summarizeRun,
  writeRunMetadata,
} from '../workflows/runLedger';

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-workflow-ledger-'));
}

function minimalWorkflow(): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA,
    id: 'wf-ledger',
    name: 'Ledger Workflow',
    nodes: [
      { id: 'start', type: 'input', kind: 'manual', config: {} },
      { id: 'report', type: 'artifact', kind: 'report', config: { path: 'report.md' } },
    ],
    edges: [
      { id: 'e1', from: { node: 'start' }, to: { node: 'report' } },
    ],
  };
}

function metadata(runId: string): WorkflowRunMetadata {
  return {
    schema: 'autoclaw.workflowRun.v1',
    runId,
    workflowId: 'wf-ledger',
    workflowSchema: WORKFLOW_SCHEMA,
    status: 'running',
    startedAt: '2026-06-27T00:00:00.000Z',
  };
}

suite('workflow run ledger', () => {
  let workspace: string;

  setup(() => {
    workspace = mkWorkspace();
  });

  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('valid minimal workflow can be validated and written to the run ledger', async () => {
    const validation = validateWorkflow(minimalWorkflow());
    assert.strictEqual(validation.valid, true, JSON.stringify(validation.diagnostics));

    await writeRunMetadata(workspace, metadata('run-valid'));
    await appendRunEvent(workspace, {
      schema: WORKFLOW_RUN_EVENT_SCHEMA,
      runId: 'run-valid',
      nodeId: 'start',
      event: 'completed',
      timestamp: '2026-06-27T00:00:01.000Z',
      artifacts: ['input.json'],
    });
    await appendRunEvent(workspace, {
      schema: WORKFLOW_RUN_EVENT_SCHEMA,
      runId: 'run-valid',
      nodeId: 'report',
      event: 'completed',
      timestamp: '2026-06-27T00:00:02.000Z',
      tokens: { input: 10, output: 5, costCents: 0 },
      artifacts: ['report.md'],
    });

    const run = await readRun(workspace, 'run-valid');
    assert.strictEqual(run.metadata?.workflowId, 'wf-ledger');
    assert.strictEqual(run.events.length, 2);
    assert.deepStrictEqual(run.warnings, []);
  });

  test('appends deterministic newline-delimited events', async () => {
    await appendRunEvent(workspace, {
      schema: WORKFLOW_RUN_EVENT_SCHEMA,
      runId: 'run-jsonl',
      nodeId: 'n1',
      event: 'queued',
      timestamp: '2026-06-27T00:00:00.000Z',
    });
    await appendRunEvent(workspace, {
      schema: WORKFLOW_RUN_EVENT_SCHEMA,
      runId: 'run-jsonl',
      nodeId: 'n1',
      event: 'started',
      timestamp: '2026-06-27T00:00:01.000Z',
    });

    const raw = fs.readFileSync(runEventsPath(workspace, 'run-jsonl'), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2);
    for (const line of lines) {
      assert.strictEqual(JSON.parse(line).schema, WORKFLOW_RUN_EVENT_SCHEMA);
    }
  });

  test('skips corrupt event lines with warnings instead of failing the read', async () => {
    await appendRunEvent(workspace, {
      schema: WORKFLOW_RUN_EVENT_SCHEMA,
      runId: 'run-corrupt',
      nodeId: 'n1',
      event: 'completed',
      timestamp: '2026-06-27T00:00:00.000Z',
    });
    fs.appendFileSync(runEventsPath(workspace, 'run-corrupt'), '{ not json\n', 'utf8');

    const run = await readRun(workspace, 'run-corrupt');
    assert.strictEqual(run.events.length, 1);
    assert.ok(run.warnings.some((warning) => warning.includes('corrupt event line')));
  });

  test('summarizes duration, status, cost, failure types, and artifact count', async () => {
    await writeRunMetadata(workspace, {
      ...metadata('run-summary'),
      status: 'failed',
      completedAt: '2026-06-27T00:00:05.000Z',
      failureType: 'test_failure',
    });
    await appendRunEvent(workspace, {
      schema: WORKFLOW_RUN_EVENT_SCHEMA,
      runId: 'run-summary',
      nodeId: 'test',
      event: 'failed',
      timestamp: '2026-06-27T00:00:05.000Z',
      failureType: 'test_failure',
      tokens: { input: 12, output: 4, costCents: 3 },
      artifacts: ['test.log', 'summary.md'],
    });

    const summary = await summarizeRun(workspace, 'run-summary');
    assert.strictEqual(summary.status, 'failed');
    assert.strictEqual(summary.durationMs, 5000);
    assert.strictEqual(summary.costCents, 3);
    assert.strictEqual(summary.inputTokens, 12);
    assert.strictEqual(summary.outputTokens, 4);
    assert.deepStrictEqual(summary.failureTypes, ['test_failure']);
    assert.strictEqual(summary.artifactCount, 2);
  });

  test('lists run metadata newest first', async () => {
    await writeRunMetadata(workspace, { ...metadata('old'), startedAt: '2026-06-27T00:00:00.000Z' });
    await writeRunMetadata(workspace, { ...metadata('new'), startedAt: '2026-06-27T00:01:00.000Z' });

    const runs = await listRuns(workspace);
    assert.deepStrictEqual(runs.map((run) => run.runId), ['new', 'old']);
  });

  test('sanitizes prompt and secret-like payloads from events', async () => {
    await appendRunEvent(workspace, {
      schema: WORKFLOW_RUN_EVENT_SCHEMA,
      runId: 'run-sanitize',
      nodeId: 'agent',
      event: 'completed',
      timestamp: '2026-06-27T00:00:00.000Z',
      inputs: { prompt: 'do not persist', visible: 'ok' },
      outputs: { response: 'do not persist', summary: 'done', apiKey: 'secret' },
    });

    const raw = fs.readFileSync(runEventsPath(workspace, 'run-sanitize'), 'utf8');
    assert.ok(!raw.includes('do not persist'));
    assert.ok(!raw.includes('secret'));
    assert.ok(raw.includes('visible'));
    assert.ok(raw.includes('summary'));
  });
});
