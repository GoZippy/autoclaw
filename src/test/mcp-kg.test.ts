/**
 * mcp-kg.test.ts — Unit tests for the KGC-4 Knowledge Graph MCP tools.
 *
 * Exercises the kg.record (write) → kg.search (read) round-trip plus
 * kg.traverse and input validation, driven through the same JSON-RPC dispatch
 * path the host uses. Each test runs against a throwaway temp workspace so the
 * KG opens a real (FTS-backed) on-disk store; the per-process KG handle is
 * cached by workspace root, so we close it between tests to avoid bleed.
 *
 * Sprint — KGC-4 (KG↔Intelligence convergence)
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildContext,
  buildToolMap,
  dispatch,
  CostLedger,
  READ_ONLY_TOOLS,
  activeTools,
} from '../mcp';
import { closeKnowledgeGraph } from '../intelligence/kg/service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal workspace: an .autoclaw dir is enough for the KG to provision. */
function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-kg-'));
  fs.mkdirSync(path.join(root, '.autoclaw', 'mcp'), { recursive: true });
  // Enable writes so the gated kg.record/kg.relate tools run.
  fs.writeFileSync(
    path.join(root, '.autoclaw', 'mcp', 'config.json'),
    JSON.stringify({ allowWrites: true }, null, 2),
    'utf8'
  );
  return root;
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const ENV = {
  AUTOCLAW_MCP_SCOPE: 'workspace',
  AUTOCLAW_MCP_ALLOW_WRITES: 'true',
  AUTOCLAW_MCP_HOST: 'test',
};

/** Dispatch a tools/call against the full active tool set (read + gated write). */
async function callTool(
  root: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ ok: boolean; data?: unknown; reason?: string; isError: boolean }> {
  const ctx = buildContext(ENV, root);
  const ledger = new CostLedger(ctx.autoclawDir);
  const toolMap = buildToolMap(activeTools(ctx, ENV));
  const resp = await dispatch(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    ctx, toolMap, ledger, ENV
  );
  const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
  const payload = JSON.parse(result.content[0].text) as {
    ok: boolean; data?: unknown; reason?: string;
  };
  return { ...payload, isError: result.isError === true };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('MCP — KG tools (KGC-4)', () => {
  test('kg.record then kg.search round-trips a thought', async () => {
    const root = makeWorkspace();
    try {
      const rec = await callTool(root, 'kg.record', {
        kind: 'finding',
        text: 'the orchestrator uses a file-based message bus for cross-agent comms',
        agent: 'claude-code',
      });
      assert.strictEqual(rec.ok, true, 'kg.record should succeed');
      const recData = rec.data as { id: string; degraded: boolean };
      assert.ok(typeof recData.id === 'string');

      const found = await callTool(root, 'kg.search', { q: 'file-based message bus' });
      assert.strictEqual(found.ok, true, 'kg.search should succeed');
      const data = found.data as { thoughts: Array<{ text: string }>; degraded: boolean };
      assert.ok(Array.isArray(data.thoughts));
      if (!recData.degraded) {
        // With a working SQLite/FTS backend the just-recorded thought is recalled.
        assert.ok(recData.id.length > 0, 'a non-degraded record returns a real id');
        assert.ok(
          data.thoughts.some(t => /file-based message bus/.test(t.text)),
          'recorded thought should be recalled by kg.search'
        );
      } else {
        // Degraded backend: writes no-op, reads empty — but the flag tells callers.
        assert.strictEqual(data.degraded, true);
      }
    } finally {
      closeKnowledgeGraph();
      rmrf(root);
    }
  });

  test('kg.record defaults project to the workspace basename and agent to mcp', async () => {
    const root = makeWorkspace();
    try {
      const rec = await callTool(root, 'kg.record', { kind: 'note', text: 'a defaulted thought' });
      assert.strictEqual(rec.ok, true);
      const recData = rec.data as { id: string; degraded: boolean };
      if (!recData.degraded) {
        const found = await callTool(root, 'kg.search', {
          q: 'defaulted thought',
          project: path.basename(root),
        });
        const data = found.data as { thoughts: Array<{ project: string; agent: string }> };
        assert.ok(
          data.thoughts.some(t => t.project === path.basename(root) && t.agent === 'mcp'),
          'thought should carry the defaulted project + agent'
        );
      }
    } finally {
      closeKnowledgeGraph();
      rmrf(root);
    }
  });

  test('kg.search rejects a missing query', async () => {
    const root = makeWorkspace();
    try {
      const res = await callTool(root, 'kg.search', {});
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.reason, 'invalid_params');
    } finally {
      closeKnowledgeGraph();
      rmrf(root);
    }
  });

  test('kg.record rejects a missing kind/text', async () => {
    const root = makeWorkspace();
    try {
      const noKind = await callTool(root, 'kg.record', { text: 'x' });
      assert.strictEqual(noKind.ok, false);
      assert.strictEqual(noKind.reason, 'invalid_params');

      const noText = await callTool(root, 'kg.record', { kind: 'finding' });
      assert.strictEqual(noText.ok, false);
      assert.strictEqual(noText.reason, 'invalid_params');
    } finally {
      closeKnowledgeGraph();
      rmrf(root);
    }
  });

  test('kg.traverse rejects a missing seed and succeeds with one', async () => {
    const root = makeWorkspace();
    try {
      const bad = await callTool(root, 'kg.traverse', {});
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(bad.reason, 'invalid_params');

      const ok = await callTool(root, 'kg.traverse', { seed: 'nonexistent-id', kinds: ['mentions'] });
      assert.strictEqual(ok.ok, true);
      const data = ok.data as { thoughts: unknown[]; degraded: boolean };
      assert.ok(Array.isArray(data.thoughts));
    } finally {
      closeKnowledgeGraph();
      rmrf(root);
    }
  });

  test('kg.relate validates its three required ids', async () => {
    const root = makeWorkspace();
    try {
      const bad = await callTool(root, 'kg.relate', { from: 'a', kind: 'mentions' });
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(bad.reason, 'invalid_params');
    } finally {
      closeKnowledgeGraph();
      rmrf(root);
    }
  });
});
