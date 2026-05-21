/**
 * reviewSla.test.ts — Sprint 3 B5 (WA-3).
 *
 * Covers the review SLA timer, dynamic consensus quorum, and claim-token
 * contention resolution.
 */

import * as assert from 'assert';

import {
  CLAIM_CONTENTION_WINDOW_MS,
  DEFAULT_REVIEW_SLA_MS,
  buildReviewRequestBroadcast,
  claimWon,
  computeQuorum,
  contentionWindowClosed,
  evaluateReviewSla,
  markRebroadcast,
  mintClaimToken,
  quorumReached,
  resolveContention,
  tokensInContention,
  type ClaimToken,
  type HeartbeatLike,
  type ReviewSlaRecord,
} from '../orchestrator/reviewSla';

// ---------------------------------------------------------------------------
// Review SLA
// ---------------------------------------------------------------------------

suite('reviewSla — evaluateReviewSla', () => {
  const base = (over: Partial<ReviewSlaRecord> = {}): ReviewSlaRecord => ({
    task_id: 'B5',
    author: 'claude-code',
    completed_at: new Date(0).toISOString(),
    reviews_received: [],
    reviews_required: 2,
    ...over,
  });

  test('a satisfied gate is never re-broadcast', () => {
    const d = evaluateReviewSla(base({ reviews_received: ['a', 'b'] }), 0);
    assert.strictEqual(d.pending, false);
    assert.strictEqual(d.shouldRebroadcast, false);
  });

  test('within the SLA window — no re-broadcast', () => {
    const d = evaluateReviewSla(base(), DEFAULT_REVIEW_SLA_MS - 1000);
    assert.strictEqual(d.breached, false);
    assert.strictEqual(d.shouldRebroadcast, false);
    assert.ok(d.msUntilBreach > 0);
  });

  test('past the SLA window — re-broadcast is due', () => {
    const d = evaluateReviewSla(base(), DEFAULT_REVIEW_SLA_MS + 1);
    assert.strictEqual(d.breached, true);
    assert.strictEqual(d.shouldRebroadcast, true);
    assert.strictEqual(d.msUntilBreach, 0);
  });

  test('an unparseable anchor is treated as breached', () => {
    const d = evaluateReviewSla(base({ completed_at: 'not-a-date' }), 0);
    assert.strictEqual(d.shouldRebroadcast, true);
  });

  test('a re-broadcast resets the SLA clock', () => {
    const rec = base();
    const now = DEFAULT_REVIEW_SLA_MS + 5000;
    const bumped = markRebroadcast(rec, new Date(now));
    assert.strictEqual(bumped.rebroadcast_count, 1);
    // Immediately after the re-broadcast the window is fresh again.
    const d = evaluateReviewSla(bumped, now + 1000);
    assert.strictEqual(d.breached, false);
  });

  test('buildReviewRequestBroadcast targets shared with reason sla_timeout', () => {
    const msg = buildReviewRequestBroadcast(base({ rebroadcast_count: 2 }), 'orchestrator');
    assert.strictEqual(msg.to, 'shared');
    assert.strictEqual(msg.type, 'review_request');
    assert.strictEqual(msg.payload.reason, 'sla_timeout');
    assert.strictEqual(msg.payload.rebroadcast_count, 3);
  });
});

// ---------------------------------------------------------------------------
// Dynamic quorum
// ---------------------------------------------------------------------------

suite('reviewSla — computeQuorum', () => {
  const hb = (id: string, ageMs: number, status = 'active'): HeartbeatLike => ({
    agent_id: id,
    timestamp: new Date(Date.now() - ageMs).toISOString(),
    status,
  });

  test('stale heartbeats are dropped from quorum', () => {
    const q = computeQuorum([hb('a', 1000), hb('b', 1000), hb('c', 999_999)]);
    assert.deepStrictEqual(q.liveAgents, ['a', 'b']);
    assert.strictEqual(q.liveCount, 2);
  });

  test('majority threshold is ceil(2/3 of live)', () => {
    const q = computeQuorum([hb('a', 0), hb('b', 0), hb('c', 0)]);
    assert.strictEqual(q.threshold, 2); // ceil(3*2/3) = 2
  });

  test('a single live agent has threshold 1', () => {
    const q = computeQuorum([hb('a', 0)]);
    assert.strictEqual(q.threshold, 1);
  });

  test('unanimous rule needs every live agent', () => {
    const q = computeQuorum([hb('a', 0), hb('b', 0), hb('c', 0)], { rule: 'unanimous' });
    assert.strictEqual(q.threshold, 3);
  });

  test('halted agents are excluded even when fresh', () => {
    const q = computeQuorum([hb('a', 0), hb('b', 0, 'halted')]);
    assert.deepStrictEqual(q.liveAgents, ['a']);
  });

  test('the freshest heartbeat per agent is used for dedupe', () => {
    const q = computeQuorum([hb('a', 999_999), hb('a', 100)]);
    assert.strictEqual(q.liveCount, 1);
  });
});

