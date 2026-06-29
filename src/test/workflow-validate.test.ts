import * as assert from 'assert';

import { WORKFLOW_SCHEMA, type WorkflowDefinition } from '../workflows/types';
import { validateWorkflow } from '../workflows/validate';

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA,
    id: 'wf-validate',
    name: 'Validate Me',
    policies: { budget: { maxCostCents: 0, maxIterations: 2 } },
    nodes: [
      { id: 'start', type: 'input', kind: 'manual', config: {} },
      { id: 'tool', type: 'tool', kind: 'shell', config: { command: 'npm test' } },
      { id: 'done', type: 'artifact', kind: 'report', config: { path: 'out.md' } },
    ],
    edges: [
      { id: 'e1', from: { node: 'start' }, to: { node: 'tool' }, type: 'control' },
      { id: 'e2', from: { node: 'tool' }, to: { node: 'done' }, type: 'control' },
    ],
    ...overrides,
  };
}

suite('workflow validation', () => {
  test('reports all actionable errors for a malformed workflow', () => {
    const malformed: WorkflowDefinition = workflow({
      id: '',
      policies: { budget: { maxCostCents: -1, maxIterations: 0 } },
      nodes: [
        { id: 'dup', type: 'tool', kind: 'shell', config: {} },
        { id: 'dup', type: 'gate', kind: 'test', config: {} },
      ],
      edges: [
        { id: 'edge', from: { node: 'dup' }, to: { node: 'missing' } },
        { id: 'edge', from: { node: 'missing' }, to: { node: 'dup' } },
      ],
    });

    const result = validateWorkflow(malformed);
    const codes = result.diagnostics.map((d) => d.code);
    assert.strictEqual(result.valid, false);
    assert.ok(codes.includes('workflow.id_required'));
    assert.ok(codes.includes('node.id_duplicate'));
    assert.ok(codes.includes('node.config.tool_target_required'));
    assert.ok(codes.includes('node.config.gate_criterion_required'));
    assert.ok(codes.includes('edge.id_duplicate'));
    assert.ok(codes.includes('edge.node_missing'));
    assert.ok(codes.includes('policy.budget_invalid'));
    assert.ok(codes.includes('policy.iterations_invalid'));
  });

  test('accepts a valid acyclic workflow', () => {
    const result = validateWorkflow(workflow());
    assert.strictEqual(result.valid, true, JSON.stringify(result.diagnostics));
  });

  test('rejects an accidental cycle without a loop node', () => {
    const result = validateWorkflow(workflow({
      edges: [
        { id: 'e1', from: { node: 'start' }, to: { node: 'tool' } },
        { id: 'e2', from: { node: 'tool' }, to: { node: 'start' } },
      ],
    }));
    assert.strictEqual(result.valid, false);
    assert.ok(result.diagnostics.some((d) => d.code === 'graph.cycle_without_loop'));
  });

  test('allows a cycle when an explicit loop node participates', () => {
    const loopWorkflow = workflow({
      nodes: [
        { id: 'start', type: 'input', kind: 'manual', config: {} },
        { id: 'loop', type: 'loop', kind: 'retry', config: { maxIterations: 2 } },
        { id: 'gate', type: 'gate', kind: 'test', config: { command: 'npm test' } },
      ],
      edges: [
        { id: 'e1', from: { node: 'start' }, to: { node: 'loop' } },
        { id: 'e2', from: { node: 'loop' }, to: { node: 'gate' } },
        { id: 'e3', from: { node: 'gate' }, to: { node: 'loop' } },
      ],
    });
    const result = validateWorkflow(loopWorkflow);
    assert.strictEqual(result.valid, true, JSON.stringify(result.diagnostics));
  });

  test('validates referenced ports when edge ports are declared', () => {
    const result = validateWorkflow(workflow({
      nodes: [
        { id: 'start', type: 'input', kind: 'manual', config: {}, ports: { outputs: [{ id: 'out', type: 'object' }] } },
        { id: 'done', type: 'artifact', kind: 'report', config: { path: 'out.md' }, ports: { inputs: [{ id: 'in', type: 'object' }] } },
      ],
      edges: [
        { id: 'e1', from: { node: 'start', port: 'missing' }, to: { node: 'done', port: 'in' } },
      ],
    }));
    assert.strictEqual(result.valid, false);
    assert.ok(result.diagnostics.some((d) => d.code === 'edge.port_missing'));
  });
});
