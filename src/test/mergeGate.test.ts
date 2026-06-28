/**
 * mergeGate.test.ts — Coordination Kernel: enforced-scope merge gate.
 *
 * Pins the PRECISE glob→path matching (a loose match is a security hole for a
 * gate), the scope partition, the pure merge decision, and the IO landing flow
 * with an injected fake git runner (no real repo touched).
 */

import * as assert from 'assert';

import {
  globToRegExp,
  fileInScope,
  checkScope,
  evaluateMerge,
  changedFiles,
  landBranch,
  type GitRunner,
  type GitResult,
} from '../orchestrator/mergeGate';

// ---------------------------------------------------------------------------
// Glob → path matching (precise)
// ---------------------------------------------------------------------------

suite('mergeGate — globToRegExp / fileInScope', () => {
  test('** crosses directory separators (subtree)', () => {
    assert.ok(globToRegExp('src/**').test('src/a.ts'));
    assert.ok(globToRegExp('src/**').test('src/a/b/c.ts'));
    assert.ok(!globToRegExp('src/**').test('lib/a.ts'));
  });

  test('* stays within a single segment', () => {
    assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
    assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  });

  test('literal path matches exactly — the foo/foobar trap', () => {
    assert.ok(globToRegExp('src/foo').test('src/foo'));
    assert.ok(!globToRegExp('src/foo').test('src/foobar.ts'), 'src/foo must NOT match src/foobar.ts');
    assert.ok(!fileInScope('src/foobar.ts', ['src/foo']), 'precise: foobar is out of scope for foo');
  });

  test('**/ matches zero or more leading segments', () => {
    assert.ok(globToRegExp('src/**/x.ts').test('src/x.ts'));
    assert.ok(globToRegExp('src/**/x.ts').test('src/a/b/x.ts'));
    assert.ok(!globToRegExp('src/**/x.ts').test('src/x.tsx'));
  });

  test('backslash paths normalize to forward slashes', () => {
    assert.ok(fileInScope('src\\orchestrator\\mergeGate.ts', ['src/orchestrator/**']));
  });

  test('? matches a single non-slash char', () => {
    assert.ok(globToRegExp('a?.ts').test('ab.ts'));
    assert.ok(!globToRegExp('a?.ts').test('a/b.ts'));
  });

  test('regex metacharacters in the glob are escaped', () => {
    assert.ok(globToRegExp('src/a.b+c.ts').test('src/a.b+c.ts'));
    assert.ok(!globToRegExp('src/a.b+c.ts').test('src/axbxc.ts'));
  });

  test('fileInScope matches any of several globs', () => {
    const scope = ['src/orchestrator/**', 'src/test/mergeGate.test.ts', 'package.json'];
    assert.ok(fileInScope('src/orchestrator/worktree.ts', scope));
    assert.ok(fileInScope('package.json', scope));
    assert.ok(!fileInScope('src/extension.ts', scope));
  });
});

// ---------------------------------------------------------------------------
// Scope partition
// ---------------------------------------------------------------------------

suite('mergeGate — checkScope', () => {
  test('partitions changed files and reports clean only when all in scope', () => {
    const r = checkScope(
      ['src/orchestrator/mergeGate.ts', 'src/orchestrator/worktree.ts'],
      ['src/orchestrator/**'],
    );
    assert.deepStrictEqual(r.outOfScope, []);
    assert.strictEqual(r.clean, true);
    assert.strictEqual(r.inScope.length, 2);
  });

  test('flags an out-of-scope file', () => {
    const r = checkScope(
      ['src/orchestrator/mergeGate.ts', 'src/extension.ts'],
      ['src/orchestrator/**'],
    );
    assert.deepStrictEqual(r.outOfScope, ['src/extension.ts']);
    assert.strictEqual(r.clean, false);
  });
});

// ---------------------------------------------------------------------------
// Merge decision (pure)
// ---------------------------------------------------------------------------

