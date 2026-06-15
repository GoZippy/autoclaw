/**
 * fabricRouteTool.test.ts — MCP fabric.route read tool (DESIGN.md Gap D).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { READ_ONLY_TOOLS } from '../mcp/tools';
import type { ToolContext } from '../mcp/types';

function makeWorkspace(): { root: string; ctx: ToolContext } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-routetool-'));
  const commsDir = path.join(root, '.autoclaw', 'orchestrator', 'comms');
  fs.mkdirSync(path.join(commsDir, 'inboxes', 'shared'), { recursive: true });
  const registry = {
    agents: [
      { id: 'kiro', agent_type: 'supervisor', capabilities: ['code', 'orchestrate'], languages_supported: ['typescript'], trust_level: 'high', max_parallel_tasks: 1 },
      { id: 'claude-code', agent_type: 'coder', capabilities: ['code', 'security-review'], languages_supported: ['typescript', 'go'], trust_level: 'high', max_parallel_tasks: 2 },
      { id: 'kilocode', agent_type: 'coder', capabilities: ['code'], languages_supported: ['python'], trust_level: 'medium', max_parallel_tasks: 1 },
    ],
    ide: 'Visual Studio Code',
    provisioned_at: '2026-06-14T00:00:00.000Z',
    schema_version: '2',
  };
  fs.writeFileSync(path.join(commsDir, 'registry.json'), JSON.stringify(registry), 'utf8');
  const ctx: ToolContext = {
    workspaceRoot: root,
    autoclawDir: path.join(root, '.autoclaw'),
    scope: 'workspace',
    host: 'test',
  };
  return { root, ctx };
}

function tool() {
  const t = READ_ONLY_TOOLS.find(h => h.definition.name === 'fabric.route');
  assert.ok(t, 'fabric.route tool should be registered');
  return t!;
}

suite('MCP fabric.route tool', () => {
  test('is registered in the read-only tool set', () => {
    assert.ok(tool());
  });

  test('routes a security-review task to the only capable agent', async () => {
    const { ctx } = makeWorkspace();
    const res = await tool().run(ctx, { required_capabilities: ['code', 'security-review'], criticality: 1, language: 'typescript', task_id: 'task-8' });
    assert.strictEqual(res.ok, true);
    const data = (res as { ok: true; data: { chosen?: string; fallback: boolean } }).data;
    assert.strictEqual(data.chosen, 'claude-code');
    assert.strictEqual(data.fallback, false);
  });

  test('falls back when no agent has the capability', async () => {
    const { ctx } = makeWorkspace();
    const res = await tool().run(ctx, { required_capabilities: ['quantum'] });
    assert.strictEqual(res.ok, true);
    const data = (res as { ok: true; data: { chosen?: string; fallback: boolean } }).data;
    assert.strictEqual(data.chosen, undefined);
    assert.strictEqual(data.fallback, true);
  });

  test('returns not_found when registry is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-routetool-empty-'));
    fs.mkdirSync(path.join(root, '.autoclaw'), { recursive: true });
    const ctx: ToolContext = { workspaceRoot: root, autoclawDir: path.join(root, '.autoclaw'), scope: 'workspace', host: 'test' };
    const res = await tool().run(ctx, { required_capabilities: ['code'] });
    assert.strictEqual(res.ok, false);
  });
});
