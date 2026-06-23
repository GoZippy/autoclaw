/**
 * agentcost.test.ts — unit tests for readAgentCosts (src/agentCost.ts).
 *
 * Exercises the real exported reader against ephemeral `.autoclaw/llm/` and
 * `.autoclaw/mcp/` ledger files in a temp workspace. No vscode, no Electron.
 *
 * Coverage:
 *   - per-agent token/cost/dispatch aggregation (sums)
 *   - missing ledger file → {}
 *   - malformed / BOM line tolerance (skipped, no throw)
 *   - multi-agent split (rows fan out by callerPersonaId)
 *   - keying fallback (runId / sessionId when no callerPersonaId)
 *   - MCP ledger contributes dispatch counts only, never tokens/cost
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { readAgentCosts } from '../agentCost';
import { formatTokens } from '../webview-render';

// Helpers --------------------------------------------------------------------

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-agentcost-'));
}

/** Write JSONL lines (objects → one JSON line each) to a ledger under .autoclaw. */
function writeLlmLedger(root: string, lines: Array<Record<string, unknown> | string>): void {
  const file = path.join(root, '.autoclaw', 'llm', 'cost-ledger.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(file, body + '\n', 'utf8');
}

function writeMcpLedger(root: string, lines: Array<Record<string, unknown> | string>): void {
  const file = path.join(root, '.autoclaw', 'mcp', 'cost-ledger.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(file, body + '\n', 'utf8');
}

function llmRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-06-22T10:00:00.000Z',
    provider: 'anthropic',
    model: 'claude-x',
    operation: 'chat',
    tokens: { input: 100, output: 50 },
    costCents: 0,
    callerPersonaId: 'claude-code',
    ...over,
  };
}

// Tests ----------------------------------------------------------------------

suite('agentCost — readAgentCosts aggregation', () => {
  test('sums tokens, cost, and dispatches per agent', () => {
    const ws = makeWorkspace();
    writeLlmLedger(ws, [
      llmRow({ tokens: { input: 100, output: 50 }, costCents: 12 }),
      llmRow({ tokens: { input: 200, output: 25 }, costCents: 30 }),
    ]);

    const out = readAgentCosts(ws);
    const c = out['claude-code'];
    assert.ok(c, 'expected a rollup for claude-code');
    assert.strictEqual(c.tokensIn, 300);
    assert.strictEqual(c.tokensOut, 75);
    assert.strictEqual(c.tokensTotal, 375);
    assert.strictEqual(c.dispatches, 2);
    // 12c + 30c = 42c = $0.42
    assert.ok(c.costUsd !== undefined && Math.abs(c.costUsd - 0.42) < 1e-9, `costUsd=${c.costUsd}`);
  });

  test('omits costUsd when every row reported zero cost', () => {
    const ws = makeWorkspace();
    writeLlmLedger(ws, [llmRow({ costCents: 0 }), llmRow({ costCents: 0 })]);
    const c = readAgentCosts(ws)['claude-code'];
    assert.ok(c);
    assert.strictEqual(c.costUsd, undefined, 'zero-cost agent should not carry costUsd');
    assert.strictEqual(c.dispatches, 2);
    assert.strictEqual(c.tokensTotal, 300);
  });

  test('tracks the latest timestamp as lastAt', () => {
    const ws = makeWorkspace();
    writeLlmLedger(ws, [
      llmRow({ timestamp: '2026-06-22T09:00:00.000Z' }),
      llmRow({ timestamp: '2026-06-22T11:30:00.000Z' }),
      llmRow({ timestamp: '2026-06-22T10:00:00.000Z' }),
    ]);
    const c = readAgentCosts(ws)['claude-code'];
    assert.strictEqual(c.lastAt, '2026-06-22T11:30:00.000Z');
  });
});

