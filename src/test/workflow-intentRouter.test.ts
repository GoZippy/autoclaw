import * as assert from 'assert';

import { routeWorkflowIntent, type CandidateModel } from '../workflows/intentRouter';

const candidates: CandidateModel[] = [
  {
    providerId: 'ollama',
    model: 'qwen-local',
    locality: 'local',
    healthy: true,
    capabilities: ['json', 'tools'],
    contextWindow: 8192,
    costCents: 0,
    benchmarkScore: 0.65,
    reputationScore: 0.7,
  },
  {
    providerId: 'lan-studio',
    model: 'qwen-lan-70b',
    locality: 'lan',
    healthy: true,
    capabilities: ['json', 'tools', 'long-context'],
    contextWindow: 64000,
    costCents: 2,
    benchmarkScore: 0.82,
    reputationScore: 0.8,
  },
  {
    providerId: 'openai-compatible',
    model: 'gpt-review',
    locality: 'cloud',
    healthy: true,
    capabilities: ['json', 'tools', 'long-context', 'vision'],
    contextWindow: 128000,
    costCents: 25,
    benchmarkScore: 0.96,
    reputationScore: 0.9,
  },
  {
    providerId: 'tiny',
    model: 'no-tools',
    locality: 'local',
    healthy: true,
    capabilities: ['json'],
    contextWindow: 4096,
    costCents: 0,
    benchmarkScore: 0.4,
  },
];

suite('workflow intent router', () => {
  test('local-only profile never selects cloud', () => {
    const decision = routeWorkflowIntent({
      intent: 'code',
      profile: 'local-only',
      candidates,
      requirements: { capabilities: ['json'] },
    });

    assert.strictEqual(decision.selected?.locality, 'local');
    assert.ok(decision.rejected.some((item) => item.providerId === 'openai-compatible' && item.reason.includes('locality cloud denied')));
  });

  test('quality profile escalates after configured failure', () => {
    const decision = routeWorkflowIntent({
      intent: 'review',
      profile: 'quality',
      candidates,
      previousFailures: ['acceptance_failure'],
      attempts: 2,
      escalation: {
        minAttemptsBeforeEscalation: 1,
        failureTriggers: ['acceptance_failure'],
      },
      requirements: { capabilities: ['json', 'tools', 'long-context'] },
    });

    assert.strictEqual(decision.selected?.providerId, 'openai-compatible');
    assert.ok(decision.reason.includes('escalation trigger'));
  });

  test('tool-use intent excludes model without tool capability', () => {
    const decision = routeWorkflowIntent({
      intent: 'tool-use',
      profile: 'cheap',
      candidates: [candidates[3], candidates[0]],
    });

    assert.strictEqual(decision.selected?.providerId, 'ollama');
    assert.ok(decision.rejected.some((item) => item.providerId === 'tiny' && item.reason.includes('missing capability tools')));
  });

  test('tool-use fallback can choose best available model when explicitly allowed', () => {
    const decision = routeWorkflowIntent({
      intent: 'tool-use',
      profile: 'cheap',
      candidates: [candidates[3]],
      requirements: { allowFallbackWithoutCapabilities: true },
    });

    assert.strictEqual(decision.selected?.providerId, 'tiny');
    assert.ok(decision.reason.includes('fallback used'));
  });

  test('uses ZippyMesh recommendation when candidate remains policy-eligible', () => {
    const decision = routeWorkflowIntent({
      intent: 'code',
      profile: 'balanced',
      candidates,
      recommendModel: () => ({ providerId: 'lan-studio', model: 'qwen-lan-70b', reason: 'ZippyMesh picked LAN 70B for code.' }),
    });

    assert.strictEqual(decision.usedRecommendation, true);
    assert.strictEqual(decision.selected?.providerId, 'lan-studio');
    assert.strictEqual(decision.reason, 'ZippyMesh picked LAN 70B for code.');
  });

  test('mentions recommended harness only when ZippyMesh provides one', () => {
    const decision = routeWorkflowIntent({
      intent: 'code',
      profile: 'balanced',
      candidates,
      recommendModel: () => ({
        providerId: 'lan-studio',
        model: 'qwen-lan-70b',
        harnessId: 'qwen-xml-tools',
        reason: 'ZippyMesh picked LAN 70B for code.',
      }),
    });

    assert.strictEqual(decision.usedRecommendation, true);
    assert.strictEqual(decision.recommendedHarnessId, 'qwen-xml-tools');
    assert.strictEqual(decision.reason, 'ZippyMesh picked LAN 70B for code.; harness=qwen-xml-tools');
  });

  test('reports no eligible model when all candidates violate hard policy', () => {
    const decision = routeWorkflowIntent({
      intent: 'long-context',
      profile: 'air-gapped',
      candidates: [candidates[1], candidates[2]],
      requirements: { capabilities: ['long-context'] },
    });

    assert.strictEqual(decision.selected, undefined);
    assert.ok(decision.reason.includes('No eligible model'));
  });
});
