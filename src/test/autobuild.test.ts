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
      steps: []
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
});
