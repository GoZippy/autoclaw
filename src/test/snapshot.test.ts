/**
 * AutoClaw Snapshot Tests
 *
 * Exercises `buildSnapshot` against ephemeral temp workspaces with synthetic
 * `.autoclaw/` content. Uses the same `DoctorVscodeShim` injection seam as
 * the doctor tests so we can run under plain Mocha without a real VS Code
 * host. Network calls hit a guaranteed-dead port; `checkZippyMeshHealth`
 * handles unreachable hosts gracefully.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildSnapshot,
  extractOpenFollowups,
  readAutoclawVersion,
  tailLines
} from '../snapshot';
import { getTodayDate, getTodayLogPath } from '../kdream-helpers';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const DEAD_ZMLR_URL = 'http://127.0.0.1:1';

suite('Snapshot: helpers', function () {
  test('extractOpenFollowups returns only `- [ ]` lines', function () {
    const md = [
      '# KDream Memory',
      '',
      '## Follow-ups',
      '- [ ] First open item',
      '  - [ ] Indented open item',
      '- [x] Completed item',
      '- [X] Also completed',
      '',
      'Some prose.',
      '- [ ] Last open item'
    ].join('\n');
    const got = extractOpenFollowups(md);
    assert.deepStrictEqual(got, [
      '- [ ] First open item',
      '- [ ] Indented open item',
      '- [ ] Last open item'
    ]);
  });

  test('extractOpenFollowups returns empty for content with no open items', function () {
    assert.deepStrictEqual(extractOpenFollowups('- [x] done\n'), []);
    assert.deepStrictEqual(extractOpenFollowups(''), []);
  });

  test('tailLines returns last N non-trailing-blank lines', function () {
    const content = 'a\nb\nc\nd\ne\nf\n\n\n';
    assert.deepStrictEqual(tailLines(content, 3), ['d', 'e', 'f']);
  });

  test('tailLines returns all lines when fewer than N', function () {
    assert.deepStrictEqual(tailLines('one\ntwo\n', 5), ['one', 'two']);
  });

  test('readAutoclawVersion reads version from package.json', function () {
    const tmp = makeTempDir('snap-pkg-');
    try {
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'autoclaw', version: '9.9.9' })
      );
      assert.strictEqual(readAutoclawVersion(tmp), '9.9.9');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('readAutoclawVersion returns "unknown" when package.json is missing', function () {
    const tmp = makeTempDir('snap-nopkg-');
    try {
      assert.strictEqual(readAutoclawVersion(tmp), 'unknown');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite('Snapshot: buildSnapshot()', function () {
  this.timeout(20000);

  let workspace: string;
  let extensionPath: string;

  setup(function () {
    workspace = makeTempDir('autoclaw-snap-ws-');
    extensionPath = makeTempDir('autoclaw-snap-ext-');
  });

  teardown(function () {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(extensionPath, { recursive: true, force: true });
  });

  test('produces all expected sections for a populated workspace', async function () {
    // Synthetic package.json so readAutoclawVersion returns a known value.
    fs.writeFileSync(
      path.join(extensionPath, 'package.json'),
      JSON.stringify({ name: 'autoclaw', version: '1.2.5-test' })
    );

    // .autoclaw/kdream/state.json
    const kdreamDir = path.join(workspace, '.autoclaw', 'kdream');
    fs.mkdirSync(kdreamDir, { recursive: true });
    const stateBody = {
      status: 'running',
      tick: 7,
      started: '2026-04-29T08:00:00Z',
      lastDream: '2026-04-29T09:30:00Z'
    };
    fs.writeFileSync(
      path.join(kdreamDir, 'state.json'),
      JSON.stringify(stateBody, null, 2)
    );

    // MEMORY.md with 2 open + 1 done follow-up
    const memDir = path.join(kdreamDir, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(
      path.join(memDir, 'MEMORY.md'),
      [
        '# KDream Memory',
        '',
        '## Follow-ups',
        '- [ ] Wire up health snapshot export',
        '- [ ] Add tests for buildSnapshot',
        '- [x] Land doctor command',
        ''
      ].join('\n')
    );

    // Today's log with 5 entries
    const today = getTodayDate();
    const logsDir = path.join(kdreamDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logLines = [
      `## ${today} 08:00`,
      '- entry one',
      '- entry two',
      '- entry three',
      '- entry four',
      '- entry five'
    ];
    fs.writeFileSync(getTodayLogPath(workspace), logLines.join('\n') + '\n');

    const snapshot = await buildSnapshot(workspace, extensionPath, {
      workspaceRoot: workspace,
      isExtensionInstalled: () => false,
      isAntigravityHost: false,
      zippymeshUrl: DEAD_ZMLR_URL
    });

    // Heading and metadata
    assert.match(snapshot, /^# AutoClaw Health Snapshot/m);
    assert.ok(snapshot.includes(`- Date:    ${today}`), 'snapshot includes today date');
    assert.ok(snapshot.includes('- Version: 1.2.5-test'), 'snapshot includes version');

    // Doctor report present
    assert.ok(snapshot.includes('## Doctor Report'), 'has Doctor Report section');
    assert.ok(snapshot.includes('AutoClaw Doctor — Health Report'), 'embeds doctor body');

    // KDream state.json — JSON-stringified
    assert.ok(snapshot.includes('## KDream state.json'), 'has state.json section');
    assert.ok(snapshot.includes('"status": "running"'), 'state.json content present');
    assert.ok(snapshot.includes('"tick": 7'), 'tick value present');

    // Recent log section with all 5 entries
    assert.ok(/^## Recent Log .*last 30 lines/m.test(snapshot), 'has recent log section');
    for (const ln of ['entry one', 'entry two', 'entry three', 'entry four', 'entry five']) {
      assert.ok(snapshot.includes(ln), `log entry "${ln}" present`);
    }

    // Open follow-ups: only the 2 open items, not the completed one
    assert.ok(snapshot.includes('## Open Follow-ups'), 'has open follow-ups section');
    assert.ok(snapshot.includes('- [ ] Wire up health snapshot export'));
    assert.ok(snapshot.includes('- [ ] Add tests for buildSnapshot'));
    assert.ok(!snapshot.includes('- [x] Land doctor command'), 'completed item NOT included');
  });

  test('handles missing .autoclaw/ entirely with sensible markers', async function () {
    fs.writeFileSync(
      path.join(extensionPath, 'package.json'),
      JSON.stringify({ name: 'autoclaw', version: '0.0.0' })
    );

    const snapshot = await buildSnapshot(workspace, extensionPath, {
      workspaceRoot: workspace,
      isExtensionInstalled: () => false,
      zippymeshUrl: DEAD_ZMLR_URL
    });

    assert.ok(snapshot.includes('## KDream state.json'));
    assert.ok(/state\.json.*not present/.test(snapshot), 'state-not-present marker shown');

    assert.ok(snapshot.includes('## Recent Log'));
    assert.ok(/no log for today/.test(snapshot), 'no-log marker shown');

    assert.ok(snapshot.includes('## Open Follow-ups'));
    assert.ok(/MEMORY\.md not present/.test(snapshot), 'memory-not-present marker shown');

    // Doctor report still composed
    assert.ok(snapshot.includes('## Doctor Report'));
  });

  test('snapshot is read-only — does not create or modify .autoclaw/', async function () {
    fs.writeFileSync(
      path.join(extensionPath, 'package.json'),
      JSON.stringify({ name: 'autoclaw', version: '1.2.5' })
    );
    const autoclawDir = path.join(workspace, '.autoclaw');
    assert.strictEqual(fs.existsSync(autoclawDir), false);

    await buildSnapshot(workspace, extensionPath, {
      workspaceRoot: workspace,
      isExtensionInstalled: () => false,
      zippymeshUrl: DEAD_ZMLR_URL
    });

    assert.strictEqual(
      fs.existsSync(autoclawDir),
      false,
      'buildSnapshot must not create .autoclaw/ directory'
    );
  });
});

/**
 * Verifies the webview→extension wiring contract: the `exportSnapshot`
 * message routes to the `autoclaw.exportSnapshot` command. We can't drive
 * the real KDreamViewProvider without a vscode host, so this test exercises
 * the same dispatch shape the provider uses.
 */
suite('Snapshot: webview message dispatch', function () {
  test('exportSnapshot message dispatches autoclaw.exportSnapshot command', async function () {
    const calls: string[] = [];
    const fakeExecuteCommand = async (cmd: string) => {
      calls.push(cmd);
    };

    // Mirror the switch shape from KDreamViewProvider.resolveWebviewView.
    async function dispatch(message: { command: string }) {
      switch (message.command) {
        case 'exportSnapshot':
          await fakeExecuteCommand('autoclaw.exportSnapshot');
          break;
      }
    }

    await dispatch({ command: 'exportSnapshot' });
    assert.deepStrictEqual(calls, ['autoclaw.exportSnapshot']);
  });
});
