import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runOrchestratorReconcile } from '../orchestrator/reconcile';

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-orch-reconcile-'));
}

function writeSprintYaml(root: string, n: number, body: string): void {
  const dir = path.join(root, '.autoclaw', 'orchestrator', 'sprints');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `sprint-${n}.yaml`), body, 'utf8');
}

function writeStateJson(root: string, body: object): void {
  const dir = path.join(root, '.autoclaw', 'orchestrator');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(body, null, 2), 'utf8');
}

suite('Orchestrator Reconcile — YAML parse validation', () => {
  test('valid sprint YAML → zero parse errors', async () => {
    const root = makeTmpRoot();
    writeSprintYaml(root, 1, [
      'sprint: 1',
      'status: in_progress',
      'assignments:',
      '  - agent: WA-1',
      '    tasks:',
      '      - id: task-1',
      '        status: pending',
      '',
    ].join('\n'));
    const report = await runOrchestratorReconcile(root);
    assert.strictEqual(report.drifts.filter(d => d.type === 'yaml_parse_error').length, 0);
  });

  test('malformed sprint YAML → surfaces yaml_parse_error drift', async () => {
    const root = makeTmpRoot();
    writeSprintYaml(root, 1, [
      'sprint: 1',
      'status: in_progress',
      'assignments:',
      '  - agent: WA-1',
      '    tasks:',
      '      - id: task-1',
      '        status: [invalid yaml here',
      '',
    ].join('\n'));
    const report = await runOrchestratorReconcile(root);
    const parseErrs = report.drifts.filter(d => d.type === 'yaml_parse_error');
    assert.strictEqual(parseErrs.length, 1);
    assert.ok(parseErrs[0].file, 'drift has file path');
    assert.match(parseErrs[0].description, /Invalid YAML/);
  });

  test('tab-indented sprint YAML → surfaces yaml_parse_error drift', async () => {
    const root = makeTmpRoot();
    writeSprintYaml(root, 2, [
      'sprint: 2',
      'status: in_progress',
      'assignments:',
      '  - agent: WA-1',
      '    tasks:',
      '\t\t\t- id: task-2',
      '',
    ].join('\n'));
    const report = await runOrchestratorReconcile(root);
    const parseErrs = report.drifts.filter(d => d.type === 'yaml_parse_error');
    assert.strictEqual(parseErrs.length, 1, 'tabs in YAML should fail to parse');
  });

  test('multiple malformed YAMLs → one drift per file', async () => {
    const root = makeTmpRoot();
    writeSprintYaml(root, 1, '{ broken: [ }');
    writeSprintYaml(root, 2, '{ also: broken: [ }');
    const report = await runOrchestratorReconcile(root);
    const parseErrs = report.drifts.filter(d => d.type === 'yaml_parse_error');
    assert.strictEqual(parseErrs.length, 2);
  });

  test('mixed: one valid, one invalid → only the invalid surfaces', async () => {
    const root = makeTmpRoot();
    writeSprintYaml(root, 1, [
      'sprint: 1',
      'status: in_progress',
      'assignments:',
      '  - agent: WA-1',
      '    tasks:',
      '      - id: task-1',
      '        status: pending',
      '',
    ].join('\n'));
    writeSprintYaml(root, 2, '{ broken: [ }');
    const report = await runOrchestratorReconcile(root);
    const parseErrs = report.drifts.filter(d => d.type === 'yaml_parse_error');
    assert.strictEqual(parseErrs.length, 1);
    assert.ok(parseErrs[0].file?.endsWith('sprint-2.yaml'));
  });

  test('parse error does not block other drift detection', async () => {
    const root = makeTmpRoot();
    writeSprintYaml(root, 1, '{ broken: [ }');
    writeStateJson(root, {
      tasks: [{ id: 'task-1', status: 'pending' }],
    });
    const report = await runOrchestratorReconcile(root);
    const parseErrs = report.drifts.filter(d => d.type === 'yaml_parse_error');
    const taskDrifts = report.drifts.filter(d => d.type !== 'yaml_parse_error');
    assert.strictEqual(parseErrs.length, 1);
    assert.ok(taskDrifts.length > 0, 'other drifts still detected alongside parse error');
  });
});
