/**
 * consensusActiveScan.test.ts — regression tests for the consensus/active
 * classifier. Guards the "always No vote files in consensus/active/" bug: review
 * stubs (`<task>.json`) must be told apart from per-agent votes
 * (`<task>-<voter>.json`), and task ids must come from file CONTENT (so ids with
 * dashes like `RV-1` aren't mangled by a filename split).
 */

import * as assert from 'assert';

import { classifyConsensusActive, ConsensusActiveEntry } from '../orchestrator/consensusActiveScan';

function vote(taskId: string, voter: string, v: string): ConsensusActiveEntry {
  return { name: `${taskId}-${voter}.json`, json: { task_id: taskId, voter, vote: v, timestamp: 't' } };
}
function stub(taskId: string): ConsensusActiveEntry {
  return { name: `${taskId}.json`, json: { task_id: taskId, reviewers: ['a', 'b'], rule: 'majority', status: 'open' } };
}

suite('consensusActiveScan', function () {
  test('separates per-agent votes from review stubs', function () {
    const scan = classifyConsensusActive([
      stub('B1'),
      vote('B1', 'claude-code', 'approve'),
      vote('B1', 'kilocode', 'approve'),
      stub('B2'), // stub only, no votes yet
    ]);
    assert.deepStrictEqual([...scan.votesByTask.keys()].sort(), ['B1'], 'B1 has votes');
    assert.strictEqual(scan.votesByTask.get('B1')!.length, 2, 'two B1 votes');
    assert.deepStrictEqual(scan.awaitingReview, ['B2'], 'B2 stub awaits votes; B1 not (has votes)');
  });

  test('task ids with dashes (RV-1) are taken from content, not split', function () {
    const scan = classifyConsensusActive([
      vote('RV-1', 'claude-code', 'approve'),
      vote('RV-1', 'kilo-code', 'request_changes'),
    ]);
    assert.deepStrictEqual([...scan.votesByTask.keys()], ['RV-1'], 'id preserved (not "RV")');
    assert.strictEqual(scan.votesByTask.get('RV-1')!.length, 2);
    assert.strictEqual(scan.awaitingReview.length, 0);
  });

  test('stub-only dir → awaitingReview, zero votes (not "no vote files")', function () {
    const scan = classifyConsensusActive([stub('A1'), stub('A2')]);
    assert.strictEqual(scan.votesByTask.size, 0);
    assert.deepStrictEqual(scan.awaitingReview, ['A1', 'A2']);
  });

  test('empty + unparseable + missing-task_id entries are ignored', function () {
    const scan = classifyConsensusActive([
      { name: 'broken.json', json: null },
      { name: 'no-task.json', json: { vote: 'approve' } },
      vote('C1', 'a', 'approve'),
    ]);
    assert.deepStrictEqual([...scan.votesByTask.keys()], ['C1']);
    assert.deepStrictEqual(scan.ignored.sort(), ['broken.json', 'no-task.json']);
    assert.strictEqual(scan.awaitingReview.length, 0);
  });
});
