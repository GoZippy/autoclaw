/**
 * peerReview.test.ts — Pure-function coverage for the peer-review promoter.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  MAX_REVIEWERS_PER_TASK,
  REVIEWER_LIVENESS_MS,
  buildConsensusStub,
  buildReviewRequest,
  computeReviewers,
  reviewRequestFilename,
  type ReviewerCandidate,
  type TaskCompleteLike,
} from '../orchestrator/peerReview';
import { promotePendingTaskCompletes } from '../orchestrator/peerReviewWatcher';

// ---------------------------------------------------------------------------
// computeReviewers
// ---------------------------------------------------------------------------

const now = new Date('2026-05-24T12:00:00Z').getTime();

function candidate(over: Partial<ReviewerCandidate> & { agent_id: string }): ReviewerCandidate {
  return {
    last_heartbeat_at: new Date(now - 30_000).toISOString(),
    status: 'active',
    opt_out: false,
    ...over,
  };
}

suite('peerReview — computeReviewers', () => {
  test('excludes the author', () => {
    const out = computeReviewers('claude-code', [
      candidate({ agent_id: 'claude-code' }),
      candidate({ agent_id: 'kilocode' }),
    ], { now });
    assert.deepStrictEqual(out, ['kilocode']);
  });

  test('excludes stale heartbeats', () => {
    const out = computeReviewers('claude-code', [
      candidate({ agent_id: 'kilocode', last_heartbeat_at: new Date(now - REVIEWER_LIVENESS_MS - 1000).toISOString() }),
      candidate({ agent_id: 'kiro' }),
    ], { now });
    assert.deepStrictEqual(out, ['kiro']);
  });

  test('excludes opted-out, halted, and offline agents', () => {
    const out = computeReviewers('claude-code', [
      candidate({ agent_id: 'a', opt_out: true }),
      candidate({ agent_id: 'b', status: 'halted' }),
      candidate({ agent_id: 'c', status: 'offline' }),
      candidate({ agent_id: 'd' }),
    ], { now });
    assert.deepStrictEqual(out, ['d']);
  });

  test('returns no more than maxReviewers, sorted deterministically', () => {
    const out = computeReviewers('me', [
      candidate({ agent_id: 'z' }),
      candidate({ agent_id: 'm' }),
      candidate({ agent_id: 'a' }),
      candidate({ agent_id: 'b' }),
    ], { now, maxReviewers: 2 });
    assert.deepStrictEqual(out, ['a', 'b']);
  });

  test('honours the default cap', () => {
    const cands: ReviewerCandidate[] = [];
    for (let i = 0; i < 8; i++) {
      cands.push(candidate({ agent_id: `agent-${i}` }));
    }
    const out = computeReviewers('me', cands, { now });
    assert.strictEqual(out.length, MAX_REVIEWERS_PER_TASK);
  });

  test('returns empty when no peer is live', () => {
    const out = computeReviewers('claude-code', [
      candidate({ agent_id: 'claude-code' }),
    ], { now });
    assert.deepStrictEqual(out, []);
  });

  test('candidates with no heartbeat are dropped', () => {
    const out = computeReviewers('me', [
      { agent_id: 'no-hb', last_heartbeat_at: null },
      candidate({ agent_id: 'with-hb' }),
    ], { now });
    assert.deepStrictEqual(out, ['with-hb']);
  });
});

// ---------------------------------------------------------------------------
// buildReviewRequest / buildConsensusStub / filename
// ---------------------------------------------------------------------------

const TC: TaskCompleteLike = {
  id: 'msg-tc-001',
  from: 'claude-code',
  type: 'task_complete',
  task_id: 'B5',
  sprint: 3,
  timestamp: new Date(now - 5000).toISOString(),
};

suite('peerReview — buildReviewRequest', () => {
  test('addresses the named peer with auto_promoted reason', () => {
    const msg = buildReviewRequest(TC, 'kilocode', { from: 'orch', now: new Date(now) });
    assert.strictEqual(msg.to, 'kilocode');
    assert.strictEqual(msg.from, 'orch');
    assert.strictEqual(msg.type, 'review_request');
    assert.strictEqual(msg.requires_response, true);
    assert.strictEqual(msg.task_id, 'B5');
    assert.strictEqual(msg.sprint, 3);
    assert.strictEqual(msg.payload.author, 'claude-code');
    assert.strictEqual(msg.payload.source_task_complete_id, 'msg-tc-001');
    assert.strictEqual(msg.payload.reason, 'auto_promoted');
    assert.strictEqual(msg.payload.review_policy, 'peer');
  });

  test('includes deadline_iso when deadlineMs is set', () => {
    const msg = buildReviewRequest(TC, 'kilocode', { now: new Date(now), deadlineMs: 30 * 60_000 });
    assert.strictEqual(
      msg.payload.deadline_iso,
      new Date(now + 30 * 60_000).toISOString(),
    );
  });

  test('omits deadline_iso when deadlineMs is not set', () => {
    const msg = buildReviewRequest(TC, 'kilocode', { now: new Date(now) });
    assert.strictEqual(msg.payload.deadline_iso, undefined);
  });

  test('reviewRequestFilename is filesystem-safe and deterministic-ish', () => {
    const msg = buildReviewRequest(TC, 'kilocode', { from: 'orch', now: new Date(now) });
    const fn = reviewRequestFilename(msg);
    assert.ok(!fn.includes(':'), 'colons must be replaced');
    assert.ok(fn.endsWith('.json'));
    assert.ok(fn.includes('review_request'));
    assert.ok(fn.includes('orch'));
  });
});

suite('peerReview — buildConsensusStub', () => {
  test('opens a stub with reviewers sorted and zero votes', () => {
    const stub = buildConsensusStub(TC, ['kilocode', 'antigravity'], { now: new Date(now) });
    assert.strictEqual(stub.task_id, 'B5');
    assert.strictEqual(stub.author, 'claude-code');
    assert.strictEqual(stub.status, 'open');
    assert.deepStrictEqual(stub.reviewers, ['antigravity', 'kilocode']);
    assert.deepStrictEqual(stub.votes, []);
    assert.strictEqual(stub.rule, 'majority');
    assert.strictEqual(stub.source_task_complete_id, 'msg-tc-001');
  });

  test('rule defaults to majority but can be unanimous', () => {
    const stub = buildConsensusStub(TC, ['x'], { now: new Date(now), rule: 'unanimous' });
    assert.strictEqual(stub.rule, 'unanimous');
  });

  test('falls back to a deterministic task_id when missing', () => {
    const stub = buildConsensusStub({ ...TC, task_id: undefined }, ['x'], { now: new Date(now) });
    assert.ok(stub.task_id.startsWith('unknown-'));
  });
});

// ---------------------------------------------------------------------------
// promotePendingTaskCompletes (IO) — covers idempotency + skipNoPeers
// ---------------------------------------------------------------------------

function mkTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-peer-'));
}

function rmrf(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}

suite('peerReviewWatcher — promotePendingTaskCompletes', () => {
  test('promotes one task_complete and is idempotent on the second call', async () => {
    const ws = mkTempWorkspace();
    try {
      const pool: ReviewerCandidate[] = [
        candidate({ agent_id: 'kilocode' }),
        candidate({ agent_id: 'kiro' }),
      ];
      const first = await promotePendingTaskCompletes({
        workspaceRoot: ws,
        now: new Date(now),
        reviewerPoolOverride: pool,
        taskCompletesOverride: [TC],
      });
      assert.strictEqual(first.promoted, 1);
      assert.strictEqual(first.skippedAlreadyPromoted, 0);

      // Inbox files written for each reviewer.
      const kilocodeInbox = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'kilocode');
      const kiroInbox = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'kiro');
      assert.ok(fs.readdirSync(kilocodeInbox).some(f => f.includes('review_request')));
      assert.ok(fs.readdirSync(kiroInbox).some(f => f.includes('review_request')));

      // Consensus stub written.
      const stubPath = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'active', 'B5.json');
      assert.ok(fs.existsSync(stubPath));
      const stub = JSON.parse(fs.readFileSync(stubPath, 'utf8'));
      assert.deepStrictEqual(stub.reviewers, ['kilocode', 'kiro']);

      // Second call should skip — ledger remembers.
      const second = await promotePendingTaskCompletes({
        workspaceRoot: ws,
        now: new Date(now + 60_000),
        reviewerPoolOverride: pool,
        taskCompletesOverride: [TC],
      });
      assert.strictEqual(second.promoted, 0);
      assert.strictEqual(second.skippedAlreadyPromoted, 1);

      // Reviewer inbox should still contain exactly one review_request — no duplicates.
      const kiloFiles = fs.readdirSync(kilocodeInbox).filter(f => f.includes('review_request'));
      assert.strictEqual(kiloFiles.length, 1);
    } finally {
      rmrf(ws);
    }
  });

  // Revise/converge handoff: when the author re-broadcasts task_complete after a
  // revision_request, the watcher must PRESERVE the round the consensusRevise loop
  // advanced the stub to — otherwise it resets round→1 every re-broadcast and the
  // bounded loop never reaches its ceiling (re-rounds indefinitely).
  test('preserves an existing stub round across a re-broadcast', async () => {
    const ws = mkTempWorkspace();
    try {
      const pool: ReviewerCandidate[] = [
        candidate({ agent_id: 'kilocode' }),
        candidate({ agent_id: 'kiro' }),
      ];
      // Post-revision state: an active stub already advanced to round 2 with its
      // votes cleared (as consensusRevise.emitRevisionRequest leaves it).
      const stubPath = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'active', 'B5.json');
      fs.mkdirSync(path.dirname(stubPath), { recursive: true });
      fs.writeFileSync(stubPath, JSON.stringify({ task_id: 'B5', round: 2, votes: [], reviewers: ['kilocode', 'kiro'] }), 'utf8');

      // Author re-broadcasts task_complete with a NEW message id for the same task.
      const rebroadcast: TaskCompleteLike = { ...TC, id: 'msg-tc-001-r2' };
      const res = await promotePendingTaskCompletes({
        workspaceRoot: ws, now: new Date(now + 120_000),
        reviewerPoolOverride: pool, taskCompletesOverride: [rebroadcast],
      });
      assert.strictEqual(res.promoted, 1, 're-broadcast (new id) is promoted');

      const stub = JSON.parse(fs.readFileSync(stubPath, 'utf8'));
      assert.strictEqual(stub.round, 2, 'round preserved — not reset to 1');
      assert.deepStrictEqual(stub.votes, [], 'fresh votes for the new round');
      // Reviewers are re-asked so round 2 can actually collect votes.
      const kiloInbox = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'kilocode');
      assert.ok(fs.readdirSync(kiloInbox).some(f => f.includes('review_request')), 'round-2 review_request sent');
    } finally {
      rmrf(ws);
    }
  });

  test('skipNoPeers leaves no ledger so a future tick can retry', async () => {
    const ws = mkTempWorkspace();
    try {
      // Pool of only the author → no eligible reviewers.
      const pool: ReviewerCandidate[] = [
        candidate({ agent_id: 'claude-code' }),
      ];
      const first = await promotePendingTaskCompletes({
        workspaceRoot: ws,
        now: new Date(now),
        reviewerPoolOverride: pool,
        taskCompletesOverride: [TC],
      });
      assert.strictEqual(first.promoted, 0);
      assert.strictEqual(first.skippedNoPeers, 1);

      // A reviewer becomes available — retry should now promote.
      const pool2: ReviewerCandidate[] = [
        candidate({ agent_id: 'claude-code' }),
        candidate({ agent_id: 'kilocode' }),
      ];
      const second = await promotePendingTaskCompletes({
        workspaceRoot: ws,
        now: new Date(now + 60_000),
        reviewerPoolOverride: pool2,
        taskCompletesOverride: [TC],
      });
      assert.strictEqual(second.promoted, 1);
      assert.strictEqual(second.skippedAlreadyPromoted, 0);
    } finally {
      rmrf(ws);
    }
  });

  // AF-8 §1: the consensus rule is derived from the task's persona — security
  // work is UNANIMOUS on the live path (previously hardcoded 'majority').
  test('security-auditor task_complete yields an UNANIMOUS consensus stub', async () => {
    const ws = mkTempWorkspace();
    try {
      const securityTC: TaskCompleteLike = { ...TC, id: 'msg-tc-sec', task_id: 'SEC9', payload: { persona_id: 'security-auditor' } };
      const pool: ReviewerCandidate[] = [
        candidate({ agent_id: 'kilocode', agent_type: 'auditor' }),
        candidate({ agent_id: 'kiro' }), // coder
      ];
      const res = await promotePendingTaskCompletes({
        workspaceRoot: ws, now: new Date(now), reviewerPoolOverride: pool, taskCompletesOverride: [securityTC],
      });
      assert.strictEqual(res.promoted, 1);
      const stub = JSON.parse(fs.readFileSync(
        path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'active', 'SEC9.json'), 'utf8'));
      assert.strictEqual(stub.rule, 'unanimous', 'security review is unanimous');
      // AF-8 §2: the live auditor is preferred as the reviewer.
      assert.deepStrictEqual(stub.reviewers, ['kilocode'], 'auditor preferred for a security review');
    } finally {
      rmrf(ws);
    }
  });

  // A non-security task keeps the majority default + the full reviewer pool.
  test('a normal task_complete stays majority with the full pool', async () => {
    const ws = mkTempWorkspace();
    try {
      const pool: ReviewerCandidate[] = [candidate({ agent_id: 'kilocode' }), candidate({ agent_id: 'kiro' })];
      await promotePendingTaskCompletes({
        workspaceRoot: ws, now: new Date(now), reviewerPoolOverride: pool, taskCompletesOverride: [TC],
      });
      const stub = JSON.parse(fs.readFileSync(
        path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'active', 'B5.json'), 'utf8'));
      assert.strictEqual(stub.rule, 'majority');
      assert.deepStrictEqual(stub.reviewers.sort(), ['kilocode', 'kiro']);
    } finally {
      rmrf(ws);
    }
  });
});
