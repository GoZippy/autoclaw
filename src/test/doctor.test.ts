import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDoctorChecks } from '../orchestrator/doctor';

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-doctor-'));
}

function writeStateJson(root: string, totalSprints: number): void {
  const dir = path.join(root, '.autoclaw', 'orchestrator');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    project: 'demo', current_sprint: 1, total_sprints: totalSprints,
    tasks_complete: 0, tasks_total: 0, agents: {},
    last_updated: new Date().toISOString(),
  }, null, 2), 'utf8');
}

function writeSprintYaml(root: string, n: number): void {
  const dir = path.join(root, '.autoclaw', 'orchestrator', 'sprints');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `sprint-${n}.yaml`), [
    `sprint: ${n}`,
    'status: in_progress',
    'assignments:',
    '  - agent: WA-1',
    '    tasks:',
    '      - id: task-1',
    '        status: pending',
    '',
  ].join('\n'), 'utf8');
}

function fakeExec(branch: string): (cmd: string, cwd: string) => string {
  return (cmd: string) => {
    if (cmd.includes(`rev-parse --verify ${branch}`)) {
      return `refs/heads/${branch}`;
    }
    throw new Error('not found');
  };
}

suite('Doctor — config vs reality checks', () => {
  test('workspace without .autoclaw → no findings', () => {
    const root = makeTmpRoot();
    const findings = runDoctorChecks(root);
    assert.deepStrictEqual(findings, []);
  });

  test('total_sprints matches actual files → no mismatch finding', () => {
    const root = makeTmpRoot();
    writeStateJson(root, 2);
    writeSprintYaml(root, 1);
    writeSprintYaml(root, 2);
    const findings = runDoctorChecks(root);
    assert.strictEqual(findings.filter(f => f.kind === 'total_sprints_mismatch').length, 0);
  });

  test('total_sprints mismatch → surfaces finding', () => {
    const root = makeTmpRoot();
    writeStateJson(root, 6);
    writeSprintYaml(root, 1);
    writeSprintYaml(root, 2);
    writeSprintYaml(root, 3);
    const findings = runDoctorChecks(root);
    const mismatch = findings.filter(f => f.kind === 'total_sprints_mismatch');
    assert.strictEqual(mismatch.length, 1);
    assert.match(mismatch[0].description, /total_sprints=6.*3 sprint/);
  });

  test('baseBranch exists → no finding', () => {
    const root = makeTmpRoot();
    writeStateJson(root, 0);
    const findings = runDoctorChecks(root, {
      configuredBaseBranch: 'main',
      exec: fakeExec('main'),
    });
    assert.strictEqual(findings.filter(f => f.kind === 'base_branch_missing').length, 0);
  });

  test('baseBranch missing → surfaces finding', () => {
    const root = makeTmpRoot();
    writeStateJson(root, 0);
    const findings = runDoctorChecks(root, {
      configuredBaseBranch: 'develop',
      exec: fakeExec('main'),
    });
    const missing = findings.filter(f => f.kind === 'base_branch_missing');
    assert.strictEqual(missing.length, 1);
    assert.match(missing[0].description, /develop/);
  });

  test('no .git → surfaces git_repo_absent', () => {
    const root = makeTmpRoot();
    writeStateJson(root, 0);
    const findings = runDoctorChecks(root);
    const kinds = findings.map(f => f.kind);
    assert.ok(kinds.includes('git_repo_absent'));
    assert.ok(kinds.includes('base_branch_missing'));
  });

  test('git present but disabled → surfaces git_repo_present_but_config_disabled', () => {
    const root = makeTmpRoot();
    writeStateJson(root, 0);
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const findings = runDoctorChecks(root, {
      gitEnabled: false,
      exec: fakeExec('main'),
    });
    const disabled = findings.filter(f => f.kind === 'git_repo_present_but_config_disabled');
    assert.strictEqual(disabled.length, 1);
  });

  test('multiple findings can coexist', () => {
    const root = makeTmpRoot();
    writeStateJson(root, 10);
    writeSprintYaml(root, 1);
    const findings = runDoctorChecks(root, {
      configuredBaseBranch: 'nonexistent',
      exec: fakeExec('main'),
    });
    const kinds = findings.map(f => f.kind);
    assert.ok(kinds.includes('total_sprints_mismatch'));
    assert.ok(kinds.includes('base_branch_missing'));
    assert.ok(kinds.includes('git_repo_absent'));
  });
});
