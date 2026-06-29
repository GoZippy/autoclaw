/**
 * llm-costwrite.test.ts — BL-6: the production cost-ledger writer.
 *
 * Proves LlmRegistry.chat() now appends one cost-ledger row per call (the
 * single writer the budget/agentCost/fleetMetrics/ledgerBridge readers consume),
 * that counts-only privacy holds (no prompt/response content), and that failed
 * calls are still counted.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LlmRegistry } from '../llm/registry';
import { CostLedger } from '../llm/costLedger';
import type { Oracle } from '../llm/oracle';
import type { LlmProvider, ChatResult } from '../llm/types';

/** Stub oracle that recommends nothing — keeps the no-provider test offline. */
const emptyOracle = { refresh: async () => {}, pick: () => ({ recommended: null, alternatives: [] }) } as unknown as Oracle;

function mkws(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-cost-'));
}

/** A provider that returns a canned ChatResult (id reused as a real ProviderId). */
function mockProvider(result: ChatResult): LlmProvider {
  return {
    id: 'ollama',
    defaultModel: 'm',
    detect: async () => ({ found: true }),
    chat: async () => result,
  } as unknown as LlmProvider;
}

function ledgerRaw(ws: string): string {
  return fs.readFileSync(path.join(ws, '.autoclaw', 'llm', 'cost-ledger.jsonl'), 'utf8');
}

suite('BL-6 — LlmRegistry cost-ledger writer', () => {
  test('a successful chat() appends one sanitized row', async () => {
    const ws = mkws();
    try {
      const result: ChatResult = {
        ok: true, model: 'm', servedBy: 'ollama', tokens: { input: 100, output: 50 },
        durationMs: 5, costCents: 7, response: 'SECRET RESPONSE TEXT',
      };
      const reg = new LlmRegistry({ workspaceRoot: ws, providers: [mockProvider(result)] });
      await reg.chat({ prompt: 'hello', sessionId: 's1', runId: 'r1' }, 'ollama:m');

      const rows = await new CostLedger(ws).readAll();
      assert.strictEqual(rows.length, 1, 'exactly one row written');
      const r = rows[0];
      assert.strictEqual(r.provider, 'ollama');
      assert.strictEqual(r.operation, 'chat');
      assert.deepStrictEqual(r.tokens, { input: 100, output: 50 });
      assert.strictEqual(r.costCents, 7);
      assert.strictEqual(r.sessionId, 's1');
      assert.strictEqual(r.runId, 'r1');
      assert.ok(r.timestamp && !isNaN(Date.parse(r.timestamp)));

      // Privacy: prompt/response content must never reach the ledger.
      const raw = ledgerRaw(ws);
      assert.ok(!raw.includes('SECRET RESPONSE TEXT'), 'response text must not be written');
      assert.ok(!raw.includes('hello'), 'prompt text must not be written');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test('a failed chat() still records a row (call count) with an error note', async () => {
    const ws = mkws();
    try {
      const result: ChatResult = { ok: false, model: 'm', servedBy: 'ollama', durationMs: 1, errorClass: 'internal', errorMessage: 'boom' };
      const reg = new LlmRegistry({ workspaceRoot: ws, providers: [mockProvider(result)] });
      await reg.chat({ prompt: 'hi' }, 'ollama:m');

      const rows = await new CostLedger(ws).readAll();
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(rows[0].tokens, { input: 0, output: 0 });
      assert.strictEqual(rows[0].costCents, 0);
      assert.ok(rows[0].notes && rows[0].notes.includes('error:internal'));
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test('multiple chats roll up via summarizeByProvider (the readers now have data)', async () => {
    const ws = mkws();
    try {
      const result: ChatResult = { ok: true, model: 'm', servedBy: 'ollama', tokens: { input: 10, output: 5 }, durationMs: 1, costCents: 3 };
      const reg = new LlmRegistry({ workspaceRoot: ws, providers: [mockProvider(result)] });
      await reg.chat({ prompt: 'a' }, 'ollama:m');
      await reg.chat({ prompt: 'b' }, 'ollama:m');

      const summary = await new CostLedger(ws).summarizeByProvider();
      assert.strictEqual(summary['ollama'].calls, 2);
      assert.strictEqual(summary['ollama'].cents, 6);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test('a no-provider chat() does NOT write a phantom row', async () => {
    const ws = mkws();
    try {
      // No providers registered + an unresolvable ref → getPreferred returns null,
      // chat returns ok:false before any provider.chat(), so nothing is recorded.
      const reg = new LlmRegistry({ workspaceRoot: ws, providers: [], oracle: emptyOracle });
      const res = await reg.chat({ prompt: 'x' }, 'nope:m');
      assert.strictEqual(res.ok, false);
      const rows = await new CostLedger(ws).readAll();
      assert.strictEqual(rows.length, 0, 'a call that never reached a provider records nothing');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });
});