suite('mergeGate — evaluateMerge', () => {
  test('allows a scope-clean, building branch', () => {
    const r = evaluateMerge({
      changedFiles: ['src/orchestrator/mergeGate.ts'],
      allowedGlobs: ['src/orchestrator/**'],
      buildOk: true,
    });
    assert.strictEqual(r.allowed, true);
    assert.deepStrictEqual(r.reasons, []);
  });

  test('denies an out-of-scope diff with an actionable reason', () => {
    const r = evaluateMerge({
      changedFiles: ['src/extension.ts'],
      allowedGlobs: ['src/orchestrator/**'],
      buildOk: true,
    });
    assert.strictEqual(r.allowed, false);
    assert.ok(r.reasons[0].includes('outside claimed scope'));
    assert.deepStrictEqual(r.outOfScope, ['src/extension.ts']);
  });

  test('denies when build is required but failed/missing', () => {
    assert.strictEqual(evaluateMerge({ changedFiles: ['src/orchestrator/x.ts'], allowedGlobs: ['src/orchestrator/**'], buildOk: false }).allowed, false);
    assert.strictEqual(evaluateMerge({ changedFiles: ['src/orchestrator/x.ts'], allowedGlobs: ['src/orchestrator/**'] }).allowed, false, 'missing build result is denied when required');
  });

  test('build not required → missing build result is fine', () => {
    const r = evaluateMerge({ changedFiles: ['src/orchestrator/x.ts'], allowedGlobs: ['src/orchestrator/**'], requireBuild: false });
    assert.strictEqual(r.allowed, true);
  });

  test('tests required and failing denies', () => {
    const r = evaluateMerge({ changedFiles: ['src/orchestrator/x.ts'], allowedGlobs: ['src/orchestrator/**'], buildOk: true, requireTests: true, testsOk: false });
    assert.strictEqual(r.allowed, false);
    assert.ok(r.reasons.some((x) => x.includes('tests fail')));
  });
});

// ---------------------------------------------------------------------------
// IO layer with a fake git runner
// ---------------------------------------------------------------------------

function fakeGit(map: Record<string, GitResult>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    const key = args.join(' ');
    for (const k of Object.keys(map)) {
      if (key.startsWith(k)) { return map[k]; }
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { git, calls };
}

suite('mergeGate — changedFiles', () => {
  test('parses + de-duplicates diff output', async () => {
    const { git } = fakeGit({ 'diff --name-only': { exitCode: 0, stdout: 'src/a.ts\0src/a.ts\0src/b.ts\0', stderr: '' } });
    const files = await changedFiles(git, 'master', 'wt/x');
    assert.deepStrictEqual(files.sort(), ['src/a.ts', 'src/b.ts']);
  });

  test('throws on a failed diff', async () => {
    const { git } = fakeGit({ 'diff --name-only': { exitCode: 128, stdout: '', stderr: 'bad rev' } });
    await assert.rejects(() => changedFiles(git, 'master', 'nope'));
  });
});

suite('mergeGate — landBranch', () => {
  test('does NOT merge an out-of-scope branch (gate blocks IO)', async () => {
    const { git, calls } = fakeGit({ 'diff --name-only': { exitCode: 0, stdout: 'src/extension.ts\n', stderr: '' } });
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true });
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.merged, false);
    assert.ok(!calls.some((c) => c[0] === 'merge'), 'merge must never be attempted when the gate denies');
  });

  test('merges a scope-clean, building branch with --no-ff', async () => {
    const { git, calls } = fakeGit({
      'diff --name-only': { exitCode: 0, stdout: 'src/orchestrator/mergeGate.ts\n', stderr: '' },
      'rev-parse': { exitCode: 0, stdout: 'base999\n', stderr: '' },
      'checkout master': { exitCode: 0, stdout: '', stderr: '' },
      'symbolic-ref': { exitCode: 0, stdout: 'refs/heads/master\n', stderr: '' },
      'merge --no-ff': { exitCode: 0, stdout: 'Merge made', stderr: '' },
    });
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true });
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.merged, true);
    assert.ok(calls.some((c) => c[0] === 'merge' && c.includes('--no-ff')));
  });

  test('dryRun evaluates without merging even when allowed', async () => {
    const { git, calls } = fakeGit({ 'diff --name-only': { exitCode: 0, stdout: 'src/orchestrator/x.ts\n', stderr: '' } });
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true, dryRun: true });
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.merged, false);
    assert.ok(!calls.some((c) => c[0] === 'merge'));
  });

  test('aborts a conflicting merge and reports the error', async () => {
    const { git, calls } = fakeGit({
      'diff --name-only': { exitCode: 0, stdout: 'src/orchestrator/x.ts\n', stderr: '' },
      'rev-parse': { exitCode: 0, stdout: 'base999\n', stderr: '' },
      'checkout master': { exitCode: 0, stdout: '', stderr: '' },
      'symbolic-ref': { exitCode: 0, stdout: 'refs/heads/master\n', stderr: '' },
      'merge --no-ff': { exitCode: 1, stdout: 'CONFLICT', stderr: 'Automatic merge failed' },
    });
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true });
    assert.strictEqual(r.merged, false);
    assert.ok(r.mergeError && r.mergeError.includes('merge failed'));
    assert.ok(calls.some((c) => c[0] === 'merge' && c[1] === '--abort'), 'a conflicted merge must be aborted to leave base clean');
  });
});

