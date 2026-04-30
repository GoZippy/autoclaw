/**
 * Analytics Tests
 *
 * Unit tests for analytics math in extension.ts:
 *   - getCodeChurnMetrics
 *   - getProductivityInsights
 *   - getProjectHealthIndicators
 *
 * Approach: spin up a real ephemeral git repo in a temp directory and
 * exercise the actual exported functions. This avoids introducing a
 * mocking seam in extension.ts (per task constraints) while still
 * keeping each test self-contained.
 *
 * NOTE: A handful of tests intentionally fail in current `master` and
 * are guarded with `test.skip(...)` calls. Those mark the bugs that
 * Phase 1 tasks B1 and B2 must fix. When Phase 1 lands, un-skip them.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

import {
  getCodeChurnMetrics,
  getProductivityInsights,
  getProjectHealthIndicators
} from '../extension';
import type { AdapterHealth, TodoItem } from '../kdream-helpers';

// Helpers --------------------------------------------------------------------

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, cmd: string) {
  execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function initRepo(cwd: string) {
  git(cwd, 'init -q');
  git(cwd, 'config user.email "test@autoclaw.local"');
  git(cwd, 'config user.name "AutoClaw Test"');
  // Avoid GPG/signing prompts in CI environments
  git(cwd, 'config commit.gpgsign false');
}

function commitFile(cwd: string, file: string, content: string, message: string) {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, `add ${JSON.stringify(file)}`);
  git(cwd, `commit -q -m ${JSON.stringify(message)}`);
}

// Tests ----------------------------------------------------------------------

suite('Analytics: getCodeChurnMetrics()', function () {
  this.timeout(20000);

  let repo: string;

  setup(function () {
    repo = makeTempDir('autoclaw-churn-');
    initRepo(repo);
    // Three commits with known sizes so we can reason about totals.
    // The last commit MUST contain both insertions and deletions so that
    // git's `--shortstat` output includes both clauses (the production
    // regex in getCodeChurnMetrics requires both — a separate latent bug
    // outside this baseline's scope).
    commitFile(repo, 'a.txt', 'a1\na2\na3\n', 'feat: a');
    commitFile(repo, 'b.txt', 'b1\nb2\n', 'feat: b');
    // Replace a.txt entirely to produce both deletions (3 lines) and
    // insertions (5 lines).
    commitFile(repo, 'a.txt', 'A1\nA2\nA3\nA4\nA5\n', 'feat: rewrite a');
  });

  teardown(function () {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('returns zeroed metrics for non-git directories', async function () {
    const empty = makeTempDir('autoclaw-nogit-');
    try {
      const m = await getCodeChurnMetrics(empty);
      assert.strictEqual(m.totalCommits, 0);
      assert.strictEqual(m.commitsLast7Days, 0);
      assert.strictEqual(m.commitsLast30Days, 0);
      assert.strictEqual(m.linesAdded, 0);
      assert.strictEqual(m.linesDeleted, 0);
      assert.strictEqual(m.churnRate, 0);
      assert.strictEqual(m.avgCommitSize, 0);
      assert.strictEqual(m.mostActiveDay, '');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('counts total commits and recent-window commits', async function () {
    const m = await getCodeChurnMetrics(repo);
    assert.strictEqual(m.totalCommits, 3, 'three commits made in setup');
    // All three were just made, so they're well within both windows.
    assert.strictEqual(m.commitsLast7Days, 3);
    assert.strictEqual(m.commitsLast30Days, 3);
  });

  test('reports a most active day formatted as YYYY-MM-DD', async function () {
    const m = await getCodeChurnMetrics(repo);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(m.mostActiveDay),
      `expected YYYY-MM-DD, got: "${m.mostActiveDay}"`);
  });

  test('records non-negative line counts from HEAD~1..HEAD diff', async function () {
    const m = await getCodeChurnMetrics(repo);
    // Last commit extended a.txt from 3 -> 5 lines: 2 insertions, 0 deletions.
    assert.ok(m.linesAdded >= 0, 'linesAdded should be non-negative');
    assert.ok(m.linesDeleted >= 0, 'linesDeleted should be non-negative');
    assert.ok(m.linesAdded + m.linesDeleted > 0,
      'last commit added lines, expected non-zero churn');
  });

  // ---- Phase 1 / B1 -------------------------------------------------------
  // BUG: linesAdded/linesDeleted only count the LAST commit (HEAD~1..HEAD),
  // not a 30-day aggregate. Phase 1 task B1 should switch to
  // `git log --since=... --shortstat` (or equivalent) and sum.
  test('[B1] linesAdded aggregates the last 30 days, not just HEAD~1..HEAD', async function () {
    const m = await getCodeChurnMetrics(repo);
    // Total insertions across our three commits as git reports them in
    // `--shortstat`:
    //   c1: a.txt 0 -> 3 lines  -> 3 insertions
    //   c2: b.txt 0 -> 2 lines  -> 2 insertions
    //   c3: a.txt 3 -> 5 lines  -> 5 insertions, 3 deletions
    //   total: 10 insertions, 3 deletions.
    // The pre-B1 implementation (HEAD~1..HEAD only) would return 5
    // insertions; the post-B1 30-day aggregation returns 10.
    assert.strictEqual(m.linesAdded, 10);
    assert.strictEqual(m.linesDeleted, 3);
  });

  // ---- Phase 1 / B2 -------------------------------------------------------
  // BUG: churnRate and avgCommitSize use the SAME formula
  // ((linesAdded + linesDeleted) / totalCommits) so they always collide.
  // Phase 1 task B2 should differentiate them — e.g.
  //   churnRate     = (added + deleted) / linesOfCodeInRepo  (or per day)
  //   avgCommitSize = (added + deleted) / commitsLast30Days
  test('[B2] churnRate and avgCommitSize use distinct formulas', async function () {
    const m = await getCodeChurnMetrics(repo);
    assert.notStrictEqual(m.churnRate, m.avgCommitSize,
      'churnRate and avgCommitSize must not share a formula');
  });
});

suite('Analytics: getProductivityInsights()', function () {
  this.timeout(20000);

  let repo: string;

  setup(function () {
    repo = makeTempDir('autoclaw-prod-');
    initRepo(repo);
    commitFile(repo, 'README.md', '# repo\n', 'docs: init');
    commitFile(repo, 'src.txt', 'hello\n', 'feat: add src');
  });

  teardown(function () {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('happy path returns expected shape and sane numbers', async function () {
    const todos: TodoItem[] = [
      { file: 'src.txt', line: 1, type: 'TODO', text: 'do a thing' }
    ];
    const insights = await getProductivityInsights(repo, [], todos);

    // Shape
    assert.ok('todoResolutionRate' in insights);
    assert.ok('avgTimeToResolveTodo' in insights);
    assert.ok('commitFrequency' in insights);
    assert.ok('activeDays' in insights);
    assert.ok('memorySize' in insights);
    assert.ok('logsSize' in insights);

    // Sanity: numeric, non-negative.
    assert.strictEqual(typeof insights.commitFrequency, 'number');
    assert.ok(insights.commitFrequency >= 0);
    assert.ok(insights.activeDays >= 1, 'we just made commits, expect >=1 active day');
    assert.strictEqual(insights.memorySize, 0, 'no MEMORY.md, so 0 KB');
    assert.strictEqual(insights.logsSize, 0, 'no log file, so 0 KB');
  });

  test('returns zero-ish values for non-git directories', async function () {
    const empty = makeTempDir('autoclaw-prod-nogit-');
    try {
      const insights = await getProductivityInsights(empty, [], []);
      assert.strictEqual(insights.commitFrequency, 0);
      assert.strictEqual(insights.activeDays, 0);
      assert.strictEqual(insights.memorySize, 0);
      assert.strictEqual(insights.logsSize, 0);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('reads memory file size when MEMORY.md exists', async function () {
    // Create a MEMORY.md in the expected location.
    const memDir = path.join(repo, '.autoclaw', 'kdream', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    const memPath = path.join(memDir, 'MEMORY.md');
    // Write ~2 KB of content so size rounds to >=1 KB.
    fs.writeFileSync(memPath, 'x'.repeat(2048));

    const insights = await getProductivityInsights(repo, [], []);
    assert.ok(insights.memorySize >= 1,
      `expected memorySize >= 1 KB, got ${insights.memorySize}`);
  });
});

suite('Analytics: getProjectHealthIndicators()', function () {
  this.timeout(20000);

  let repo: string;

  setup(function () {
    repo = makeTempDir('autoclaw-health-');
    initRepo(repo);
    commitFile(repo, 'a.ts', 'export const x = 1;\n', 'feat: add a');
  });

  teardown(function () {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('happy path returns expected shape and adapter coverage math', async function () {
    const todos: TodoItem[] = [];
    const adapterHealth: AdapterHealth[] = [
      { name: 'A', status: 'healthy', details: 'ok' },
      { name: 'B', status: 'warning', details: 'missing' },
      { name: 'C', status: 'healthy', details: 'ok' },
      { name: 'D', status: 'warning', details: 'missing' }
    ];
    const h = await getProjectHealthIndicators(repo, todos, adapterHealth);

    // Shape
    assert.ok('totalFiles' in h);
    assert.ok('sourceFiles' in h);
    assert.ok('openTodos' in h);
    assert.ok('uncommittedChanges' in h);
    assert.ok('staleChangesHours' in h);
    assert.ok('memoryCompleteness' in h);
    assert.ok('adapterCoverage' in h);

    // Adapter coverage: 2 of 4 healthy => 50%.
    assert.strictEqual(h.adapterCoverage, 50);
    assert.strictEqual(h.openTodos, 0);
    // No uncommitted changes immediately after a commit.
    assert.ok(h.uncommittedChanges >= 0);
    assert.ok(h.staleChangesHours >= 0);
  });

  test('counts uncommitted changes after a dirty edit', async function () {
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'unstaged\n');
    const h = await getProjectHealthIndicators(repo, [], [
      { name: 'A', status: 'healthy', details: 'ok' }
    ]);
    assert.ok(h.uncommittedChanges >= 1,
      `expected >=1 uncommitted change, got ${h.uncommittedChanges}`);
  });

  test('memoryCompleteness reflects which sections are present', async function () {
    const memDir = path.join(repo, '.autoclaw', 'kdream', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'),
      '# KDream Memory\n\n## Follow-ups\n\n- [ ] a\n');

    const h = await getProjectHealthIndicators(repo, [], [
      { name: 'A', status: 'healthy', details: 'ok' }
    ]);
    // 1 of 3 sections present => 33%.
    assert.strictEqual(h.memoryCompleteness, 33);
  });
});
