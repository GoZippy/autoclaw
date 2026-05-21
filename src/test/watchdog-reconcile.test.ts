/**
 * watchdog-reconcile.test.ts
 *
 * Unit tests for:
 *   - src/daemon/watcher.ts         (A3: InboxWatcher fires on file add)
 *   - src/orchestrator/watchdog.ts  (A3: stall detection)
 *   - src/orchestrator/reconcile.ts (A6: orchestrator drift detection)
 *   - src/orchestrator/planSummaryGenerator.ts  (A7: idempotent plan-summary.yaml)
 *   - src/orchestrator/sprintMarkdownGenerator.ts (A7: idempotent sprint-N.md)
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createInboxWatcher } from '../daemon/watcher';
import { createWatchdog } from '../orchestrator/watchdog';
import { runOrchestratorReconcile } from '../orchestrator/reconcile';
import { generatePlanSummary } from '../orchestrator/planSummaryGenerator';
import { generateSprintMarkdown } from '../orchestrator/sprintMarkdownGenerator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/** Build the standard .autoclaw directory tree under root. */
function scaffoldAutoclaw(root: string): {
  orchestratorDir: string;
  sprintsDir: string;
  commsDir: string;
  inboxesDir: string;
  heartbeatsDir: string;
} {
  const orchestratorDir = path.join(root, '.autoclaw', 'orchestrator');
  const sprintsDir = path.join(orchestratorDir, 'sprints');
  const commsDir = path.join(orchestratorDir, 'comms');
  const inboxesDir = path.join(commsDir, 'inboxes');
  const heartbeatsDir = path.join(commsDir, 'heartbeats');
  mkdirp(sprintsDir);
  mkdirp(inboxesDir);
  mkdirp(heartbeatsDir);
  return { orchestratorDir, sprintsDir, commsDir, inboxesDir, heartbeatsDir };
}

// ---------------------------------------------------------------------------
// InboxWatcher — A3
// ---------------------------------------------------------------------------

suite('InboxWatcher — A3', () => {

  test('watcher fires onFileAdded when a .json file is added to an inbox', async function () {
    this.timeout(15_000);

    const root = makeTmp('autoclaw-watcher-');
    const commsDir = path.join(root, 'comms');
    const inboxesDir = path.join(commsDir, 'inboxes');
    const agentInbox = path.join(inboxesDir, 'test-agent');
    mkdirp(agentInbox);

    const received: Array<{ filePath: string; agentId: string }> = [];
    const watcher = createInboxWatcher({
      commsDir,
      onFileAdded: (filePath, agentId) => {
        received.push({ filePath, agentId });
      },
    });

    await watcher.start();

    // Give chokidar/polling a moment to settle.
    await new Promise(r => setTimeout(r, 500));

    // Drop a file into the inbox.
    const msgPath = path.join(agentInbox, `${Date.now()}-test_message.json`);
    fs.writeFileSync(msgPath, JSON.stringify({ type: 'test' }), 'utf8');

    // Wait up to 8 seconds for the event (chokidar is usually sub-100ms).
    const deadline = Date.now() + 8_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }

    await watcher.stop();

    assert.strictEqual(received.length, 1, 'Expected exactly one file-added notification');
    assert.strictEqual(received[0].agentId, 'test-agent');
    assert.ok(received[0].filePath.endsWith('.json'));
  });

  test('watcher.isFallback is false when chokidar initialises successfully', async function () {
    this.timeout(12_000);

    const root = makeTmp('autoclaw-watcher-fallback-');
    const commsDir = path.join(root, 'comms');
    mkdirp(path.join(commsDir, 'inboxes'));

    const watcher = createInboxWatcher({
      commsDir,
      onFileAdded: () => { /* noop */ },
    });
    await watcher.start();
    assert.strictEqual(watcher.isFallback, false, 'Should use chokidar, not polling');
    await watcher.stop();
  });

  test('watcher ignores non-.json files', async function () {
    this.timeout(12_000);

    const root = makeTmp('autoclaw-watcher-nojson-');
    const commsDir = path.join(root, 'comms');
    const agentInbox = path.join(commsDir, 'inboxes', 'alpha');
    mkdirp(agentInbox);

    const received: string[] = [];
    const watcher = createInboxWatcher({
      commsDir,
      onFileAdded: (fp) => received.push(fp),
    });
    await watcher.start();
    await new Promise(r => setTimeout(r, 400));

    fs.writeFileSync(path.join(agentInbox, 'ignored.txt'), 'not json', 'utf8');
    fs.writeFileSync(path.join(agentInbox, `${Date.now()}.json`), '{}', 'utf8');

    const deadline = Date.now() + 6_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }

    await watcher.stop();
    // Only the .json file should be reported.
    assert.ok(received.every(fp => fp.endsWith('.json')), 'Should only fire for .json files');
  });
});

