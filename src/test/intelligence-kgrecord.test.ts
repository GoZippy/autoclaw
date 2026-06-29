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

import { recordCoordinationToKg, recordOrchestrationEventsToKg, recordLearningsToKg, recordOutcomeEdge, OrchestrationEvent } from '../intelligence/kgRecord';
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

/** In-memory KG that mimics the real store: duplicate thought id → throw (plain
 *  INSERT); edges INSERT OR REPLACE by (from,kind,to) so re-adding never grows. */
function fakeKg() {
  const recorded: Array<{ id?: string; project: string; agent?: string; task_id?: string; kind: string; text: string; meta?: Record<string, unknown> }> = [];
  const ids = new Set<string>();
  const edges = new Map<string, { from: string; kind: string; to: string; meta?: Record<string, unknown> }>();
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
    async recordRelation(from: string, kind: string, to: string, meta?: Record<string, unknown>) {
      edges.set(`${from}|${kind}|${to}`, { from, kind, to, meta }); // upsert (PK = triple)
    },
  } as unknown as KnowledgeGraph;
  return { kg, recorded, ids, edges };
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

  suite('recordOrchestrationEventsToKg', () => {
    const events: OrchestrationEvent[] = [
      { type: 'dispatch', eventId: 'B1-123-ab', agentId: 'claude-code', taskId: 'B1', sprint: 2, text: 'Dispatched B1 to claude-code.' },
      { type: 'completion', eventId: 'msg-9', agentId: 'kilocode', taskId: 'B2', text: 'kilocode completed B2.' },
    ];

    test('records dispatch + completion as observation thoughts (deterministic ids)', async () => {
      const f = fakeKg();
      const res = await recordOrchestrationEventsToKg(WS, events, { deps: { getKg: () => f.kg } });
      assert.strictEqual(res.recorded, 2);
      assert.strictEqual(f.recorded.length, 2);
      const dispatch = f.recorded.find((t) => t.task_id === 'B1')!;
      assert.strictEqual(dispatch.kind, 'observation');
      assert.strictEqual(dispatch.agent, 'claude-code', 'attributed to the assignee');
      assert.ok(dispatch.id!.startsWith('dispatch:') && dispatch.id!.endsWith(':B1-123-ab'), 'dispatch id');
      assert.strictEqual((dispatch.meta as any).source, 'dispatch');
      const done = f.recorded.find((t) => t.task_id === 'B2')!;
      assert.ok(done.id!.startsWith('completion:') && done.id!.endsWith(':msg-9'), 'completion id');
      assert.strictEqual(done.agent, 'kilocode');
    });

    test('idempotent — re-recording the same events records nothing new', async () => {
      const f = fakeKg();
      await recordOrchestrationEventsToKg(WS, events, { deps: { getKg: () => f.kg } });
      const second = await recordOrchestrationEventsToKg(WS, events, { deps: { getKg: () => f.kg } });
      assert.strictEqual(second.recorded, 0);
      assert.strictEqual(second.skipped, 2);
      assert.strictEqual(f.recorded.length, 2);
    });

    test('skips malformed events and survives a KG open failure', async () => {
      const f = fakeKg();
      const res = await recordOrchestrationEventsToKg(
        WS,
        [...events, { type: 'dispatch', eventId: '', agentId: 'x', text: 'no id' } as OrchestrationEvent],
        { deps: { getKg: () => f.kg } },
      );
      assert.strictEqual(res.recorded, 2, 'malformed (empty eventId) filtered out');

      const failed = await recordOrchestrationEventsToKg(WS, events, {
        deps: { getKg: () => { throw new Error('no driver'); } },
      });
      assert.strictEqual(failed.recorded, 0);
      assert.strictEqual(failed.skipped, 2);
    });

    test('empty list records nothing', async () => {
      const f = fakeKg();
      assert.deepStrictEqual(
        await recordOrchestrationEventsToKg(WS, [], { deps: { getKg: () => f.kg } }),
        { recorded: 0, skipped: 0 },
      );
    });
  });

  suite('recordLearningsToKg', () => {
    function workflow(seq: string[], shipped: number, discarded: number): any {
      const total = shipped + discarded;
      return { sequence: seq, label: seq.join(' → '), shipped, discarded, unknown: 0, total, shipRate: total ? shipped / (shipped + discarded) : 0 };
    }

    test('records workflow patterns + review findings as finding thoughts', async () => {
      const f = fakeKg();
      const res = await recordLearningsToKg(WS, {
        workflows: [workflow(['Read', 'Edit', 'Bash'], 6, 1)],
        findings: [{ from: 'kilocode', severity: 'high', description: 'inbox watcher race on same-second writes' }],
      }, { deps: { getKg: () => f.kg } });
      assert.strictEqual(res.recorded, 2);
      assert.strictEqual(f.recorded.length, 2);

      const wf = f.recorded.find((t) => t.id!.startsWith('workflow:'))!;
      assert.strictEqual(wf.kind, 'finding');
      assert.ok(wf.text.includes('Read → Edit → Bash') && wf.text.includes('ships'), 'reuses workflowPatternLabel');
      assert.strictEqual((wf.meta as any).source, 'workflow');

      const find = f.recorded.find((t) => t.id!.startsWith('finding:'))!;
      assert.strictEqual(find.kind, 'finding');
      assert.strictEqual(find.text, 'inbox watcher race on same-second writes');
      assert.strictEqual((find.meta as any).severity, 'high');
      assert.strictEqual(find.agent, 'kilocode');
    });

    test('idempotent on re-run', async () => {
      const f = fakeKg();
      const facts = { workflows: [workflow(['Read', 'Edit'], 3, 0)], findings: [{ from: 'x', severity: 'low', description: 'note' }] };
      const first = await recordLearningsToKg(WS, facts, { deps: { getKg: () => f.kg } });
      assert.strictEqual(first.recorded, 2);
      const second = await recordLearningsToKg(WS, facts, { deps: { getKg: () => f.kg } });
      assert.strictEqual(second.recorded, 0, 'duplicate ids skipped on re-run');
      assert.strictEqual(second.skipped, 2);
    });

    test('empty learnings record nothing; a failing KG never throws', async () => {
      const f = fakeKg();
      assert.deepStrictEqual(await recordLearningsToKg(WS, {}, { deps: { getKg: () => f.kg } }), { recorded: 0, skipped: 0 });
      const res = await recordLearningsToKg(WS, { findings: [{ from: 'x', severity: 'low', description: 'd' }] }, {
        deps: { getKg: () => { throw new Error('no driver'); } },
      });
      assert.strictEqual(res.recorded, 0);
      assert.strictEqual(res.skipped, 1);
    });
  });

  suite('recordOutcomeEdge', () => {
    const outcome = {
      taskId: 'B1', agentId: 'claude-code', verdict: 'approved', gatePassed: true,
      resolvedAt: '2026-06-28T00:00:00.000Z', reviewers: ['kilocode', 'claude-code'], capabilities: ['typescript', 'testing'],
    };

    test('materializes entity nodes + completed/reviewed/demonstrated edges', async () => {
      const f = fakeKg();
      const res = await recordOutcomeEdge(WS, outcome, { deps: { getKg: () => f.kg } });
      assert.ok(res.recorded > 0);

      // entity nodes exist as thoughts with deterministic ids
      assert.ok(f.ids.has('agent:claude-code'), 'agent node');
      assert.ok([...f.ids].some((id) => id.startsWith('task:') && id.endsWith(':B1')), 'task node');
      assert.ok(f.ids.has('agent:kilocode'), 'reviewer node');
      assert.ok(f.ids.has('capability:typescript') && f.ids.has('capability:testing'), 'capability nodes');

      const kinds = [...f.edges.values()].map((e) => e.kind).sort();
      // completed(1) + reviewed(1, assignee filtered out) + demonstrated(2)
      assert.deepStrictEqual(kinds, ['completed', 'demonstrated', 'demonstrated', 'reviewed']);
      const completed = [...f.edges.values()].find((e) => e.kind === 'completed')!;
      assert.strictEqual(completed.from, 'agent:claude-code');
      assert.ok(completed.to.endsWith(':B1'));
      assert.strictEqual((completed.meta as any).verdict, 'approved');
      assert.strictEqual((completed.meta as any).gate_passed, true);
      // the assignee is NOT recorded as its own reviewer
      assert.ok(![...f.edges.values()].some((e) => e.kind === 'reviewed' && e.from === 'agent:claude-code'));
    });

    test('idempotent — re-run does not grow the graph', async () => {
      const f = fakeKg();
      await recordOutcomeEdge(WS, outcome, { deps: { getKg: () => f.kg } });
      const nodes1 = f.ids.size, edges1 = f.edges.size;
      await recordOutcomeEdge(WS, outcome, { deps: { getKg: () => f.kg } });
      assert.strictEqual(f.ids.size, nodes1, 'no new nodes (deterministic ids)');
      assert.strictEqual(f.edges.size, edges1, 'no new edges (PK = from,kind,to)');
    });

    test('skips malformed input and survives a KG open failure', async () => {
      const f = fakeKg();
      assert.deepStrictEqual(
        await recordOutcomeEdge(WS, { taskId: '', agentId: 'x' }, { deps: { getKg: () => f.kg } }),
        { recorded: 0, skipped: 0 },
      );
      const res = await recordOutcomeEdge(WS, outcome, { deps: { getKg: () => { throw new Error('no driver'); } } });
      assert.strictEqual(res.recorded, 0);
      assert.strictEqual(res.skipped, 1);
    });
  });
});
