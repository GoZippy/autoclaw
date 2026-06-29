/**
 * workflow-fixtures.test.ts — validates WL-0.5 built-in workflow fixtures.
 *
 * Each fixture in docs/specs/recursive-workflow-lab/fixtures and
 * src/test/fixtures/workflows must pass validateWorkflow() from src/workflows/validate.
 *
 * This is the acceptance gate for WL-0.5: every fixture validates; fixtures
 * are small enough for unit tests but representative enough for UI.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { validateWorkflow } from '../workflows/validate';
import { WORKFLOW_SCHEMA, parseWorkflowDefinition } from '../workflows/types';

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'docs', 'specs', 'recursive-workflow-lab', 'fixtures');
const TEST_FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'workflows');

function fixtureFiles(): string[] {
  const dirs = [FIXTURES_DIR, TEST_FIXTURES_DIR];
  const files: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith('.workflow.json')) {
        files.push(path.join(dir, entry));
      }
    }
  }
  return files;
}

function requiredFixtureIds(): string[] {
  return [
    'cheap-fix-loop',
    'context-repair-loop',
    'adversarial-test-loop',
    'release-gate',
    'model-benchmark-routing',
  ];
}

function collectFixtureIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of fixtureFiles()) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const wf = JSON.parse(text) as { id?: string };
      if (typeof wf.id === 'string' && wf.id.length > 0) {
        ids.add(wf.id);
      }
    } catch {
      // ignore — per-file suite will fail on read
    }
  }
  return ids;
}

const FIXTURE_IDS = collectFixtureIds();

suite('WL-0.5 — Workflow Fixtures', () => {
  const files = fixtureFiles();
  const ids = new Set<string>(FIXTURE_IDS);

  for (const file of files) {
    const basename = path.basename(file);
    suite(`fixture: ${basename}`, () => {
      let raw: unknown;

      test('reads and parses as JSON', () => {
        const text = fs.readFileSync(file, 'utf8');
        raw = JSON.parse(text);
        assert.ok(raw && typeof raw === 'object');
      });

      test('has autoclaw.workflow.v1 schema', () => {
        assert.strictEqual((raw as { schema: string }).schema, WORKFLOW_SCHEMA);
      });

      test('passes validateWorkflow', () => {
        const result = validateWorkflow(raw);
        const errors = result.diagnostics.filter((d) => d.severity === 'error');
        assert.strictEqual(
          errors.length,
          0,
          `Validation errors:\n${errors.map((e) => `  - ${e.code}: ${e.message} (${e.path})`).join('\n')}`,
        );
        assert.strictEqual(result.valid, true);
      });

      test('has required top-level fields', () => {
        const wf = raw as Record<string, unknown>;
        assert.ok(typeof wf.id === 'string' && wf.id.length > 0, 'id required');
        assert.ok(typeof wf.name === 'string' && wf.name.length > 0, 'name required');
        assert.ok(Array.isArray(wf.nodes), 'nodes required');
        assert.ok(Array.isArray(wf.edges), 'edges required');
        ids.add(wf.id as string);
      });

      test('has contract with inputs, outputs, successCriteria', () => {
        const wf = raw as { contract?: { inputs?: unknown[]; outputs?: unknown[]; successCriteria?: unknown[] } };
        assert.ok(wf.contract, 'contract required');
        assert.ok(Array.isArray(wf.contract?.inputs) && wf.contract!.inputs.length > 0, 'contract.inputs required');
        assert.ok(Array.isArray(wf.contract?.outputs) && wf.contract!.outputs.length > 0, 'contract.outputs required');
        assert.ok(
          Array.isArray(wf.contract?.successCriteria) && wf.contract!.successCriteria.length > 0,
          'contract.successCriteria required',
        );
      });

      test('has policies with budget and routingProfile', () => {
        const wf = raw as { policies?: { budget?: unknown; routingProfile?: string } };
        assert.ok(wf.policies, 'policies required');
        assert.ok(wf.policies?.budget, 'policies.budget required');
        assert.ok(typeof wf.policies?.routingProfile === 'string', 'policies.routingProfile required');
      });

      test('every node has id, type, kind, config', () => {
        const wf = raw as { nodes: Array<{ id?: string; type?: string; kind?: string; config?: unknown }> };
        for (const node of wf.nodes) {
          assert.ok(typeof node.id === 'string' && node.id.length > 0, 'node.id required');
          assert.ok(typeof node.type === 'string' && node.type.length > 0, 'node.type required');
          assert.ok(typeof node.kind === 'string' && node.kind.length > 0, 'node.kind required');
          assert.ok(node.config && typeof node.config === 'object', 'node.config required');
        }
      });

      test('every edge has id, from.node, to.node', () => {
        const wf = raw as {
          nodes: Array<{ id?: string }>;
          edges: Array<{ id?: string; from?: { node?: string }; to?: { node?: string } }>;
        };
        const ids = new Set(wf.nodes.map((n) => n.id));
        for (const edge of wf.edges) {
          assert.ok(typeof edge.id === 'string' && edge.id.length > 0, 'edge.id required');
          assert.ok(edge.from && typeof edge.from.node === 'string', 'edge.from.node required');
          assert.ok(edge.to && typeof edge.to.node === 'string', 'edge.to.node required');
          assert.ok(ids.has(edge.from!.node), `edge.from.node ${edge.from!.node} must exist`);
          assert.ok(ids.has(edge.to!.node), `edge.to.node ${edge.to!.node} must exist`);
        }
      });

      test('every gate node has config.criterion or config.check or config.command', () => {
        const wf = raw as {
          nodes: Array<{
            id: string;
            type: string;
            config: { criterion?: string; check?: string; command?: string };
          }>;
        };
        for (const node of wf.nodes) {
          if (node.type !== 'gate') {
            continue;
          }
          const hasCriterion = typeof node.config.criterion === 'string' && node.config.criterion.length > 0;
          const hasCheck = typeof node.config.check === 'string' && node.config.check.length > 0;
          const hasCommand = typeof node.config.command === 'string' && node.config.command.length > 0;
          assert.ok(
            hasCriterion || hasCheck || hasCommand,
            `gate node ${node.id} must have criterion, check, or command`,
          );
        }
      });

      test('every tool node has config.command or config.toolId or config.action', () => {
        const wf = raw as {
          nodes: Array<{
            id: string;
            type: string;
            config: { command?: string; toolId?: string; action?: string };
          }>;
        };
        for (const node of wf.nodes) {
          if (node.type !== 'tool') {
            continue;
          }
          const hasCommand = typeof node.config.command === 'string' && node.config.command.length > 0;
          const hasToolId = typeof node.config.toolId === 'string' && node.config.toolId.length > 0;
          const hasAction = typeof node.config.action === 'string' && node.config.action.length > 0;
          assert.ok(
            hasCommand || hasToolId || hasAction,
            `tool node ${node.id} must have command, toolId, or action`,
          );
        }
      });

      test('every agent node has config.provider or config.model', () => {
        const wf = raw as {
          nodes: Array<{
            id: string;
            type: string;
            config: { provider?: string; providerId?: string; model?: string };
          }>;
        };
        for (const node of wf.nodes) {
          if (node.type !== 'agent') {
            continue;
          }
          const hasProvider =
            (typeof node.config.provider === 'string' && node.config.provider.length > 0) ||
            (typeof node.config.providerId === 'string' && node.config.providerId.length > 0);
          const hasModel = typeof node.config.model === 'string' && node.config.model.length > 0;
          assert.ok(hasProvider || hasModel, `agent node ${node.id} must have provider or model`);
        }
      });

      test('metadata includes packId and tags', () => {
        const wf = raw as { metadata?: { packId?: string; tags?: string[] } };
        assert.ok(wf.metadata, 'metadata required');
        assert.ok(typeof wf.metadata?.packId === 'string' && wf.metadata.packId.length > 0, 'packId required');
        assert.ok(Array.isArray(wf.metadata?.tags) && wf.metadata!.tags.length > 0, 'tags required');
      });
    });
  }

  for (const required of requiredFixtureIds()) {
    test(`includes required fixture: ${required}`, () => {
      assert.ok(ids.has(required), `Required fixture ${required} is missing from fixtures dir`);
    });
  }

  test('parseWorkflow round-trips each fixture', () => {
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const wf = parseWorkflowDefinition(text);
      assert.strictEqual(wf.schema, WORKFLOW_SCHEMA);
    }
  });
});
