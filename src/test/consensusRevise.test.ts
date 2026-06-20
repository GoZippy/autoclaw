/**
 * consensusRevise.test.ts — the bounded revise/converge round.
 *
 * Pure decision (detectDissentAndRevise) + the FS effect (emitRevisionRequest) +
 * integration through resolvePendingConsensus with reviseMaxRounds.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  detectDissentAndRevise,
  emitRevisionRequest,
} from '../orchestrator/consensusRevise';
import {
  resolvePendingConsensus,
  type ConsensusStub,
  type TallyVote,
} from '../orchestrator/consensusTally';

function vote(voter: string, v: TallyVote['vote'], ts?: string): TallyVote {
  return { voter, vote: v, timestamp: ts };
}
function stub(over: Partial<ConsensusStub> = {}): ConsensusStub {
  return {
    task_id: 'A1', author: 'claude-code',
    reviewers: ['kilocode', 'kiro', 'codex'], rule: 'majority',
    votes: [], source_task_complete_id: 'msg-1', status: 'open', ...over,
  };
}
function activePath(root: string, name: string): string {
  return path.join(root, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'active', name);
}
function resolvedPath(root: string, name: string): string {
  return path.join(root, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'resolved', name);
}
function inboxOf(root: string, agent: string): string {
  return path.join(root, '.autoclaw', 'orchestrator', 'comms', 'inboxes', agent);
}
function writeJson(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Pure: detectDissentAndRevise
// ---------------------------------------------------------------------------

suite('consensusRevise — detectDissentAndRevise', () => {
  test('an approval keeps the verdict (no revise)', () => {
    const d = detectDissentAndRevise({ status: 'resolved', verdict: 'approved' }, {}, { maxRounds: 2 });
    assert.strictEqual(d.action, 'keep_resolved');
  });

  test('a still-pending tally never revises', () => {
    const d = detectDissentAndRevise({ status: 'pending' }, {}, { maxRounds: 2 });
    assert.strictEqual(d.action, 'keep_resolved');
    assert.strictEqual(d.reason, 'pending');
  });

  test('dissent on round 1 with rounds left → emit revision to round 2', () => {
    const d = detectDissentAndRevise({ status: 'resolved', verdict: 'changes_requested' }, { round: 1 }, { maxRounds: 2 });
    assert.strictEqual(d.action, 'emit_revision_request');
    assert.strictEqual(d.nextRound, 2);
  });

  test('dissent at the round ceiling finalizes', () => {
    const d = detectDissentAndRevise({ status: 'resolved', verdict: 'rejected' }, { round: 2 }, { maxRounds: 2 });
    assert.strictEqual(d.action, 'keep_resolved');
    assert.ok(d.reason.includes('max_rounds'));
  });

  test('default maxRounds=1 is back-compat: dissent finalizes immediately', () => {
    const d = detectDissentAndRevise({ status: 'resolved', verdict: 'rejected' }, { round: 1 });
    assert.strictEqual(d.action, 'keep_resolved');
  });
});

// ---------------------------------------------------------------------------
// FS: emitRevisionRequest
// ---------------------------------------------------------------------------

suite('consensusRevise — emitRevisionRequest', () => {
  let root: string;
  setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-')); });
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('writes a revision_request, resets the stub, clears per-agent votes', async () => {
    writeJson(activePath(root, 'A1.json'), stub({ votes: [vote('kilocode', 'request_changes')] }));
    writeJson(activePath(root, 'A1-kilocode.json'), { voter: 'kilocode', task_id: 'A1', vote: 'request_changes' });

    const res = await emitRevisionRequest({
      workspaceRoot: root,
      stub: stub({ round: 1 }),
      votes: [vote('kilocode', 'request_changes'), vote('kiro', 'reject')],
      nextRound: 2,
      now: new Date('2026-06-20T00:00:00Z'),
    });

    assert.ok(res.messageFile, 'a message was written');
    assert.strictEqual(res.stubReset, true);

    // Message landed in the author's inbox with the dissent feedback.
    const inbox = inboxOf(root, 'claude-code');
    const files = fs.readdirSync(inbox).filter(n => n.includes('revision_request'));
    assert.strictEqual(files.length, 1);
    const msg = JSON.parse(fs.readFileSync(path.join(inbox, files[0]), 'utf8'));
    assert.strictEqual(msg.type, 'revision_request');
    assert.strictEqual(msg.payload.round, 2);
    assert.strictEqual(msg.payload.dissent_votes.length, 2, 'carries the dissenting votes');

    // Stub reset: round bumped, votes cleared.
    const updated = JSON.parse(fs.readFileSync(activePath(root, 'A1.json'), 'utf8'));
    assert.strictEqual(updated.round, 2);
    assert.deepStrictEqual(updated.votes, []);
    assert.ok(!fs.existsSync(activePath(root, 'A1-kilocode.json')), 'per-agent vote cleared');
  });

  test('no author ⇒ no message, no reset (caller should finalize)', async () => {
    const res = await emitRevisionRequest({
      workspaceRoot: root, stub: stub({ author: undefined }), votes: [], nextRound: 2,
    });
    assert.strictEqual(res.messageFile, undefined);
    assert.strictEqual(res.stubReset, false);
  });
});

// ---------------------------------------------------------------------------
// Integration through resolvePendingConsensus
// ---------------------------------------------------------------------------

suite('consensusRevise — resolvePendingConsensus integration', () => {
  let root: string;
  setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cri-')); });
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('reviseMaxRounds:2 — first-round dissent triggers a revise, not a finalize', async () => {
    writeJson(activePath(root, 'A1.json'), stub({
      votes: [vote('kilocode', 'request_changes'), vote('kiro', 'request_changes'), vote('codex', 'request_changes')],
    }));
    const res = await resolvePendingConsensus({ workspaceRoot: root, reviseMaxRounds: 2 });

    assert.strictEqual(res.resolved.length, 0, 'not finalized');
    assert.deepStrictEqual(res.revised, [{ task_id: 'A1', round: 2 }]);
    assert.deepStrictEqual(res.pending, ['A1']);
    assert.ok(!fs.existsSync(resolvedPath(root, 'A1.json')), 'no resolved record yet');
    const updated = JSON.parse(fs.readFileSync(activePath(root, 'A1.json'), 'utf8'));
    assert.strictEqual(updated.round, 2, 'stub advanced to round 2');
    const inbox = inboxOf(root, 'claude-code');
    assert.ok(fs.readdirSync(inbox).some(n => n.includes('revision_request')), 'author got a revision_request');
  });

  test('round 2 approval finalizes after a revise', async () => {
    // Simulate the post-revise state: stub at round 2 with fresh approvals.
    writeJson(activePath(root, 'A1.json'), stub({
      round: 2, votes: [vote('kilocode', 'approve'), vote('kiro', 'approve')],
    }));
    const res = await resolvePendingConsensus({ workspaceRoot: root, reviseMaxRounds: 2 });

    assert.strictEqual(res.resolved.length, 1);
    assert.strictEqual(res.resolved[0].verdict, 'approved');
    const rec = JSON.parse(fs.readFileSync(resolvedPath(root, 'A1.json'), 'utf8'));
    assert.strictEqual(rec.round, 2, 'resolved record records the round reached');
  });

  test('round 2 dissent finalizes (ceiling reached)', async () => {
    writeJson(activePath(root, 'A1.json'), stub({
      round: 2, votes: [vote('kilocode', 'reject'), vote('kiro', 'reject'), vote('codex', 'reject')],
    }));
    const res = await resolvePendingConsensus({ workspaceRoot: root, reviseMaxRounds: 2 });
    assert.strictEqual(res.resolved.length, 1);
    assert.strictEqual(res.resolved[0].verdict, 'rejected');
    assert.strictEqual(res.revised.length, 0);
  });

  test('default (no reviseMaxRounds) finalizes first-round dissent — back-compat', async () => {
    writeJson(activePath(root, 'A1.json'), stub({
      votes: [vote('kilocode', 'reject'), vote('kiro', 'reject'), vote('codex', 'reject')],
    }));
    const res = await resolvePendingConsensus({ workspaceRoot: root });
    assert.strictEqual(res.resolved.length, 1);
    assert.strictEqual(res.resolved[0].verdict, 'rejected');
    assert.strictEqual(res.revised.length, 0);
  });
});
