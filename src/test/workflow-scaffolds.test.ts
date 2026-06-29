import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  PROMPT_HARNESS_SCHEMA,
  SCAFFOLD_SCHEMA,
  SCAFFOLD_SCORE_SCHEMA,
  appendPromptHarnessContract,
  appendScaffoldScore,
  appendScaffoldVariant,
  parseScaffoldVariant,
  readPromptHarnessContracts,
  readScaffoldScores,
  readScaffoldVariants,
  scaffoldScoresPath,
  type PromptHarnessContract,
  type ScaffoldScore,
  type ScaffoldVariant,
} from '../workflows/scaffolds';

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-workflow-scaffolds-'));
}

function variant(overrides: Partial<ScaffoldVariant> = {}): ScaffoldVariant {
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
      reviewerIndependence: 'different-model',
      gatesFirst: true,
    },
    ...overrides,
  };
}

function promptHarness(overrides: Partial<PromptHarnessContract> = {}): PromptHarnessContract {
  return {
    schema: PROMPT_HARNESS_SCHEMA,
    id: 'qwen-xml-tools-v1',
    roleFormat: 'qwen-xml',
    toolCallFormat: 'xml',
    toolResponseFormat: 'xml',
    reasoningFormat: 'tagged',
    supportsVisionInSystem: false,
    modelFamily: 'qwen',
    requiresReasoningParser: true,
    requiresToolParser: true,
    ...overrides,
  };
}

function score(overrides: Partial<ScaffoldScore> = {}): ScaffoldScore {
  return {
    schema: SCAFFOLD_SCORE_SCHEMA,
    scaffoldId: 'scaffold-review-local-v1',
    runId: 'run-1',
    workflowId: 'wf-review',
    taskIntent: 'review',
    createdAt: '2026-06-28T00:01:00.000Z',
    pass: true,
    reward: 0.85,
    verifierPass: true,
    judgeVeto: false,
    scopeViolation: false,
    costCents: 0,
    durationMs: 1200,
    retryCount: 0,
    reworkCount: 0,
    promptHarnessId: 'qwen-xml-tools-v1',
    reviewerIndependence: 'different-model',
    ...overrides,
  };
}

suite('workflow scaffolds', () => {
  let workspace: string;

  setup(() => {
    workspace = mkWorkspace();
  });

  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('parses scaffold variants and preserves unknown future fields', () => {
    const parsed = parseScaffoldVariant({
      ...variant(),
      futureContract: { kgAblation: true },
    });

    assert.strictEqual(parsed.id, 'scaffold-review-local-v1');
    assert.deepStrictEqual(parsed.futureContract, { kgAblation: true });
  });

  test('appends and reads scaffold variants and prompt harness contracts', async () => {
    await appendScaffoldVariant(workspace, variant({ id: 'scaffold-a' }));
    await appendPromptHarnessContract(workspace, promptHarness({ metadata: { template: 'hf-chat-template' } }));

    const variants = await readScaffoldVariants(workspace);
    const harnesses = await readPromptHarnessContracts(workspace);

    assert.deepStrictEqual(variants.warnings, []);
    assert.deepStrictEqual(harnesses.warnings, []);
    assert.strictEqual(variants.records[0].id, 'scaffold-a');
    assert.strictEqual(harnesses.records[0].toolCallFormat, 'xml');
    assert.deepStrictEqual(harnesses.records[0].metadata, { template: 'hf-chat-template' });
  });

  test('appends and reads scaffold scores deterministically', async () => {
    await appendScaffoldScore(workspace, score({ runId: 'run-a', reward: 0.1 }));
    await appendScaffoldScore(workspace, score({ runId: 'run-b', reward: 0.9 }));

    const scores = await readScaffoldScores(workspace);

    assert.deepStrictEqual(scores.warnings, []);
    assert.deepStrictEqual(scores.records.map((record) => record.runId), ['run-a', 'run-b']);
    assert.deepStrictEqual(scores.records.map((record) => record.reward), [0.1, 0.9]);
  });

  test('skips corrupt scaffold score lines with warnings', async () => {
    await appendScaffoldScore(workspace, score({ runId: 'run-good' }));
    fs.appendFileSync(scaffoldScoresPath(workspace), '{ not json\n', 'utf8');

    const scores = await readScaffoldScores(workspace);

    assert.strictEqual(scores.records.length, 1);
    assert.strictEqual(scores.records[0].runId, 'run-good');
    assert.ok(scores.warnings.some((warning) => warning.includes('Skipped invalid scaffold score line')));
  });

  test('does not persist prompt or response content in scaffold scores', async () => {
    await appendScaffoldScore(workspace, {
      ...score(),
      metadata: {
        prompt: 'do not write prompt',
        responseText: 'do not write response',
        nested: {
          rawResponse: 'do not write nested response',
          keep: 'ok',
        },
      },
    });

    const raw = fs.readFileSync(scaffoldScoresPath(workspace), 'utf8');
    const scores = await readScaffoldScores(workspace);

    assert.ok(!raw.includes('do not write'));
    assert.ok(raw.includes('promptHarnessId'));
    assert.strictEqual(scores.records[0].promptHarnessId, 'qwen-xml-tools-v1');
    assert.deepStrictEqual(scores.records[0].metadata, { nested: { keep: 'ok' } });
  });
});
