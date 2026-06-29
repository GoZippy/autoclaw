import * as assert from 'assert';

import {
  PROMPT_HARNESS_SCHEMA,
  SCAFFOLD_SCHEMA,
  SCAFFOLD_SCORE_SCHEMA,
  selectScaffoldVariant,
  type PromptHarnessContract,
  type ScaffoldScore,
  type ScaffoldVariant,
} from '../workflows/scaffolds';
import { routeWorkflowIntent, type CandidateModel } from '../workflows/intentRouter';

function scaffold(overrides: Partial<ScaffoldVariant> = {}): ScaffoldVariant {
  return {
    schema: SCAFFOLD_SCHEMA,
    id: 'scaffold-local-pass',
    workflowId: 'wf-review',
    taskIntent: 'review',
    routerProfile: 'cheap',
    toolLaneIds: ['filesystem', 'mocha'],
    createdAt: '2026-06-28T00:00:00.000Z',
    promptHarnessId: 'qwen-local',
    metadata: { localities: ['local', 'lan'], expectedCostCents: 0 },
    review: {
      tier: 'tier1-local',
      reviewerIndependence: 'different-model',
      gatesFirst: true,
    },
    ...overrides,
  };
}

function score(overrides: Partial<ScaffoldScore> = {}): ScaffoldScore {
  return {
    schema: SCAFFOLD_SCORE_SCHEMA,
    scaffoldId: 'scaffold-local-pass',
    runId: 'run-1',
    workflowId: 'wf-review',
    taskIntent: 'review',
    createdAt: '2026-06-28T00:05:00.000Z',
    pass: true,
    reward: 0.9,
    verifierPass: true,
    judgeVeto: false,
    scopeViolation: false,
    costCents: 0,
    durationMs: 1000,
    retryCount: 0,
    reworkCount: 0,
    promptHarnessId: 'qwen-local',
    reviewerIndependence: 'different-model',
    ...overrides,
  };
}

function harness(overrides: Partial<PromptHarnessContract> = {}): PromptHarnessContract {
  return {
    schema: PROMPT_HARNESS_SCHEMA,
    id: 'qwen-local',
    roleFormat: 'qwen-xml',
    toolCallFormat: 'xml',
    toolResponseFormat: 'xml',
    reasoningFormat: 'tagged',
    supportsVisionInSystem: false,
    modelFamily: 'qwen',
    capabilities: ['json', 'tools'],
    metadata: { localities: ['local', 'lan'] },
    ...overrides,
  };
}

suite('workflow scaffold selector', () => {
  test('passing low-cost scaffold outranks costly failing scaffold', () => {
    const decision = selectScaffoldVariant({
      intent: 'review',
      profile: 'cheap',
      now: '2026-06-29T00:00:00.000Z',
      variants: [
        scaffold({ id: 'scaffold-local-pass', metadata: { localities: ['local'], expectedCostCents: 0 } }),
        scaffold({
          id: 'scaffold-cloud-fail',
          routerProfile: 'quality',
          promptHarnessId: 'openai-tools',
          metadata: { localities: ['cloud'], expectedCostCents: 80 },
        }),
      ],
      promptHarnesses: [
        harness({ id: 'qwen-local' }),
        harness({ id: 'openai-tools', roleFormat: 'openai-responses', toolCallFormat: 'function-call', metadata: { locality: 'cloud' } }),
      ],
      scores: [
        score({ scaffoldId: 'scaffold-local-pass', reward: 0.82, pass: true, costCents: 0 }),
        score({ scaffoldId: 'scaffold-cloud-fail', reward: -0.7, pass: false, costCents: 80, failureType: 'test_failure' }),
      ],
    });

    assert.strictEqual(decision.selected?.id, 'scaffold-local-pass');
    assert.ok((decision.selectedScore ?? 0) > 0);
    assert.ok(decision.reason.includes('reward='));
    assert.ok(!decision.reason.includes('prompt'));
  });

  test('local-only and air-gapped profiles reject cloud-only harnesses', () => {
    for (const profile of ['local-only', 'air-gapped'] as const) {
      const decision = selectScaffoldVariant({
        intent: 'review',
        profile,
        variants: [
          scaffold({
            id: `cloud-${profile}`,
            routerProfile: profile,
            promptHarnessId: 'cloud-harness',
            metadata: { cloudOnly: true },
          }),
        ],
        promptHarnesses: [
          harness({ id: 'cloud-harness', metadata: { cloudOnly: true } }),
        ],
      });

      assert.strictEqual(decision.selected, undefined);
      assert.ok(decision.rejected[0].reason.includes('locality denied') || decision.rejected[0].reason.includes('harness locality'));
    }
  });

  test('previous failure type rewards scaffolds that fixed the same failure', () => {
    const decision = selectScaffoldVariant({
      intent: 'review',
      profile: 'balanced',
      previousFailureType: 'tool_format_invalid',
      variants: [
        scaffold({ id: 'fixed-format', routerProfile: 'balanced' }),
        scaffold({ id: 'still-format-bad', routerProfile: 'balanced' }),
      ],
      scores: [
        score({ scaffoldId: 'fixed-format', pass: true, reward: 0.4, failureType: 'tool_format_invalid' }),
        score({ scaffoldId: 'still-format-bad', pass: false, reward: 0.4, failureType: 'tool_format_invalid' }),
      ],
    });

    assert.strictEqual(decision.selected?.id, 'fixed-format');
  });

  test('intent router can attach scaffold choice without changing model routing', () => {
    const candidates: CandidateModel[] = [
      {
        providerId: 'ollama',
        model: 'qwen-local',
        locality: 'local',
        healthy: true,
        capabilities: ['json', 'tools', 'long-context'],
        contextWindow: 64000,
        costCents: 0,
        benchmarkScore: 0.8,
      },
    ];

    const decision = routeWorkflowIntent({
      intent: 'review',
      profile: 'cheap',
      candidates,
      scaffoldSelection: {
        variants: [scaffold({ id: 'router-scaffold' })],
        scores: [score({ scaffoldId: 'router-scaffold', reward: 0.75 })],
      },
    });

    assert.strictEqual(decision.selected?.providerId, 'ollama');
    assert.strictEqual(decision.selectedScaffold?.id, 'router-scaffold');
    assert.ok(decision.reason.includes('scaffold=router-scaffold'));
  });
});
