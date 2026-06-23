/**
 * fleetMetrics.test.ts — LANE C per-agent metrics rollup coverage.
 *
 * Two halves, mirroring the module:
 *   - Pure builder (`buildAgentMetrics`, `formatTokens`, `formatUsd`): plain
 *     value checks, no fs — style matches `fleetDigest.test.ts`.
 *   - Thin fs reader (`readLlmLedgerRows`, `gatherAgentMetrics`): exercised
 *     against an EPHEMERAL ledger file written to a temp workspace, style
 *     matches `llm-cost-ledger.test.ts` (mkdtemp / rmSync teardown).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildAgentMetrics,
  readLlmLedgerRows,
  gatherAgentMetrics,
  formatTokens,
  formatUsd,
  FLEET_TOTAL_AGENT_ID,
  UNATTRIBUTED_AGENT_ID,
  LLM_COST_LEDGER_REL_PATH,
  type LlmLedgerRow,
  type MetricsAttribution,
} from '../fleet/fleetMetrics';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const TS = '2026-06-23T12:00:00.000Z';

function row(over: Partial<LlmLedgerRow> = {}): LlmLedgerRow {
  return {
    timestamp: '2026-06-23T00:00:00.000Z',
    tokens: { input: 100, output: 50 },
    costCents: 0,
    operation: 'chat',
    ...over,
  };
}

function attr(over: Partial<MetricsAttribution> = {}): MetricsAttribution {
  return {
    bySession: {},
    byPersona: {},
    knownAgents: [],
    ...over,
  };
}

/** Write JSONL rows to an ephemeral workspace ledger and return the root. */
function mkLedger(lines: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-metrics-'));
  const file = path.join(root, '.autoclaw', 'llm', 'cost-ledger.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return root;
}

// ---------------------------------------------------------------------------
// buildAgentMetrics — empties & shape
// ---------------------------------------------------------------------------

suite('fleetMetrics — buildAgentMetrics empties', () => {
  test('empty rows → zeroed total + unattributed, empty perAgent', () => {
    const m = buildAgentMetrics([], attr(), TS);
    assert.deepStrictEqual(m.perAgent, []);
    assert.strictEqual(m.total.agentId, FLEET_TOTAL_AGENT_ID);
    assert.strictEqual(m.total.tokensIn, 0);
    assert.strictEqual(m.total.tokensOut, 0);
    assert.strictEqual(m.total.tokensTotal, 0);
    assert.strictEqual(m.total.costUsd, 0);
    assert.strictEqual(m.total.dispatches, 0);
    assert.strictEqual(m.unattributed.agentId, UNATTRIBUTED_AGENT_ID);
    assert.strictEqual(m.unattributed.dispatches, 0);
    assert.strictEqual(m.generatedAt, TS);
  });

  test('epoch-ms timestamp normalizes to ISO', () => {
    const ms = Date.parse(TS);
    const m = buildAgentMetrics([], attr(), ms);
    assert.strictEqual(m.generatedAt, TS);
  });

  test('null / non-array rows do not throw', () => {
    // @ts-expect-error deliberately bad input
    const m = buildAgentMetrics(null, attr(), TS);
    assert.strictEqual(m.total.dispatches, 0);
    assert.deepStrictEqual(m.perAgent, []);
  });
});

// ---------------------------------------------------------------------------
// Malformed / tolerant input
// ---------------------------------------------------------------------------

suite('fleetMetrics — tolerant of malformed rows', () => {
  test('non-object rows are skipped, valid ones counted', () => {
    const rows = [
      null,
      undefined,
      42,
      'nope',
      row({ callerPersonaId: 'claude-code', tokens: { input: 10, output: 5 }, costCents: 200 }),
    ] as unknown as LlmLedgerRow[];
    const m = buildAgentMetrics(rows, attr({ knownAgents: ['claude-code'] }), TS);
    assert.strictEqual(m.total.dispatches, 1);
    assert.strictEqual(m.perAgent.length, 1);
    assert.strictEqual(m.perAgent[0].agentId, 'claude-code');
  });

  test('missing / NaN tokens coerce to 0', () => {
    const rows = [
      row({ callerPersonaId: 'a', tokens: undefined, costCents: 100 }),
      // @ts-expect-error NaN token field
      row({ callerPersonaId: 'a', tokens: { input: NaN, output: 'x' }, costCents: 50 }),
    ];
    const m = buildAgentMetrics(rows, attr({ knownAgents: ['a'] }), TS);
    assert.strictEqual(m.perAgent[0].tokensIn, 0);
    assert.strictEqual(m.perAgent[0].tokensOut, 0);
    assert.strictEqual(m.perAgent[0].tokensTotal, 0);
    // 150 cents → $1.50 still accrues.
    assert.strictEqual(m.perAgent[0].costUsd, 1.5);
    assert.strictEqual(m.perAgent[0].dispatches, 2);
  });

  test('negative tokens / costCents floor to 0', () => {
    const rows = [row({ callerPersonaId: 'a', tokens: { input: -5, output: -9 }, costCents: -300 })];
    const m = buildAgentMetrics(rows, attr({ knownAgents: ['a'] }), TS);
    assert.strictEqual(m.perAgent[0].tokensIn, 0);
    assert.strictEqual(m.perAgent[0].tokensOut, 0);
    assert.strictEqual(m.perAgent[0].costUsd, 0);
  });
});

// ---------------------------------------------------------------------------
// cents → USD
// ---------------------------------------------------------------------------

suite('fleetMetrics — costCents → USD', () => {
  test('costCents divides by 100 and rounds to cents', () => {
    const rows = [
      row({ callerPersonaId: 'a', costCents: 1234 }), // $12.34
      row({ callerPersonaId: 'a', costCents: 1 }),    // $0.01
    ];
    const m = buildAgentMetrics(rows, attr({ knownAgents: ['a'] }), TS);
    assert.strictEqual(m.perAgent[0].costUsd, 12.35);
    assert.strictEqual(m.total.costUsd, 12.35);
  });

  test('local-only fleet (costCents 0) legitimately shows $0.00 with tokens', () => {
    const rows = [row({ callerPersonaId: 'a', tokens: { input: 800, output: 200 }, costCents: 0 })];
    const m = buildAgentMetrics(rows, attr({ knownAgents: ['a'] }), TS);
    assert.strictEqual(m.perAgent[0].costUsd, 0);
    assert.strictEqual(m.perAgent[0].tokensTotal, 1000);
  });
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

suite('fleetMetrics — attribution', () => {
  test('callerPersonaId matching a known agent attributes directly', () => {
    const rows = [row({ callerPersonaId: 'claude-code', costCents: 100 })];
    const m = buildAgentMetrics(rows, attr({ knownAgents: ['claude-code'] }), TS);
    assert.strictEqual(m.perAgent[0].agentId, 'claude-code');
    assert.strictEqual(m.unattributed.dispatches, 0);
  });

  test('callerPersonaId maps via byPersona', () => {
    const rows = [row({ callerPersonaId: 'reviewer-persona', costCents: 100 })];
    const m = buildAgentMetrics(rows, attr({ byPersona: { 'reviewer-persona': 'kilocode' } }), TS);
    assert.strictEqual(m.perAgent[0].agentId, 'kilocode');
  });

  test('sessionId maps via bySession', () => {
    const rows = [row({ sessionId: 'sess-1', tokens: { input: 5, output: 5 }, costCents: 0 })];
    const m = buildAgentMetrics(rows, attr({ bySession: { 'sess-1': 'kilocode' } }), TS);
    assert.strictEqual(m.perAgent[0].agentId, 'kilocode');
  });

  test('runId falls back to known agent / persona / session maps', () => {
    const m1 = buildAgentMetrics([row({ runId: 'claude-code' })], attr({ knownAgents: ['claude-code'] }), TS);
    assert.strictEqual(m1.perAgent[0].agentId, 'claude-code');

    const m2 = buildAgentMetrics([row({ runId: 'sess-9' })], attr({ bySession: { 'sess-9': 'kilocode' } }), TS);
    assert.strictEqual(m2.perAgent[0].agentId, 'kilocode');
  });

  test('unresolvable rows land in the unattributed bucket (kept, not dropped)', () => {
    const rows = [
      row({ sessionId: 'unknown-sess', tokens: { input: 30, output: 10 }, costCents: 500 }),
      row({ tokens: { input: 0, output: 0 }, costCents: 100 }), // no id at all
    ];
    const m = buildAgentMetrics(rows, attr({ knownAgents: ['claude-code'] }), TS);
    assert.strictEqual(m.perAgent.length, 0);
    assert.strictEqual(m.unattributed.dispatches, 2);
    assert.strictEqual(m.unattributed.tokensIn, 30);
    assert.strictEqual(m.unattributed.costUsd, 6); // (500 + 100) / 100
    // The fleet total still includes the unattributed rows.
    assert.strictEqual(m.total.dispatches, 2);
    assert.strictEqual(m.total.costUsd, 6);
  });

  test('persona match wins over session match (most-specific first)', () => {
    const rows = [row({ callerPersonaId: 'claude-code', sessionId: 'sess-1' })];
    const m = buildAgentMetrics(
      rows,
      attr({ knownAgents: ['claude-code'], bySession: { 'sess-1': 'kilocode' } }),
      TS,
    );
    assert.strictEqual(m.perAgent[0].agentId, 'claude-code');
  });
});

// ---------------------------------------------------------------------------
// Aggregation + sort determinism
// ---------------------------------------------------------------------------

suite('fleetMetrics — aggregation & sort', () => {
  test('rows for the same agent accumulate', () => {
    const rows = [
      row({ callerPersonaId: 'a', tokens: { input: 100, output: 20 }, costCents: 100 }),
      row({ callerPersonaId: 'a', tokens: { input: 50, output: 30 }, costCents: 250 }),
    ];
    const m = buildAgentMetrics(rows, attr({ knownAgents: ['a'] }), TS);
    const a = m.perAgent[0];
    assert.strictEqual(a.tokensIn, 150);
    assert.strictEqual(a.tokensOut, 50);
    assert.strictEqual(a.tokensTotal, 200);
    assert.strictEqual(a.costUsd, 3.5);
    assert.strictEqual(a.dispatches, 2);
  });

  test('perAgent sorts by costUsd desc, then tokensTotal desc, then id asc', () => {
    const rows = [
      row({ callerPersonaId: 'low', costCents: 100, tokens: { input: 1, output: 1 } }),
      row({ callerPersonaId: 'high', costCents: 900, tokens: { input: 1, output: 1 } }),
      // same cost as 'low' but more tokens → ranks above 'low'
      row({ callerPersonaId: 'mid', costCents: 100, tokens: { input: 500, output: 500 } }),
    ];
    const m = buildAgentMetrics(rows, attr({ knownAgents: ['low', 'high', 'mid'] }), TS);
    assert.deepStrictEqual(m.perAgent.map((p) => p.agentId), ['high', 'mid', 'low']);
  });

  test('tie on cost AND tokens breaks by agent id ascending', () => {
    const rows = [
      row({ callerPersonaId: 'zebra', costCents: 100, tokens: { input: 10, output: 10 } }),
      row({ callerPersonaId: 'alpha', costCents: 100, tokens: { input: 10, output: 10 } }),
    ];
    const m = buildAgentMetrics(rows, attr({ knownAgents: ['zebra', 'alpha'] }), TS);
    assert.deepStrictEqual(m.perAgent.map((p) => p.agentId), ['alpha', 'zebra']);
  });

  test('determinism: same input + timestamp → byte-identical output', () => {
    const rows = [
      row({ callerPersonaId: 'a', costCents: 300 }),
      row({ sessionId: 's', costCents: 50 }),
      row({ costCents: 10 }),
    ];
    const a = attr({ knownAgents: ['a'], bySession: { s: 'b' } });
    const m1 = buildAgentMetrics(rows, a, TS);
    const m2 = buildAgentMetrics(rows, a, TS);
    assert.strictEqual(JSON.stringify(m1), JSON.stringify(m2));
  });
});

// ---------------------------------------------------------------------------
// formatTokens / formatUsd helpers
// ---------------------------------------------------------------------------

suite('fleetMetrics — formatters', () => {
  test('formatTokens compacts to k / M', () => {
    assert.strictEqual(formatTokens(0), '0');
    assert.strictEqual(formatTokens(840), '840');
    assert.strictEqual(formatTokens(999), '999');
    assert.strictEqual(formatTokens(1000), '1k');
    assert.strictEqual(formatTokens(12_345), '12.3k');
    assert.strictEqual(formatTokens(1_200_000), '1.2M');
    assert.strictEqual(formatTokens(1_000_000), '1M');
  });

  test('formatTokens coerces garbage to 0', () => {
    // @ts-expect-error bad input on purpose
    assert.strictEqual(formatTokens('nope'), '0');
    assert.strictEqual(formatTokens(NaN), '0');
  });

  test('formatUsd always shows two decimals with a $', () => {
    assert.strictEqual(formatUsd(0), '$0.00');
    assert.strictEqual(formatUsd(1.2), '$1.20');
    assert.strictEqual(formatUsd(14.5), '$14.50');
  });
});

// ---------------------------------------------------------------------------
// readLlmLedgerRows — ephemeral ledger files
// ---------------------------------------------------------------------------

suite('fleetMetrics — readLlmLedgerRows', () => {
  const roots: string[] = [];
  teardown(() => {
    while (roots.length) {
      const r = roots.pop()!;
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('rel-path constant points at the LLM ledger', () => {
    assert.strictEqual(LLM_COST_LEDGER_REL_PATH, '.autoclaw/llm/cost-ledger.jsonl');
  });

  test('missing file → [] (no throw)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-metrics-'));
    roots.push(root);
    const rows = await readLlmLedgerRows(root);
    assert.deepStrictEqual(rows, []);
  });

  test('parses JSONL rows, skips blank + malformed lines', async () => {
    const root = mkLedger([
      JSON.stringify(row({ callerPersonaId: 'a', costCents: 100 })),
      '',
      '{ not valid json',
      '   ',
      JSON.stringify(row({ sessionId: 's', costCents: 50 })),
    ]);
    roots.push(root);
    const rows = await readLlmLedgerRows(root);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].callerPersonaId, 'a');
    assert.strictEqual(rows[1].sessionId, 's');
  });

  test('strips a leading UTF-8 BOM on the first line', async () => {
    const root = mkLedger(['﻿' + JSON.stringify(row({ callerPersonaId: 'a' }))]);
    roots.push(root);
    const rows = await readLlmLedgerRows(root);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].callerPersonaId, 'a');
  });

  test('handles CRLF line endings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-metrics-'));
    roots.push(root);
    const file = path.join(root, '.autoclaw', 'llm', 'cost-ledger.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(row({ callerPersonaId: 'a' })) + '\r\n' + JSON.stringify(row({ sessionId: 's' })) + '\r\n',
      'utf8',
    );
    const rows = await readLlmLedgerRows(root);
    assert.strictEqual(rows.length, 2);
  });

  test('limit reads only the last N rows', async () => {
    const root = mkLedger([
      JSON.stringify(row({ callerPersonaId: 'first' })),
      JSON.stringify(row({ callerPersonaId: 'second' })),
      JSON.stringify(row({ callerPersonaId: 'third' })),
    ]);
    roots.push(root);
    const rows = await readLlmLedgerRows(root, 2);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].callerPersonaId, 'second');
    assert.strictEqual(rows[1].callerPersonaId, 'third');
  });

  test('gatherAgentMetrics: missing ledger → fully zeroed rollup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-metrics-'));
    roots.push(root);
    const m = await gatherAgentMetrics(root, attr(), TS);
    assert.deepStrictEqual(m.perAgent, []);
    assert.strictEqual(m.total.dispatches, 0);
    assert.strictEqual(m.generatedAt, TS);
  });

  test('gatherAgentMetrics: end-to-end read + rollup + attribution', async () => {
    const root = mkLedger([
      JSON.stringify(row({ callerPersonaId: 'claude-code', tokens: { input: 100, output: 40 }, costCents: 300 })),
      JSON.stringify(row({ sessionId: 'sess-k', tokens: { input: 20, output: 10 }, costCents: 0 })),
      JSON.stringify(row({ tokens: { input: 5, output: 5 }, costCents: 10 })), // unattributed
    ]);
    roots.push(root);
    const a = attr({ knownAgents: ['claude-code'], bySession: { 'sess-k': 'kilocode' } });
    const m = await gatherAgentMetrics(root, a, TS);

    assert.strictEqual(m.perAgent.length, 2);
    const claude = m.perAgent.find((p) => p.agentId === 'claude-code')!;
    assert.strictEqual(claude.tokensTotal, 140);
    assert.strictEqual(claude.costUsd, 3);
    const kilo = m.perAgent.find((p) => p.agentId === 'kilocode')!;
    assert.strictEqual(kilo.tokensTotal, 30);
    assert.strictEqual(kilo.costUsd, 0);

    assert.strictEqual(m.unattributed.dispatches, 1);
    assert.strictEqual(m.unattributed.costUsd, 0.1);

    assert.strictEqual(m.total.dispatches, 3);
    assert.strictEqual(m.total.tokensTotal, 180);
    assert.strictEqual(m.total.costUsd, 3.1);
  });
});