suite('reviewSla — quorumReached', () => {
  const hb = (id: string): HeartbeatLike => ({
    agent_id: id,
    timestamp: new Date().toISOString(),
    status: 'active',
  });

  test('reached when live approvals meet the threshold', () => {
    const q = computeQuorum([hb('a'), hb('b'), hb('c')]);
    const r = quorumReached(['a', 'b'], q);
    assert.strictEqual(r.reached, true);
    assert.strictEqual(r.effectiveApprovals, 2);
  });

  test('approvals from non-live agents do not count', () => {
    const q = computeQuorum([hb('a'), hb('b'), hb('c')]);
    const r = quorumReached(['a', 'ghost'], q);
    assert.strictEqual(r.effectiveApprovals, 1);
    assert.strictEqual(r.reached, false);
  });

  test('no live agents — quorum cannot be reached', () => {
    const r = quorumReached(['a'], computeQuorum([]));
    assert.strictEqual(r.reached, false);
  });
});

// ---------------------------------------------------------------------------
// Claim tokens
// ---------------------------------------------------------------------------

suite('reviewSla — claim tokens', () => {
  test('mintClaimToken produces a UUID token', () => {
    const t = mintClaimToken('B5', 'claude-code');
    assert.match(t.token, /^[0-9a-f-]{36}$/);
    assert.strictEqual(t.task_id, 'B5');
  });

  test('tokens minted close together for the same task are in contention', () => {
    const a = mintClaimToken('B5', 'claude-code', { now: new Date(1000) });
    const b = mintClaimToken('B5', 'kilocode', { now: new Date(1000 + 5000) });
    assert.ok(tokensInContention(a, b));
  });

  test('tokens minted far apart are not in contention', () => {
    const a = mintClaimToken('B5', 'claude-code', { now: new Date(0) });
    const b = mintClaimToken('B5', 'kilocode', { now: new Date(CLAIM_CONTENTION_WINDOW_MS + 1) });
    assert.ok(!tokensInContention(a, b));
  });

  test('tokens for different tasks are never in contention', () => {
    const a = mintClaimToken('B5', 'claude-code', { now: new Date(0) });
    const b = mintClaimToken('BP3', 'kilocode', { now: new Date(0) });
    assert.ok(!tokensInContention(a, b));
  });

  test('resolveContention picks the earliest mint', () => {
    const early = mintClaimToken('B5', 'a', { now: new Date(1000) });
    const late = mintClaimToken('B5', 'b', { now: new Date(2000) });
    const winner = resolveContention([late, early]);
    assert.strictEqual(winner?.token, early.token);
  });

  test('resolveContention breaks an exact tie lexicographically and is deterministic', () => {
    const t1: ClaimToken = { task_id: 'B5', agent: 'a', token: 'zzz', minted_at: new Date(0).toISOString() };
    const t2: ClaimToken = { task_id: 'B5', agent: 'b', token: 'aaa', minted_at: new Date(0).toISOString() };
    assert.strictEqual(resolveContention([t1, t2])?.token, 'aaa');
    assert.strictEqual(resolveContention([t2, t1])?.token, 'aaa'); // order-independent
  });

  test('resolveContention rejects a mixed-task set', () => {
    const a = mintClaimToken('B5', 'a');
    const b = mintClaimToken('BP3', 'b');
    assert.strictEqual(resolveContention([a, b]), null);
  });

  test('claimWon reflects the contention outcome', () => {
    const mine = mintClaimToken('B5', 'a', { now: new Date(1000) });
    const theirs = mintClaimToken('B5', 'b', { now: new Date(2000) });
    assert.ok(claimWon(mine, [theirs]));
    assert.ok(!claimWon(theirs, [mine]));
  });

  test('contentionWindowClosed is false inside the window, true past it', () => {
    const t = mintClaimToken('B5', 'a', { now: new Date(0) });
    assert.ok(!contentionWindowClosed(t, 5000));
    assert.ok(contentionWindowClosed(t, CLAIM_CONTENTION_WINDOW_MS + 1));
  });
});
