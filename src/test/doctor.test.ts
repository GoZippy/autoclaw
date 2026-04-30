/**
 * AutoClaw Doctor Tests
 *
 * Exercises `runDoctor` and section-builders against ephemeral temp
 * workspaces. No real `vscode` host is required — we inject a synthetic
 * shim. Network calls are unavoidable for the ZMLR section, but
 * `checkZippyMeshHealth` already handles unreachable hosts by returning a
 * `warning` status, so we just point it at a guaranteed-dead port.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  runDoctor,
  buildMemorySection,
  buildAdapterDriftSection,
  buildAdapterInstallationSection,
  buildSkillsSourceSection,
  buildAutobuildSection,
  renderReport
} from '../doctor';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ZMLR base URL guaranteed to fail fast — `checkZippyMeshHealth` handles
// unreachable hosts gracefully and returns a `warning` AdapterHealth.
const DEAD_ZMLR_URL = 'http://127.0.0.1:1';

suite('Doctor: runDoctor()', function () {
  this.timeout(20000);

  let workspace: string;
  let extensionPath: string;

  setup(function () {
    workspace = makeTempDir('autoclaw-doc-ws-');
    extensionPath = makeTempDir('autoclaw-doc-ext-');
  });

  teardown(function () {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(extensionPath, { recursive: true, force: true });
  });

  test('returns the expected sections for an empty workspace', async function () {
    const report = await runDoctor(extensionPath, {
      workspaceRoot: workspace,
      isExtensionInstalled: () => false,
      isAntigravityHost: false,
      zippymeshUrl: DEAD_ZMLR_URL
    });

    assert.ok(report.generatedAt, 'has generatedAt');
    assert.strictEqual(report.workspace.workspaceRoot, workspace);
    assert.strictEqual(report.workspace.autoclawDirExists, false);
    assert.strictEqual(report.kdreamState.initialised, false);
    assert.strictEqual(report.memory.present, false);
    assert.strictEqual(report.logs.todayLogPresent, false);
    assert.ok(Array.isArray(report.adapterInstallation.hosts));
    assert.ok(report.adapterInstallation.hosts.length >= 8,
      'covers all 8 known hosts');
    assert.strictEqual(report.zmlr.name, 'ZippyMesh LLM Router');
    assert.ok(report.skillsSource.skills.length === 3,
      'reports kdream/autobuild/mateam');
  });

  test('reads state.json fields when initialised', async function () {
    const stateDir = path.join(workspace, '.autoclaw', 'kdream');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        status: 'running',
        tick: 42,
        started: '2026-04-29T10:00:00Z',
        lastDream: '2026-04-29T11:30:00Z'
      })
    );

    const report = await runDoctor(extensionPath, {
      workspaceRoot: workspace,
      isExtensionInstalled: () => false,
      zippymeshUrl: DEAD_ZMLR_URL
    });

    assert.strictEqual(report.kdreamState.initialised, true);
    assert.strictEqual(report.kdreamState.status, 'running');
    assert.strictEqual(report.kdreamState.tick, 42);
    assert.strictEqual(report.kdreamState.lastDream, '2026-04-29T11:30:00Z');
  });
});

suite('Doctor: buildMemorySection()', function () {
  let workspace: string;

  setup(function () {
    workspace = makeTempDir('autoclaw-doc-mem-');
  });

  teardown(function () {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('counts open vs done follow-ups and detects sections', function () {
    const memDir = path.join(workspace, '.autoclaw', 'kdream', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(
      path.join(memDir, 'MEMORY.md'),
      [
        '# KDream Memory',
        '',
        '## Follow-ups',
        '',
        '- [ ] open one',
        '- [ ] open two',
        '- [x] done one',
        '- [X] done two (capital)',
        '- [ ] open three',
        '',
        '## Facts',
        '',
        '- repo uses TypeScript',
        ''
      ].join('\n')
    );

    const m = buildMemorySection(workspace);
    assert.strictEqual(m.present, true);
    assert.strictEqual(m.openFollowups, 3, 'three [ ] entries');
    assert.strictEqual(m.doneFollowups, 2, 'two [x]/[X] entries');
    assert.strictEqual(m.hasFollowupsSection, true);
    assert.strictEqual(m.hasFactsSection, true);
    assert.strictEqual(m.hasObservationsSection, false);
    assert.ok(m.lineCount > 5);
  });

  test('returns present=false when MEMORY.md is missing', function () {
    const m = buildMemorySection(workspace);
    assert.strictEqual(m.present, false);
    assert.strictEqual(m.openFollowups, 0);
    assert.strictEqual(m.doneFollowups, 0);
  });
});

suite('Doctor: buildAdapterDriftSection()', function () {
  test("reports 'skipped' when out/scripts/check-adapters.js is missing", function () {
    const empty = makeTempDir('autoclaw-doc-drift-empty-');
    try {
      const section = buildAdapterDriftSection(empty);
      assert.strictEqual(section.status, 'skipped');
      assert.strictEqual(section.exitCode, null);
      assert.match(
        section.message,
        /adapters:compile/,
        'mentions the compile step in the message'
      );
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

suite('Doctor: buildAdapterInstallationSection()', function () {
  let workspace: string;

  setup(function () {
    workspace = makeTempDir('autoclaw-doc-install-');
  });

  teardown(function () {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('marks claude-code destination present when ~/.claude/skills/* exist', function () {
    // We don't write into the real $HOME — just verify the host shape
    // and that workspace-relative hosts compute their destinations.
    const section = buildAdapterInstallationSection({
      workspaceRoot: workspace,
      isExtensionInstalled: (id: string) => id === 'kilocode.kilo-code'
    });
    const hosts = new Set(section.hosts.map(h => h.host));
    for (const expected of [
      'claude-code',
      'kilocode',
      'cline',
      'cursor',
      'antigravity',
      'windsurf',
      'kiro',
      'continue'
    ]) {
      assert.ok(hosts.has(expected), `missing host: ${expected}`);
    }
    const kilo = section.hosts.find(h => h.host === 'kilocode')!;
    assert.strictEqual(kilo.extensionInstalled, true);
    const cline = section.hosts.find(h => h.host === 'cline')!;
    assert.strictEqual(cline.extensionInstalled, false);
    // Workspace-relative destinations should have been computed.
    assert.ok(cline.destination.includes('.clinerules'));
  });
});

suite('Doctor: buildAutobuildSection()', function () {
  let workspace: string;

  setup(function () {
    workspace = makeTempDir('autoclaw-doc-ab-');
  });

  teardown(function () {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('lists scheduled workflows and surfaces last-run status', function () {
    const wfDir = path.join(workspace, '.autoclaw', 'autobuild', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(
      path.join(wfDir, 'nightly.yaml'),
      'name: nightly\ncron: "0 2 * * *"\nsteps:\n  - id: build\n    run: echo build\n'
    );
    const regPath = path.join(workspace, '.autoclaw', 'autobuild', 'registry.json');
    fs.writeFileSync(
      regPath,
      JSON.stringify({
        workflows: [
          {
            name: 'nightly',
            cron: '0 2 * * *',
            lastRun: '2026-04-29T02:00:00.000Z',
            status: 'passed',
            lastLog: '/tmp/nightly.log'
          }
        ]
      })
    );

    const section = buildAutobuildSection(workspace);
    assert.strictEqual(section.workflowCount, 1);
    assert.strictEqual(section.registryPresent, true);
    assert.strictEqual(section.workflows.length, 1);
    const wf = section.workflows[0];
    assert.strictEqual(wf.name, 'nightly');
    assert.strictEqual(wf.cronValid, true);
    assert.strictEqual(wf.status, 'passed');
    assert.strictEqual(wf.workflowPresent, true);
  });

  test('returns empty section when no workspace is open', function () {
    const section = buildAutobuildSection(null);
    assert.strictEqual(section.workflowCount, 0);
    assert.strictEqual(section.workflows.length, 0);
  });

  test('renderReport includes the AutoBuild section header', async function () {
    const wfDir = path.join(workspace, '.autoclaw', 'autobuild', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(
      path.join(wfDir, 'wf.yaml'),
      'name: wf\ncron: "* * * * *"\nsteps:\n  - id: a\n    run: echo a\n'
    );
    const report = await runDoctor(makeTempDir('autoclaw-doc-ab-ext-'), {
      workspaceRoot: workspace,
      isExtensionInstalled: () => false,
      zippymeshUrl: 'http://127.0.0.1:1'
    });
    const text = renderReport(report);
    assert.match(text, /## AutoBuild/);
    assert.match(text, /workflow files:\s+1/);
    assert.match(text, /- wf:/);
  });
});

suite('Doctor: buildSkillsSourceSection()', function () {
  test('flags skills as missing when extensionPath has no skills/', function () {
    const empty = makeTempDir('autoclaw-doc-skills-empty-');
    try {
      const section = buildSkillsSourceSection(empty);
      assert.strictEqual(section.allPresent, false);
      assert.strictEqual(section.skills.length, 3);
      assert.ok(section.skills.every(s => !s.present));
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('detects skills present when SKILL.md files exist', function () {
    const ext = makeTempDir('autoclaw-doc-skills-full-');
    try {
      for (const name of ['kdream', 'autobuild', 'mateam']) {
        const dir = path.join(ext, 'skills', name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), '# stub\n');
      }
      const section = buildSkillsSourceSection(ext);
      assert.strictEqual(section.allPresent, true);
    } finally {
      fs.rmSync(ext, { recursive: true, force: true });
    }
  });
});
