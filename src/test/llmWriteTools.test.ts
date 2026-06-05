/**
 * llmWriteTools.test.ts — PA-5/PA-6 (integrate-automate-v3.2, Lane C).
 * The gated MCP llm.chat / llm.models / llm.health write-tools.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  RAW_WRITE_TOOLS,
  WRITE_TOOLS,
  _setLlmRegistryFactoryForTests,
} from '../mcp/writeTools';
import type { ToolContext } from '../mcp/types';
import type { LlmRegistry } from '../llm';

function ctx(autoclawDir: string): ToolContext {
  return { workspaceRoot: path.dirname(autoclawDir), autoclawDir, scope: 'workspace', host: 'claude-code' };
}
function makeWs(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-llmtool-'));
  const autoclawDir = path.join(root, '.autoclaw');
  fs.mkdirSync(autoclawDir, { recursive: true });
  return autoclawDir;
}
function rawTool(name: string) {
  const t = RAW_WRITE_TOOLS.find(h => h.definition.name === name);
  if (!t) { throw new Error(`tool ${name} not registered`); }
  return t;
}

/** A fake registry covering just the surface the tools touch. */
function fakeRegistry(over: Partial<Record<'chat' | 'list', unknown>> = {}): LlmRegistry {
  const provider = {
    id: 'ollama',
    async models() { return [{ id: 'llama3.1:70b', sizeB: 70, local: true }]; },
    async health() { return { ok: true, reachable: true, authPresent: false, modelCount: 1, recentErrors: [] }; },
  };
  return {
    async chat() { return { ok: true, response: 'hi there', model: 'llama3.1:70b', servedBy: 'ollama', tokens: { input: 3, output: 2 }, durationMs: 12 }; },
    list() { return [provider]; },
    ...over,
  } as unknown as LlmRegistry;
}

teardown(() => { _setLlmRegistryFactoryForTests(null); });

suite('mcp llm.* write-tools — registration', () => {
  test('llm.chat / llm.models / llm.health are registered (gated + raw)', () => {
    for (const name of ['llm.chat', 'llm.models', 'llm.health']) {
      assert.ok(WRITE_TOOLS.some(t => t.definition.name === name), `${name} gated`);
      assert.ok(RAW_WRITE_TOOLS.some(t => t.definition.name === name), `${name} raw`);
    }
  });
});

suite('mcp llm.chat', () => {
  test('requires prompt or messages', async () => {
    _setLlmRegistryFactoryForTests(() => fakeRegistry());
    const res = await rawTool('llm.chat').run(ctx(makeWs()), {});
    assert.strictEqual(res.ok, false);
    if (!res.ok) { assert.strictEqual(res.reason, 'invalid_params'); }
  });

  test('routes a prompt through the registry and returns the response', async () => {
    _setLlmRegistryFactoryForTests(() => fakeRegistry());
    const res = await rawTool('llm.chat').run(ctx(makeWs()), { prompt: 'hello' });
    assert.strictEqual(res.ok, true);
    if (res.ok) {
      const d = res.data as { response: string; servedBy: string; tokens: unknown };
      assert.strictEqual(d.response, 'hi there');
      assert.strictEqual(d.servedBy, 'ollama');
      assert.deepStrictEqual(d.tokens, { input: 3, output: 2 });
    }
  });

  test('a failed chat surfaces state_unreachable', async () => {
    _setLlmRegistryFactoryForTests(() => fakeRegistry({
      chat: async () => ({ ok: false, model: 'x', servedBy: 'ollama', durationMs: 1, errorClass: 'unreachable', errorMessage: 'no provider online' }),
    }));
    const res = await rawTool('llm.chat').run(ctx(makeWs()), { prompt: 'hi' });
    assert.strictEqual(res.ok, false);
    if (!res.ok) { assert.strictEqual(res.reason, 'state_unreachable'); }
  });
});

suite('mcp llm.models + llm.health', () => {
  test('llm.models lists models per provider', async () => {
    _setLlmRegistryFactoryForTests(() => fakeRegistry());
    const res = await rawTool('llm.models').run(ctx(makeWs()), {});
    assert.strictEqual(res.ok, true);
    if (res.ok) {
      const provs = (res.data as { providers: Record<string, unknown> }).providers;
      assert.ok(Array.isArray(provs.ollama));
    }
  });

  test('llm.health reports per-provider health', async () => {
    _setLlmRegistryFactoryForTests(() => fakeRegistry());
    const res = await rawTool('llm.health').run(ctx(makeWs()), {});
    assert.strictEqual(res.ok, true);
    if (res.ok) {
      const provs = (res.data as { providers: Record<string, { ok: boolean }> }).providers;
      assert.strictEqual(provs.ollama.ok, true);
    }
  });
});

suite('mcp llm.* gate', () => {
  test('the gated tool denies when writes are not authorized', async () => {
    _setLlmRegistryFactoryForTests(() => fakeRegistry());
    // No .autoclaw/mcp/config.json + no env ⇒ allowWrites false ⇒ denied.
    delete process.env.AUTOCLAW_MCP_ALLOW_WRITES;
    const gated = WRITE_TOOLS.find(t => t.definition.name === 'llm.chat')!;
    const res = await gated.run(ctx(makeWs()), { prompt: 'hi' });
    assert.strictEqual(res.ok, false);
    if (!res.ok) { assert.strictEqual(res.reason, 'permission_denied'); }
  });
});
