/**
 * voidspec.test.ts — Unit tests for the VoidSpec ↔ AutoClaw sync layer (G1/G2).
 *
 * Covers:
 *  1. tasks.yaml parsing (stable ids, status normalisation, extra fields)
 *  2. VoidSpec → AutoClaw mapping into the VS-<id> shared namespace
 *  3. Bidirectional sync: new tasks, status write-back, conflict resolution
 *  4. applyStatusWriteBack rewriting / inserting status lines
 *  5. dispatch: runner mode vs native-conversion fallback
 *  6. syncVoidSpecCommand end-to-end against a temp workspace
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseVoidSpecYaml,
  mapToAutoClawTask,
  mapDocument,
  syncVoidSpec,
  applyStatusWriteBack,
  buildExecutionState,
} from '../voidspec/sync';
import {
  toSharedId,
  toVoidSpecId,
  isSharedVoidSpecId,
  normaliseVoidSpecStatus,
  voidSpecToAutoClawStatus,
} from '../voidspec/types';
import {
  dispatchVoidSpecTasks,
  syncVoidSpecCommand,
  resolveTasksYamlPath,
  hasVoidSpec,
  VoidSpecRunner,
} from '../voidspec/dispatch';
import type { AutoClawMirroredTask } from '../voidspec/types';

const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-voidspec-'));
}

const SAMPLE_YAML = `project: demo-spec
version: "1.2"
tasks:
  - id: T-001
    title: "Build the parser"
    status: in_progress
    description: "Parse the input"
    depends_on: [T-000]
    owner: claude-code
    priority: high
  - id: T-002
    title: "Write the docs"
    status: todo
  - id: T-003
    title: "Ship it"
    status: done
`;

// ---------------------------------------------------------------------------

suite('VoidSpec — types helpers', () => {
  test('toSharedId / toVoidSpecId round-trip', () => {
    assert.strictEqual(toSharedId('T-001'), 'VS-T-001');
    assert.strictEqual(toSharedId('VS-T-001'), 'VS-T-001'); // idempotent
    assert.strictEqual(toVoidSpecId('VS-T-001'), 'T-001');
    assert.strictEqual(toVoidSpecId('T-001'), 'T-001');
  });

  test('isSharedVoidSpecId', () => {
    assert.ok(isSharedVoidSpecId('VS-abc'));
    assert.ok(!isSharedVoidSpecId('A1'));
  });

  test('normaliseVoidSpecStatus maps synonyms', () => {
    assert.strictEqual(normaliseVoidSpecStatus('Completed'), 'done');
    assert.strictEqual(normaliseVoidSpecStatus('WIP'), 'in_progress');
    assert.strictEqual(normaliseVoidSpecStatus('on hold'), 'blocked');
    assert.strictEqual(normaliseVoidSpecStatus(undefined), 'todo');
    assert.strictEqual(normaliseVoidSpecStatus('weird'), 'todo');
  });

  test('voidSpecToAutoClawStatus', () => {
    assert.strictEqual(voidSpecToAutoClawStatus('done'), 'complete');
    assert.strictEqual(voidSpecToAutoClawStatus('todo'), 'pending');
  });
});

suite('VoidSpec — parseVoidSpecYaml', () => {
  test('parses project + version + all tasks', () => {
    const doc = parseVoidSpecYaml(SAMPLE_YAML);
    assert.strictEqual(doc.project, 'demo-spec');
    assert.strictEqual(doc.version, '1.2');
    assert.strictEqual(doc.tasks.length, 3);
  });

  test('preserves stable ids and parses fields', () => {
    const doc = parseVoidSpecYaml(SAMPLE_YAML);
    const t1 = doc.tasks[0];
    assert.strictEqual(t1.id, 'T-001');
    assert.strictEqual(t1.title, 'Build the parser');
    assert.strictEqual(t1.status, 'in_progress');
    assert.strictEqual(t1.description, 'Parse the input');
    assert.deepStrictEqual(t1.dependsOn, ['T-000']);
    assert.strictEqual(t1.owner, 'claude-code');
  });

  test('captures unmodelled scalar fields in extra', () => {
    const doc = parseVoidSpecYaml(SAMPLE_YAML);
    assert.ok(doc.tasks[0].extra);
    assert.strictEqual(doc.tasks[0].extra!.priority, 'high');
  });

  test('a task with no id is dropped', () => {
    const doc = parseVoidSpecYaml('tasks:\n  - title: "no id here"\n');
    assert.strictEqual(doc.tasks.length, 0);
  });
});

suite('VoidSpec — mapping', () => {
  test('maps into the VS- shared namespace', () => {
    const doc = parseVoidSpecYaml(SAMPLE_YAML);
    const mapped = mapToAutoClawTask(doc.tasks[0]);
    assert.strictEqual(mapped.id, 'VS-T-001');
    assert.strictEqual(mapped.sourceId, 'T-001');
    assert.strictEqual(mapped.status, 'in_progress');
    assert.deepStrictEqual(mapped.dependsOn, ['VS-T-000']);
  });

  test('mapDocument maps every task', () => {
    const mapped = mapDocument(parseVoidSpecYaml(SAMPLE_YAML));
    assert.strictEqual(mapped.length, 3);
    assert.strictEqual(mapped[2].status, 'complete'); // done -> complete
  });
});

suite('VoidSpec — applyStatusWriteBack', () => {
  test('rewrites an existing status line', () => {
    const out = applyStatusWriteBack(
      SAMPLE_YAML,
      new Map([['T-002', 'in_progress']]),
    );
    const reparsed = parseVoidSpecYaml(out);
    assert.strictEqual(reparsed.tasks[1].status, 'in_progress');
    // Other tasks untouched.
    assert.strictEqual(reparsed.tasks[0].status, 'in_progress');
    assert.strictEqual(reparsed.tasks[2].status, 'done');
  });

  test('inserts a status line when the task has none', () => {
    const noStatus = 'tasks:\n  - id: X-1\n    title: "no status"\n';
    const out = applyStatusWriteBack(noStatus, new Map([['X-1', 'complete']]));
    const reparsed = parseVoidSpecYaml(out);
    assert.strictEqual(reparsed.tasks[0].status, 'done');
  });

  test('no rewrites returns input unchanged', () => {
    assert.strictEqual(applyStatusWriteBack(SAMPLE_YAML, new Map()), SAMPLE_YAML);
  });
});

suite('VoidSpec — syncVoidSpec bidirectional', () => {
  test('new tasks flow VoidSpec -> AutoClaw', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'tasks.yaml');
    fs.writeFileSync(file, SAMPLE_YAML, 'utf8');
    const { result } = syncVoidSpec(file, {}); // empty exec state
    assert.strictEqual(result.added, 3);
    assert.strictEqual(result.writtenBack, 0);
    assert.ok(result.tasks.every((t) => t.direction === 'voidspec_to_autoclaw'));
  });

  test('AutoClaw execution status wins and is written back', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'tasks.yaml');
    fs.writeFileSync(file, SAMPLE_YAML, 'utf8');
    // AutoClaw says T-002 is complete, T-001 still in_progress.
    const exec = buildExecutionState({
      'VS-T-001': 'in_progress',
      'VS-T-002': 'complete',
      'VS-T-003': 'complete',
    });
    const { result } = syncVoidSpec(file, { executionState: exec });
    assert.strictEqual(result.writtenBack, 1); // only T-002 differed
    assert.ok(result.voidSpecFileChanged);
    // tasks.yaml on disk now reflects AutoClaw's status.
    const reparsed = parseVoidSpecYaml(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(reparsed.tasks[1].status, 'done');
  });

  test('conflict (both sides at terminal state) is counted', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'tasks.yaml');
    fs.writeFileSync(file, SAMPLE_YAML, 'utf8');
    // T-003 is done in VoidSpec but AutoClaw says in_progress.
    const exec = buildExecutionState({ 'VS-T-003': 'in_progress' });
    const { result } = syncVoidSpec(file, { executionState: exec });
    assert.ok(result.conflicts >= 1);
    const t3 = result.tasks.find((t) => t.id === 'VS-T-003');
    assert.strictEqual(t3!.direction, 'conflict_resolved');
  });

  test('writeBack:false leaves tasks.yaml on disk untouched', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'tasks.yaml');
    fs.writeFileSync(file, SAMPLE_YAML, 'utf8');
    const exec = buildExecutionState({ 'VS-T-002': 'complete' });
    syncVoidSpec(file, { executionState: exec, writeBack: false });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), SAMPLE_YAML);
  });
});

suite('VoidSpec — dispatch', () => {
  const mirrored: AutoClawMirroredTask[] = [
    { id: 'VS-T-1', sourceId: 'T-1', name: 'x', status: 'pending', subtasks: [], dependsOn: [] },
  ];

  test('native conversion when no runner', async () => {
    const r = await dispatchVoidSpecTasks(mirrored, { logger: SILENT });
    assert.strictEqual(r.mode, 'native');
    assert.strictEqual(r.tasks.length, 1);
  });

  test('runner mode when a runner is available', async () => {
    const runner: VoidSpecRunner = {
      id: 'runner-voidspec',
      isAvailable: () => true,
      dispatch: async (tasks) => {
        const out: Record<string, string> = {};
        for (const t of tasks) { out[t.id] = 'queued'; }
        return out;
      },
    };
    const r = await dispatchVoidSpecTasks(mirrored, { runner, logger: SILENT });
    assert.strictEqual(r.mode, 'runner');
    assert.strictEqual(r.dispatched!['VS-T-1'], 'queued');
  });

  test('falls back to native when runner reports unavailable', async () => {
    const runner: VoidSpecRunner = {
      id: 'runner-voidspec',
      isAvailable: () => false,
      dispatch: async () => ({}),
    };
    const r = await dispatchVoidSpecTasks(mirrored, { runner, logger: SILENT });
    assert.strictEqual(r.mode, 'native');
  });
});

suite('VoidSpec — syncVoidSpecCommand', () => {
  test('reports ran:false when no tasks.yaml exists', async () => {
    const dir = tmpDir();
    const r = await syncVoidSpecCommand({ workspaceRoot: dir, logger: SILENT });
    assert.strictEqual(r.ran, false);
    assert.ok(!hasVoidSpec(dir));
  });

  test('end-to-end sync against a temp workspace', async () => {
    const dir = tmpDir();
    const file = resolveTasksYamlPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SAMPLE_YAML, 'utf8');
    assert.ok(hasVoidSpec(dir));
    const r = await syncVoidSpecCommand({
      workspaceRoot: dir,
      executionState: buildExecutionState({ 'VS-T-002': 'complete' }),
      logger: SILENT,
    });
    assert.strictEqual(r.ran, true);
    assert.strictEqual(r.result!.writtenBack, 1);
    assert.strictEqual(r.dispatch!.mode, 'native');
    assert.ok(r.summary.includes('VoidSpec sync'));
  });
});

// ---------------------------------------------------------------------------
// AF-0505 — the `autoclaw.voidspec.sync` command is contributed + wired.
// These assertions are intentionally headless: they read package.json and the
// dispatch module directly (no `vscode` import), so they run under plain mocha.
// ---------------------------------------------------------------------------
suite('VoidSpec — AF-0505 command wiring', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
  ) as { contributes: { commands: { command: string; title: string }[] } };

  test('autoclaw.voidspec.sync appears in package contributions', () => {
    const cmd = pkg.contributes.commands.find(
      (c) => c.command === 'autoclaw.voidspec.sync',
    );
    assert.ok(cmd, 'autoclaw.voidspec.sync must be contributed in package.json');
    assert.ok(
      cmd!.title.length > 0,
      'the contributed command must carry a human-readable title',
    );
  });

  test('the sync handler runs without requiring a vscode import', () => {
    // syncVoidSpecCommand is imported from dispatch.ts at the top of this file;
    // if dispatch.ts pulled in `vscode`, this module would fail to load under
    // plain mocha. Reaching this assertion proves the core logic is headless.
    assert.strictEqual(typeof syncVoidSpecCommand, 'function');
  });

  test('no-task-file case: command reports ran:false gracefully', async () => {
    const dir = tmpDir();
    const r = await syncVoidSpecCommand({ workspaceRoot: dir, logger: SILENT });
    assert.strictEqual(r.ran, false);
    assert.ok(r.summary.includes('No VoidSpec tasks found'));
  });

  test('sync case: command syncs an existing tasks.yaml', async () => {
    const dir = tmpDir();
    const file = resolveTasksYamlPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SAMPLE_YAML, 'utf8');
    const r = await syncVoidSpecCommand({ workspaceRoot: dir, logger: SILENT });
    assert.strictEqual(r.ran, true);
    assert.ok(r.result, 'a sync result must be returned when a task file exists');
    assert.strictEqual(r.result!.added, 3);
    assert.strictEqual(r.dispatch!.mode, 'native');
  });
});
