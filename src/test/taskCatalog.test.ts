/**
 * taskCatalog.test.ts — L0 task-catalog ingestion.
 *
 * Pure-merge tests plus fs-integration tests proving that ingesting sprint YAMLs /
 * spec tasks.md into state.json makes the board's `claimable` lane non-empty (the
 * keystone fix for "messages flow but nothing coordinates").
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseTasksMarkdown,
  extractSprintTasks,
  mapSprintStatus,
  normalizeCatalog,
  catalogDigest,
} from '../orchestrator/taskCatalog';
import { ingestTaskCatalog } from '../orchestrator/taskCatalogIngest';
import { writeBoard } from '../orchestrator/boardWriter';

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

suite('taskCatalog — parseTasksMarkdown', () => {
  test('extracts explicit ids in several shapes + checkbox state', () => {
    const md = [
      '# Tasks',
      '- [ ] **T-12** Build the thing',
      '- [x] 3. Already done',
      '- [ ] T4: Colon style',
      'some prose, not a task',
      '   - [ ] Indented no-id task',
      '     extra description line',
    ].join('\n');
    const tasks = parseTasksMarkdown(md);
    assert.deepStrictEqual(tasks.map(t => t.id), ['T-12', '3', 'T4', 'T-4']);
    assert.strictEqual(tasks[0].title, 'Build the thing');
    assert.strictEqual(tasks[1].done, true);
    assert.strictEqual(tasks[2].title, 'Colon style');
    assert.strictEqual(tasks[3].title, 'Indented no-id task');
  });

  test('ignores non-checkbox bullets and prose', () => {
    assert.strictEqual(parseTasksMarkdown('- regular bullet\nplain text\n').length, 0);
  });
});

suite('taskCatalog — extractSprintTasks', () => {
  const yaml = [
    'sprint: 2',
    'level: 1',
    'status: assigned',
    'assignments:',
    '  - agent: WA-1',
    '    platform: claude-code',
    '    scope:',
    '      - "src/foo/**"',
    '    tasks:',
    '      - id: B1',
    '        name: "Build foo"',
    '        status: in_progress',
    '        subtasks:',
    '          - "sub a"',
    '      - id: B2',
    '        name: "Build bar"',
    '        status: pending',
    '    branch: feat/s2-1',
    '  - agent: WA-2',
    '    scope:',
    '      - "src/baz/**"',
    '    tasks:',
    '      - id: B3',
    '        name: "Build baz"',
    '        status: pending',
    '    branch: feat/s2-2',
  ].join('\n');

  test('pulls every task across assignments, stamps the sprint number', () => {
    const tasks = extractSprintTasks(yaml);
    assert.deepStrictEqual(tasks.map(t => t.id), ['B1', 'B2', 'B3']);
    assert.strictEqual(tasks[0].name, 'Build foo');
    assert.strictEqual(tasks[0].status, 'in_progress');
    assert.ok(tasks.every(t => t.sprint === 2), 'sprint stamped on all');
    // subtask bullets must not leak in as tasks
    assert.ok(!tasks.some(t => t.id.includes('sub')));
  });
});

suite('taskCatalog — mapSprintStatus', () => {
  test('maps raw status words onto board statuses', () => {
    assert.strictEqual(mapSprintStatus('pending'), 'open');
    assert.strictEqual(mapSprintStatus('in_progress'), 'in_progress');
    assert.strictEqual(mapSprintStatus('review'), 'in_review');
    assert.strictEqual(mapSprintStatus('merged'), 'merged');
    assert.strictEqual(mapSprintStatus('done'), 'done');
    assert.strictEqual(mapSprintStatus('weird'), undefined);
  });
});

suite('taskCatalog — normalizeCatalog (merge precedence)', () => {
  test('manifest wins static metadata; sprint wins status+sprint; markdown fills gaps', () => {
    const cat = normalizeCatalog({
      manifestTasks: [{ id: 'A', name: 'Manifest A', depends_on: ['Z'], scope: ['src/a/**'], priority: 'high' }],
      sprintTasks: [{ id: 'A', name: 'Sprint A', status: 'in_progress', sprint: 1 }],
      markdownTasks: [{ id: 'A', title: 'MD A', done: true }],
    });
    assert.strictEqual(cat.length, 1);
    const a = cat[0];
    assert.strictEqual(a.title, 'Manifest A', 'manifest title wins');
    assert.deepStrictEqual(a.depends_on, ['Z']);
    assert.deepStrictEqual(a.files, ['src/a/**']);
    assert.strictEqual(a.priority, 'high');
    assert.strictEqual(a.status, 'in_progress', 'sprint status wins over markdown done');
    assert.strictEqual(a.sprint, 1);
  });

  test('markdown-only task: done→done, else open; default status open', () => {
    const cat = normalizeCatalog({ markdownTasks: [{ id: 'M1', title: 't', done: true }, { id: 'M2', title: 'u' }] });
    assert.strictEqual(cat.find(t => t.id === 'M1')!.status, 'done');
    assert.strictEqual(cat.find(t => t.id === 'M2')!.status, 'open');
  });

  test('dedups by id and preserves first-seen order (manifest → sprint → markdown)', () => {
    const cat = normalizeCatalog({
      manifestTasks: [{ id: 'A' }],
      sprintTasks: [{ id: 'A' }, { id: 'B' }],
      markdownTasks: [{ id: 'B' }, { id: 'C' }],
    });
    assert.deepStrictEqual(cat.map(t => t.id), ['A', 'B', 'C']);
  });
});

suite('taskCatalog — catalogDigest', () => {
  test('order-independent for tasks, deps, and files', () => {
    const a = normalizeCatalog({ manifestTasks: [
      { id: 'A', depends_on: ['x', 'y'], scope: ['p', 'q'] },
      { id: 'B' },
    ] });
    const b = normalizeCatalog({ manifestTasks: [
      { id: 'B' },
      { id: 'A', depends_on: ['y', 'x'], scope: ['q', 'p'] },
    ] });
    assert.strictEqual(catalogDigest(a), catalogDigest(b));
  });

  test('differs when a status changes', () => {
    const a = normalizeCatalog({ sprintTasks: [{ id: 'A', status: 'pending' }] });
    const b = normalizeCatalog({ sprintTasks: [{ id: 'A', status: 'done' }] });
    assert.notStrictEqual(catalogDigest(a), catalogDigest(b));
  });
});

// ---------------------------------------------------------------------------
// fs ingest runner
// ---------------------------------------------------------------------------

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-catalog-test-'));
}
function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}
function orch(ws: string, ...p: string[]): string {
  return path.join(ws, '.autoclaw', 'orchestrator', ...p);
}

const SPRINT_YAML = [
  'sprint: 1',
  'status: assigned',
  'assignments:',
  '  - agent: WA-1',
  '    tasks:',
  '      - id: B1',
  '        name: "Build foo"',
  '        status: pending',
  '      - id: B2',
  '        name: "Build bar"',
  '        status: pending',
  '    branch: feat/s1',
].join('\n');

function seedState(ws: string): void {
  write(orch(ws, 'state.json'), JSON.stringify({
    project: 'demo', current_sprint: 1, total_sprints: 1,
    tasks_complete: 0, tasks_total: 0, agents: {}, last_updated: '2026-01-01T00:00:00Z',
  }, null, 2));
}

suite('taskCatalog — ingestTaskCatalog (fs)', () => {
  test('ingests sprint YAML tasks into an existing state.json', async () => {
    const ws = makeWorkspace();
    try {
      seedState(ws);
      write(orch(ws, 'sprints', 'sprint-1.yaml'), SPRINT_YAML);
      const res = await ingestTaskCatalog({ workspaceRoot: ws, skipSpecScan: true });
      assert.strictEqual(res.changed, true);
      assert.strictEqual(res.count, 2);
      const state = JSON.parse(fs.readFileSync(orch(ws, 'state.json'), 'utf8'));
      assert.deepStrictEqual(state.tasks.map((t: any) => t.id), ['B1', 'B2']);
      assert.strictEqual(state.tasks_total, 2);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('is idempotent: a second ingest does not rewrite', async () => {
    const ws = makeWorkspace();
    try {
      seedState(ws);
      write(orch(ws, 'sprints', 'sprint-1.yaml'), SPRINT_YAML);
      await ingestTaskCatalog({ workspaceRoot: ws, skipSpecScan: true });
      const second = await ingestTaskCatalog({ workspaceRoot: ws, skipSpecScan: true });
      assert.strictEqual(second.changed, false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('falls back to spec tasks.md when there are no sprints (the observed failure)', async () => {
    const ws = makeWorkspace();
    try {
      seedState(ws);
      write(path.join(ws, 'specs', 'physics', 'tasks.md'),
        '# Physics\n- [ ] 1. Crate skeleton\n- [ ] 2. Backend seam\n');
      const res = await ingestTaskCatalog({ workspaceRoot: ws });
      assert.strictEqual(res.changed, true);
      assert.strictEqual(res.count, 2);
      assert.strictEqual(res.sources.markdown, 2);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('does not fabricate a state file when there is nothing to ingest', async () => {
    const ws = makeWorkspace();
    try {
      const res = await ingestTaskCatalog({ workspaceRoot: ws, skipSpecScan: true });
      assert.strictEqual(res.changed, false);
      assert.strictEqual(fs.existsSync(orch(ws, 'state.json')), false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('END-TO-END: after ingestion the board.json claimable lane is non-empty', async () => {
    const ws = makeWorkspace();
    try {
      seedState(ws);
      write(orch(ws, 'sprints', 'sprint-1.yaml'), SPRINT_YAML);
      await ingestTaskCatalog({ workspaceRoot: ws, skipSpecScan: true });
      await writeBoard({ workspaceRoot: ws, generator: 'test' });
      const board = JSON.parse(fs.readFileSync(orch(ws, 'board.json'), 'utf8'));
      const claimableIds = (board.claimable ?? []).map((c: any) => c.task_id);
      assert.ok(claimableIds.includes('B1') && claimableIds.includes('B2'),
        `expected B1+B2 claimable, got ${JSON.stringify(claimableIds)}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
