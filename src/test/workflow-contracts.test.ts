import * as assert from 'assert';

import {
  WORKFLOW_SCHEMA,
  type WorkflowDefinition,
} from '../workflows/types';
import {
  summarizeWorkflowContract,
  validateWorkflowContract,
} from '../workflows/contracts';

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA,
    id: 'wf-contract',
    name: 'Contract Workflow',
    contract: {
      inputs: [{ id: 'task', type: 'string', required: true }],
      outputs: [{ id: 'report', type: 'artifact' }],
      invariants: [{ id: 'no-src-writes', description: 'Do not write source files', noTouchGlobs: ['src/**'] }],
      requiredTools: [{ id: 'test-runner', name: 'npm test', required: true }],
      requiredModels: [{ id: 'local-json', capabilities: ['json', 'tools'], locality: 'local', minContextWindow: 8192 }],
      requiredPermissions: [{ id: 'exec-tests', kind: 'execute', scope: 'npm test' }],
      successCriteria: [{ id: 'tests-pass', description: 'Tests pass', gateNodeId: 'test-gate' }],
      privacy: [{ id: 'local-only', dataSensitivity: 'project-private', allowedLocalities: ['local', 'lan'] }],
      recovery: { onFailure: 'route', maxAttempts: 2 },
    },
    nodes: [
      { id: 'input', type: 'input', kind: 'manual', config: {} },
      { id: 'test-gate', type: 'gate', kind: 'test', config: { command: 'npm test', criterion: 'exit_code == 0' } },
      { id: 'report', type: 'artifact', kind: 'report', config: { path: 'artifacts/report.md' } },
    ],
    edges: [
      { id: 'e1', from: { node: 'input' }, to: { node: 'test-gate' } },
      { id: 'e2', from: { node: 'test-gate' }, to: { node: 'report' } },
    ],
    ...overrides,
  };
}

const fullContext = {
  availableTools: [{ id: 'test-runner' }],
  availableModels: [{ id: 'local-json', locality: 'local' as const, capabilities: ['json' as const, 'tools' as const], contextWindow: 16000 }],
  grantedPermissions: [{ id: 'exec-tests', kind: 'execute' as const, scope: 'npm test' }],
};

suite('workflow contracts', () => {
  test('valid contract preflight passes and returns policy decisions', () => {
    const result = validateWorkflowContract(workflow(), fullContext);
    assert.strictEqual(result.valid, true, JSON.stringify(result.diagnostics));
    assert.ok(result.policyDecisions.some((decision) => decision.policyId === 'required-tool:test-runner' && decision.allowed));
    assert.ok(result.policyDecisions.some((decision) => decision.policyId === 'required-model:local-json' && decision.allowed));
    assert.ok(result.policyDecisions.some((decision) => decision.policyId === 'required-permission:exec-tests' && decision.allowed));
  });

  test('workflow with missing required tool fails preflight', () => {
    const result = validateWorkflowContract(workflow(), {
      ...fullContext,
      availableTools: [],
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'contract.tool_missing'));
    assert.ok(result.policyDecisions.some((decision) => decision.policyId === 'required-tool:test-runner' && !decision.allowed));
  });

  test('workflow with declared no-touch invariant blocks write node targeting that scope', () => {
    const result = validateWorkflowContract(workflow({
      nodes: [
        { id: 'input', type: 'input', kind: 'manual', config: {} },
        { id: 'write-src', type: 'tool', kind: 'file_editor', config: { action: 'apply_patch', file: 'src/unsafe.ts' } },
      ],
    }), fullContext);

    assert.strictEqual(result.valid, false);
    const invariant = result.diagnostics.find((diagnostic) => diagnostic.code === 'contract.invariant_no_touch_violation');
    assert.ok(invariant);
    assert.strictEqual(invariant.failureType, 'scope_conflict');
    assert.ok(result.policyDecisions.some((decision) => decision.policyId === 'invariant:no-src-writes' && !decision.allowed));
  });

  test('contract shape diagnostics surface missing requirements before execution', () => {
    const result = validateWorkflowContract(workflow({
      contract: {
        inputs: [],
        outputs: [],
        successCriteria: [],
      },
    }));

    assert.strictEqual(result.valid, false);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'contract.inputs_required'));
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'contract.outputs_required'));
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'contract.success_criteria_required'));
  });

  test('missing required permission and model produce actionable preflight diagnostics when context is supplied', () => {
    const result = validateWorkflowContract(workflow(), {
      availableTools: [{ id: 'test-runner' }],
      availableModels: [{ id: 'tiny-local', locality: 'local', capabilities: ['json'], contextWindow: 2048 }],
      grantedPermissions: [{ kind: 'read', scope: 'src/**' }],
    });

    assert.strictEqual(result.valid, false);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'contract.model_missing'));
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'contract.permission_missing'));
  });

  test('contract summary is available to UI and run ledger callers', () => {
    const summary = summarizeWorkflowContract(workflow());
    assert.deepStrictEqual(summary.requiredToolIds, ['test-runner']);
    assert.deepStrictEqual(summary.requiredModelIds, ['local-json']);
    assert.deepStrictEqual(summary.requiredPermissionIds, ['exec-tests']);
    assert.deepStrictEqual(summary.successCriteriaIds, ['tests-pass']);
    assert.deepStrictEqual(summary.privacyConstraintIds, ['local-only']);
    assert.strictEqual(summary.recovery, 'route');
  });
});
