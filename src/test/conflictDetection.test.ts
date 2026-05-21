/**
 * conflictDetection.test.ts — Unit tests for the pre-push branch-overlap
 * conflict detector (`src/hooks/conflictDetection.ts`).
 *
 * No `vscode` import — plain Node/Mocha, consistent with the project's other
 * unit suites. The git subprocess is fully stubbed via the `runGit` injector.
 *
 * Sprint 4 — C5_statusbar (C.12, WA-1).
 */

import * as assert from 'assert';
import {
  parseChangedFiles,
  computeOverlaps,
  formatConflictWarnings,
  resolveBaseRef,
  detectBranchConflicts,
  type GitRunner,
} from '../hooks/conflictDetection';

suite('Conflict Detection — pure parsers', () => {
  test('parseChangedFiles splits, trims, and drops blanks', () => {
    const out = 'src/a.ts\n  src/b.ts  \n\nsrc/c.ts\n';
    assert.deepStrictEqual(parseChangedFiles(out), [
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  test('parseChangedFiles on empty output yields empty array', () => {
    assert.deepStrictEqual(parseChangedFiles(''), []);
    assert.deepStrictEqual(parseChangedFiles('\n\n  \n'), []);
  });

  test('computeOverlaps finds shared files between branch and peers', () => {
    const branchFiles = new Set(['src/a.ts', 'src/b.ts']);
    const peers = new Map([
      ['feat/peer-1', new Set(['src/b.ts', 'src/x.ts'])],
      ['feat/peer-2', new Set(['src/y.ts'])],
    ]);
    const overlaps = computeOverlaps('feat/mine', branchFiles, peers);
    assert.strictEqual(overlaps.length, 1);
    assert.strictEqual(overlaps[0].otherBranch, 'feat/peer-1');
    assert.deepStrictEqual(overlaps[0].overlappingFiles, ['src/b.ts']);
  });

  test('computeOverlaps skips the branch compared against itself', () => {
    const branchFiles = new Set(['src/a.ts']);
    const peers = new Map([['feat/mine', new Set(['src/a.ts'])]]);
    const overlaps = computeOverlaps('feat/mine', branchFiles, peers);
    assert.deepStrictEqual(overlaps, []);
  });

  test('computeOverlaps returns sorted, multi-file overlaps', () => {
    const branchFiles = new Set(['z.ts', 'a.ts', 'm.ts']);
    const peers = new Map([
      ['feat/b', new Set(['z.ts', 'a.ts', 'm.ts'])],
    ]);
    const overlaps = computeOverlaps('feat/mine', branchFiles, peers);
    assert.deepStrictEqual(overlaps[0].overlappingFiles, ['a.ts', 'm.ts', 'z.ts']);
  });

  test('formatConflictWarnings produces human-readable lines', () => {
    const warnings = formatConflictWarnings([
      { branch: 'feat/mine', otherBranch: 'feat/peer', overlappingFiles: ['src/a.ts'] },
    ]);
    assert.ok(warnings.some(l => l.includes('feat/mine')));
    assert.ok(warnings.some(l => l.includes('feat/peer')));
    assert.ok(warnings.some(l => l.includes('src/a.ts')));
    assert.ok(warnings.some(l => l.includes('coordinate')));
  });
});

suite('Conflict Detection — base-ref resolution', () => {
  test('resolveBaseRef returns the first ref git accepts', async () => {
    const runGit: GitRunner = async (_dir, args) => {
      if (args.includes('origin/main^{commit}')) {
        throw new Error('not found');
      }
      if (args.includes('main^{commit}')) {
        return 'abc123\n';
      }
      throw new Error('not found');
    };
    const ref = await resolveBaseRef('/repo', runGit);
    assert.strictEqual(ref, 'main');
  });

  test('resolveBaseRef honors an explicit ref first', async () => {
    const runGit: GitRunner = async (_dir, args) => {
      if (args.includes('develop^{commit}')) { return 'ok\n'; }
      throw new Error('not found');
    };
    const ref = await resolveBaseRef('/repo', runGit, 'develop');
    assert.strictEqual(ref, 'develop');
  });

  test('resolveBaseRef falls back to the empty tree when nothing resolves', async () => {
    const runGit: GitRunner = async () => { throw new Error('not found'); };
    const ref = await resolveBaseRef('/repo', runGit);
    assert.strictEqual(ref, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });
});

suite('Conflict Detection — detectBranchConflicts', () => {
  /** Build a git stub: branch→file-list map, plus resolvable base refs. */
  function gitStub(branchFiles: Record<string, string[]>): GitRunner {
    return async (_dir, args) => {
      if (args[0] === 'rev-parse') {
        // Accept only origin/main as the base.
        if (args.some(a => a.startsWith('origin/main'))) { return 'base\n'; }
        throw new Error('not found');
      }
      if (args[0] === 'diff' && args[1] === '--name-only') {
        const spec = args[2]; // "<base>...<branch>"
        const branch = spec.split('...')[1];
        const files = branchFiles[branch];
        if (files === undefined) { throw new Error(`unknown ref ${branch}`); }
        return files.join('\n') + '\n';
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    };
  }

  test('reports no conflict when branches touch disjoint files', async () => {
    const report = await detectBranchConflicts({
      repoDir: '/repo',
      branch: 'feat/wa1',
      peerBranches: ['feat/wa2'],
      runGit: gitStub({
        'feat/wa1': ['src/statusbar/a.ts'],
        'feat/wa2': ['src/runners/b.ts'],
      }),
    });
    assert.strictEqual(report.hasConflict, false);
    assert.deepStrictEqual(report.overlaps, []);
    assert.deepStrictEqual(report.warnings, []);
    assert.strictEqual(report.baseRef, 'origin/main');
  });

  test('reports a conflict when two branches touch the same file', async () => {
    const report = await detectBranchConflicts({
      repoDir: '/repo',
      branch: 'feat/wa1',
      peerBranches: ['feat/wa2', 'feat/wa3'],
      runGit: gitStub({
        'feat/wa1': ['src/extension.ts', 'src/statusbar/a.ts'],
        'feat/wa2': ['src/extension.ts'],
        'feat/wa3': ['src/cloud/c.ts'],
      }),
    });
    assert.strictEqual(report.hasConflict, true);
    assert.strictEqual(report.overlaps.length, 1);
    assert.strictEqual(report.overlaps[0].otherBranch, 'feat/wa2');
    assert.deepStrictEqual(report.overlaps[0].overlappingFiles, ['src/extension.ts']);
    assert.ok(report.warnings.length > 0);
  });

  test('skips peer branches that do not resolve', async () => {
    const report = await detectBranchConflicts({
      repoDir: '/repo',
      branch: 'feat/wa1',
      peerBranches: ['feat/ghost'],
      runGit: gitStub({ 'feat/wa1': ['src/a.ts'] }),
    });
    assert.strictEqual(report.hasConflict, false);
  });

  test('the branch itself is never compared against itself', async () => {
    const report = await detectBranchConflicts({
      repoDir: '/repo',
      branch: 'feat/wa1',
      peerBranches: ['feat/wa1', 'feat/wa2'],
      runGit: gitStub({
        'feat/wa1': ['src/a.ts'],
        'feat/wa2': ['src/b.ts'],
      }),
    });
    assert.strictEqual(report.hasConflict, false);
  });
});
