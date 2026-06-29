import * as assert from 'assert';

import { evaluatePremiumEscalation } from '../workflows/escalationPolicy';
import type { CandidateModel } from '../workflows/intentRouter';
import type { PremiumModelPolicy } from '../workflows/types';

const candidate: CandidateModel = {
  providerId: 'openai-compatible',
  model: 'gpt-review',
  locality: 'cloud',
  healthy: true,
  capabilities: ['json', 'tools', 'long-context'],
  contextWindow: 128000,
  costCents: 25,
};

const policy: PremiumModelPolicy = {
  allowedProviders: ['openai-compatible'],
  maxCostCents: 50,
  minAttemptsBeforeEscalation: 2,
  allowedFailureTriggers: ['acceptance_failure', 'tool_format_invalid'],
  requiresHumanApproval: false,
};

function input(overrides: Parameters<typeof evaluatePremiumEscalation>[0] extends infer T ? Partial<T> : never = {}) {
  return {
    runId: 'run-1',
    nodeId: 'agent',
    timestamp: '2026-06-28T00:00:00.000Z',
    policy,
    attempts: 2,
    previousFailures: ['acceptance_failure' as const],
    candidate,
    budgetRemainingCents: 100,
    ...overrides,
  };
}

suite('workflow escalation policy', () => {
  test('local failures escalate only after threshold', () => {
    const decision = evaluatePremiumEscalation(input({ attempts: 1 }));
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.reason, 'threshold_not_met');
  });

  test('disallowed provider is never selected', () => {
    const decision = evaluatePremiumEscalation(input({
      candidate: { ...candidate, providerId: 'unapproved-provider' },
    }));
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.reason, 'provider_not_allowed');
    assert.strictEqual(decision.selected, undefined);
  });

  test('human approval requirement blocks automatic escalation', () => {
    const decision = evaluatePremiumEscalation(input({
      policy: { ...policy, requiresHumanApproval: true },
      humanApproved: false,
    }));
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.reason, 'human_approval_required');
  });

  test('release/security override requires human approval', () => {
    const decision = evaluatePremiumEscalation(input({
      releaseCritical: true,
      humanApproved: false,
    }));
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.reason, 'release_or_security_override_requires_human');
  });

  test('respects budget HALT before selecting premium model', () => {
    const decision = evaluatePremiumEscalation(input({
      budgetRemainingCents: 10,
    }));
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.reason, 'budget_exhausted');
  });

  test('allowed escalation emits auditable escalated run event', () => {
    const decision = evaluatePremiumEscalation(input());
    assert.strictEqual(decision.allowed, true);
    assert.strictEqual(decision.selected?.providerId, 'openai-compatible');
    assert.strictEqual(decision.runEvent?.event, 'escalated');
    assert.strictEqual(decision.runEvent?.retryCount, 2);
    assert.strictEqual(decision.runEvent?.model?.provider, 'openai-compatible');
    assert.strictEqual(decision.runEvent?.policyDecision?.allowed, true);
    assert.ok(decision.runEvent?.summary?.includes('after 2 attempt'));
  });

  test('failure trigger must be allowed by policy', () => {
    const decision = evaluatePremiumEscalation(input({
      previousFailures: ['context_missing'],
    }));
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.reason, 'failure_trigger_not_allowed');
  });
});
