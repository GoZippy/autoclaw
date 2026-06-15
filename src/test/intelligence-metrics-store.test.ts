/**
 * intelligence-metrics-store.test.ts — unit tests for the metrics store and the
 * cost-ledger bridge (intelligence-metrics-dashboard, tasks 1.2 + 2.3).
 *
 * Pure-logic, fully offline: no `vscode`, no extension host. Exercises:
 *  - recordLearningRun → persistence + summary/trend recomputation (R1.1, R1.2)
 *  - last-100 bound (R1.2)
 *  - corruption-tolerant load: garbage / wrong-shape file → empty, never throws,
 *    and a subsequent record still succeeds (R1 error handling)
 *  - lock-protected writes land at `.autoclaw/metrics/token-metrics.json` (R1.3)
 *  - ledgerBridge enabled aggregation from a STUBBED ledger, real-vs-estimated
 *    marking, and the disabled flag suppressing real tokens (R2.1-R2.4)
 *
 * Temp dirs live under one enclosing suite so teardown never races siblings.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  LearningRunStats,
  MAX_RUNS,
  getDashboardData,
  getMetrics,
  metricsFilePath,
  recordLearningRun,
} from '../intelligence/metrics/store';
import { LedgerLike, aggregateRealTokens } from '../intelligence/metrics/ledgerBridge';
import type { LedgerRow } from '../llm/costLedger';
import { defaultConfig } from '../intelligence/config';

let tmpRoot: string;

function freshWs(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

function run(over: Partial<LearningRunStats> = {}): LearningRunStats {
  const sessionsAnalyzed = over.sessionsAnalyzed ?? 4;
  const kept = over.kept ?? 2;
  return {
    ts: over.ts ?? new Date().toISOString(),
    sessionsAnalyzed,
    kept,
    keptRate: over.keptRate ?? (sessionsAnalyzed > 0 ? kept / sessionsAnalyzed : 0),
    patternsLearned: over.patternsLearned ?? 3,
    sources: over.sources ?? ['autoclaw-native'],
    estTokens: over.estTokens ?? 1000,
    gitEnriched: over.gitEnriched ?? false,
    ...(over.focus ? { focus: over.focus } : {}),
    ...(over.realTokens ? { realTokens: over.realTokens } : {}),
    ...(over.costUsd !== undefined ? { costUsd: over.costUsd } : {}),
  };
}

/** A stub ledger that yields a fixed set of rows. */
function stubLedger(rows: LedgerRow[]): LedgerLike {
  return { async readAll(): Promise<LedgerRow[]> { return rows; } };
}

function ledgerRow(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    timestamp: over.timestamp ?? new Date().toISOString(),
    provider: over.provider ?? 'ollama',
    model: over.model ?? 'qwen3:0.6b',
    operation: over.operation ?? 'chat',
    tokens: over.tokens ?? { input: 100, output: 50 },
    costCents: over.costCents ?? 0,
    ...(over.runId ? { runId: over.runId } : {}),
    ...(over.sessionId ? { sessionId: over.sessionId } : {}),
  };
}

