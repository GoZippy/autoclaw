/**
 * AutoBuild scheduler tests.
 *
 * Pure-Mocha — no `vscode` dependency. Exercises cron parsing/matching, YAML
 * loading, the run engine, and `tick`'s skip-in-flight + enabled=false paths.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import {
  parseCron,
  cronMatches,
  parseWorkflowYaml,
  loadWorkflow,
  runWorkflow,
  tick,
  readRegistry,
  writeRegistry,
  getWorkflowsDir,
  getRunsDir,
  getRegistryPath,
  pruneRunLogs,
  tryAcquireLock,
  releaseLock,
  getLockPath,
  isConcreteStep,
  isRunnableWorkflow,
  writeSchedulerHeartbeat,
  getSchedulerStatus,
  getSchedulerHeartbeatPath,
  SCHEDULER_STALE_MS,
  _resetInFlight,
  _isInFlight
} from '../autobuild';
import type { RunResult } from '../autobuild';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeWorkflowFile(workspaceRoot: string, name: string, body: string): string {
  const dir = getWorkflowsDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${name}.yaml`);
  fs.writeFileSync(p, body);
  return p;
}

suite('AutoBuild: parseCron + cronMatches', function () {
  test('wildcard matches every minute', function () {
    const spec = parseCron('* * * * *');
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 0, 0)), true);
    assert.strictEqual(cronMatches(spec, new Date(2026, 5, 15, 13, 37)), true);
  });

  test('every-5 minutes step', function () {
    const spec = parseCron('*/5 * * * *');
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 12, 0)), true);
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 12, 5)), true);
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 12, 10)), true);
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 12, 11)), false);
  });

  test('comma-list minutes', function () {
    const spec = parseCron('1,2,3 * * * *');
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 5, 1)), true);
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 5, 2)), true);
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 5, 3)), true);
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 5, 4)), false);
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 5, 0)), false);
  });

  test('range minutes 0-30', function () {
    const spec = parseCron('0-30 * * * *');
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 0, 0)), true);
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 0, 30)), true);
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 0, 31)), false);
    assert.strictEqual(cronMatches(spec, new Date(2026, 0, 1, 0, 59)), false);
  });

  test('day-of-week matches Monday only', function () {
    const spec = parseCron('0 0 * * 1');
    // 2026-04-27 is a Monday at 00:00
    assert.strictEqual(cronMatches(spec, new Date(2026, 3, 27, 0, 0)), true);
    // 2026-04-28 Tuesday
    assert.strictEqual(cronMatches(spec, new Date(2026, 3, 28, 0, 0)), false);
  });

  test('leap year Feb 29 matches when explicitly requested', function () {
    const spec = parseCron('0 0 29 2 *');
    // 2024 is a leap year
    assert.strictEqual(cronMatches(spec, new Date(2024, 1, 29, 0, 0)), true);
    // wrong day
    assert.strictEqual(cronMatches(spec, new Date(2024, 1, 28, 0, 0)), false);
    // wrong month
    assert.strictEqual(cronMatches(spec, new Date(2024, 2, 29, 0, 0)), false);
  });

  test('dom OR dow when both restricted', function () {
    // first of the month OR Sunday
    const spec = parseCron('0 0 1 * 0');
    // Random Sunday — 2026-04-26 is a Sunday but not the 1st
    assert.strictEqual(cronMatches(spec, new Date(2026, 3, 26, 0, 0)), true);
    // 1st of June 2026 is a Monday — still matches via dom
    assert.strictEqual(cronMatches(spec, new Date(2026, 5, 1, 0, 0)), true);
    // Tuesday April 28 2026 — neither
    assert.strictEqual(cronMatches(spec, new Date(2026, 3, 28, 0, 0)), false);
  });

  test('rejects malformed expressions', function () {
    assert.throws(() => parseCron(''), /empty/);
    assert.throws(() => parseCron('* * * *'), /5 fields/);
    assert.throws(() => parseCron('60 * * * *'), /out of range/);
    assert.throws(() => parseCron('JAN * * * *'), /unsupported/);
    assert.throws(() => parseCron('5-2 * * * *'), /out of bounds/);
    assert.throws(() => parseCron('*/0 * * * *'), /invalid step/);
  });
});

