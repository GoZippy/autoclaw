import * as assert from 'assert';

import { WORKFLOW_SCHEMA, type WorkflowDefinition } from '../workflows/types';
import { simulateWorkflow } from '../workflows/simulate';

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA,
    id: 'wf-sim',
    name: 'Simulated Workflow',
    contract: {
      inputs: [{ id: 'task', type: 'string', required: true }],
      outputs: [{ id: 'report', type: 'artifact' }],
      requiredTools: [{ id: 'test-runner', required: true }],
      requiredModels: [
        { id: 'cheap-local', locality: 'local', capabilities: ['json', 'tools'], minContextWindow: 4096 },
        { id: 'premium-review', locality: 'cloud', capabilities: ['json', 'tools', 'long-context'], minContextWindow: 64000 },
      ],
      requiredPermissions: [{ id: 'write-report', kind: 'write', scope: 'artifacts/**' }],
      successCriteria: [{ id: 'report-written', description: 'Report artifact exists' }],
      privacy: [{ id: 'public-ok', dataSensitivity: 'public', allowedLocalities: ['local', 'lan', 'cloud'] }],
    },
    policies: {
      routingProfile: 'balanced',
      allowWrites: true,
      budget: { maxIterations: 2, maxCostCents: 100 },
      premiumModelPolicy: {
        allowedProviders: ['openai-compatible'],
        minAttemptsBeforeEscalation: 1,
        allowedFailureTriggers: ['acceptance_failure'],
      },
    },
    nodes: [
      { id: 'input', type: 'input', kind: 'manual', config: {} },
      { id: 'agent', type: 'agent', kind: 'model_call', config: { provider: 'ollama', model: 'qwen' } },
      { id: 'test', type: 'gate', kind: 'test', config: { command: 'npm test', criterion: 'exit_code == 0' } },
      { id: 'report', type: 'artifact', kind: 'report', config: { path: 'artifacts/report.md' } },
    ],
    edges: [
      { id: 'e1', from: { node: 'input' }, to: { node: 'agent' } },
      { id: 'e2', from: { node: 'agent' }, to: { node: 'test' } },
      { id: 'e3', from: { node: 'test' }, to: { node: 'report' } },
    ],
    ...overrides,
  };
}

const availableModels = [
  { id: 'cheap-local', provider: 'ollama', model: 'qwen', locality: 'local' as const, capabilities: ['json' as const, 'tools' as const], contextWindow: 8192 },
  { id: 'premium-review', provider: 'openai-compatible', model: 'gpt-review', locality: 'cloud' as const, capabilities: ['json' as const, 'tools' as const, 'long-context' as const], contextWindow: 128000 },
];

suite('workflow simulation planner', () => {
  test('local-only policy simulation excludes cloud models', () => {
    const result = simulateWorkflow(workflow({
      policies: { routingProfile: 'local-only', allowWrites: true, budget: { maxIterations: 1 } },
    }), {
      availableTools: [{ id: 'test-runner' }],
      availableModels,
      grantedPermissions: [{ id: 'write-report', kind: 'write', scope: 'artifacts/**' }],
    });

    assert.ok(result.eligibleModels.some((model) => model.locality === 'local'));
    assert.ok(!result.eligibleModels.some((model) => model.locality === 'cloud'));
  });

  test('missing tool appears as actionable blocker', () => {
    const result = simulateWorkflow(workflow(), {
      availableTools: [],
      availableModels,
      grantedPermissions: [{ id: 'write-report', kind: 'write', scope: 'artifacts/**' }],
    });

    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(result.missingTools, ['test-runner']);
    assert.ok(result.blockedNodes.some((blocker) => blocker.code === 'simulation.missing_tool' && blocker.remediation));
  });

  test('estimated premium escalation path is visible before run', () => {
    const result = simulateWorkflow(workflow(), {
      availableTools: [{ id: 'test-runner' }],
      availableModels,
      grantedPermissions: [{ id: 'write-report', kind: 'write', scope: 'artifacts/**' }],
      costPerNodeCents: 2,
      durationPerNodeSeconds: 5,
    });

    assert.ok(result.eligibleModels.some((model) => model.requirementId === 'premium-review' && model.locality === 'cloud'));
    assert.strictEqual(result.estimatedCostCents.min, 8);
    assert.strictEqual(result.estimatedCostCents.max, 16);
    assert.strictEqual(result.estimatedDurationSeconds.min, 20);
    assert.strictEqual(result.estimatedDurationSeconds.max, 40);
  });

  test('write permission and human approval requirements are surfaced without execution', () => {
    const result = simulateWorkflow(workflow({
      policies: { routingProfile: 'balanced', allowWrites: false, requireHumanApproval: true },
    }), {
      availableTools: [{ id: 'test-runner' }],
      availableModels,
      grantedPermissions: [{ id: 'write-report', kind: 'write', scope: 'artifacts/**' }],
    });

    assert.ok(result.writePermissions.some((permission) => permission.nodeId === 'report' && permission.requiresApproval));
    assert.ok(result.humanApprovals.includes('workflow-policy'));
    assert.ok(result.blockedNodes.some((blocker) => blocker.code === 'simulation.write_permission_required'));
  });

  test('likely execution path is reported for valid graph shape', () => {
    const result = simulateWorkflow(workflow(), {
      availableTools: [{ id: 'test-runner' }],
      availableModels,
      grantedPermissions: [{ id: 'write-report', kind: 'write', scope: 'artifacts/**' }],
    });

    assert.deepStrictEqual(result.likelyPath, ['input', 'agent', 'test', 'report']);
  });
});
