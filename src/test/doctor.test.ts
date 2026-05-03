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
  buildCompilationSection,
  buildAdapterSchemaSection,
  buildGitHealthSection,
  renderReport,
  renderReportJson
} from '../doctor';
import { spawnSync } from 'child_process';

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

suite('Doctor: buildCompilationSection()', function () {
  let ext: string;

  setup(function () {
    ext = makeTempDir('autoclaw-doc-comp-');
  });
  teardown(function () {
    fs.rmSync(ext, { recursive: true, force: true });
  });

  test('reports out/ missing when only src/ exists', function () {
    const srcDir = path.join(ext, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'extension.ts'), 'export {};');
    const section = buildCompilationSection(ext);
    assert.strictEqual(section.outDirPresent, false);
    assert.strictEqual(section.stale, true);
    assert.match(section.message, /out\//);
  });

  test('reports stale when src/ is newer than out/', async function () {
    const srcDir = path.join(ext, 'src');
    const outDir = path.join(ext, 'out');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'extension.js'), 'module.exports={};');
    // Backdate the out/ file by 10 seconds, then write src/.
    const past = (Date.now() - 10_000) / 1000;
    fs.utimesSync(path.join(outDir, 'extension.js'), past, past);
    fs.writeFileSync(path.join(srcDir, 'extension.ts'), 'export {};');
    const section = buildCompilationSection(ext);
    assert.strictEqual(section.outDirPresent, true);
    assert.strictEqual(section.extensionJsPresent, true);
    assert.strictEqual(section.stale, true);
    assert.ok(section.staleFiles.length > 0);
  });

  test('reports up-to-date when out/ is newer than src/', function () {
    const srcDir = path.join(ext, 'src');
    const outDir = path.join(ext, 'out');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'extension.ts'), 'export {};');
    // Backdate src/ first, then write the newer out/extension.js.
    const past = (Date.now() - 10_000) / 1000;
    fs.utimesSync(path.join(srcDir, 'extension.ts'), past, past);
    fs.writeFileSync(path.join(outDir, 'extension.js'), 'module.exports={};');
    const section = buildCompilationSection(ext);
    assert.strictEqual(section.stale, false);
    assert.strictEqual(section.staleFiles.length, 0);
  });
});

suite('Doctor: buildAdapterSchemaSection()', function () {
  let ext: string;
  setup(function () { ext = makeTempDir('autoclaw-doc-sch-'); });
  teardown(function () { fs.rmSync(ext, { recursive: true, force: true }); });

  test('flags missing adapter dir as not ok', function () {
    const section = buildAdapterSchemaSection(ext);
    assert.strictEqual(section.ok, false);
  });

  test('reports each skill found per host (flat .md layout)', function () {
    const adapter = path.join(ext, 'adapters', 'cline');
    fs.mkdirSync(adapter, { recursive: true });
    for (const skill of ['kdream', 'autobuild', 'mateam']) {
      fs.writeFileSync(path.join(adapter, `${skill}.md`), '# stub');
    }
    const section = buildAdapterSchemaSection(ext);
    assert.strictEqual(section.ok, true);
    const cline = section.adapters.find(a => a.name === 'cline');
    assert.ok(cline);
    assert.deepStrictEqual(cline!.skillsFound.sort(), ['autobuild', 'kdream', 'mateam']);
  });

  test('detects subdir layout (claude-code style)', function () {
    const adapter = path.join(ext, 'adapters', 'claude-code');
    for (const skill of ['kdream', 'autobuild', 'mateam']) {
      fs.mkdirSync(path.join(adapter, skill), { recursive: true });
      fs.writeFileSync(path.join(adapter, skill, 'SKILL.md'), '# stub');
    }
    const section = buildAdapterSchemaSection(ext);
    const cc = section.adapters.find(a => a.name === 'claude-code');
    assert.ok(cc && cc.skillsFound.length === 3);
    assert.strictEqual(section.ok, true);
  });

  test('reports issues when an adapter is missing one or more skills', function () {
    const adapter = path.join(ext, 'adapters', 'kiro');
    fs.mkdirSync(adapter, { recursive: true });
    fs.writeFileSync(path.join(adapter, 'kdream.md'), '# stub'); // only one
    const section = buildAdapterSchemaSection(ext);
    assert.strictEqual(section.ok, false);
    const issue = section.issues.find(i => i.adapter === 'kiro');
    assert.ok(issue);
    assert.deepStrictEqual(issue!.missingSkills.sort(), ['autobuild', 'mateam']);
  });

  test('skips kilocode and zippymesh (custom layouts)', function () {
    fs.mkdirSync(path.join(ext, 'adapters', 'kilocode'), { recursive: true });
    fs.mkdirSync(path.join(ext, 'adapters', 'zippymesh'), { recursive: true });
    fs.writeFileSync(path.join(ext, 'adapters', 'kilocode', 'autoclaw-modes.yaml'), '# stub');
    fs.writeFileSync(path.join(ext, 'adapters', 'zippymesh', 'README.md'), '# stub');
    const section = buildAdapterSchemaSection(ext);
    // Custom layouts must not contribute issues.
    assert.ok(!section.issues.some(i => i.adapter === 'kilocode'));
    assert.ok(!section.issues.some(i => i.adapter === 'zippymesh'));
  });
});