suite('agentCost — robustness', () => {
  test('missing ledger file → {}', () => {
    const ws = makeWorkspace(); // nothing written
    assert.deepStrictEqual(readAgentCosts(ws), {});
  });

  test('empty / whitespace workspace root → {}', () => {
    assert.deepStrictEqual(readAgentCosts(''), {});
    // @ts-expect-error intentional bad input
    assert.deepStrictEqual(readAgentCosts(undefined), {});
  });

  test('malformed lines are skipped, valid rows still aggregate', () => {
    const ws = makeWorkspace();
    writeLlmLedger(ws, [
      '{ not json',
      llmRow({ tokens: { input: 10, output: 5 } }),
      '',
      '   ',
      'null',
      JSON.stringify(llmRow({ tokens: { input: 20, output: 0 } })),
    ]);
    const c = readAgentCosts(ws)['claude-code'];
    assert.ok(c, 'valid rows should still produce a rollup');
    assert.strictEqual(c.dispatches, 2);
    assert.strictEqual(c.tokensTotal, 35);
  });

  test('a leading BOM on the file is tolerated', () => {
    const ws = makeWorkspace();
    const file = path.join(ws, '.autoclaw', 'llm', 'cost-ledger.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '﻿' + JSON.stringify(llmRow()) + '\n', 'utf8');
    const c = readAgentCosts(ws)['claude-code'];
    assert.ok(c, 'BOM-prefixed first line should still parse');
    assert.strictEqual(c.dispatches, 1);
  });

  test('rows with no agent key are dropped (not invented)', () => {
    const ws = makeWorkspace();
    writeLlmLedger(ws, [
      { timestamp: '2026-06-22T10:00:00.000Z', tokens: { input: 5, output: 5 }, costCents: 9 },
      llmRow(),
    ]);
    const out = readAgentCosts(ws);
    assert.deepStrictEqual(Object.keys(out), ['claude-code']);
    assert.strictEqual(out['claude-code'].dispatches, 1);
  });

  test('negative / non-numeric token & cost values coerce to 0', () => {
    const ws = makeWorkspace();
    writeLlmLedger(ws, [
      llmRow({ tokens: { input: -50, output: 'x' }, costCents: -100 }),
    ]);
    const c = readAgentCosts(ws)['claude-code'];
    assert.strictEqual(c.tokensIn, 0);
    assert.strictEqual(c.tokensOut, 0);
    assert.strictEqual(c.tokensTotal, 0);
    assert.strictEqual(c.costUsd, undefined);
    assert.strictEqual(c.dispatches, 1);
  });
});

suite('agentCost — multi-agent split & keying', () => {
  test('splits rows across agents by callerPersonaId', () => {
    const ws = makeWorkspace();
    writeLlmLedger(ws, [
      llmRow({ callerPersonaId: 'claude-code', tokens: { input: 100, output: 50 }, costCents: 10 }),
      llmRow({ callerPersonaId: 'kilocode', tokens: { input: 40, output: 60 }, costCents: 20 }),
      llmRow({ callerPersonaId: 'claude-code', tokens: { input: 1, output: 1 }, costCents: 5 }),
    ]);
    const out = readAgentCosts(ws);
    assert.strictEqual(Object.keys(out).length, 2);
    assert.strictEqual(out['claude-code'].dispatches, 2);
    assert.strictEqual(out['claude-code'].tokensTotal, 152);
    assert.ok(Math.abs((out['claude-code'].costUsd ?? 0) - 0.15) < 1e-9);
    assert.strictEqual(out['kilocode'].dispatches, 1);
    assert.strictEqual(out['kilocode'].tokensTotal, 100);
  });

  test('falls back to runId then sessionId when callerPersonaId absent', () => {
    const ws = makeWorkspace();
    writeLlmLedger(ws, [
      { timestamp: '2026-06-22T10:00:00.000Z', tokens: { input: 10, output: 0 }, runId: 'run-A' },
      { timestamp: '2026-06-22T10:00:00.000Z', tokens: { input: 20, output: 0 }, sessionId: 'sess-B' },
    ]);
    const out = readAgentCosts(ws);
    assert.ok(out['run-A'], 'runId used as key when no callerPersonaId');
    assert.ok(out['sess-B'], 'sessionId used as key when neither callerPersonaId nor runId');
  });
});

suite('agentCost — MCP ledger fold-in', () => {
  test('MCP rows bump dispatches only for known agents, never tokens/cost', () => {
    const ws = makeWorkspace();
    // 'claude-code' becomes a known key via the LLM ledger.
    writeLlmLedger(ws, [llmRow({ callerPersonaId: 'claude-code', tokens: { input: 100, output: 0 }, costCents: 10 })]);
    writeMcpLedger(ws, [
      { ts: '2026-06-22T12:00:00.000Z', tool: 'recall.query', session: 'claude-code', duration_ms: 5, ok: true, host: 'h', args_hash: 'a' },
      { ts: '2026-06-22T12:01:00.000Z', tool: 'recall.query', session: 'unknown-agent', duration_ms: 5, ok: true, host: 'h', args_hash: 'a' },
    ]);
    const out = readAgentCosts(ws);
    // claude-code: 1 LLM dispatch + 1 matching MCP dispatch = 2; tokens unchanged.
    assert.strictEqual(out['claude-code'].dispatches, 2);
    assert.strictEqual(out['claude-code'].tokensTotal, 100);
    assert.ok(Math.abs((out['claude-code'].costUsd ?? 0) - 0.10) < 1e-9);
    // The unattributable MCP session is dropped — no agent invented.
    assert.strictEqual(out['unknown-agent'], undefined);
    // lastAt advances to the matching MCP row's later ts.
    assert.strictEqual(out['claude-code'].lastAt, '2026-06-22T12:00:00.000Z');
  });

  test('missing MCP ledger is harmless', () => {
    const ws = makeWorkspace();
    writeLlmLedger(ws, [llmRow()]);
    const out = readAgentCosts(ws);
    assert.strictEqual(out['claude-code'].dispatches, 1);
  });
});

suite('agentCost — formatTokens', () => {
  test('compacts counts into k / M labels', () => {
    assert.strictEqual(formatTokens(0), '0');
    assert.strictEqual(formatTokens(-5), '0');
    assert.strictEqual(formatTokens(999), '999');
    assert.strictEqual(formatTokens(1000), '1.0k');
    assert.strictEqual(formatTokens(12300), '12.3k');
    assert.strictEqual(formatTokens(125000), '125k');
    assert.strictEqual(formatTokens(1_200_000), '1.2M');
  });
});
