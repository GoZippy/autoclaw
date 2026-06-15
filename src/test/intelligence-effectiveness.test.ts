/**
 * intelligence-effectiveness.test.ts — unit tests for the tool × project
 * effectiveness matrix (src/intelligence/effectiveness.ts) and its snapshot
 * store (src/intelligence/metrics/effectivenessStore.ts).
 *
 * Pure-logic + a tiny temp-dir round-trip. No `vscode`, no extension host.
 * Exercises:
 *  - per-tool and per-(tool×project) aggregation, ship rate, kept density, ROI.
 *  - deterministic ranking (best ship rate first).
 *  - snapshot persistence: write → read round-trip lands at the contract path,
 *    and a corrupt/missing file reads back empty without throwing.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { computeEffectiveness } from '../intelligence/effectiveness';
import {
  effectivenessFilePath,
  getEffectiveness,
  recordEffectiveness,
} from '../intelligence/metrics/effectivenessStore';
import { SessionOutcome, UnifiedSession } from '../intelligence/types';

function session(
  id: string,
  tool: string,
  project: string,
  outcome: SessionOutcome,
  keptCount = 0,
  text = 'x'.repeat(40),
): UnifiedSession {
  const signals: UnifiedSession['signals'] = {
    keptCode: Array.from({ length: keptCount }, () => ({
      code: 'const x = 1;',
      reason: 'applied_edit' as const,
      confidence: 0.8,
    })),
  };
  if (outcome === 'shipped' && keptCount === 0) {
    signals.gitKept = true;
  } else if (outcome === 'discarded') {
    signals.outcome = 'discarded';
  }
  return {
    id,
    source: tool === 'Claude Code' ? 'claude-code' : 'cursor',
    tool,
    project,
    startedAt: 1,
    messages: [{ role: 'assistant', text }],
    signals,
    provenance: { adapterId: 'x', rawRef: id, extractedAt: 1 },
  };
}

let tmpRoot: string;

suite('intelligence-effectiveness', function () {
  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-eff-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  suite('computeEffectiveness', function () {
    test('aggregates per tool with ship rate and kept density', function () {
      const sessions = [
        session('a', 'Claude Code', '/repo/demo', 'shipped', 2),
        session('b', 'Claude Code', '/repo/demo', 'shipped', 0),
        session('c', 'Claude Code', '/repo/demo', 'discarded', 0),
        session('d', 'Cursor', '/repo/demo', 'discarded', 0),
      ];
      const m = computeEffectiveness(sessions, { now: '2026-06-14T00:00:00.000Z' });
      assert.strictEqual(m.totalSessions, 4);

      const cc = m.byTool.find((c) => c.tool === 'Claude Code');
      assert.ok(cc);
      assert.strictEqual(cc?.sessions, 3);
      assert.strictEqual(cc?.shipped, 2);
      assert.strictEqual(cc?.discarded, 1);
      assert.ok(Math.abs((cc?.shipRate ?? 0) - 2 / 3) < 1e-9);
      assert.ok(Math.abs((cc?.keptPerSession ?? 0) - 2 / 3) < 1e-9);

      const cur = m.byTool.find((c) => c.tool === 'Cursor');
      assert.strictEqual(cur?.shipRate, 0);
    });

    test('ranks higher ship rate first', function () {
      const sessions = [
        session('a', 'Claude Code', '/repo/x', 'shipped', 1),
        session('b', 'Cursor', '/repo/x', 'discarded', 0),
      ];
      const m = computeEffectiveness(sessions);
      assert.strictEqual(m.byTool[0].tool, 'Claude Code', 'best ship rate ranks first');
    });

    test('tokensPerKept rewards efficiency (lower is better)', function () {
      // Same tokens, more kept signals → lower tokens/kept.
      const efficient = session('eff', 'Claude Code', '/r', 'shipped', 4, 'y'.repeat(400));
      const wasteful = session('waste', 'Cursor', '/r', 'shipped', 1, 'y'.repeat(400));
      const m = computeEffectiveness([efficient, wasteful]);
      const cc = m.byTool.find((c) => c.tool === 'Claude Code');
      const cur = m.byTool.find((c) => c.tool === 'Cursor');
      assert.ok((cc?.tokensPerKept ?? 0) < (cur?.tokensPerKept ?? 0));
    });

    test('per tool×project rows carry a friendly project label', function () {
      const m = computeEffectiveness([session('a', 'Claude Code', '/a/b/myrepo', 'shipped', 1)]);
      const row = m.byToolProject[0];
      assert.strictEqual(row.projectLabel, 'myrepo');
      assert.strictEqual(row.project, '/a/b/myrepo');
    });
  });

  suite('effectivenessStore (persistence)', function () {
    test('write → read round-trip at the contract path', async function () {
      const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
      const m = computeEffectiveness(
        [session('a', 'Claude Code', '/repo/demo', 'shipped', 1)],
        { now: '2026-06-14T00:00:00.000Z' },
      );
      await recordEffectiveness(ws, m);

      const file = effectivenessFilePath(ws);
      assert.ok(fs.existsSync(file), 'snapshot file written');
      assert.ok(file.endsWith('.autoclaw/metrics/effectiveness.json'));

      const read = getEffectiveness(ws);
      assert.strictEqual(read.totalSessions, 1);
      assert.strictEqual(read.byTool[0].tool, 'Claude Code');
      assert.strictEqual(read.generatedAt, '2026-06-14T00:00:00.000Z');
    });

    test('missing file reads back empty', function () {
      const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
      const read = getEffectiveness(ws);
      assert.strictEqual(read.totalSessions, 0);
      assert.deepStrictEqual(read.byTool, []);
    });

    test('corrupt file reads back empty, never throws', async function () {
      const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
      const file = effectivenessFilePath(ws);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{ not json', 'utf8');
      const read = getEffectiveness(ws);
      assert.strictEqual(read.totalSessions, 0);
      assert.deepStrictEqual(read.byToolProject, []);
    });
  });
});
