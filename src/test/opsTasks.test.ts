import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  driftToOpsTask,
  findingToOpsTask,
  materializeOpsTasks,
  readOpsTasks,
} from '../orchestrator/opsTasks';
import type { DriftRecord } from '../orchestrator/reconcile';
import type { DoctorFinding } from '../orchestrator/doctor';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opstasks-test-'));
}

const NOW = new Date('2026-06-27T12:00:00Z');

suite('opsTasks — driftToOpsTask', () => {
  test('yaml_parse_error → high priority ops task with file', () => {
    const drift: DriftRecord = {
      type: 'yaml_parse_error',
      task_id: '',
      description: 'Invalid YAML in sprint-1.yaml: bad indentation',
      laggard: 'sprint_yaml',
      file: '/ws/.autoclaw/orchestrator/sprints/sprint-1.yaml',
    };
    const t = driftToOpsTask(drift, NOW);
    assert.ok(t);
    assert.strictEqual(t!.id, 'ops-yaml-sprint-1.yaml');
    assert.strictEqual(t!.priority, 'high');
    assert.strictEqual(t!.file, drift.file);
    assert.match(t!.title, /Fix invalid YAML/);
  });

  test('task_in_yaml_not_in_state → medium priority sync task', () => {
    const drift: DriftRecord = {
      type: 'task_in_yaml_not_in_state',
      task_id: 'T-42',
      description: 'Task T-42 in YAML but not state.json',
      laggard: 'state_json',
    };
    const t = driftToOpsTask(drift, NOW);
    assert.ok(t);
    assert.strictEqual(t!.id, 'ops-sync-T-42');
    assert.strictEqual(t!.priority, 'medium');
  });

  test('task_status_mismatch → medium priority reconcile task', () => {
    const drift: DriftRecord = {
      type: 'task_status_mismatch',
      task_id: 'B1',
      description: 'Status mismatch',
      laggard: 'sprint_yaml',
    };
    const t = driftToOpsTask(drift, NOW);
    assert.ok(t);
    assert.strictEqual(t!.id, 'ops-status-B1');
  });

  test('unrelated drift type → null', () => {
    const drift: DriftRecord = {
      type: 'task_complete_in_comms_not_yaml',
      task_id: 'X',
      description: 'comms says done',
      laggard: 'sprint_yaml',
    };
    assert.strictEqual(driftToOpsTask(drift, NOW), null);
  });
});

suite('opsTasks — findingToOpsTask', () => {
  test('total_sprints_mismatch → medium priority', () => {
    const f: DoctorFinding = {
      kind: 'total_sprints_mismatch',
      description: 'state says 6, files say 3',
      hint: 'Update state',
    };
    const t = findingToOpsTask(f, NOW);
    assert.strictEqual(t.id, 'ops-sprint-count');
    assert.strictEqual(t.priority, 'medium');
  });

  test('base_branch_missing → high priority', () => {
    const f: DoctorFinding = {
      kind: 'base_branch_missing',
      description: 'develop missing',
      hint: 'git checkout -b develop',
    };
    const t = findingToOpsTask(f, NOW);
    assert.strictEqual(t.id, 'ops-base-branch');
    assert.strictEqual(t.priority, 'high');
  });

  test('git_repo_absent → low priority', () => {
    const f: DoctorFinding = {
      kind: 'git_repo_absent',
      description: 'No .git',
      hint: 'git init',
    };
    const t = findingToOpsTask(f, NOW);
    assert.strictEqual(t.priority, 'low');
  });
});

suite('opsTasks — materializeOpsTasks', () => {
  test('writes ops tasks to disk and returns them', async () => {
    const dir = makeTmp();
    const drifts: DriftRecord[] = [
      {
        type: 'yaml_parse_error',
        task_id: '',
        description: 'bad yaml',
        laggard: 'sprint_yaml',
        file: '/ws/sprints/sprint-1.yaml',
      },
    ];
    const findings: DoctorFinding[] = [];
    const ops = await materializeOpsTasks(dir, drifts, findings, NOW);
    assert.strictEqual(ops.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'ops-tasks.json')));
  });

  test('deduplicates by id (latest wins)', async () => {
    const dir = makeTmp();
    const drifts2: DriftRecord[] = [
      {
        type: 'yaml_parse_error',
        task_id: '',
        description: 'first',
        laggard: 'sprint_yaml',
        file: '/ws/sprints/sprint-1.yaml',
      },
      {
        type: 'yaml_parse_error',
        task_id: '',
        description: 'second',
        laggard: 'sprint_yaml',
        file: '/ws/sprints/sprint-1.yaml',
      },
    ];
    const ops = await materializeOpsTasks(dir, drifts2, [], NOW);
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].description, 'second');
  });

  test('readOpsTasks round-trip', async () => {
    const dir = makeTmp();
    const findings: DoctorFinding[] = [
      { kind: 'base_branch_missing', description: 'develop missing', hint: 'git checkout -b develop' },
    ];
    await materializeOpsTasks(dir, [], findings, NOW);
    const read = await readOpsTasks(dir);
    assert.strictEqual(read.length, 1);
    assert.strictEqual(read[0].id, 'ops-base-branch');
  });

  test('readOpsTasks on missing file → []', async () => {
    const dir = makeTmp();
    const read = await readOpsTasks(dir);
    assert.deepStrictEqual(read, []);
  });
});
