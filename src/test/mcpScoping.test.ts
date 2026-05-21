/**
 * mcpScoping.test.ts — Sprint 3 BP3 (WA-3).
 *
 * Covers the MCP workspace/global scoping helpers, the per-tool authorization
 * policy, and the write-tool audit trail wired into writeTools.ts.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  WRITE_TOOL_NAMES,
  authorizeWriteTool,
  isGlobalScoped,
  isWorkspaceScoped,
  normalizeScope,
  parseToolAuthPolicy,
} from '../mcp/scoping';
import { WRITE_TOOLS } from '../mcp/writeTools';
import type { ToolContext } from '../mcp/types';

// ---------------------------------------------------------------------------
// Scope predicates
// ---------------------------------------------------------------------------

suite('mcp scoping — predicates', () => {
  test('isWorkspaceScoped / isGlobalScoped are complementary', () => {
    assert.ok(isWorkspaceScoped({ scope: 'workspace' }));
    assert.ok(!isGlobalScoped({ scope: 'workspace' }));
    assert.ok(isGlobalScoped({ scope: 'global' }));
  });

  test('normalizeScope only accepts the exact workspace string', () => {
    assert.strictEqual(normalizeScope('workspace'), 'workspace');
    assert.strictEqual(normalizeScope('WORKSPACE'), 'workspace');
    assert.strictEqual(normalizeScope('project'), 'global');
    assert.strictEqual(normalizeScope(undefined), 'global');
  });
});

// ---------------------------------------------------------------------------
// Per-tool authorization policy
// ---------------------------------------------------------------------------

suite('mcp scoping — parseToolAuthPolicy', () => {
  test('extracts well-formed entries', () => {
    const p = parseToolAuthPolicy({
      allowWrites: true,
      tools: { 'dream.run': { allow: false, reason: 'daemon owns it' } },
    });
    assert.strictEqual(p['dream.run']?.allow, false);
    assert.strictEqual(p['dream.run']?.reason, 'daemon owns it');
  });

  test('drops malformed entries rather than default-allowing', () => {
    const p = parseToolAuthPolicy({ tools: { 'inbox.send': { allow: 'yes' } } });
    assert.strictEqual(p['inbox.send'], undefined);
  });

  test('a non-object config yields an empty policy', () => {
    assert.deepStrictEqual(parseToolAuthPolicy(null), {});
    assert.deepStrictEqual(parseToolAuthPolicy('nope'), {});
    assert.deepStrictEqual(parseToolAuthPolicy({ tools: [] }), {});
  });
});

suite('mcp scoping — authorizeWriteTool', () => {
  test('global scope is always denied', () => {
    const d = authorizeWriteTool({ scope: 'global' }, true, 'note.add', {});
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.code, 'global_scope');
  });

  test('allowWrites false denies even in workspace scope', () => {
    const d = authorizeWriteTool({ scope: 'workspace' }, false, 'note.add', {});
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.code, 'writes_disabled');
  });

  test('per-tool deny withholds one tool while writes stay enabled', () => {
    const policy = { 'dream.run': { allow: false, reason: 'daemon owns it' } };
    const denied = authorizeWriteTool({ scope: 'workspace' }, true, 'dream.run', policy);
    assert.strictEqual(denied.allowed, false);
    assert.strictEqual(denied.code, 'tool_denied');
    assert.ok(denied.detail.includes('daemon owns it'));

    const allowed = authorizeWriteTool({ scope: 'workspace' }, true, 'note.add', policy);
    assert.strictEqual(allowed.allowed, true);
  });

  test('a tool absent from the policy inherits the coarse allow', () => {
    const d = authorizeWriteTool({ scope: 'workspace' }, true, 'inbox.send', {});
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(d.code, 'ok');
  });

  test('WRITE_TOOL_NAMES matches the registered write tools', () => {
    const registered = WRITE_TOOLS.map(t => t.definition.name).sort();
    assert.deepStrictEqual(registered, [...WRITE_TOOL_NAMES].sort());
  });
});

// ---------------------------------------------------------------------------
// Write-tool audit trail (writeTools.ts integration)
// ---------------------------------------------------------------------------

suite('mcp scoping — write-tool audit trail', () => {
  let dir: string;
  let ctx: ToolContext;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mcp-audit-'));
    const autoclawDir = path.join(dir, '.autoclaw');
    fs.mkdirSync(path.join(autoclawDir, 'mcp'), { recursive: true });
    ctx = {
      workspaceRoot: dir,
      autoclawDir,
      scope: 'workspace',
      host: 'claude-code',
      sessionId: 'sess-1234',
    };
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const tool = (name: string) => WRITE_TOOLS.find(t => t.definition.name === name)!;

  function readAudit(): unknown[] {
    const statePath = path.join(ctx.autoclawDir, 'orchestrator', 'state.json');
    const doc = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { write_tool_audit?: unknown[] };
    return doc.write_tool_audit ?? [];
  }

  test('a denied write (writes disabled) appends an audit row and is refused', async () => {
    // No mcp/config.json ⇒ allowWrites false ⇒ denied.
    const res = await tool('note.add').run(ctx, { text: 'hello' });
    assert.strictEqual(res.ok, false);
    const audit = readAudit() as Array<{ tool: string; authorized: boolean; auth_code: string }>;
    assert.strictEqual(audit.length, 1);
    assert.strictEqual(audit[0].tool, 'note.add');
    assert.strictEqual(audit[0].authorized, false);
    assert.strictEqual(audit[0].auth_code, 'writes_disabled');
  });

  test('an authorized write appends an audit row and runs the tool body', async () => {
    fs.writeFileSync(
      path.join(ctx.autoclawDir, 'mcp', 'config.json'),
      JSON.stringify({ allowWrites: true }),
      'utf8',
    );
    const res = await tool('note.add').run(ctx, { text: 'a captured note' });
    assert.strictEqual(res.ok, true);
    const audit = readAudit() as Array<{
      tool: string;
      authorized: boolean;
      result_ok?: boolean;
      from: string;
      session?: string;
    }>;
    const row = audit.find(r => r.tool === 'note.add')!;
    assert.strictEqual(row.authorized, true);
    assert.strictEqual(row.result_ok, true);
    assert.strictEqual(row.from, 'claude-code');
    assert.strictEqual(row.session, 'sess-1234');
    // The note itself was written.
    assert.ok(fs.existsSync(path.join(ctx.autoclawDir, 'dream', 'MEMORY.md')));
  });

  test('a per-tool deny refuses one tool while another still runs', async () => {
    fs.writeFileSync(
      path.join(ctx.autoclawDir, 'mcp', 'config.json'),
      JSON.stringify({ allowWrites: true, tools: { 'dream.run': { allow: false } } }),
      'utf8',
    );
    const denied = await tool('dream.run').run(ctx, {});
    assert.strictEqual(denied.ok, false);
    assert.strictEqual((denied as { reason: string }).reason, 'permission_denied');

    const allowed = await tool('note.add').run(ctx, { text: 'still works' });
    assert.strictEqual(allowed.ok, true);

    const audit = readAudit() as Array<{ tool: string; authorized: boolean }>;
    assert.ok(audit.some(r => r.tool === 'dream.run' && r.authorized === false));
    assert.ok(audit.some(r => r.tool === 'note.add' && r.authorized === true));
  });
});
