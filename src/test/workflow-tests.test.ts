import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { parseWorkflowDefinition, type WorkflowDefinition } from '../workflows/types';
import {
  formatWorkflowTestFailures,
  runWorkflowTestCase,
  type WorkflowTestCase,
} from '../workflows/tests';

function readFixture(name: string): WorkflowDefinition {
  const file = path.resolve(__dirname, '..', '..', 'docs', 'specs', 'recursive-workflow-lab', 'fixtures', name);
  return parseWorkflowDefinition(fs.readFileSync(file, 'utf8'));
}

function cheapFixCase(overrides: Partial<WorkflowTestCase> = {}): WorkflowTestCase {
  const workflow = readFixture('cheap-fix-loop.workflow.json');
  return {
    id: 'cheap-fix-loop-happy-path',
    workflowId: workflow.id,
    workflow,
    inputs: {
      task: 'fix failing parser test',
      targetFile: 'targetFile',
      testCommand: 'npm test -- parser',
    },
    contractContext: {
      availableTools: [{ id: 'test-runner' }, { id: 'file-editor' }],
      availableModels: [
        { id: 'cheap-model', locality: 'local', capabilities: ['tools', 'json'], contextWindow: 8192 },
        { id: 'strong-model', locality: 'lan', capabilities: ['tools', 'json', 'long-context'], contextWindow: 64000 },
      ],
      grantedPermissions: [
        { id: 'exec-test', kind: 'execute', scope: 'testCommand' },
        { id: 'write-target', kind: 'write', scope: 'targetFile' },
      ],
    },
    mocks: {
      nodes: {
        'context-pack': { outputs: { context: { files: ['src/parser.ts'] } } },
        'cheap-dispatch': { outputs: { patch: { file: 'targetFile', hunks: 1 } } },
        'apply-patch': { outputs: { applied: true } },
        'test-gate': { outputs: { passed: true }, artifacts: ['test-result.json'] },
        artifact: { outputs: { reviewPacket: 'review-packet.md' }, artifacts: ['review-packet.md'] },
        escalate: { status: 'skipped' },
      },
    },
    expect: [
      { type: 'status', status: 'passed' },
      { type: 'routing_profile', profile: 'cheap' },
      { type: 'route_includes', nodeId: 'cheap-dispatch' },
      { type: 'route_excludes', nodeId: 'escalate' },
      { type: 'artifact', path: 'review-packet.md' },
      { type: 'policy_decision', policyId: 'required-tool:test-runner', allowed: true },
      { type: 'node_output', nodeId: 'test-gate', key: 'passed', equals: true },
    ],
    ...overrides,
  };
}

suite('workflow pack tests', () => {
  test('fixture workflow test runs fully with mocked tools and models', () => {
    const result = runWorkflowTestCase(cheapFixCase());
    assert.strictEqual(result.passed, true, formatWorkflowTestFailures(result));
    assert.ok(result.route.includes('context-pack'));
    assert.ok(result.route.includes('apply-patch'));
    assert.ok(result.artifacts.includes('review-packet.md'));
  });

  test('expected route and routing profile assertions pass', () => {
    const result = runWorkflowTestCase(cheapFixCase());
    assert.strictEqual(result.expectations.find((item) => item.expectation.type === 'routing_profile')?.passed, true);
    assert.strictEqual(result.expectations.find((item) => item.expectation.type === 'route_excludes')?.passed, true);
  });

  test('supports expected failure type assertions from mocked gate output', () => {
    const result = runWorkflowTestCase(cheapFixCase({
      id: 'cheap-fix-loop-failure',
      mocks: {
        nodes: {
          'context-pack': { outputs: { context: { files: ['src/parser.ts'] } } },
          'cheap-dispatch': { outputs: { patch: { file: 'targetFile', hunks: 1 } } },
          'apply-patch': { outputs: { applied: true } },
          'test-gate': { status: 'failed', outputs: { passed: false, failureType: 'test_failure' }, failureType: 'test_failure' },
        },
      },
      expect: [
        { type: 'failure_type', failureType: 'test_failure' },
        { type: 'route_includes', nodeId: 'test-gate' },
        { type: 'route_excludes', nodeId: 'artifact' },
      ],
    }));
    assert.strictEqual(result.passed, true, formatWorkflowTestFailures(result));
  });

  test('supports expected policy decision assertions from contract preflight', () => {
    const result = runWorkflowTestCase(cheapFixCase({
      contractContext: {
        availableTools: [{ id: 'test-runner' }],
        availableModels: [
          { id: 'cheap-model', locality: 'local', capabilities: ['tools', 'json'], contextWindow: 8192 },
          { id: 'strong-model', locality: 'lan', capabilities: ['tools', 'json', 'long-context'], contextWindow: 64000 },
        ],
        grantedPermissions: [
          { id: 'exec-test', kind: 'execute', scope: 'testCommand' },
          { id: 'write-target', kind: 'write', scope: 'targetFile' },
        ],
      },
      expect: [
        { type: 'policy_decision', policyId: 'required-tool:file-editor', allowed: false },
      ],
    }));
    assert.strictEqual(result.passed, false);
    assert.ok(result.policyDecisions.some((decision) => decision.policyId === 'required-tool:file-editor' && !decision.allowed));
    assert.ok(formatWorkflowTestFailures(result).includes('contract.tool_missing'));
  });

  test('failed expectation prints actionable diff', () => {
    const result = runWorkflowTestCase(cheapFixCase({
      expect: [{ type: 'artifact', path: 'missing.md' }],
    }));
    assert.strictEqual(result.passed, false);
    const formatted = formatWorkflowTestFailures(result);
    assert.ok(formatted.includes('$.artifacts'));
    assert.ok(formatted.includes('missing.md'));
    assert.ok(formatted.includes('review-packet.md'));
  });
});