suite('intelligence-metrics', function () {
  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-metrics-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  // -------------------------------------------------------------------------
  suite('store: record + persistence', function () {
    test('records a run to .autoclaw/metrics/token-metrics.json (R1.3)', async function () {
      const ws = freshWs('rec');
      await recordLearningRun(ws, run({ patternsLearned: 5 }));

      const file = metricsFilePath(ws);
      assert.ok(file.endsWith('.autoclaw/metrics/token-metrics.json'), 'canonical path');
      assert.ok(fs.existsSync(file), 'file written');

      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(onDisk.runs.length, 1);
      assert.strictEqual(onDisk.summary.totalRuns, 1);
      assert.strictEqual(onDisk.summary.totalPatterns, 5);
      assert.ok(Array.isArray(onDisk.trends.keptRate), 'trends precomputed on disk');
    });

    test('empty store yields the empty dashboard state (R4.5)', function () {
      const ws = freshWs('empty');
      const data = getDashboardData(ws);
      assert.strictEqual(data.empty, true);
      assert.strictEqual(data.runs.length, 0);
      assert.strictEqual(data.summary.totalRuns, 0);
      assert.strictEqual(data.summary.lastRun, null);
    });
  });

  // -------------------------------------------------------------------------
  suite('store: summary + trends (R1.1, R1.2)', function () {
    test('computes avg kept rate, totals, token split, and trend series', async function () {
      const ws = freshWs('trend');
      await recordLearningRun(ws, run({ ts: '2026-01-01T00:00:00.000Z', kept: 1, sessionsAnalyzed: 4, patternsLearned: 2, estTokens: 500 }));
      await recordLearningRun(ws, run({
        ts: '2026-01-02T00:00:00.000Z',
        kept: 3,
        sessionsAnalyzed: 4,
        patternsLearned: 4,
        estTokens: 700,
        realTokens: { prompt: 120, completion: 80, model: 'qwen3:0.6b', provider: 'ollama' },
        costUsd: 0.01,
      }));

      const data = getDashboardData(ws);
      assert.strictEqual(data.empty, false);
      assert.strictEqual(data.summary.totalRuns, 2);
      assert.strictEqual(data.summary.totalSessions, 8);
      assert.strictEqual(data.summary.totalKept, 4);
      assert.strictEqual(data.summary.totalPatterns, 6);
      // avg of 0.25 and 0.75 = 0.5
      assert.ok(Math.abs(data.summary.avgKeptRate - 0.5) < 1e-9, 'avg kept rate');
      assert.strictEqual(data.summary.tokens.estimated, 1200);
      assert.strictEqual(data.summary.tokens.real, 200, 'real = prompt + completion');
      assert.strictEqual(data.summary.tokens.hasReal, true);
      assert.ok(Math.abs(data.summary.totalCostUsd - 0.01) < 1e-9);

      // Trends are oldest → newest and aligned to runs.
      assert.deepStrictEqual(
        data.trends.keptRate.map((p) => p.value),
        [0.25, 0.75],
      );
      assert.deepStrictEqual(
        data.trends.patterns.map((p) => p.value),
        [2, 4],
      );
      assert.deepStrictEqual(
        data.trends.realTokens.map((p) => p.value),
        [0, 200],
      );
      assert.strictEqual(data.summary.lastRun && data.summary.lastRun.ts, '2026-01-02T00:00:00.000Z');
    });
  });

  // -------------------------------------------------------------------------
  suite('store: last-100 bound (R1.2)', function () {
    test('retains only the most recent MAX_RUNS runs', async function () {
      const ws = freshWs('bound');
      const total = MAX_RUNS + 25;
      for (let i = 0; i < total; i++) {
        // sequential timestamps so "most recent" is well-defined
        const ts = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
        await recordLearningRun(ws, run({ ts, patternsLearned: i }));
      }

      const metrics = getMetrics(ws);
      assert.strictEqual(metrics.runs.length, MAX_RUNS, 'bounded to MAX_RUNS');
      // The oldest retained run should be run #25 (patternsLearned === 25).
      assert.strictEqual(metrics.runs[0].patternsLearned, 25, 'oldest 25 runs dropped');
      assert.strictEqual(metrics.runs[MAX_RUNS - 1].patternsLearned, total - 1, 'newest kept');
      assert.strictEqual(metrics.summary.totalRuns, MAX_RUNS);
    });
  });

  // -------------------------------------------------------------------------
  suite('store: corruption recovery (R1 error handling)', function () {
    test('garbage JSON loads as empty and does not throw', function () {
      const ws = freshWs('corrupt');
      const file = metricsFilePath(ws);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{ this is not json ::::', 'utf8');

      const metrics = getMetrics(ws);
      assert.strictEqual(metrics.runs.length, 0);
      assert.strictEqual(metrics.summary.totalRuns, 0);
    });

    test('wrong-shape file loads as empty', function () {
      const ws = freshWs('shape');
      const file = metricsFilePath(ws);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ runs: 'not-an-array' }), 'utf8');

      assert.strictEqual(getMetrics(ws).runs.length, 0);
    });

    test('drops individual malformed runs but keeps valid ones', function () {
      const ws = freshWs('mixed');
      const file = metricsFilePath(ws);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          runs: [
            { ts: '2026-01-01T00:00:00.000Z', sessionsAnalyzed: 2, kept: 1, patternsLearned: 1 },
            { sessionsAnalyzed: 2 }, // no ts → dropped
            'garbage',
          ],
        }),
        'utf8',
      );

      const metrics = getMetrics(ws);
      assert.strictEqual(metrics.runs.length, 1, 'only the valid run survives');
      assert.strictEqual(metrics.runs[0].ts, '2026-01-01T00:00:00.000Z');
    });

    test('a record after corruption recovers and persists cleanly', async function () {
      const ws = freshWs('recover');
      const file = metricsFilePath(ws);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'totally broken', 'utf8');

      await recordLearningRun(ws, run({ patternsLearned: 7 }));
      const metrics = getMetrics(ws);
      assert.strictEqual(metrics.runs.length, 1);
      assert.strictEqual(metrics.runs[0].patternsLearned, 7);
    });
  });

  // -------------------------------------------------------------------------
  suite('ledgerBridge (R2.1-R2.4)', function () {
    test('enabled: aggregates prompt/completion + cost from a stubbed ledger', async function () {
      const ws = freshWs('ledger-on');
      const cfg = defaultConfig();
      cfg.tokenLogging.enabled = true;

      const ledger = stubLedger([
        ledgerRow({ tokens: { input: 100, output: 40 }, costCents: 5, provider: 'ollama', model: 'qwen3:0.6b' }),
        ledgerRow({ tokens: { input: 60, output: 20 }, costCents: 3, provider: 'ollama', model: 'qwen3:0.6b' }),
        ledgerRow({ operation: 'embed', tokens: { input: 999, output: 0 } }), // excluded (not 'chat')
      ]);

      const agg = await aggregateRealTokens(ws, cfg, { ledger });
      assert.strictEqual(agg.available, true);
      assert.strictEqual(agg.real, true, 'marked real, not estimated (R2.4)');
      assert.strictEqual(agg.usage.prompt, 160);
      assert.strictEqual(agg.usage.completion, 60);
      assert.strictEqual(agg.usage.provider, 'ollama');
      assert.strictEqual(agg.usage.model, 'qwen3:0.6b');
      assert.ok(Math.abs(agg.costUsd - 0.08) < 1e-9, 'cents → USD');
      assert.strictEqual(agg.rowCount, 2, 'embed row excluded');
    });

    test('disabled: surfaces NO real tokens (R2.3)', async function () {
      const ws = freshWs('ledger-off');
      const cfg = defaultConfig();
      cfg.tokenLogging.enabled = false;

      let read = false;
      const ledger: LedgerLike = {
        async readAll() {
          read = true;
          return [ledgerRow()];
        },
      };

      const agg = await aggregateRealTokens(ws, cfg, { ledger });
      assert.strictEqual(agg.available, false);
      assert.strictEqual(agg.real, false);
      assert.strictEqual(agg.usage.prompt, 0);
      assert.strictEqual(agg.usage.completion, 0);
      assert.strictEqual(read, false, 'ledger not even read when disabled');
    });

    test('enabled but no matching rows → unavailable (estimates only)', async function () {
      const ws = freshWs('ledger-empty');
      const cfg = defaultConfig();
      const agg = await aggregateRealTokens(ws, cfg, { ledger: stubLedger([]) });
      assert.strictEqual(agg.available, false);
      assert.strictEqual(agg.real, false);
    });

    test('filters ledger rows by runId for per-run attribution', async function () {
      const ws = freshWs('ledger-runid');
      const cfg = defaultConfig();
      const ledger = stubLedger([
        ledgerRow({ runId: 'run-A', tokens: { input: 10, output: 5 } }),
        ledgerRow({ runId: 'run-B', tokens: { input: 999, output: 999 } }),
      ]);

      const agg = await aggregateRealTokens(ws, cfg, { ledger, runId: 'run-A' });
      assert.strictEqual(agg.usage.prompt, 10);
      assert.strictEqual(agg.usage.completion, 5);
      assert.strictEqual(agg.rowCount, 1);
    });
  });
});
