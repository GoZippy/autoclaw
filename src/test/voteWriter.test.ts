/**
 * voteWriter.test.ts — RV-1 (integrate-automate-v3.2, Lane A).
 *
 * Covers the consensus vote writer that backs the panel's review-decision
 * Approve / Request changes / Reject buttons.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  VALID_VOTES,
  isValidVote,
  sanitizeSegment,
  writeConsensusVote,
} from '../orchestrator/voteWriter';

function tmpConsensusDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-votes-'));
  return path.join(dir, 'consensus', 'active');
}

suite('voteWriter — isValidVote', () => {
  test('accepts the three protocol votes', () => {
    for (const v of VALID_VOTES) {
      assert.strictEqual(isValidVote(v), true);
    }
  });

  test('rejects anything else', () => {
    for (const v of ['yes', 'approved', 'REJECT', '', 'abstain']) {
      assert.strictEqual(isValidVote(v), false);
    }
  });
});

suite('voteWriter — sanitizeSegment', () => {
  test('strips path separators so a task id cannot escape the dir', () => {
    assert.strictEqual(sanitizeSegment('../../etc/passwd'), '_etc_passwd');
    assert.strictEqual(sanitizeSegment('a/b\\c'), 'a_b_c');
    assert.ok(!/[\\/]/.test(sanitizeSegment('../../etc/passwd')), 'no separators survive');
  });

  test('preserves the real-world id punctuation in the tree', () => {
    assert.strictEqual(sanitizeSegment('A3,A6,A7'), 'A3,A6,A7');
    assert.strictEqual(sanitizeSegment('C5_statusbar'), 'C5_statusbar');
  });
});

suite('voteWriter — writeConsensusVote', () => {
  test('writes a protocol-shaped vote file named <task>-<voter>.json', async () => {
    const dir = tmpConsensusDir();
    const res = await writeConsensusVote({
      consensusActiveDir: dir,
      taskId: 'RV-1',
      voter: 'claude-code',
      sessionId: 'sess-123',
      vote: 'approve',
      comment: 'looks good',
      timestamp: '2026-05-31T03:00:00.000Z',
    });
    assert.strictEqual(res.ok, true);
    assert.ok(res.file && res.file.endsWith(path.join('active', 'RV-1-claude-code.json')));

    const onDisk = JSON.parse(fs.readFileSync(res.file!, 'utf8'));
    assert.deepStrictEqual(onDisk, {
      voter: 'claude-code',
      session_id: 'sess-123',
      task_id: 'RV-1',
      vote: 'approve',
      timestamp: '2026-05-31T03:00:00.000Z',
      comments: 'looks good',
    });
  });

  test('rejects an invalid vote without writing', async () => {
    const dir = tmpConsensusDir();
    const res = await writeConsensusVote({
      consensusActiveDir: dir,
      taskId: 'RV-1',
      voter: 'claude-code',
      sessionId: 's',
      vote: 'lgtm',
    });
    assert.strictEqual(res.ok, false);
    assert.match(res.error ?? '', /invalid vote/);
    assert.strictEqual(fs.existsSync(dir), false, 'no dir/file created on rejection');
  });

  test('rejects a missing task id or voter', async () => {
    const dir = tmpConsensusDir();
    const a = await writeConsensusVote({ consensusActiveDir: dir, taskId: '', voter: 'x', sessionId: 's', vote: 'approve' });
    const b = await writeConsensusVote({ consensusActiveDir: dir, taskId: 't', voter: '', sessionId: 's', vote: 'approve' });
    assert.strictEqual(a.ok, false);
    assert.strictEqual(b.ok, false);
  });

  test('a re-vote overwrites the voter own file (idempotent), defaults comment to ""', async () => {
    const dir = tmpConsensusDir();
    await writeConsensusVote({
      consensusActiveDir: dir, taskId: 'B2', voter: 'claude-code',
      sessionId: 's', vote: 'request_changes', comment: 'fix the gate',
    });
    const second = await writeConsensusVote({
      consensusActiveDir: dir, taskId: 'B2', voter: 'claude-code',
      sessionId: 's', vote: 'approve',
    });
    assert.strictEqual(second.ok, true);

    // Only one file for this voter+task; latest vote wins; comment defaulted.
    const files = fs.readdirSync(dir).filter(f => f.startsWith('B2-claude-code'));
    assert.deepStrictEqual(files, ['B2-claude-code.json']);
    const onDisk = JSON.parse(fs.readFileSync(second.file!, 'utf8'));
    assert.strictEqual(onDisk.vote, 'approve');
    assert.strictEqual(onDisk.comments, '');
  });

  test('a crafted task id cannot escape the consensus dir', async () => {
    const dir = tmpConsensusDir();
    const res = await writeConsensusVote({
      consensusActiveDir: dir, taskId: '../../evil', voter: 'claude-code',
      sessionId: 's', vote: 'approve',
    });
    assert.strictEqual(res.ok, true);
    // The file lands INSIDE the consensus dir, sanitised — not in a parent.
    assert.strictEqual(path.dirname(res.file!), dir);
    assert.strictEqual(path.basename(res.file!), '_evil-claude-code.json');
    assert.ok(!res.file!.includes('..'), 'no parent traversal in path');
  });
});
