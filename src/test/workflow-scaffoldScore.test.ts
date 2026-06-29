import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SCAFFOLD_SCHEMA,
  buildScaffoldScore,
  readScaffoldScores,
  scoreAndAppendScaffoldRun,
  type AntiHackingViolation,
  type ScaffoldVariant,
} from '../workflows/scaffolds';
import {
  WORKFLOW_RUN_EVENT_SCHEMA,
  WORKFLOW_SCHEMA,
  type WorkflowRunMetadata,
} from '../workflows/types';
import {
  appendRunEvent,
  summarizeRun,
  writeRunMetadata,
} from '../workflows/runLedger';

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-scaffold-score-'));
}

function scaffold(): ScaffoldVariant {
  return {
    schema: SCAFFOLD_SCHEMA,
    id: 'scaffold-review-local-v1',
    workflowId: 'wf-review',
    taskIntent: 'review',
    routerProfile: 'local-only',
    toolLaneIds: ['filesystem', 'mocha'],
    createdAt: '2026-06-28T00:00:00.000Z',
    promptHarnessId: 'qwen-xml-tools-v1',
    review: {
      tier: 'tier1-local',
      reviewerIndependence: 'different-provider',
      gatesFirst: true,
    },
  };
}

function metadata(runId: string, overrides: Partial<WorkflowRunMetadata> = {}): WorkflowRunMetadata {
  return {
    schema: 'autoclaw.workflowRun.v1',
    runId,
    workflowId: 'wf-review',
    workflowSchema: WORKFLOW_SCHEMA,
    status: 'running',
    startedAt: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

suite('workflow scaffold scorer', () => {
  let workspace: string;

  setup(() => {
    workspace = mkWorkspace();
  });

  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('mocked successful run summary produces a positive reward row', async () => {
    await writeRunMetadata(workspace, metadata('run-pass', {
      status: 'completed',
      completedAt: '2026-06-28T00:00:03.000Z',
    }));
    await appendRunEvent(workspace, {
      schema: WORKFLOW_RUN_EVENT_SCHEMA,
      runId: 'run-pass',
      nodeId: 'gate',
      event: 'completed',
      timestamp: '2026-06-28T00:00:03.000Z',
      tokens: { input: 10, output: 4, costCents: 0 },
      gateResults: [{ id: 'tests', kind: 'mocha', passed: true }],
    });

    const summary = await summarizeRun(workspace, 'run-pass');
    const result = buildScaffoldScore({
      scaffold: scaffold(),
      run: summary,
      review: { verifierPass: true },
      createdAt: '2026-06-28T00:00:04.000Z',
    });

    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(result.score?.pass, true);
    assert.strictEqual(result.score?.falseAccept, false);
    assert.strictEqual(result.score?.falseReject, false);
    assert.ok((result.score?.reward ?? 0) > 0.8);
  });

  test('gates, retries, cost, duration, and review verdict lower reward', () => {
    const result = buildScaffoldScore({
      scaffold: scaffold(),
      run: {
        runId: 'run-fail',
        workflowId: 'wf-review',
        status: 'failed',
        costCents: 250,
        durationMs: 120000,
        retryCount: 2,
        gateCount: 2,
        failedGateCount: 1,
        failureTypes: ['test_failure'],
      },
      review: { verifierPass: false, judgeVeto: true, reworkCount: 2 },
      createdAt: '2026-06-28T00:00:04.000Z',
    });

    assert.strictEqual(result.score?.pass, false);
    assert.strictEqual(result.score?.failureType, 'test_failure');
    assert.strictEqual(result.score?.retryCount, 2);
    assert.strictEqual(result.score?.reworkCount, 2);
    assert.ok((result.score?.reward ?? 1) < -0.5);
  });

  test('false accept and false reject are explicit reward hooks', () => {
    const falseAccept = buildScaffoldScore({
      scaffold: scaffold(),
      run: {
        runId: 'run-false-accept',
        workflowId: 'wf-review',
        status: 'completed',
        failureTypes: [],
      },
      review: { verifierPass: true, falseAccept: true },
      createdAt: '2026-06-28T00:00:04.000Z',
    });
    const falseReject = buildScaffoldScore({
      scaffold: scaffold(),
      run: {
        runId: 'run-false-reject',
        workflowId: 'wf-review',
        status: 'completed',
        failureTypes: [],
      },
      review: { verifierPass: true, falseReject: true },
      createdAt: '2026-06-28T00:00:04.000Z',
    });

    assert.strictEqual(falseAccept.score?.pass, false);
    assert.strictEqual(falseAccept.score?.falseAccept, true);
    assert.strictEqual(falseReject.score?.falseReject, true);
    assert.ok((falseAccept.score?.reward ?? 0) < (falseReject.score?.reward ?? 0));
  });

  test('anti-hacking violation forces non-pass and negative reward', () => {
    const violation: AntiHackingViolation = {
      kind: 'scope_violation',
      severity: 'fatal',
      summary: 'attempted score ledger edit',
    };

    const result = buildScaffoldScore({
      scaffold: scaffold(),
      run: {
        runId: 'run-hack',
        workflowId: 'wf-review',
        status: 'completed',
        failureTypes: [],
      },
      review: { verifierPass: true },
      antiHackingViolation: violation,
      createdAt: '2026-06-28T00:00:04.000Z',
    });

    assert.strictEqual(result.score?.pass, false);
    assert.strictEqual(result.score?.reward, -1);
    assert.strictEqual(result.score?.scopeViolation, true);
    assert.strictEqual(result.score?.failureType, 'scope_conflict');
  });

  test('incomplete or corrupt summaries degrade to warnings instead of throwing', () => {
    const result = buildScaffoldScore({
      scaffold: scaffold(),
      run: {
        workflowId: 'wf-review',
        costCents: Number.NaN,
        durationMs: -5,
        failureTypes: ['test_failure', 3] as unknown as string[],
      } as unknown as Parameters<typeof buildScaffoldScore>[0]['run'],
    });

    assert.strictEqual(result.score, undefined);
    assert.ok(result.warnings.some((warning) => warning.includes('run.runId is required')));
    assert.ok(result.warnings.some((warning) => warning.includes('non-string')));
  });

  test('scoreAndAppendScaffoldRun writes scaffold score rows', async () => {
    const result = await scoreAndAppendScaffoldRun(workspace, {
      scaffold: scaffold(),
      run: {
        runId: 'run-append',
        workflowId: 'wf-review',
        status: 'completed',
        failureTypes: [],
      },
      review: { verifierPass: true },
      createdAt: '2026-06-28T00:00:04.000Z',
    });
    const ledger = await readScaffoldScores(workspace);

    assert.strictEqual(result.score?.runId, 'run-append');
    assert.strictEqual(ledger.records.length, 1);
    assert.strictEqual(ledger.records[0].runId, 'run-append');
  });
});
