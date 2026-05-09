import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runReconcile } from '../reconcile';

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-reconcile-'));
}

function writeTaskMd(root: string, spec: string, body: string): void {
  const dir = path.join(root, '.kiro', 'specs', spec);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.md'), body, 'utf8');
}

function writeSprintYaml(root: string, n: number, body: string): void {
  const dir = path.join(root, '.autoclaw', 'orchestrator', 'sprints');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `sprint-${n}.yaml`), body, 'utf8');
}

function appendCommsLog(root: string, entries: object[]): void {
  const dir = path.join(root, '.autoclaw', 'orchestrator', 'comms');
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(path.join(dir, 'comms-log.jsonl'), lines, 'utf8');
}

suite('Reconcile — drift detection', () => {
  test('empty workspace → empty mismatches', async () => {
    const root = makeTmpRoot();
    const report = await runReconcile(root);
    assert.ok(report.timestamp);
    assert.deepStrictEqual(report.mismatches, []);
  });

  test('empty workspaceRoot string returns empty', async () => {
    const report = await runReconcile('');
    assert.deepStrictEqual(report.mismatches, []);
  });

  test('tasks.md says task-1 done, sprint yaml says pending → 1 mismatch', async () => {
    const root = makeTmpRoot();
    writeTaskMd(root, 'feature-a', '- [x] task-1 First task\n- [ ] task-2 Second task\n');
    writeSprintYaml(root, 1, [
      'sprint: 1',
      'level: 0',
      'status: in_progress',
      'assignments:',
      '  - agent: WA-1',
      '    tasks:',
      '      - id: task-1',
      '        status: pending',
      '      - id: task-2',
      '        status: pending',
      '',
    ].join('\n'));
    const report = await runReconcile(root);
    assert.strictEqual(report.mismatches.length, 1);
    const m = report.mismatches[0];
    assert.strictEqual(m.task_id, 'task-1');
    assert.strictEqual(m.source, 'sprint_yaml');
    assert.match(m.expected, /done/);
  });

  test('tasks.md done + comms-log task_complete + sprint yaml pending → still 1 mismatch (yaml laggard)', async () => {
    const root = makeTmpRoot();
    writeTaskMd(root, 'feature-a', '- [x] task-7 Done already\n');
    writeSprintYaml(root, 2, [
      'sprint: 2',
      'level: 0',
      'status: in_progress',
      'assignments:',
      '  - agent: WA-1',
      '    tasks:',
      '      - id: task-7',
      '        status: pending',
      '',
    ].join('\n'));
    appendCommsLog(root, [
      { timestamp: '2026-05-09T00:00:00Z', type: 'task_complete', from: 'kiro', task_id: 'task-7', message: 'done' },
    ]);
    const report = await runReconcile(root);
    // The first matching rule (tasks.md done, yaml pending) wins per the
    // continue-after-first-rule contract.
    assert.strictEqual(report.mismatches.length, 1);
    assert.strictEqual(report.mismatches[0].task_id, 'task-7');
    assert.strictEqual(report.mismatches[0].source, 'sprint_yaml');
  });

  test('aligned state (md=done, yaml=merged, comms-log task_complete) → no mismatches', async () => {
    const root = makeTmpRoot();
    writeTaskMd(root, 'feature-a', '- [x] task-9 All caught up\n');
    writeSprintYaml(root, 3, [
      'sprint: 3',
      'level: 0',
      'status: merged',
      'assignments:',
      '  - agent: WA-1',
      '    tasks:',
      '      - id: task-9',
      '        status: merged',
      '',
    ].join('\n'));
    appendCommsLog(root, [
      { timestamp: '2026-05-09T00:00:00Z', type: 'task_complete', from: 'kiro', task_id: 'task-9', message: 'done' },
    ]);
    const report = await runReconcile(root);
    assert.deepStrictEqual(report.mismatches, []);
  });
});
