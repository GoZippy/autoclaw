/**
 * intelligence-gitsignals.test.ts — unit tests for git-validated kept/discarded
 * enrichment + signal ranking (Phase-2 intelligence-signal-and-rag).
 *
 * Verifies, using a STUBBED GitRunner (no real repo, fully offline):
 *  - a session whose code block matches a recent commit's added lines is marked
 *    gitKept with its gitKeptCommit + a git_commit KeptCode carrying confidence
 *    >= minConfidence (R1.1, R1.2)
 *  - a session with unrelated code is NOT marked gitKept (R1.2)
 *  - no git repo ⇒ sessions returned unchanged, no error (R1.4)
 *  - resolveHomeDir honors HOME and USERPROFILE (R1.5)
 *  - deriveOutcome / weightForRetrieval precedence: git_commit > applied_edit >
 *    user_approval > none, and git always outranks heuristic-only (R1.3, R4.1)
 */

import * as assert from 'assert';

import {
  enrichSessionsWithGitSignals,
  resolveHomeDir,
  GitSignalsOptions,
} from '../intelligence/gitSignals';
import { GitRunner } from '../intelligence/ragCode';
import {
  deriveOutcome,
  weightForRetrieval,
  weightForSignal,
} from '../intelligence/ranking';
import { UnifiedSession } from '../intelligence/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEPT_CODE = [
  'export function computeTotal(items) {',
  '  return items.reduce((acc, value) => acc + value, 0);',
  '}',
].join('\n');

const COMMIT_DIFF = [
  'diff --git a/util.ts b/util.ts',
  'index 0000000..1111111 100644',
  '--- a/util.ts',
  '+++ b/util.ts',
  '@@ -0,0 +1,3 @@',
  '+export function computeTotal(items) {',
  '+  return items.reduce((acc, value) => acc + value, 0);',
  '+}',
].join('\n');

const COMMIT_LOG = 'abc1234|2026-06-12 10:00:00 +0000|Add computeTotal helper';

function makeSession(id: string, code: string): UnifiedSession {
  return {
    id,
    source: 'test',
    tool: 'Test Tool',
    project: '/repo',
    startedAt: 1,
    messages: [{ role: 'assistant', text: 'here', codeBlocks: [{ lang: 'ts', code }] }],
    signals: { keptCode: [] },
    provenance: { adapterId: 'test', rawRef: id, extractedAt: 1 },
  };
}

/** A git runner that simulates a repo with one matching commit. */
function repoGit(diff: string = COMMIT_DIFF, log: string = COMMIT_LOG): GitRunner {
  return (args: string): string => {
    if (args.startsWith('rev-parse --is-inside-work-tree')) return 'true';
    if (args.startsWith('log')) return log;
    if (args.startsWith('show')) return diff;
    return '';
  };
}

/** A git runner that simulates "not a git repo" (rev-parse throws). */
const noRepoGit: GitRunner = (args: string): string => {
  if (args.startsWith('rev-parse')) {
    throw new Error('not a git repository');
  }
  return '';
};