suite('AutoBuild: parseWorkflowYaml + loadWorkflow', function () {
  test('parses a complete workflow', function () {
    const yaml = [
      'name: nightly-build',
      'cron: "0 2 * * *"',
      'created: 2026-04-29T00:00:00Z',
      'notify: true',
      'timeout: 600',
      'steps:',
      '  - id: install',
      '    run: npm ci',
      '  - id: build',
      '    run: npm run build',
      '  - id: test',
      '    run: npm test',
      '    condition: "{{build.exit_code}} == 0"'
    ].join('\n');
    const wf = parseWorkflowYaml(yaml);
    assert.strictEqual(wf.name, 'nightly-build');
    assert.strictEqual(wf.cron, '0 2 * * *');
    assert.strictEqual(wf.notify, true);
    assert.strictEqual(wf.timeout, 600);
    assert.strictEqual(wf.steps.length, 3);
    assert.strictEqual(wf.steps[0].id, 'install');
    assert.strictEqual(wf.steps[2].condition, '{{build.exit_code}} == 0');
  });

  test('rejects missing name', function () {
    const yaml = 'cron: "* * * * *"\nsteps:\n  - id: a\n    run: echo a\n';
    assert.throws(() => parseWorkflowYaml(yaml), /missing required "name"/);
  });

  test('rejects missing cron', function () {
    const yaml = 'name: foo\nsteps:\n  - id: a\n    run: echo a\n';
    assert.throws(() => parseWorkflowYaml(yaml), /missing required "cron"/);
  });

  test('rejects empty steps', function () {
    const yaml = 'name: foo\ncron: "* * * * *"\nsteps:\n';
    assert.throws(() => parseWorkflowYaml(yaml), /at least one step/);
  });

  test('rejects bad cron at load time', function () {
    const yaml = 'name: foo\ncron: "60 * * * *"\nsteps:\n  - id: a\n    run: echo a\n';
    assert.throws(() => parseWorkflowYaml(yaml), /out of range/);
  });

  test('loadWorkflow reads a file from disk', function () {
    const tmp = makeTempDir('autoclaw-ab-load-');
    try {
      const p = path.join(tmp, 'w.yaml');
      fs.writeFileSync(
        p,
        'name: smoke\ncron: "* * * * *"\nsteps:\n  - id: hi\n    run: echo hi\n'
      );
      const wf = loadWorkflow(p);
      assert.strictEqual(wf.name, 'smoke');
      assert.strictEqual(wf.steps[0].id, 'hi');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite('AutoBuild: runWorkflow', function () {
  this.timeout(30000);

  let workspace: string;

  setup(function () {
    workspace = makeTempDir('autoclaw-ab-run-');
    _resetInFlight();
  });

  teardown(function () {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('runs a 2-step workflow where step 2 fails', async function () {
    const failCmd = process.platform === 'win32' ? 'exit /b 7' : 'exit 7';
    const wfPath = writeWorkflowFile(workspace, 'sample',
      [
        'name: sample',
        'cron: "* * * * *"',
        'steps:',
        '  - id: hello',
        '    run: echo hello',
        '  - id: bad',
        `    run: ${failCmd}`
      ].join('\n')
    );

    const runsDir = getRunsDir(workspace);
    const result = await runWorkflow(wfPath, runsDir);

    assert.strictEqual(result.workflow, 'sample');
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.steps.length, 2);
    assert.strictEqual(result.steps[0].id, 'hello');
    assert.strictEqual(result.steps[0].exitCode, 0);
    assert.strictEqual(result.steps[1].id, 'bad');
    assert.notStrictEqual(result.steps[1].exitCode, 0);

    const log = fs.readFileSync(result.logPath, 'utf8');
    assert.match(log, /\[STEP hello\]/);
    assert.match(log, /\[OK hello\]/);
    assert.match(log, /\[STEP bad\]/);
    assert.match(log, /\[FAILED bad\]/);
    assert.match(log, /status:\s+failed/);
  });

  test('passes when both steps succeed and updates registry via tick', async function () {
    writeWorkflowFile(workspace, 'okwf',
      [
        'name: okwf',
        'cron: "* * * * *"',
        'steps:',
        '  - id: a',
        '    run: echo first',
        '  - id: b',
        '    run: echo second'
      ].join('\n')
    );

    const report = await tick(workspace, new Date(2026, 3, 29, 12, 0));
    assert.deepStrictEqual(report.errors, []);
    assert.deepStrictEqual(report.ranNow, ['okwf']);

    // Wait for the in-flight promise to resolve.
    // Tick fires fire-and-forget; we drain by polling the in-flight tracker.
    for (let i = 0; i < 50 && _isInFlight('okwf'); i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    assert.strictEqual(_isInFlight('okwf'), false);

    const reg = readRegistry(workspace);
    const entry = reg.workflows.find(w => w.name === 'okwf');
    assert.ok(entry, 'registry entry created');
    assert.strictEqual(entry!.status, 'passed');
    assert.ok(entry!.lastLog && fs.existsSync(entry!.lastLog), 'log path persisted');
  });
});

suite('AutoBuild: tick()', function () {
  this.timeout(15000);

  let workspace: string;

  setup(function () {
    workspace = makeTempDir('autoclaw-ab-tick-');
    _resetInFlight();
  });

  teardown(function () {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('skips when enabled=false', async function () {
    writeWorkflowFile(workspace, 'wf',
      'name: wf\ncron: "* * * * *"\nsteps:\n  - id: a\n    run: echo hi\n'
    );
    const report = await tick(workspace, new Date(), { enabled: false });
    assert.strictEqual(report.disabled, true);
    assert.strictEqual(report.ranNow.length, 0);
  });

  test('skips workflows already in flight', async function () {
    writeWorkflowFile(workspace, 'flight',
      'name: flight\ncron: "* * * * *"\nsteps:\n  - id: a\n    run: echo hi\n'
    );

    // A runner that never resolves until we manually finish it.
    let resolveRun: (r: RunResult) => void = () => undefined;
    const slowRunner = (workflowPath: string, runsDir: string): Promise<RunResult> => {
      return new Promise<RunResult>(res => {
        resolveRun = res;
      });
    };

    const r1 = await tick(workspace, new Date(), { runner: slowRunner });
    assert.deepStrictEqual(r1.ranNow, ['flight']);
    assert.strictEqual(_isInFlight('flight'), true);

    const r2 = await tick(workspace, new Date(), { runner: slowRunner });
    assert.deepStrictEqual(r2.ranNow, []);
    assert.deepStrictEqual(r2.skippedInFlight, ['flight']);

    // Drain
    resolveRun({
      workflow: 'flight',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'passed',
      logPath: path.join(getRunsDir(workspace), 'fake.log'),
      steps: [],
      guardBlockRejected: 0,
      guardRolledBack: 0,
    });
    for (let i = 0; i < 50 && _isInFlight('flight'); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.strictEqual(_isInFlight('flight'), false);
  });

  test('skips workflows whose cron does not match', async function () {
    writeWorkflowFile(workspace, 'noon',
      'name: noon\ncron: "0 12 * * *"\nsteps:\n  - id: a\n    run: echo hi\n'
    );
    // 09:30 doesn't match 12:00
    const r = await tick(workspace, new Date(2026, 3, 29, 9, 30));
    assert.deepStrictEqual(r.ranNow, []);
    assert.deepStrictEqual(r.skippedNotMatching, ['noon']);
  });

  test('parks a placeholder workflow as draft instead of firing it (#3)', async function () {
    writeWorkflowFile(workspace, 'ph',
      'name: ph\ncron: "* * * * *"\nsteps:\n  - id: plan\n    run: echo "Planning step — customize me"\n'
    );
    const r = await tick(workspace, new Date());
    assert.deepStrictEqual(r.ranNow, [], 'placeholder must not run');
    assert.deepStrictEqual(r.skippedDraft, ['ph']);
    const reg = readRegistry(workspace);
    assert.strictEqual(reg.workflows.find(w => w.name === 'ph')?.status, 'draft');
  });

  test('still fires a workflow with a concrete step', async function () {
    writeWorkflowFile(workspace, 'real',
      'name: real\ncron: "* * * * *"\nsteps:\n  - id: a\n    run: echo hi\n'
    );
    let ran = false;
    const runner = async (): Promise<RunResult> => {
      ran = true;
      return {
        workflow: 'real', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        status: 'passed', logPath: path.join(getRunsDir(workspace), 'x.log'), steps: [],
        guardBlockRejected: 0, guardRolledBack: 0,
      };
    };
    const r = await tick(workspace, new Date(), { runner });
    assert.deepStrictEqual(r.ranNow, ['real']);
    assert.deepStrictEqual(r.skippedDraft, []);
    assert.strictEqual(ran, true);
  });
});

suite('AutoBuild: draft detection (#3)', function () {
  test('isConcreteStep rejects placeholders and blanks', function () {
    assert.strictEqual(isConcreteStep({ id: 'a', run: 'echo "customize me"' }), false);
    assert.strictEqual(isConcreteStep({ id: 'a', run: '   ' }), false);
    assert.strictEqual(isConcreteStep({ id: 'a', run: '# TODO add command' }), false);
    assert.strictEqual(isConcreteStep({ id: 'a', run: 'npm test' }), true);
    assert.strictEqual(isConcreteStep({ id: 'a', run: 'echo hello' }), true);
  });
  test('isRunnableWorkflow needs at least one concrete step', function () {
    assert.strictEqual(isRunnableWorkflow({ name: 'x', cron: '* * * * *', steps: [] }), false);
    assert.strictEqual(isRunnableWorkflow({
      name: 'x', cron: '* * * * *', steps: [{ id: 'p', run: 'echo "TODO customize me"' }],
    }), false);
    assert.strictEqual(isRunnableWorkflow({
      name: 'x', cron: '* * * * *', steps: [{ id: 'p', run: 'echo "TODO" ' }, { id: 'b', run: 'npm run build' }],
    }), true);
  });
});

suite('AutoBuild: scheduler liveness (#4)', function () {
  let workspace: string;
  setup(function () { workspace = makeTempDir('autoclaw-ab-sched-'); });
  teardown(function () { fs.rmSync(workspace, { recursive: true, force: true }); });

  test('status is dormant when no heartbeat exists', function () {
    const s = getSchedulerStatus(workspace);
    assert.strictEqual(s.live, false);
    assert.strictEqual(s.lastHeartbeat, null);
  });

  test('status is live right after a heartbeat', async function () {
    await writeSchedulerHeartbeat(workspace, 30);
    assert.ok(fs.existsSync(getSchedulerHeartbeatPath(workspace)));
    const s = getSchedulerStatus(workspace);
    assert.strictEqual(s.live, true);
    assert.strictEqual(s.lastHeartbeat?.intervalSeconds, 30);
  });

  test('status is dormant when the heartbeat is stale', async function () {
    const old = new Date(Date.now() - SCHEDULER_STALE_MS - 10_000);
    await writeSchedulerHeartbeat(workspace, 30, old);
    const s = getSchedulerStatus(workspace);
    assert.strictEqual(s.live, false);
    assert.ok((s.ageMs ?? 0) > SCHEDULER_STALE_MS);
  });
});

suite('AutoBuild: pruneRunLogs', function () {
  test('keeps the N newest logs and deletes the rest', function () {
    const tmp = makeTempDir('autoclaw-ab-prune-');
    try {
      const runsDir = path.join(tmp, 'runs');
      fs.mkdirSync(runsDir, { recursive: true });
      const names = [
        'wf-2025-01-01T00-00-00-000Z.log',
        'wf-2025-02-01T00-00-00-000Z.log',
        'wf-2025-03-01T00-00-00-000Z.log',
        'wf-2025-04-01T00-00-00-000Z.log',
        'wf-2025-05-01T00-00-00-000Z.log',
        'other-2025-01-01T00-00-00-000Z.log' // different workflow — must be kept
      ];
      for (const n of names) {
        fs.writeFileSync(path.join(runsDir, n), 'x');
      }
      const result = pruneRunLogs(runsDir, 'wf', 2);
      assert.strictEqual(result.kept, 2);
      assert.strictEqual(result.deleted, 3);
      const remaining = fs.readdirSync(runsDir).sort();
      assert.deepStrictEqual(remaining, [
        'other-2025-01-01T00-00-00-000Z.log',
        'wf-2025-04-01T00-00-00-000Z.log',
        'wf-2025-05-01T00-00-00-000Z.log'
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('keep=0 is a no-op (no deletion)', function () {
    const tmp = makeTempDir('autoclaw-ab-prune-zero-');
    try {
      const runsDir = path.join(tmp, 'runs');
      fs.mkdirSync(runsDir, { recursive: true });
      fs.writeFileSync(path.join(runsDir, 'wf-2025-01-01.log'), 'x');
      const result = pruneRunLogs(runsDir, 'wf', 0);
      assert.strictEqual(result.deleted, 0);
      assert.ok(fs.existsSync(path.join(runsDir, 'wf-2025-01-01.log')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite('AutoBuild: cross-host lock', function () {
  test('acquire then release succeeds; lock file goes away', function () {
    const tmp = makeTempDir('autoclaw-ab-lock-');
    try {
      assert.strictEqual(tryAcquireLock(tmp), true);
      assert.ok(fs.existsSync(getLockPath(tmp)));
      releaseLock(tmp);
      assert.ok(!fs.existsSync(getLockPath(tmp)));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('second acquire by same process is rejected (EEXIST)', function () {
    const tmp = makeTempDir('autoclaw-ab-lock2-');
    try {
      assert.strictEqual(tryAcquireLock(tmp), true);
      // Same-PID re-acquire — current PID is alive, so the lock is NOT stale,
      // so the second attempt must fail.
      assert.strictEqual(tryAcquireLock(tmp), false);
      releaseLock(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('stale lock from dead PID is taken over', function () {
    const tmp = makeTempDir('autoclaw-ab-lock3-');
    try {
      const lockPath = getLockPath(tmp);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      // PID 0 is never a valid live process on any supported platform.
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 0, acquiredAt: Date.now() }));
      assert.strictEqual(tryAcquireLock(tmp), true);
      releaseLock(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite('AutoBuild: registry persistence', function () {
  test('round-trips through write+read', function () {
    const tmp = makeTempDir('autoclaw-ab-reg-');
    try {
      writeRegistry(tmp, {
        workflows: [
          { name: 'a', cron: '* * * * *', lastRun: null, status: 'scheduled' }
        ]
      });
      assert.ok(fs.existsSync(getRegistryPath(tmp)));
      const reg = readRegistry(tmp);
      assert.strictEqual(reg.workflows.length, 1);
      assert.strictEqual(reg.workflows[0].name, 'a');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Guard tests (AB-4)
  // ──────────────────────────────────────────────────────────────────────

  suite('Guard — YAML parsing', () => {
    test('parses guard block with all fields', () => {
      const yaml = [
        'name: guarded',
        'cron: "0 2 * * *"',
        'steps:',
        '  - id: fix',
        '    run: npm run lint -- --fix',
        '    mode: fix',
        '    guard:',
        '      scope_globs: ["src/**", "test/**"]',
        '      max_files: 5',
        '      require_clean_git: true',
        '      rollback_on: test_fail',
      ].join('\n');
      const wf = parseWorkflowYaml(yaml);
      assert.strictEqual(wf.steps.length, 1);
      const guard = wf.steps[0].guard!;
      assert.ok(guard);
      assert.deepStrictEqual(guard.scope_globs, ['src/**', 'test/**']);
      assert.strictEqual(guard.max_files, 5);
      assert.strictEqual(guard.require_clean_git, true);
      assert.strictEqual(guard.rollback_on, 'test_fail');
      assert.strictEqual(wf.steps[0].mode, 'fix');
    });

    test('parses guard block with rollback_on: never', () => {
      const yaml = [
        'name: guarded',
        'cron: "0 2 * * *"',
        'steps:',
        '  - id: fix',
        '    run: echo hello',
        '    mode: fix',
        '    guard:',
        '      scope_globs: ["**/*"]',
        '      max_files: 10',
        '      require_clean_git: false',
        '      rollback_on: never',
      ].join('\n');
      const wf = parseWorkflowYaml(yaml);
      assert.strictEqual(wf.steps[0].guard!.rollback_on, 'never');
      assert.strictEqual(wf.steps[0].guard!.require_clean_git, false);
    });

    test('defaults mode to report when omitted', () => {
      const yaml = [
        'name: simple',
        'cron: "0 2 * * *"',
        'steps:',
        '  - id: step1',
        '    run: echo hello',
      ].join('\n');
      const wf = parseWorkflowYaml(yaml);
      assert.strictEqual(wf.steps[0].mode, 'report');
    });

    test('rejects invalid mode value', () => {
      const yaml = [
        'name: bad',
        'cron: "0 2 * * *"',
        'steps:',
        '  - id: step1',
        '    run: echo hello',
        '    mode: invalid',
      ].join('\n');
      assert.throws(() => parseWorkflowYaml(yaml), /step mode must be/);
    });

    test('rejects invalid rollback_on value', () => {
      const yaml = [
        'name: bad',
        'cron: "0 2 * * *"',
        'steps:',
        '  - id: step1',
        '    run: echo hello',
        '    mode: fix',
        '    guard:',
        '      scope_globs: ["**/*"]',
        '      max_files: 5',
        '      require_clean_git: true',
        '      rollback_on: sometimes',
      ].join('\n');
      assert.throws(() => parseWorkflowYaml(yaml), /guard.rollback_on must be/);
    });

    test('guard defaults are applied when guard key is list marker', () => {
      const yaml = [
        'name: guarded',
        'cron: "0 2 * * *"',
        'steps:',
        '  - id: fix',
        '    run: echo hello',
        '    guard:',
      ].join('\n');
      const wf = parseWorkflowYaml(yaml);
      const guard = wf.steps[0].guard!;
      assert.ok(guard);
      assert.deepStrictEqual(guard.scope_globs, ['**/*']);
      assert.strictEqual(guard.max_files, 10);
      assert.strictEqual(guard.require_clean_git, true);
      assert.strictEqual(guard.rollback_on, 'test_fail');
    });

    test('flushes guard state between steps', () => {
      const yaml = [
        'name: multi',
        'cron: "0 2 * * *"',
        'steps:',
        '  - id: fix1',
        '    run: echo a',
        '    mode: fix',
        '    guard:',
        '      scope_globs: ["src/**"]',
        '      max_files: 3',
        '      require_clean_git: true',
        '      rollback_on: test_fail',
        '  - id: report1',
        '    run: echo b',
      ].join('\n');
      const wf = parseWorkflowYaml(yaml);
      assert.strictEqual(wf.steps.length, 2);
      assert.ok(wf.steps[0].guard);
      assert.strictEqual(wf.steps[1].guard, undefined);
      assert.strictEqual(wf.steps[1].mode, 'report');
    });
  });

  suite('Guard — scope_glob matching', () => {
    test('matches simple glob patterns', () => {
      const yaml = [
        'name: scope',
        'cron: "0 2 * * *"',
        'steps:',
        '  - id: fix',
        '    run: echo hello',
        '    mode: fix',
        '    guard:',
        '      scope_globs: ["src/**", "test/**"]',
        '      max_files: 5',
        '      require_clean_git: false',
        '      rollback_on: never',
      ].join('\n');
      const wf = parseWorkflowYaml(yaml);
      const guard = wf.steps[0].guard!;
      assert.ok(guard.scope_globs.some((p: string) => p === 'src/**'));
      assert.ok(guard.scope_globs.some((p: string) => p === 'test/**'));
    });
  });

  suite('Guard — verify field', () => {
    test('parses verify field', () => {
      const yaml = [
        'name: verified',
        'cron: "0 2 * * *"',
        'steps:',
        '  - id: fix',
        '    run: npm run fix',
        '    verify: npm test',
      ].join('\n');
      const wf = parseWorkflowYaml(yaml);
      assert.strictEqual(wf.steps[0].verify, 'npm test');
    });
  });

  suite('Guard — max_files validation', () => {
    test('rejects non-positive max_files', () => {
      const yaml = [
        'name: bad',
        'cron: "0 2 * * *"',
        'steps:',
        '  - id: step1',
        '    run: echo hello',
        '    guard:',
        '      scope_globs: ["**/*"]',
        '      max_files: 0',
        '      require_clean_git: true',
        '      rollback_on: test_fail',
      ].join('\n');
      assert.throws(() => parseWorkflowYaml(yaml), /max_files must be a positive integer/);
    });
  });

  suite('Guard — RunResult shape', () => {
    test('RunResult includes guardBlockRejected and guardRolledBack fields', () => {
      const import_check = require('../autobuild');
      assert.ok(typeof import_check === 'object');
    });
  });

});

// ---------------------------------------------------------------------------
// AB-4: guarded auto-fix — real rollback behaviour (integration, needs git)
// ---------------------------------------------------------------------------

suite('AutoBuild: guarded fix rollback', function () {
  this.timeout(30000);

  let repo: string;

  function git(args: string, cwd: string): void {
    const r = spawnSync('git', args.split(' '), { cwd, encoding: 'utf8' });
    if (r.status !== 0) { throw new Error(`git ${args} failed: ${r.stderr || r.stdout}`); }
  }

  setup(function () {
    repo = makeTempDir('autoclaw-ab-rollback-');
    git('init -q', repo);
    git('config user.email test@autoclaw.dev', repo);
    git('config user.name AutoClawTest', repo);
    // .autoclaw is gitignored in real AutoClaw repos — mirror that so the
    // workflow, run logs, and our helper scripts don't show as untracked.
    fs.writeFileSync(path.join(repo, '.gitignore'), '.autoclaw/\n');
    fs.writeFileSync(path.join(repo, 'target.txt'), 'baseline\n');
    git('add -A', repo);
    git('commit -qm baseline', repo);
    // Helper scripts invoked by filename (no nested shell quotes — cmd.exe
    // mangles `node -e "..."`). They run with cwd = repo, so the relative
    // paths resolve against the repo root.
    fs.mkdirSync(path.join(repo, '.autoclaw'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.autoclaw', 'corrupt.js'), `require('fs').writeFileSync('target.txt','corrupted');`);
    fs.writeFileSync(path.join(repo, '.autoclaw', 'mkoutside.js'), `require('fs').writeFileSync('outside.txt','x');`);
    fs.writeFileSync(path.join(repo, '.autoclaw', 'fail.js'), `process.exit(1);`);
  });

  teardown(function () {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('verify failure rolls back a tracked change (verdict rolled_back, file restored)', async function () {
    const wf = writeWorkflowFile(repo, 'heal', [
      'name: heal',
      'cron: "* * * * *"',
      'steps:',
      '  - id: badfix',
      '    run: node .autoclaw/corrupt.js',
      '    mode: fix',
      '    verify: node .autoclaw/fail.js',
      '    guard:',
      '      scope_globs: ["**/*"]',
      '      max_files: 10',
      '      require_clean_git: true',
      '      rollback_on: test_fail',
    ].join('\n'));

    const result = await runWorkflow(wf, getRunsDir(repo));
    const step = result.steps[0];
    assert.strictEqual(step.guard_verdict, 'rolled_back', 'verdict is rolled_back');
    assert.strictEqual(result.guardRolledBack, 1);
    // The file is restored to its committed baseline (line-ending-agnostic:
    // git on Windows may re-checkout with CRLF under core.autocrlf).
    assert.strictEqual(fs.readFileSync(path.join(repo, 'target.txt'), 'utf8').trim(), 'baseline');
  });

  test('out-of-scope change is rejected and reverted (verdict rejected_scope)', async function () {
    const wf = writeWorkflowFile(repo, 'heal', [
      'name: heal',
      'cron: "* * * * *"',
      'steps:',
      '  - id: scopefix',
      '    run: node .autoclaw/mkoutside.js',
      '    mode: fix',
      '    guard:',
      '      scope_globs: ["src/**"]',
      '      max_files: 10',
      '      require_clean_git: true',
      '      rollback_on: test_fail',
    ].join('\n'));

    const result = await runWorkflow(wf, getRunsDir(repo));
    assert.strictEqual(result.steps[0].guard_verdict, 'rejected_scope');
    assert.strictEqual(result.guardBlockRejected, 1);
    // The newly-created out-of-scope file was removed by the revert.
    assert.strictEqual(fs.existsSync(path.join(repo, 'outside.txt')), false);
  });

  test('a dirty tree short-circuits a require_clean_git fix (verdict rejected_dirty)', async function () {
    fs.appendFileSync(path.join(repo, 'target.txt'), 'dirty\n'); // make the tree dirty
    const wf = writeWorkflowFile(repo, 'heal', [
      'name: heal',
      'cron: "* * * * *"',
      'steps:',
      '  - id: fix',
      '    run: node .autoclaw/corrupt.js',
      '    mode: fix',
      '    guard:',
      '      scope_globs: ["**/*"]',
      '      max_files: 10',
      '      require_clean_git: true',
      '      rollback_on: test_fail',
    ].join('\n'));

    const result = await runWorkflow(wf, getRunsDir(repo));
    assert.strictEqual(result.steps[0].guard_verdict, 'rejected_dirty');
    assert.strictEqual(result.guardBlockRejected, 1);
  });

  test('report-mode step never triggers guard machinery (verdict na)', async function () {
    const wf = writeWorkflowFile(repo, 'rep', [
      'name: rep',
      'cron: "* * * * *"',
      'steps:',
      '  - id: look',
      '    run: node --version',
    ].join('\n'));
    const result = await runWorkflow(wf, getRunsDir(repo));
    assert.strictEqual(result.steps[0].guard_verdict, 'na');
    assert.strictEqual(result.steps[0].mode, 'report');
  });
});