// ---------------------------------------------------------------------------
// Adversarial-review regressions (F1–F14) — scope-bypass holes must stay closed
// ---------------------------------------------------------------------------

suite('mergeGate — hardening regressions', () => {
  test('F1: a `..` segment is OUT of scope (no traversal escape)', () => {
    assert.strictEqual(fileInScope('src/../package.json', ['src/**']), false);
    assert.strictEqual(fileInScope('src/x/../../secret.ts', ['src/**']), false);
    const r = checkScope(['src/ok.ts', 'src/../package.json'], ['src/**']);
    assert.deepStrictEqual(r.outOfScope, ['src/../package.json'], 'a `..` path is flagged, not silently skipped');
    assert.strictEqual(r.clean, false);
  });

  test('F2: non-segment `**` does not escape its directory', () => {
    assert.strictEqual(fileInScope('src/food/x.ts', ['src/foo**']), false, 'foo** must not cross into food/');
    assert.strictEqual(fileInScope('src/a/b.ts', ['src/**.ts']), false, '**.ts must not cross directories');
    // proper subtree form is precise
    assert.strictEqual(fileInScope('src/foo/x.ts', ['src/foo/**']), true);
    assert.strictEqual(fileInScope('src/foobar.ts', ['src/foo/**']), false);
  });

  test('F3: absolute paths are OUT of scope (not relativized)', () => {
    assert.strictEqual(fileInScope('/src/secret.ts', ['src/**']), false, 'leading-slash absolute must not match');
    assert.strictEqual(fileInScope('C:/Windows/x', ['src/**']), false, 'drive-letter absolute must not match');
    const r = checkScope(['/etc/passwd'], ['src/**']);
    assert.deepStrictEqual(r.outOfScope, ['/etc/passwd']);
  });

  test('F7: changedFiles uses -z (NUL) so quoted/non-ASCII names survive', async () => {
    const { git, calls } = fakeGit({ 'diff --name-only -z': { exitCode: 0, stdout: 'src/a.ts\0src/ünï.ts\0', stderr: '' } });
    const files = await changedFiles(git, 'master', 'wt/x');
    assert.ok(calls[0].includes('-z'), 'diff must pass -z');
    assert.deepStrictEqual(files.sort(), ['src/a.ts', 'src/ünï.ts']);
  });
});