function baseOpts(gitRunner: GitRunner): GitSignalsOptions {
  return { lookbackDays: 14, minConfidence: 0.5, cwd: '/repo', gitRunner };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('intelligence-gitsignals', function () {
  suite('enrichSessionsWithGitSignals', function () {
    test('marks a committed code block as gitKept with confidence + commit (R1.1/R1.2)', async function () {
      const sessions = [makeSession('s1', KEPT_CODE)];
      const out = await enrichSessionsWithGitSignals(sessions, baseOpts(repoGit()));

      const s = out[0];
      assert.strictEqual(s.signals.gitKept, true, 'matched session should be gitKept');
      assert.ok(s.signals.gitKeptCommit, 'gitKeptCommit should be set');
      assert.strictEqual(s.signals.gitKeptCommit?.hash, 'abc1234');
      assert.ok(
        s.signals.gitKeptCommit?.message.includes('computeTotal'),
        'commit message should be retained',
      );

      const gitKept = s.signals.keptCode.find((k) => k.reason === 'git_commit');
      assert.ok(gitKept, 'a git_commit KeptCode entry should be appended');
      assert.ok(
        (gitKept?.confidence ?? 0) >= 0.5,
        `confidence ${gitKept?.confidence} should clear minConfidence`,
      );
    });

    test('does not mark unrelated code as gitKept (R1.2)', async function () {
      const sessions = [makeSession('s2', 'export function unrelatedThing() { return "nope"; }')];
      const out = await enrichSessionsWithGitSignals(sessions, baseOpts(repoGit()));

      assert.strictEqual(out[0].signals.gitKept, false, 'non-matching session must not be gitKept');
      assert.strictEqual(
        out[0].signals.keptCode.find((k) => k.reason === 'git_commit'),
        undefined,
        'no git_commit KeptCode for an unmatched session',
      );
    });

    test('no git repo ⇒ sessions unchanged, no error (R1.4)', async function () {
      const sessions = [makeSession('s3', KEPT_CODE)];
      const snapshot = JSON.parse(JSON.stringify(sessions));
      const out = await enrichSessionsWithGitSignals(sessions, baseOpts(noRepoGit));

      assert.deepStrictEqual(out, snapshot, 'sessions must pass through unchanged');
    });

    test('empty session list is a no-op', async function () {
      const out = await enrichSessionsWithGitSignals([], baseOpts(repoGit()));
      assert.deepStrictEqual(out, []);
    });
  });

  // -------------------------------------------------------------------------
  // resolveHomeDir (R1.5)
  // -------------------------------------------------------------------------

  suite('resolveHomeDir', function () {
    test('prefers HOME when set', function () {
      assert.strictEqual(resolveHomeDir({ HOME: '/home/alice' }), '/home/alice');
    });

    test('falls back to USERPROFILE when HOME is absent (Windows fix)', function () {
      assert.strictEqual(
        resolveHomeDir({ USERPROFILE: 'C:\\Users\\alice' }),
        'C:\\Users\\alice',
      );
    });

    test('falls back to os.homedir() when neither is set', function () {
      const resolved = resolveHomeDir({});
      assert.ok(typeof resolved === 'string' && resolved.length > 0);
    });
  });

  // -------------------------------------------------------------------------
  // ranking precedence (R1.3 / R4.1)
  // -------------------------------------------------------------------------

  suite('ranking precedence', function () {
    function sessionWith(
      partial: Partial<UnifiedSession['signals']>,
    ): UnifiedSession {
      const s = makeSession('r', '');
      s.signals = { keptCode: [], ...partial } as UnifiedSession['signals'];
      return s;
    }

    test('git_commit outranks applied_edit and user_approval', function () {
      const session = sessionWith({
        keptCode: [
          { code: 'a', reason: 'user_approval', confidence: 0.9 },
          { code: 'b', reason: 'applied_edit', confidence: 0.9 },
          { code: 'c', reason: 'git_commit', confidence: 0.6 },
        ],
      });
      const derived = deriveOutcome(session);
      assert.strictEqual(derived.signalType, 'git_commit');
      assert.strictEqual(derived.outcome, 'shipped');
    });

    test('applied_edit outranks user_approval', function () {
      const session = sessionWith({
        keptCode: [
          { code: 'a', reason: 'user_approval', confidence: 0.9 },
          { code: 'b', reason: 'applied_edit', confidence: 0.5 },
        ],
      });
      assert.strictEqual(deriveOutcome(session).signalType, 'applied_edit');
    });

    test('gitKept flag alone derives a git_commit outcome', function () {
      const session = sessionWith({ keptCode: [], gitKept: true });
      assert.strictEqual(deriveOutcome(session).signalType, 'git_commit');
    });

    test('no signal ⇒ unknown', function () {
      assert.strictEqual(deriveOutcome(sessionWith({ keptCode: [] })).signalType, 'none');
      assert.strictEqual(deriveOutcome(sessionWith({ keptCode: [] })).outcome, 'unknown');
    });

    test('git-validated weight outranks heuristic-only even at worst vs best case (R4.1)', function () {
      const worstGit = weightForSignal('git_commit', 0);
      const bestApproval = weightForSignal('user_approval', 1);
      assert.ok(
        worstGit > bestApproval,
        `git@0 (${worstGit}) should outrank approval@1 (${bestApproval})`,
      );
    });

    test('weightForRetrieval reflects the derived signal', function () {
      const gitSession = makeSession('g', '');
      gitSession.signals = {
        keptCode: [{ code: 'c', reason: 'git_commit', confidence: 0.8 }],
      };
      const approvalSession = makeSession('u', '');
      approvalSession.signals = {
        keptCode: [{ code: 'c', reason: 'user_approval', confidence: 0.8 }],
      };
      assert.ok(weightForRetrieval(gitSession) > weightForRetrieval(approvalSession));
    });
  });
});
