/**
 * worktree.test.ts — Coordination Kernel: isolated git worktree lifecycle.
 *
 * Pure helpers (branch naming, path derivation, porcelain parsing) and the IO
 * layer with an injected fake git runner.
 */

import * as assert from 'assert';

import {
  sanitizeSegment,
  worktreeBranchName,
  worktreePath,
  parseWorktreePorcelain,
  createWorktree,
  removeWorktree,
  listWorktrees,
} from '../orchestrator/worktree';
import type { GitRunner, GitResult } from '../orchestrator/mergeGate';

suite('worktree — naming', () => {
  test('sanitizeSegment lowercases and strips unsafe chars', () => {
    assert.strictEqual(sanitizeSegment('Claude/Code WL-1'), 'claude-code-wl-1');
    assert.strictEqual(sanitizeSegment('  ..weird.. '), 'weird', 'leading/trailing dots stripped (no .. traversal)');
  });

  test('worktreeBranchName is deterministic and namespaced under wt/', () => {
    const b = worktreeBranchName('claude-code', 'BL-7-reputation', 'a1b2c3d4ef');
    assert.strictEqual(b, 'wt/claude-code-bl-7-reputation-a1b2c3d4');
    assert.strictEqual(worktreeBranchName('claude-code', 'BL-7-reputation', 'a1b2c3d4ef'), b, 'stable');
  });

  test('worktreePath lives outside the repo checkout', () => {
    const p = worktreePath('/workspace/autoclaw', 'wt/claude-code-bl-7-a1b2');
    assert.ok(!p.replace(/\\/g, '/').startsWith('/workspace/autoclaw/'), 'worktree must not be inside the repo');
    assert.ok(p.includes('autoclaw__wt__claude-code-bl-7-a1b2'));
  });
});

suite('worktree — parseWorktreePorcelain', () => {
  test('parses multiple entries with branch / detached / bare', () => {
    const out = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/master',
      '',
      'worktree /repo/.wt/x',
      'HEAD def456',
      'branch refs/heads/wt/claude-code-bl-7',
      '',
      'worktree /repo/.wt/d',
      'HEAD 000111',
      'detached',
      '',
    ].join('\n');
    const entries = parseWorktreePorcelain(out);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].branch, 'master');
    assert.strictEqual(entries[1].branch, 'wt/claude-code-bl-7');
    assert.strictEqual(entries[2].detached, true);
  });

  test('tolerates missing trailing blank line', () => {
    const out = 'worktree /repo\nHEAD abc\nbranch refs/heads/master';
    const entries = parseWorktreePorcelain(out);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].branch, 'master');
  });
});

function fakeGit(map: Record<string, GitResult>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    const key = args.join(' ');
    for (const k of Object.keys(map)) { if (key.startsWith(k)) { return map[k]; } }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { git, calls };
}

suite('worktree — createWorktree', () => {
  test('creates a fresh branch worktree', async () => {
    const { git, calls } = fakeGit({ 'worktree add': { exitCode: 0, stdout: '', stderr: '' } });
    const r = await createWorktree(git, { repoRoot: '/workspace/autoclaw', agentId: 'claude-code', taskId: 'BL-7', sessionFrag: 'a1b2c3d4' });
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.branch, 'wt/claude-code-bl-7-a1b2c3d4');
    assert.ok(calls[0].includes('-b'), 'first attempt creates a new branch with -b');
  });

  test('falls back to attaching when the branch already exists', async () => {
    let n = 0;
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'add') {
        n++;
        // first call (with -b) fails; second (attach existing) succeeds
        return n === 1
          ? { exitCode: 128, stdout: '', stderr: "fatal: a branch named 'wt/x' already exists" }
          : { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const r = await createWorktree(git, { repoRoot: '/workspace/autoclaw', agentId: 'claude-code', taskId: 'BL-7', sessionFrag: 'a1b2c3d4' });
    assert.strictEqual(r.created, true);
    assert.strictEqual(n, 2, 'should retry attaching to the existing branch');
  });

  test('reports an error when both attempts fail', async () => {
    const { git } = fakeGit({ 'worktree add': { exitCode: 128, stdout: '', stderr: 'fatal: boom' } });
    const r = await createWorktree(git, { repoRoot: '/r', agentId: 'a', taskId: 't', sessionFrag: 's' });
    assert.strictEqual(r.created, false);
    assert.ok(r.error && r.error.includes('boom'));
  });
});

suite('worktree — removeWorktree / listWorktrees', () => {
  test('removeWorktree forces removal and prunes', async () => {
    const { git, calls } = fakeGit({ 'worktree remove': { exitCode: 0, stdout: '', stderr: '' } });
    const r = await removeWorktree(git, '/repo', '/repo/.wt/x');
    assert.strictEqual(r.removed, true);
    assert.ok(calls.some((c) => c.join(' ') === 'worktree remove --force /repo/.wt/x'));
    assert.ok(calls.some((c) => c.join(' ') === 'worktree prune'));
  });

  test('listWorktrees returns parsed entries', async () => {
    const { git } = fakeGit({ 'worktree list': { exitCode: 0, stdout: 'worktree /repo\nbranch refs/heads/master\n', stderr: '' } });
    const entries = await listWorktrees(git, '/repo');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].branch, 'master');
  });
});

// ---------------------------------------------------------------------------
// Adversarial-review regressions (F9/F10/F12) — branch names must be valid refs
// ---------------------------------------------------------------------------

/** Mirror git check-ref-format's relevant rules for our wt/ names. */
function isRefSafe(b: string): boolean {
  return /^[a-z0-9][a-z0-9._/-]*$/.test(b)
    && !b.includes('..')
    && !/\.lock$/i.test(b)
    && !/[./-]$/.test(b)
    && !b.includes('//');
}

suite('worktree — sanitize hardening', () => {
  test('F9/F12: slice never re-introduces a trailing dot', () => {
    const r = sanitizeSegment('a'.repeat(39) + '.rest');
    assert.ok(!r.endsWith('.'), `must not end in '.': got "${r}"`);
    assert.ok(r.length <= 40);
  });

  test('F10: interior `..` collapses and a `.lock` tail is stripped', () => {
    assert.strictEqual(sanitizeSegment('a..b'), 'a.b', 'interior .. collapses');
    assert.strictEqual(sanitizeSegment('foo.lock'), 'foo', '.lock tail stripped');
    assert.strictEqual(sanitizeSegment('weird...name'), 'weird.name');
  });

  test('F10: adversarial ids still yield a valid git ref', () => {
    for (const [a, t, f] of [
      ['../../etc', 'BL..7', 'sess.lock'],
      ['..', '..', '..'],
      ['HEAD@{0}', 'x/y\\z', '....'],
      ['', '', ''],
    ] as Array<[string, string, string]>) {
      const b = worktreeBranchName(a, t, f);
      assert.ok(b.startsWith('wt/'), `branch must be namespaced: ${b}`);
      assert.ok(isRefSafe(b), `branch must be a valid git ref: "${b}"`);
    }
  });
});
