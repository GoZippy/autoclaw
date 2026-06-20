/**
 * consensusTally.test.ts — Coverage for the consensus auto-tally (learnings #9).
 *
 * Pure decision logic (tallyConsensus) + the FS runner that writes resolved/
 * records and clears active stubs.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  requiredApprovals,
  dedupeLatest,
  tallyConsensus,
  resolvePendingConsensus,
  type ConsensusStub,
  type TallyVote,
} from '../orchestrator/consensusTally';

function vote(voter: string, v: TallyVote['vote'], ts?: string): TallyVote {
  return { voter, vote: v, timestamp: ts };
}

function stub(over: Partial<ConsensusStub> = {}): ConsensusStub {
  return {
    task_id: 'A1',
    author: 'claude-code',
    reviewers: ['kilocode', 'kiro', 'codex'],
    rule: 'majority',
    votes: [],
    source_task_complete_id: 'msg-1',
    status: 'open',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// requiredApprovals
// ---------------------------------------------------------------------------

suite('consensusTally — requiredApprovals', () => {
  test('majority is ceil(2/3) of the panel', () => {
    assert.strictEqual(requiredApprovals(3, 'majority'), 2);
    assert.strictEqual(requiredApprovals(2, 'majority'), 2); // ceil(1.33)
    assert.strictEqual(requiredApprovals(4, 'majority'), 3); // ceil(2.66)
    assert.strictEqual(requiredApprovals(6, 'majority'), 4);
  });
  test('unanimous requires the whole panel', () => {
    assert.strictEqual(requiredApprovals(3, 'unanimous'), 3);
    assert.strictEqual(requiredApprovals(1, 'unanimous'), 1);
  });
  test('empty panel requires nothing', () => {
    assert.strictEqual(requiredApprovals(0, 'majority'), 0);
  });
});

// ---------------------------------------------------------------------------
// dedupeLatest
// ---------------------------------------------------------------------------

suite('consensusTally — dedupeLatest', () => {
  test('keeps the latest vote per voter', () => {
    const out = dedupeLatest([
      vote('a', 'reject', '2026-01-01T00:00:00Z'),
      vote('a', 'approve', '2026-01-02T00:00:00Z'),
      vote('b', 'approve', '2026-01-01T00:00:00Z'),
    ]);
    const byVoter = Object.fromEntries(out.map(v => [v.voter, v.vote]));
    assert.strictEqual(byVoter.a, 'approve');
    assert.strictEqual(byVoter.b, 'approve');
    assert.strictEqual(out.length, 2);
  });
  test('drops malformed votes', () => {
    const out = dedupeLatest([{ voter: '', vote: 'approve' } as TallyVote, vote('a', 'approve')]);
    assert.strictEqual(out.length, 1);
  });
});

// ---------------------------------------------------------------------------
// tallyConsensus — decisions
// ---------------------------------------------------------------------------

suite('consensusTally — tallyConsensus', () => {
  test('pending until enough votes', () => {
    const r = tallyConsensus(stub(), [vote('kilocode', 'approve')]);
    assert.strictEqual(r.status, 'pending');
  });

  test('majority approved at 2/3', () => {
    const r = tallyConsensus(stub(), [vote('kilocode', 'approve'), vote('kiro', 'approve')]);
    assert.strictEqual(r.status, 'resolved');
    assert.strictEqual(r.verdict, 'approved');
    assert.strictEqual(r.approvals, 2);
  });

  test('decided-against once approval is mathematically impossible', () => {
    // panel of 3, two reject → max possible approvals = 1 < required 2.
    const r = tallyConsensus(stub(), [vote('kilocode', 'reject'), vote('kiro', 'reject')]);
    assert.strictEqual(r.status, 'resolved');
    assert.strictEqual(r.verdict, 'rejected');
  });

  test('changes_requested when panel complete, no rejects, bar unmet', () => {
    const r = tallyConsensus(stub(), [
      vote('kilocode', 'approve'),
      vote('kiro', 'request_changes'),
      vote('codex', 'request_changes'),
    ]);
    assert.strictEqual(r.status, 'resolved');
    assert.strictEqual(r.verdict, 'changes_requested');
  });

  test('unanimous fails on a single dissent', () => {
    const r = tallyConsensus(stub({ rule: 'unanimous' }), [
      vote('kilocode', 'approve'),
      vote('kiro', 'reject'),
    ]);
    assert.strictEqual(r.status, 'resolved');
    assert.strictEqual(r.verdict, 'rejected');
  });

  test('unanimous approved only when all approve', () => {
    const r = tallyConsensus(stub({ rule: 'unanimous' }), [
      vote('kilocode', 'approve'),
      vote('kiro', 'approve'),
      vote('codex', 'approve'),
    ]);
    assert.strictEqual(r.status, 'resolved');
    assert.strictEqual(r.verdict, 'approved');
  });

  test('ignores votes from non-reviewers', () => {
    const r = tallyConsensus(stub(), [
      vote('kilocode', 'approve'),
      vote('stranger', 'approve'), // not on the panel — must not count
    ]);
    assert.strictEqual(r.approvals, 1);
    assert.strictEqual(r.status, 'pending');
  });

  test('reconciles per-agent extra votes with embedded stub votes', () => {
    const r = tallyConsensus(
      stub({ votes: [vote('kilocode', 'approve')] }),
      [vote('kiro', 'approve')],
    );
    assert.strictEqual(r.status, 'resolved');
    assert.strictEqual(r.verdict, 'approved');
  });
});

// ---------------------------------------------------------------------------
// resolvePendingConsensus — FS runner
// ---------------------------------------------------------------------------

function activePath(root: string, name: string): string {
  return path.join(root, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'active', name);
}
function resolvedPath(root: string, name: string): string {
  return path.join(root, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'resolved', name);
}
function writeJson(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

suite('consensusTally — resolvePendingConsensus', () => {
  let root: string;
  setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-')); });
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('resolves an approved task: writes resolved/, clears active', async () => {
    writeJson(activePath(root, 'A1.json'), stub({
      votes: [vote('kilocode', 'approve'), vote('kiro', 'approve')],
    }));
    const res = await resolvePendingConsensus({ workspaceRoot: root, now: new Date('2026-06-17T00:00:00Z') });

    assert.strictEqual(res.resolved.length, 1);
    assert.strictEqual(res.resolved[0].verdict, 'approved');
    assert.ok(fs.existsSync(resolvedPath(root, 'A1.json')), 'resolved record written');
    assert.ok(!fs.existsSync(activePath(root, 'A1.json')), 'active stub cleared');

    const rec = JSON.parse(fs.readFileSync(resolvedPath(root, 'A1.json'), 'utf8'));
    assert.strictEqual(rec.verdict, 'approved');
    assert.strictEqual(rec.resolved_by, 'orchestrator-loop');
  });

  test('reconciles per-agent vote files and clears them too', async () => {
    writeJson(activePath(root, 'B2.json'), stub({ task_id: 'B2', votes: [] }));
    writeJson(activePath(root, 'B2-kilocode.json'), { voter: 'kilocode', task_id: 'B2', vote: 'approve', timestamp: '2026-06-17T00:00:00Z' });
    writeJson(activePath(root, 'B2-kiro.json'), { voter: 'kiro', task_id: 'B2', vote: 'approve', timestamp: '2026-06-17T00:00:01Z' });

    const res = await resolvePendingConsensus({ workspaceRoot: root });
    assert.strictEqual(res.resolved.length, 1);
    assert.ok(!fs.existsSync(activePath(root, 'B2-kilocode.json')), 'per-agent vote file cleared');
    assert.ok(!fs.existsSync(activePath(root, 'B2-kiro.json')));
  });

  test('leaves an undecided task pending', async () => {
    writeJson(activePath(root, 'C3.json'), stub({ task_id: 'C3', votes: [vote('kilocode', 'approve')] }));
    const res = await resolvePendingConsensus({ workspaceRoot: root });
    assert.strictEqual(res.resolved.length, 0);
    assert.deepStrictEqual(res.pending, ['C3']);
    assert.ok(fs.existsSync(activePath(root, 'C3.json')), 'pending stub kept');
  });

  test('idempotent: already-resolved task clears stale active stub, no duplicate', async () => {
    writeJson(resolvedPath(root, 'A1.json'), { task_id: 'A1', verdict: 'approved' });
    writeJson(activePath(root, 'A1.json'), stub({ votes: [vote('kilocode', 'approve'), vote('kiro', 'approve')] }));
    const res = await resolvePendingConsensus({ workspaceRoot: root });
    assert.strictEqual(res.resolved.length, 0, 'no re-resolution');
    assert.ok(!fs.existsSync(activePath(root, 'A1.json')), 'stale active stub cleared');
  });

  test('no active dir → empty result', async () => {
    const res = await resolvePendingConsensus({ workspaceRoot: root });
    assert.strictEqual(res.scanned, 0);
    assert.strictEqual(res.resolved.length, 0);
  });
});