// ---------------------------------------------------------------------------
// Watchdog — A3 (5-min stall detection)
// ---------------------------------------------------------------------------

suite('Watchdog — A3', () => {

  test('tick() emits stall when heartbeat file is older than stallThresholdMs', async () => {
    const root = makeTmp('autoclaw-watchdog-');
    const { commsDir, heartbeatsDir } = scaffoldAutoclaw(root);

    // Write a heartbeat file and back-date its mtime.
    const hbPath = path.join(heartbeatsDir, 'kilo-code.json');
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    fs.writeFileSync(hbPath, JSON.stringify({ agent_id: 'kilo-code', timestamp: oldTimestamp }), 'utf8');
    // Set mtime to 10 minutes ago.
    const oldDate = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(hbPath, oldDate, oldDate);

    const stalls: string[] = [];
    const watchdog = createWatchdog({
      commsDir,
      stallThresholdMs: 5 * 60 * 1000, // 5 minutes
      tickIntervalMs: 99999,            // prevent auto-tick in this test
      onStall: (agentId) => stalls.push(agentId),
    });

    await watchdog.tick();

    assert.strictEqual(stalls.length, 1, 'Expected one stall event');
    assert.strictEqual(stalls[0], 'kilo-code');
  });

  test('tick() does NOT emit stall when heartbeat is fresh', async () => {
    const root = makeTmp('autoclaw-watchdog-fresh-');
    const { commsDir, heartbeatsDir } = scaffoldAutoclaw(root);

    const hbPath = path.join(heartbeatsDir, 'claude-code.json');
    fs.writeFileSync(hbPath, JSON.stringify({ agent_id: 'claude-code', timestamp: new Date().toISOString() }), 'utf8');
    // mtime is already now — within threshold.

    const stalls: string[] = [];
    const watchdog = createWatchdog({
      commsDir,
      stallThresholdMs: 5 * 60 * 1000,
      tickIntervalMs: 99999,
      onStall: (agentId) => stalls.push(agentId),
    });

    await watchdog.tick();
    assert.strictEqual(stalls.length, 0, 'Should not emit stall for fresh heartbeat');
  });

  test('tick() is a no-op when heartbeats directory is absent', async () => {
    const root = makeTmp('autoclaw-watchdog-nodir-');
    const commsDir = path.join(root, 'comms');
    // Deliberately do NOT create heartbeats/.

    const stalls: string[] = [];
    const watchdog = createWatchdog({
      commsDir,
      stallThresholdMs: 1000,
      tickIntervalMs: 99999,
      onStall: (agentId) => stalls.push(agentId),
    });

    // Should not throw.
    await watchdog.tick();
    assert.deepStrictEqual(stalls, []);
  });
});

// ---------------------------------------------------------------------------
// OrchestratorReconcile — A6
// ---------------------------------------------------------------------------