suite('mergeGate — landBranch hardening', () => {
  function handler(routes: Array<{ k: string; res: GitResult }>): { git: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      const s = args.join(' ');
      for (const r of routes) { if (s.includes(r.k)) { return r.res; } }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    return { git, calls };
  }

  test('F14: empty diff is a no-op, never a phantom merge', async () => {
    const { git, calls } = handler([{ k: 'diff --name-only -z', res: { exitCode: 0, stdout: '', stderr: '' } }]);
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/**'], buildOk: true });
    assert.strictEqual(r.noop, true);
    assert.strictEqual(r.merged, false);
    assert.ok(!calls.some((c) => c[0] === 'merge'));
  });

  test('F4: refuses to land on a detached HEAD (dangling-commit guard)', async () => {
    const { git, calls } = handler([
      { k: 'master...wt/x', res: { exitCode: 0, stdout: 'src/orchestrator/x.ts\0', stderr: '' } },
      { k: 'rev-parse', res: { exitCode: 0, stdout: 'abc123\n', stderr: '' } },
      { k: 'checkout', res: { exitCode: 0, stdout: '', stderr: '' } },
      { k: 'symbolic-ref', res: { exitCode: 1, stdout: '', stderr: 'detached' } },
    ]);
    const r = await landBranch(git, { base: 'origin/master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true });
    assert.strictEqual(r.merged, false);
    assert.ok(r.mergeError && r.mergeError.includes('detached'));
    assert.ok(!calls.some((c) => c[0] === 'merge' && c[1] === '--no-ff'), 'must not merge onto a detached HEAD');
  });

  test('F5: post-merge re-diff catches a base that moved, and resets', async () => {
    let diffN = 0;
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      const s = args.join(' ');
      if (s.includes('diff --name-only -z')) {
        diffN++;
        // 1st diff (gate): in scope; 2nd diff (post-merge): out of scope.
        return diffN === 1
          ? { exitCode: 0, stdout: 'src/orchestrator/x.ts\0', stderr: '' }
          : { exitCode: 0, stdout: 'src/orchestrator/x.ts\0src/extension.ts\0', stderr: '' };
      }
      if (s.includes('rev-parse')) { return { exitCode: 0, stdout: 'base999\n', stderr: '' }; }
      if (s.includes('symbolic-ref')) { return { exitCode: 0, stdout: 'refs/heads/master\n', stderr: '' }; }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true });
    assert.strictEqual(r.merged, false);
    assert.ok(r.mergeError && r.mergeError.includes('post-merge'));
    assert.ok(calls.some((c) => c[0] === 'reset' && c.includes('--hard')), 'a moved-base land must be reset');
  });

  test('happy path still lands with the new guards in place', async () => {
    const { git, calls } = handler([
      { k: 'diff --name-only -z', res: { exitCode: 0, stdout: 'src/orchestrator/x.ts\0', stderr: '' } },
      { k: 'rev-parse', res: { exitCode: 0, stdout: 'base999\n', stderr: '' } },
      { k: 'symbolic-ref', res: { exitCode: 0, stdout: 'refs/heads/master\n', stderr: '' } },
      { k: 'merge --no-ff', res: { exitCode: 0, stdout: 'Merge made', stderr: '' } },
    ]);
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true });
    assert.strictEqual(r.merged, true);
    assert.ok(calls.some((c) => c[0] === 'merge' && c.includes('--no-ff')));
  });

  test('postMergeBuild failure resets the merge', async () => {
    const { git, calls } = handler([
      { k: 'diff --name-only -z', res: { exitCode: 0, stdout: 'src/orchestrator/x.ts\0', stderr: '' } },
      { k: 'rev-parse', res: { exitCode: 0, stdout: 'base999\n', stderr: '' } },
      { k: 'symbolic-ref', res: { exitCode: 0, stdout: 'refs/heads/master\n', stderr: '' } },
      { k: 'merge --no-ff', res: { exitCode: 0, stdout: 'Merge made', stderr: '' } },
    ]);
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true, postMergeBuild: async () => false });
    assert.strictEqual(r.merged, false);
    assert.ok(r.mergeError && r.mergeError.includes('post-merge build'));
    assert.ok(calls.some((c) => c[0] === 'reset'));
  });
});

// ---------------------------------------------------------------------------
// Re-verify regressions — the "fail-closed" guards must actually fail CLOSED
// ---------------------------------------------------------------------------

suite('mergeGate — fail-closed regressions', () => {
  function rt(routes: Array<{ k: string; res: GitResult }>): { git: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      const s = args.join(' ');
      for (const r of routes) { if (s.includes(r.k)) { return r.res; } }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    return { git, calls };
  }
  const inScopeDiff = { k: 'master...wt/x', res: { exitCode: 0, stdout: 'src/orchestrator/x.ts\0', stderr: '' } as GitResult };

  test('CRITICAL: a failed rev-parse (empty base SHA) is FATAL — never merges', async () => {
    const { git, calls } = rt([inScopeDiff, { k: 'rev-parse', res: { exitCode: 128, stdout: '', stderr: 'unknown rev' } }]);
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true });
    assert.strictEqual(r.merged, false);
    assert.ok(r.mergeError && r.mergeError.includes('could not pin base SHA'));
    assert.ok(!calls.some((c) => c[0] === 'merge'), 'must not merge when base SHA cannot be pinned');
    assert.ok(!calls.some((c) => c[0] === 'checkout'), 'must not even checkout');
  });

  test('dirty land-target tree refuses to land (no reset over uncommitted work)', async () => {
    const { git, calls } = rt([inScopeDiff, { k: 'status --porcelain', res: { exitCode: 0, stdout: ' M src/other.ts\n', stderr: '' } }]);
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true });
    assert.strictEqual(r.merged, false);
    assert.ok(r.mergeError && r.mergeError.includes('dirty'));
    assert.ok(!calls.some((c) => c[0] === 'merge'));
  });

  test('fully-qualified base (refs/heads/master) is accepted, not falsely rejected', async () => {
    const { git } = rt([
      { k: 'refs/heads/master...wt/x', res: { exitCode: 0, stdout: 'src/orchestrator/x.ts\0', stderr: '' } },
      { k: 'rev-parse', res: { exitCode: 0, stdout: 'base999\n', stderr: '' } },
      { k: 'symbolic-ref', res: { exitCode: 0, stdout: 'refs/heads/master\n', stderr: '' } },
      { k: 'merge --no-ff', res: { exitCode: 0, stdout: 'Merge made', stderr: '' } },
    ]);
    const r = await landBranch(git, { base: 'refs/heads/master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true });
    assert.strictEqual(r.merged, true);
  });

  test('post-merge diff ERROR fails closed (reset + deny, not silent accept)', async () => {
    let diffN = 0;
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      const s = args.join(' ');
      if (s.includes('diff --name-only -z')) {
        diffN++;
        return diffN === 1 ? { exitCode: 0, stdout: 'src/orchestrator/x.ts\0', stderr: '' } : { exitCode: 128, stdout: '', stderr: 'diff boom' };
      }
      if (s.includes('rev-parse')) { return { exitCode: 0, stdout: 'base999\n', stderr: '' }; }
      if (s.includes('symbolic-ref')) { return { exitCode: 0, stdout: 'refs/heads/master\n', stderr: '' }; }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true });
    assert.strictEqual(r.merged, false);
    assert.ok(r.mergeError && r.mergeError.includes('verification diff failed'));
    assert.ok(calls.some((c) => c[0] === 'reset' && c.includes('--hard')));
  });

  test('a reset failure is surfaced loudly (could-not-undo is never reported as undone)', async () => {
    let diffN = 0;
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      const s = args.join(' ');
      if (s.includes('diff --name-only -z')) {
        diffN++;
        return diffN === 1 ? { exitCode: 0, stdout: 'src/orchestrator/x.ts\0', stderr: '' } : { exitCode: 0, stdout: 'src/orchestrator/x.ts\0src/extension.ts\0', stderr: '' };
      }
      if (s.includes('rev-parse')) { return { exitCode: 0, stdout: 'base999\n', stderr: '' }; }
      if (s.includes('symbolic-ref')) { return { exitCode: 0, stdout: 'refs/heads/master\n', stderr: '' }; }
      if (s.includes('reset --hard')) { return { exitCode: 1, stdout: '', stderr: 'reset blocked' }; }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true });
    assert.strictEqual(r.merged, false);
    assert.ok(r.mergeError && r.mergeError.includes('CRITICAL'), `reset failure must be loud: ${r.mergeError}`);
  });

  test('merge-abort failure names the unclean state', async () => {
    const { git } = rt([
      inScopeDiff,
      { k: 'rev-parse', res: { exitCode: 0, stdout: 'base999\n', stderr: '' } },
      { k: 'symbolic-ref', res: { exitCode: 0, stdout: 'refs/heads/master\n', stderr: '' } },
      { k: 'merge --no-ff', res: { exitCode: 1, stdout: 'CONFLICT', stderr: 'failed' } },
      { k: 'merge --abort', res: { exitCode: 1, stdout: '', stderr: 'abort blocked' } },
      { k: 'reset --hard', res: { exitCode: 1, stdout: '', stderr: 'reset blocked' } },
    ]);
    const r = await landBranch(git, { base: 'master', ref: 'wt/x', allowedGlobs: ['src/orchestrator/**'], buildOk: true });
    assert.strictEqual(r.merged, false);
    assert.ok(r.mergeError && r.mergeError.includes('abort failed'));
  });
});

suite('mergeGate — globToRegExp ReDoS collapse', () => {
  test('consecutive ** segments collapse (a/**/**/c ≡ a/**/c) and match the same set', () => {
    for (const f of ['a/c', 'a/x/c', 'a/x/y/c']) {
      assert.strictEqual(globToRegExp('a/**/**/c').test(f), globToRegExp('a/**/c').test(f), `mismatch on ${f}`);
    }
    // and the compiled source must not contain two adjacent group quantifiers
    assert.ok(!globToRegExp('a/**/**/c').source.includes(')*(?:'), 'adjacent ** groups must be collapsed');
  });

  test('deep non-matching path resolves quickly (no catastrophic backtracking)', () => {
    const re = globToRegExp('a/**/**/**/c');
    const deep = 'a/' + 'seg/'.repeat(2000) + 'nope';
    const start = process.hrtime.bigint();
    re.test(deep);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 200, `evaluation should be fast, took ${ms.toFixed(1)}ms`);
  });
});
