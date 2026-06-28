import * as assert from 'assert';

import {
  WORKFLOW_RUN_EVENT_SCHEMA,
  WORKFLOW_SCHEMA,
  parseWorkflowDefinition,
  parseWorkflowRunEvent,
  stringifyWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowRunEvent,
} from '../workflows/types';
import { validateWorkflow } from '../workflows/validate';

function minimalWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA,
    id: 'wf-minimal',
    name: 'Minimal Workflow',
    policies: { budget: { maxCostCents: 0, maxIterations: 1 } },
    nodes: [
      { id: 'input', type: 'input', kind: 'manual', config: {} },
      { id: 'artifact', type: 'artifact', kind: 'report', config: { path: 'report.md' } },
    ],
    edges: [
      { id: 'edge-1', from: { node: 'input' }, to: { node: 'artifact' }, type: 'control' },
    ],
    ...overrides,
  };
}

suite('workflow types', () => {
  test('exposes stable schema strings', () => {
    assert.strictEqual(WORKFLOW_SCHEMA, 'autoclaw.workflow.v1');
    assert.strictEqual(WORKFLOW_RUN_EVENT_SCHEMA, 'autoclaw.workflowRunEvent.v1');
  });

  test('parses a valid workflow fixture', () => {
    const workflow = parseWorkflowDefinition(JSON.stringify(minimalWorkflow()));
    const result = validateWorkflow(workflow);
    assert.strictEqual(result.valid, true, JSON.stringify(result.diagnostics));
  });

  test('preserves unknown future fields through parse and stringify', () => {
    const workflow = minimalWorkflow({
      futureTopLevel: { enabled: true },
      nodes: [
        { id: 'input', type: 'input', kind: 'manual', config: {}, futureNodeField: 'kept' },
      ],
      edges: [],
    } as Partial<WorkflowDefinition>);

    const parsed = parseWorkflowDefinition(stringifyWorkflowDefinition(workflow));
    assert.deepStrictEqual(parsed.futureTopLevel, { enabled: true });
    assert.strictEqual(parsed.nodes[0].futureNodeField, 'kept');
  });

  test('missing required IDs fail validation', () => {
    const workflow = minimalWorkflow({ id: '', nodes: [{ id: '', type: 'input', kind: 'manual', config: {} } as any] });
    const result = validateWorkflow(workflow);
    assert.strictEqual(result.valid, false);
    assert.ok(result.diagnostics.some((d) => d.code === 'workflow.id_required'));
    assert.ok(result.diagnostics.some((d) => d.code === 'node.id_required'));
  });

  test('parses a run event fixture', () => {
    const event: WorkflowRunEvent = {
      schema: WORKFLOW_RUN_EVENT_SCHEMA,
      runId: 'run-1',
      nodeId: 'input',
      event: 'completed',
      timestamp: '2026-06-27T00:00:00.000Z',
    };
    assert.deepStrictEqual(parseWorkflowRunEvent(JSON.stringify(event)), event);
  });
});