suite('OrchestratorReconcile — A6', () => {

  test('empty workspace returns empty drifts', async () => {
    const root = makeTmp('autoclaw-orecon-');
    const report = await runOrchestratorReconcile(root);
    assert.ok(report.generated_at);
    assert.deepStrictEqual(report.drifts, []);
  });

  test('empty workspaceRoot string returns empty drifts without throwing', async () => {
    const report = await runOrchestratorReconcile('');
    assert.deepStrictEqual(report.drifts, []);
  });

  test('reconcile detects task_in_yaml_not_in_state drift', async () => {
    const root = makeTmp('autoclaw-orecon-drift-');
    const { sprintsDir } = scaffoldAutoclaw(root);

    // Sprint YAML has task A1 but state.json has no tasks at all.
    fs.writeFileSync(
      path.join(sprintsDir, 'sprint-1.yaml'),
      [
        'sprint: 1',
        'status: in_progress',
        'assignments:',
        '  - agent: WA-1',
        '    tasks:',
        '      - id: A1',
        '        name: "Some task"',
        '        status: pending',
        '',
      ].join('\n'),
      'utf8'
    );

    // No state.json written — so state has no tasks.
    const report = await runOrchestratorReconcile(root);
    const drift = report.drifts.find(d => d.task_id === 'A1');
    assert.ok(drift, 'Expected a drift for task A1');
    assert.strictEqual(drift!.type, 'task_in_yaml_not_in_state');
    assert.strictEqual(drift!.laggard, 'state_json');
  });

  test('reconcile detects task_status_mismatch when state and yaml disagree', async () => {
    const root = makeTmp('autoclaw-orecon-mismatch-');
    const { orchestratorDir, sprintsDir } = scaffoldAutoclaw(root);

    // state.json says A2 is merged; YAML says pending.
    fs.writeFileSync(
      path.join(orchestratorDir, 'state.json'),
      JSON.stringify({ tasks: [{ id: 'A2', status: 'merged' }] }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(sprintsDir, 'sprint-1.yaml'),
      [
        'sprint: 1',
        'status: in_progress',
        'assignments:',
        '  - agent: WA-1',
        '    tasks:',
        '      - id: A2',
        '        name: "Atomic claim"',
        '        status: pending',
        '',
      ].join('\n'),
      'utf8'
    );

    const report = await runOrchestratorReconcile(root);
    const drift = report.drifts.find(d => d.task_id === 'A2');
    assert.ok(drift, 'Expected a mismatch drift for A2');
    assert.strictEqual(drift!.type, 'task_status_mismatch');
  });

  test('reconcile detects task_complete_in_comms_not_yaml', async () => {
    const root = makeTmp('autoclaw-orecon-commslog-');
    const { sprintsDir, commsDir } = scaffoldAutoclaw(root);

    fs.writeFileSync(
      path.join(sprintsDir, 'sprint-2.yaml'),
      [
        'sprint: 2',
        'status: in_progress',
        'assignments:',
        '  - agent: WA-2',
        '    tasks:',
        '      - id: A6',
        '        name: "Reconcile sweep"',
        '        status: pending',
        '',
      ].join('\n'),
      'utf8'
    );

    // comms-log says A6 is task_complete but YAML still says pending.
    const logPath = path.join(commsDir, 'comms-log.jsonl');
    fs.writeFileSync(
      logPath,
      JSON.stringify({ timestamp: new Date().toISOString(), type: 'task_complete', task_id: 'A6', from: 'WA-2' }) + '\n',
      'utf8'
    );

    const report = await runOrchestratorReconcile(root);
    const drift = report.drifts.find(d => d.task_id === 'A6');
    assert.ok(drift, 'Expected drift for A6');
    assert.ok(
      drift!.type === 'task_complete_in_comms_not_yaml' || drift!.type === 'task_in_yaml_not_in_state',
      `Unexpected drift type: ${drift!.type}`
    );
  });

  test('reconcile finds no drift when state.json and yaml agree', async () => {
    const root = makeTmp('autoclaw-orecon-clean-');
    const { orchestratorDir, sprintsDir } = scaffoldAutoclaw(root);

    fs.writeFileSync(
      path.join(orchestratorDir, 'state.json'),
      JSON.stringify({ tasks: [{ id: 'A3', status: 'merged' }] }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(sprintsDir, 'sprint-1.yaml'),
      [
        'sprint: 1',
        'status: merged',
        'assignments:',
        '  - agent: WA-2',
        '    tasks:',
        '      - id: A3',
        '        name: "Watchdog"',
        '        status: merged',
        '',
      ].join('\n'),
      'utf8'
    );

    const report = await runOrchestratorReconcile(root);
    assert.deepStrictEqual(report.drifts, []);
  });
});

// ---------------------------------------------------------------------------
// PlanSummaryGenerator — A7 (idempotent)
// ---------------------------------------------------------------------------

suite('PlanSummaryGenerator — A7', () => {

  function writeSampleSprintYaml(sprintsDir: string, n: number): void {
    fs.writeFileSync(
      path.join(sprintsDir, `sprint-${n}.yaml`),
      [
        `sprint: ${n}`,
        'level: 0',
        'status: pending',
        `description: "Sprint ${n} work"`,
        `estimated_days: ${n * 3}`,
        'depends_on_sprints: []',
        'assignments:',
        '  - agent: WA-1',
        '    role: "Core work"',
        '    branch: feat/sprint-X',
        '    tasks:',
        `      - id: A${n}`,
        `        name: "Task A${n}"`,
        '        status: pending',
        '        subtasks:',
        '          - "Do the thing"',
        '    scope:',
        '      - "src/foo.ts"',
        '',
      ].join('\n'),
      'utf8'
    );
  }

  test('generator writes plan-summary.yaml with correct totals', async () => {
    const root = makeTmp('autoclaw-plansum-');
    const { sprintsDir } = scaffoldAutoclaw(root);
    writeSampleSprintYaml(sprintsDir, 1);
    writeSampleSprintYaml(sprintsDir, 2);

    const result = await generatePlanSummary({ workspaceRoot: root });
    assert.ok(result.written, 'Expected the file to be written');
    assert.ok(result.yaml.includes('sprints: 2'), 'Expected 2 sprints in totals');
    assert.ok(result.yaml.includes('tasks: 2'), 'Expected 2 tasks in totals');
    assert.ok(fs.existsSync(result.outputPath), 'Expected output file to exist');
  });

  test('generator is idempotent — second call skips the write', async () => {
    const root = makeTmp('autoclaw-plansum-idem-');
    const { sprintsDir } = scaffoldAutoclaw(root);
    writeSampleSprintYaml(sprintsDir, 1);

    const r1 = await generatePlanSummary({ workspaceRoot: root });
    assert.ok(r1.written, 'First call should write');

    const r2 = await generatePlanSummary({ workspaceRoot: root });
    assert.strictEqual(r2.written, false, 'Second call with identical content should skip write');
    assert.strictEqual(r1.yaml, r2.yaml, 'YAML content must be identical');
  });

  test('generator handles empty sprints directory gracefully', async () => {
    const root = makeTmp('autoclaw-plansum-empty-');
    scaffoldAutoclaw(root);

    const result = await generatePlanSummary({ workspaceRoot: root });
    // Even with no sprint YAMLs it should produce a valid (but minimal) file.
    assert.ok(result.yaml.includes('project:'));
    assert.ok(result.yaml.includes('sprints: 0'));
  });
});

// ---------------------------------------------------------------------------
// SprintMarkdownGenerator — A7 (idempotent)
// ---------------------------------------------------------------------------

suite('SprintMarkdownGenerator — A7', () => {

  const SAMPLE_SPRINT_1_YAML = [
    'sprint: 1',
    'level: 0',
    'status: pending',
    'description: "Foundation"',
    'depends_on_sprints: []',
    'estimated_days: 5',
    'assignments:',
    '  - agent: WA-2',
    '    role: "Watchdog & Reconciliation"',
    '    branch: feat/sprint-1-wa2-watchdog-reconcile',
    '    tasks:',
    '      - id: A3',
    '        name: "Replace sleep(30) with watchdog"',
    '        status: pending',
    '        subtasks:',
    '          - "Integrate chokidar"',
    '          - "5-min heartbeat tick"',
    '    scope:',
    '      - "src/daemon/watcher.ts"',
    '',
  ].join('\n');

  test('generates markdown with sprint header and task list', async () => {
    const root = makeTmp('autoclaw-sprintmd-');
    const { sprintsDir } = scaffoldAutoclaw(root);
    fs.writeFileSync(path.join(sprintsDir, 'sprint-1.yaml'), SAMPLE_SPRINT_1_YAML, 'utf8');

    const result = await generateSprintMarkdown(sprintsDir, 1);
    assert.ok(result.written, 'Should write the file on first call');
    assert.ok(result.markdown.includes('# Sprint 1'), 'Should include sprint header');
    assert.ok(result.markdown.includes('WA-2'), 'Should include agent name');
    assert.ok(result.markdown.includes('A3'), 'Should include task ID A3');
    assert.ok(result.markdown.includes('Integrate chokidar'), 'Should include subtask text');
  });

  test('generator is idempotent — second call skips the write', async () => {
    const root = makeTmp('autoclaw-sprintmd-idem-');
    const { sprintsDir } = scaffoldAutoclaw(root);
    fs.writeFileSync(path.join(sprintsDir, 'sprint-1.yaml'), SAMPLE_SPRINT_1_YAML, 'utf8');

    const r1 = await generateSprintMarkdown(sprintsDir, 1);
    assert.ok(r1.written, 'First call should write the file');

    const r2 = await generateSprintMarkdown(sprintsDir, 1);
    assert.strictEqual(r2.written, false, 'Second call with unchanged YAML should skip write');
    assert.strictEqual(r1.markdown, r2.markdown, 'Markdown must be identical between calls');
  });

  test('generated markdown includes branch and scope references', async () => {
    const root = makeTmp('autoclaw-sprintmd-scope-');
    const { sprintsDir } = scaffoldAutoclaw(root);
    fs.writeFileSync(path.join(sprintsDir, 'sprint-1.yaml'), SAMPLE_SPRINT_1_YAML, 'utf8');

    const result = await generateSprintMarkdown(sprintsDir, 1);
    assert.ok(result.markdown.includes('feat/sprint-1-wa2-watchdog-reconcile'), 'Should include branch name');
    assert.ok(result.markdown.includes('src/daemon/watcher.ts'), 'Should include scope file');
  });

  test('completed tasks render with [x] checkbox', async () => {
    const root = makeTmp('autoclaw-sprintmd-done-');
    const { sprintsDir } = scaffoldAutoclaw(root);
    // Match the 8-space task-level status (NOT the sprint-level status also says "pending").
    const doneYaml = SAMPLE_SPRINT_1_YAML.replace(/        status: pending/, '        status: merged');
    fs.writeFileSync(path.join(sprintsDir, 'sprint-1.yaml'), doneYaml, 'utf8');

    const result = await generateSprintMarkdown(sprintsDir, 1);
    assert.ok(result.markdown.includes('[x]'), 'Merged task should render as [x]');
  });
});
