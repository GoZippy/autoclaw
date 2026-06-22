/**
 * intelligence-kgrecord.test.ts — unit tests for KG population from coordination
 * outcomes.
 *
 * Verifies:
 *  - each consensus outcome is recorded as a `decision` thought, project- and
 *    task-scoped, with a deterministic dedup id and verdict in meta;
 *  - re-recording the same outcomes is idempotent (duplicate-id INSERT throws in
 *    the real store → guarded → skipped, not surfaced);
 *  - an empty/absent signal set records nothing;
 *  - a degraded/unavailable KG never throws (returns recorded:0).
 *
 * The KnowledgeGraph is injected (an in-memory stub that mimics the real store's
 * duplicate-id throw), so the test runs fully offline with no SQLite/KG stack.
 */

import * as assert from 'assert';

import { recordCoordinationToKg } from '../intelligence/kgRecord';
import { CoordinationSignals } from '../intelligence/coordinationSignals';
import type { KnowledgeGraph } from '../intelligence/kg/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = '/tmp/kgrec-ws';

function signals(overrides: Partial<CoordinationSignals> = {}): CoordinationSignals {
  return {
    outcomes: [
      { taskId: 'B1', verdict: 'approved', rule: 'majority', approvals: 2, panelSize: 3, reviewers: ['a', 'b'] },
      { taskId: 'B2', verdict: 'rejected', rule: 'majority', approvals: 0, panelSize: 3, reviewers: ['a'] },
    ],
    successful: [],
    avoided: [],
    findings: [],
    counts: { approved: 1, changesRequested: 0, rejected: 1, findings: 0 },
    ...overrides,
  };
}

/** In-memory KG that mimics the real store: duplicate id → throw (plain INSERT). */
function fakeKg() {
  const recorded: Array<{ id?: string; project: string; task_id?: string; kind: string; text: string; meta?: Record<string, unknown> }> = [];
  const ids = new Set<string>();
  const kg = {
    async recordThought(t: any) {
      const id = t.id;
      if (id && ids.has(id)) {
        throw new Error('UNIQUE constraint failed: thoughts.id');
      }
      if (id) ids.add(id);
      recorded.push(t);
      return id ?? `auto-${recorded.length}`;
    },
  } as unknown as KnowledgeGraph;
  return { kg, recorded, ids };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('intelligence-kgrecord', function () {
  test('records each outcome as a project/task-scoped decision thought', async () => {
    const f = fakeKg();
    const res = await recordCoordinationToKg(WS, signals(), { deps: { getKg: () => f.kg } });
    assert.strictEqual(res.recorded, 2);
    assert.strictEqual(res.skipped, 0);
    assert.strictEqual(f.recorded.length, 2);

    const b1 = f.recorded.find((t) => t.task_id === 'B1')!;
    assert.strictEqual(b1.kind, 'decision');
    assert.ok(b1.id && b1.id.startsWith('coord:'), 'deterministic id');
    assert.ok(b1.id!.endsWith(':B1:approved'), 'id encodes task + verdict');
    assert.ok(b1.text.includes('approved') && b1.text.includes('B1'), 'human text');
    assert.strictEqual((b1.meta as any).verdict, 'approved');
    assert.strictEqual((b1.meta as any).source, 'coordination');
    assert.ok(b1.project && b1.project.length > 0, 'project scoped');
  });

  test('is idempotent — re-recording the same outcomes records nothing new', async () => {
    const f = fakeKg();
    const first = await recordCoordinationToKg(WS, signals(), { deps: { getKg: () => f.kg } });
    assert.strictEqual(first.recorded, 2);
    const second = await recordCoordinationToKg(WS, signals(), { deps: { getKg: () => f.kg } });
    assert.strictEqual(second.recorded, 0, 'no new records on re-run');
    assert.strictEqual(second.skipped, 2, 'both skipped as duplicates');
    assert.strictEqual(f.recorded.length, 2, 'store still holds 2');
  });

  test('a new verdict for the same task records a distinct fact', async () => {
    const f = fakeKg();
    await recordCoordinationToKg(WS, signals({ outcomes: [
      { taskId: 'B1', verdict: 'rejected', rule: 'majority', approvals: 0, panelSize: 3, reviewers: [] },
    ] }), { deps: { getKg: () => f.kg } });
    const res = await recordCoordinationToKg(WS, signals({ outcomes: [
      { taskId: 'B1', verdict: 'approved', rule: 'majority', approvals: 3, panelSize: 3, reviewers: [] },
    ] }), { deps: { getKg: () => f.kg } });
    assert.strictEqual(res.recorded, 1, 'approved is a new id vs the earlier rejected');
    assert.strictEqual(f.recorded.length, 2);
  });

  test('empty / absent outcomes record nothing', async () => {
    const f = fakeKg();
    assert.deepStrictEqual(
      await recordCoordinationToKg(WS, signals({ outcomes: [] }), { deps: { getKg: () => f.kg } }),
      { recorded: 0, skipped: 0 },
    );
    assert.deepStrictEqual(
      await recordCoordinationToKg(WS, undefined, { deps: { getKg: () => f.kg } }),
      { recorded: 0, skipped: 0 },
    );
    assert.strictEqual(f.recorded.length, 0);
  });

  test('a KG that fails to open never throws', async () => {
    const res = await recordCoordinationToKg(WS, signals(), {
      deps: {
        getKg: () => {
          throw new Error('no sqlite driver');
        },
      },
    });
    assert.strictEqual(res.recorded, 0);
    assert.strictEqual(res.skipped, 2, 'all outcomes counted as skipped');
  });
});
