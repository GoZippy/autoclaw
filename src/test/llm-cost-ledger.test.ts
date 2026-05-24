/**
 * llm-cost-ledger.test.ts — Cost ledger tests.
 *
 * Verifies the ZICO-aligned schema (provider, model, operation, tokens,
 * costCents, runId), append-only behavior, and the sanitizer that strips
 * any accidental prompt/response payload.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CostLedger } from '../llm/costLedger';

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-ledger-'));
}

suite('CostLedger', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('append() writes a JSONL row matching the ZICO schema', async () => {
    const ledger = new CostLedger(workspace);
    await ledger.append({
      timestamp: '2026-05-24T00:00:00Z',
      provider: 'zippymesh',
      model: 'auto',
      operation: 'chat',
      tokens: { input: 100, output: 50 },
      costCents: 12,
      runId: 'r-1',
      sessionId: 's-1',
    });
    const rows = await ledger.readAll();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].provider, 'zippymesh');
    assert.strictEqual(rows[0].operation, 'chat');
    assert.strictEqual(rows[0].costCents, 12);
    assert.strictEqual(rows[0].runId, 'r-1');
    assert.strictEqual(rows[0].tokens.input, 100);
  });

  test('append() is append-only (multiple writes accumulate)', async () => {
    const ledger = new CostLedger(workspace);
    for (let i = 0; i < 3; i++) {
      await ledger.append({
        timestamp: new Date().toISOString(),
        provider: 'ollama',
        model: 'llama3.1:8b',
        operation: 'chat',
        tokens: { input: i, output: i },
        costCents: 0,
      });
    }
    const rows = await ledger.readAll();
    assert.strictEqual(rows.length, 3);
  });

  test('append() sanitizes notes to a single line and drops prompts', async () => {
    const ledger = new CostLedger(workspace);
    await ledger.append({
      timestamp: '2026-05-24T00:00:00Z',
      provider: 'ollama',
      model: 'llama3.1:8b',
      operation: 'chat',
      tokens: { input: 0, output: 0 },
      costCents: 0,
      notes: 'first line\nsecond line — should be dropped\nthird',
    });
    const rows = await ledger.readAll();
    assert.strictEqual(rows[0].notes, 'first line');
    // The row JSON should NOT contain "second line" anywhere.
    const file = path.join(workspace, '.autoclaw', 'llm', 'cost-ledger.jsonl');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('second line'), 'multi-line notes must be truncated');
  });

  test('summarizeByProvider() sums calls and cents per provider', async () => {
    const ledger = new CostLedger(workspace);
    await ledger.append({
      timestamp: '1', provider: 'zippymesh', model: 'auto', operation: 'chat',
      tokens: { input: 0, output: 0 }, costCents: 10,
    });
    await ledger.append({
      timestamp: '2', provider: 'zippymesh', model: 'auto', operation: 'chat',
      tokens: { input: 0, output: 0 }, costCents: 5,
    });
    await ledger.append({
      timestamp: '3', provider: 'ollama', model: 'llama3.1:8b', operation: 'chat',
      tokens: { input: 0, output: 0 }, costCents: 0,
    });
    const summary = await ledger.summarizeByProvider();
    assert.strictEqual(summary['zippymesh'].calls, 2);
    assert.strictEqual(summary['zippymesh'].cents, 15);
    assert.strictEqual(summary['ollama'].calls, 1);
    assert.strictEqual(summary['ollama'].cents, 0);
  });

  test('readAll() returns [] when ledger file does not exist', async () => {
    const ledger = new CostLedger(workspace);
    const rows = await ledger.readAll();
    assert.deepStrictEqual(rows, []);
  });
});
