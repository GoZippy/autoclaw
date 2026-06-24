/**
 * boardAutotransition.test.ts — board lane auto-transition.
 *
 * Pure logic (computeTaskTransitions): claim→in_progress, review→in_review,
 * approved→merged; forward-only (never downgrades), never touches `blocked`,
 * idempotent, and populates signal-only tasks. Plus an end-to-end
 * applyBoardAutoTransition over a temp .autoclaw tree.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  computeTaskTransitions,
  applyBoardAutoTransition,
} from '../orchestrator/boardAutotransition';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-board-'));
}

suite('boardAutotransition', function () {
  suite('computeTaskTransitions (pure)', function () {
    test('claim → in_progress, review → in_review, approved → merged', function () {
      const tr = computeTaskTransitions({
        tasks: [{ id: 'A', status: 'open' }, { id: 'B', status: 'open' }, { id: 'C', status: 'open' }],
        claimedTaskIds: new Set(['A']),
        reviewTaskIds: new Set(['B']),
        approvedTaskIds: new Set(['C']),
      });
      const byId = new Map(tr.map((t) => [t.taskId, t.newStatus]));
      assert.strictEqual(byId.get('A'), 'in_progress');
      assert.strictEqual(byId.get('B'), 'in_review');
      assert.strictEqual(byId.get('C'), 'merged');
    });

    test('highest applicable target wins (approved > review > claim)', function () {
      const tr = computeTaskTransitions({
        tasks: [{ id: 'X', status: 'in_progress' }],
        claimedTaskIds: new Set(['X']),
        reviewTaskIds: new Set(['X']),
        approvedTaskIds: new Set(['X']),
      });
      assert.deepStrictEqual(tr.map((t) => t.newStatus), ['merged']);
    });

    test('forward-only: never downgrades, idempotent', function () {
      // Already merged; a stale claim/review signal must NOT move it back.
      const tr = computeTaskTransitions({
        tasks: [{ id: 'M', status: 'merged' }],
        claimedTaskIds: new Set(['M']),
        reviewTaskIds: new Set(['M']),
        approvedTaskIds: new Set(),
      });
      assert.strictEqual(tr.length, 0, 'no downgrade');

      // Re-running after a transition is a no-op (idempotent).
      const inputs = {
        tasks: [{ id: 'A', status: 'in_progress' }],
        claimedTaskIds: new Set(['A']),
        reviewTaskIds: new Set<string>(),
        approvedTaskIds: new Set<string>(),
      };
      assert.strictEqual(computeTaskTransitions(inputs).length, 0, 'already in_progress → no-op');
    });

    test('never auto-moves a blocked task', function () {
      const tr = computeTaskTransitions({
        tasks: [{ id: 'B', status: 'blocked' }],
        claimedTaskIds: new Set(['B']),
        reviewTaskIds: new Set(['B']),
        approvedTaskIds: new Set(['B']),
      });
      assert.strictEqual(tr.length, 0);
    });

    test('populates signal-only tasks not yet in state', function () {
      const tr = computeTaskTransitions({
        tasks: [], // empty state.tasks
        claimedTaskIds: new Set(['NEW']),
        reviewTaskIds: new Set(),
        approvedTaskIds: new Set(),
      });
      assert.deepStrictEqual(tr.map((t) => [t.taskId, t.oldStatus, t.newStatus]), [['NEW', undefined, 'in_progress']]);
    });
  });

  suite('applyBoardAutoTransition (end-to-end)', function () {
    test('reads live signals + writes state.json', async function () {
      const root = mkTmp();
      try {
        const comms = path.join(root, '.autoclaw', 'orchestrator', 'comms');
        fs.mkdirSync(path.join(comms, 'claims'), { recursive: true });
        fs.mkdirSync(path.join(comms, 'consensus', 'active'), { recursive: true });
        fs.mkdirSync(path.join(comms, 'consensus', 'resolved'), { recursive: true });
        const statePath = path.join(root, '.autoclaw', 'orchestrator', 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({ tasks: [{ id: 'T1', status: 'open' }, { id: 'T2', status: 'open' }, { id: 'T3', status: 'open' }] }));

        // T1 claimed, T2 in review (stub), T3 approved.
        fs.writeFileSync(path.join(comms, 'claims', 'T1.json'), JSON.stringify({ task_id: 'T1', claimed_by: 'a' }));
        fs.writeFileSync(path.join(comms, 'consensus', 'active', 'T2.json'), JSON.stringify({ task_id: 'T2', reviewers: ['a'] }));
        fs.writeFileSync(path.join(comms, 'consensus', 'resolved', 'T3.json'), JSON.stringify({ task_id: 'T3', verdict: 'approved' }));

        const res = await applyBoardAutoTransition(root, { nowIso: '2026-06-22T00:00:00.000Z' });
        assert.strictEqual(res.transitions.length, 3);

        const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const byId = new Map((saved.tasks as Array<{ id: string; status: string }>).map((t) => [t.id, t.status]));
        assert.strictEqual(byId.get('T1'), 'in_progress');
        assert.strictEqual(byId.get('T2'), 'in_review');
        assert.strictEqual(byId.get('T3'), 'merged');

        // Idempotent: a second pass over the same signals makes no changes.
        const again = await applyBoardAutoTransition(root, { nowIso: '2026-06-22T00:00:01.000Z' });
        assert.strictEqual(again.transitions.length, 0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('missing .autoclaw tree → no transitions, no throw', async function () {
      const root = mkTmp();
      try {
        const res = await applyBoardAutoTransition(root);
        assert.deepStrictEqual(res.transitions, []);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