suite('Doctor: buildGitHealthSection()', function () {
  test('returns isGitRepo=false when no .git/ exists', function () {
    const tmp = makeTempDir('autoclaw-doc-git-');
    try {
      const section = buildGitHealthSection(tmp);
      assert.strictEqual(section.isGitRepo, false);
      assert.strictEqual(section.branch, null);
      assert.strictEqual(section.uncommittedFiles, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns isGitRepo=false for null workspace', function () {
    const section = buildGitHealthSection(null);
    assert.strictEqual(section.isGitRepo, false);
  });

  test('reports branch and clean status for an init+commit repo', function () {
    const tmp = makeTempDir('autoclaw-doc-git2-');
    try {
      // Initialise a real repo so the section can shell out to git.
      const opts = { cwd: tmp, encoding: 'utf8' as const };
      const init = spawnSync('git', ['init', '-b', 'master'], opts);
      if (init.status !== 0) {
        // Some git versions don't accept -b; fall back.
        spawnSync('git', ['init'], opts);
      }
      spawnSync('git', ['config', 'user.email', 't@t'], opts);
      spawnSync('git', ['config', 'user.name', 'T'], opts);
      spawnSync('git', ['config', 'commit.gpgsign', 'false'], opts);
      fs.writeFileSync(path.join(tmp, 'README.md'), '# x');
      spawnSync('git', ['add', '.'], opts);
      spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], opts);

      const section = buildGitHealthSection(tmp);
      assert.strictEqual(section.isGitRepo, true);
      assert.ok(section.branch && section.branch.length > 0);
      assert.strictEqual(section.uncommittedFiles, 0);
      assert.strictEqual(section.untrackedFiles, 0);
      // No upstream — should produce a note.
      assert.strictEqual(section.remoteName, null);
      assert.ok(section.notes.some(n => /upstream/i.test(n)));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

suite('Doctor: renderReportJson()', function () {
  test('produces valid JSON parseable round-trip', async function () {
    const ws = makeTempDir('autoclaw-doc-json-ws-');
    const ext = makeTempDir('autoclaw-doc-json-ext-');
    try {
      const report = await runDoctor(ext, {
        workspaceRoot: ws,
        isExtensionInstalled: () => false,
        zippymeshUrl: DEAD_ZMLR_URL
      });
      const json = renderReportJson(report);
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed.workspace.workspaceRoot, ws);
      assert.ok(parsed.compilation, 'has compilation section');
      assert.ok(parsed.adapterSchema, 'has adapterSchema section');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(ext, { recursive: true, force: true });
    }
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
