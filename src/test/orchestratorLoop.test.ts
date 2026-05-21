import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  healthCheck,
  vendorFromId,
  writeLoopJournal,
  readLoopJournal,
  writeLoopState,
  readPersistedLoopState,
  dispatchWork,
  buildWorkLoopPrompt,
  runTick,
  getAgentRegistry,
  startOrchestratorLoop,
  COMMS_DIR_REL,
  HEARTBEATS_DIR_REL,
  SHARED_INBOX_REL,
  LOOP_JOURNAL_REL,
  LOOP_STATE_REL,
  LOOP_SIDE_CAR_DIR,
  DEFAULT_TICK_MS,
  HEALTHY_MS,
  STALLED_MS,
  type HealthCheckResult,
  type LoopState,
  type WorkPackage,
} from '../orchestratorLoop';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `autoclaw-loop-${prefix}-`));
  fs.mkdirSync(path.join(d, '.autoclaw', 'orchestrator', 'comms', 'heartbeats'), { recursive: true });
  fs.mkdirSync(path.join(d, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(d, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'agent-a'), { recursive: true });
  fs.mkdirSync(path.join(d, '.autoclaw', 'orchestrator', 'sprints'), { recursive: true });
  return d;
}

function writeHeartbeat(workspaceRoot: string, agentId: string, ageMs: number): void {
  const hbDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'heartbeats');
  fs.mkdirSync(hbDir, { recursive: true });
  const ts = new Date(Date.now() - ageMs).toISOString();
  const hb = { agent_id: agentId, timestamp: ts, status: 'active', sprint: 1, current_task: null, session_id: 'test-sess' };
  fs.writeFileSync(path.join(hbDir, `${agentId}.json`), JSON.stringify(hb, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// vendorFromId
// ---------------------------------------------------------------------------

suite('vendorFromId', () => {
  test('returns kilocode for "kilocode"', () => {
    assert.strictEqual(vendorFromId('kilocode'), 'kilocode');
  });

  test('returns claude-code for "claude-code"', () => {
    assert.strictEqual(vendorFromId('claude-code'), 'claude-code');
  });

  test('returns kiro for "kiro"', () => {
    assert.strictEqual(vendorFromId('kiro'), 'kiro');
  });

  test('returns cursor for "cursor"', () => {
    assert.strictEqual(vendorFromId('cursor'), 'cursor');
  });

  test('returns antigravity for "antigravity"', () => {
    assert.strictEqual(vendorFromId('antigravity'), 'antigravity');
  });

  test('returns other for unknown agent', () => {
    assert.strictEqual(vendorFromId('some-random-agent'), 'other');
  });
});

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

suite('Path constants', () => {
  test('COMMS_DIR_REL is well-formed', () => {
    assert.ok(COMMS_DIR_REL.includes('.autoclaw'));
    assert.ok(COMMS_DIR_REL.includes('comms'));
  });

  test('HEARTBEATS_DIR_REL starts with COMMS_DIR_REL', () => {
    assert.ok(HEARTBEATS_DIR_REL.startsWith(COMMS_DIR_REL));
    assert.ok(HEARTBEATS_DIR_REL.includes('heartbeats'));
  });

  test('SHARED_INBOX_REL starts with COMMS_DIR_REL', () => {
    assert.ok(SHARED_INBOX_REL.startsWith(COMMS_DIR_REL));
    assert.ok(SHARED_INBOX_REL.includes('shared'));
  });

  test('LOOP_JOURNAL_REL ends with .jsonl', () => {
    assert.ok(LOOP_JOURNAL_REL.endsWith('.jsonl'));
  });

  test('LOOP_STATE_REL ends with .json', () => {
    assert.ok(LOOP_STATE_REL.endsWith('.json'));
  });

  test('DEFAULT_TICK_MS is 30000', () => {
    assert.strictEqual(DEFAULT_TICK_MS, 30_000);
  });

  test('HEALTHY_MS is 60000', () => {
    assert.strictEqual(HEALTHY_MS, 60_000);
  });

  test('STALLED_MS is 300000', () => {
    assert.strictEqual(STALLED_MS, 300_000);
  });
});

// ---------------------------------------------------------------------------
// healthCheck
// ---------------------------------------------------------------------------

suite('healthCheck', () => {
  test('empty workspace returns empty result', async () => {
    const root = makeTmp('health-empty');
    const result = await healthCheck(root);
    assert.strictEqual(result.entries.length, 0);
    assert.strictEqual(result.healthyCount, 0);
  });

  test('fresh heartbeat → alive', async () => {
    const root = makeTmp('health-alive');
    writeHeartbeat(root, 'agent-a', 10_000);  // 10 s ago
    const result = await healthCheck(root);
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.entries[0].agentId, 'agent-a');
    assert.strictEqual(result.entries[0].state, 'alive');
    assert.strictEqual(result.healthyCount, 1);
  });

  test('stale heartbeat (> STALLED_MS) → stalled', async () => {
    const root = makeTmp('health-stalled');
    writeHeartbeat(root, 'agent-a', STALLED_MS + 10_00);
    const result = await healthCheck(root);
    assert.strictEqual(result.entries[0].state, 'stalled');
    assert.ok(result.stalledIds.includes('agent-a'));
  });

  test('very stale heartbeat (> STALLED_MS * 3) → dead', async () => {
    const root = makeTmp('health-dead');
    writeHeartbeat(root, 'agent-a', STALLED_MS * 3 + 10_00);
    const result = await healthCheck(root);
    assert.strictEqual(result.entries[0].state, 'dead');
    assert.ok(result.deadIds.includes('agent-a'));
  });

  test('mid-age heartbeat → degraded', async () => {
    const root = makeTmp('health-degraded');
    writeHeartbeat(root, 'agent-a', HEALTHY_MS + 10_00);
    const result = await healthCheck(root);
    assert.strictEqual(result.entries[0].state, 'degraded');
  });

  test('session heartbeat files are skipped', async () => {
    const root = makeTmp('health-session-skip');
    writeHeartbeat(root, 'agent-a', 10_000);
    // Write a session-level heartbeat (agent-a-session123.json)
    const hbDir = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'heartbeats');
    fs.writeFileSync(
      path.join(hbDir, 'agent-a-sess-abc.json'),
      JSON.stringify({ agent_id: 'agent-a', timestamp: new Date().toISOString(), status: 'active' }),
      'utf8'
    );
    const result = await healthCheck(root);
    // Only the primary file should be counted
    assert.strictEqual(result.entries.length, 1);
  });

  test('multiple agents are all detected', async () => {
    const root = makeTmp('health-multi');
    writeHeartbeat(root, 'agent-a', 10_000);
    writeHeartbeat(root, 'agent-b', 20_000);
    writeHeartbeat(root, 'agent-c', STALLED_MS + 10_00);
    const result = await healthCheck(root);
    assert.strictEqual(result.entries.length, 3);
    assert.strictEqual(result.healthyCount, 2);
    assert.strictEqual(result.stalledIds.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Loop journal
// ---------------------------------------------------------------------------

suite('Loop journal', () => {
  test('writeLoopJournal appends entries', async () => {
    const root = makeTmp('journal-write');
    await writeLoopJournal(root, { at: new Date().toISOString(), tick: 1, phase: 'health', action: 'test' });
    await writeLoopJournal(root, { at: new Date().toISOString(), tick: 2, phase: 'dispatch', action: 'test2' });
    const entries = await readLoopJournal(root);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].action, 'test');
    assert.strictEqual(entries[1].action, 'test2');
  });

  test('readLoopJournal returns empty for missing file', async () => {
    const root = makeTmp('journal-missing');
    const entries = await readLoopJournal(root);
    assert.strictEqual(entries.length, 0);
  });

  test('readLoopJournal caps at maxLines', async () => {
    const root = makeTmp('journal-cap');
    for (let i = 0; i < 10; i++) {
      await writeLoopJournal(root, { at: new Date().toISOString(), tick: i, phase: 'log', action: `entry-${i}` });
    }
    const entries = await readLoopJournal(root, 5);
    assert.strictEqual(entries.length, 5);
    assert.strictEqual(entries[0].action, 'entry-5');
    assert.strictEqual(entries[4].action, 'entry-9');
  });
});

// ---------------------------------------------------------------------------
// Loop state persistence
// ---------------------------------------------------------------------------

suite('Loop state persistence', () => {
  test('write + read round-trips', async () => {
    const root = makeTmp('state-roundtrip');
    const state: LoopState = {
      tick: 42, startedAt: '2026-01-01T00:00:00Z', lastTickAt: '2026-01-01T01:00:00Z',
      totalAgentsSeen: 3, totalTicks: 100, totalErrors: 0, totalDispatches: 5,
      vendorStats: { kilocode: { dispatched: 3, errors: 0 }, 'claude-code': { dispatched: 2, errors: 0 } },
    };
    await writeLoopState(root, state);
    const loaded = await readPersistedLoopState(root);
    assert.strictEqual(loaded.tick, 42);
    assert.strictEqual(loaded.totalAgentsSeen, 3);
    assert.strictEqual(loaded.totalDispatches, 5);
    assert.deepStrictEqual(loaded.vendorStats, state.vendorStats);
  });

  test('readPersistedLoopState returns fresh state for missing file', async () => {
    const root = makeTmp('state-missing');
    const loaded = await readPersistedLoopState(root);
    assert.strictEqual(loaded.tick, 0);
    assert.strictEqual(loaded.totalErrors, 0);
  });
});

// ---------------------------------------------------------------------------
// buildWorkLoopPrompt
// ---------------------------------------------------------------------------

suite('buildWorkLoopPrompt', () => {
  function makePkg(): WorkPackage {
    return {
      type: 'work_package', taskId: 'T1', taskName: 'Fix the thing',
      description: 'A test task', filePaths: ['src/foo.ts'],
      successCriteria: ['Tests pass', 'Lint clean'],
      sprint: 1, assignToVendor: 'kilocode', priority: 'high', timeBudgetMs: 3_600_000,
    };
  }

  test('includes task id and name', () => {
    const prompt = buildWorkLoopPrompt(makePkg());
    assert.ok(prompt.includes('T1'));
    assert.ok(prompt.includes('Fix the thing'));
  });

  test('includes file paths', () => {
    const prompt = buildWorkLoopPrompt(makePkg());
    assert.ok(prompt.includes('src/foo.ts'));
  });

  test('includes success criteria', () => {
    const prompt = buildWorkLoopPrompt(makePkg());
    assert.ok(prompt.includes('Tests pass'));
    assert.ok(prompt.includes('Lint clean'));
  });

  test('includes nested loop lifecycle instructions', () => {
    const prompt = buildWorkLoopPrompt(makePkg());
    assert.ok(prompt.includes('Nested Loop Lifecycle'));
    assert.ok(prompt.includes('task_complete'));
  });
});

// ---------------------------------------------------------------------------
// dispatchWork
// ---------------------------------------------------------------------------

suite('dispatchWork', () => {
  test('writes sidecar and returns path', async () => {
    const root = makeTmp('dispatch-sidecar');
    const pkg: WorkPackage = {
      type: 'work_package', taskId: 'T1', taskName: 'Test task',
      description: 'A test', filePaths: [], successCriteria: ['pass'],
      sprint: 1, assignToVendor: 'kilocode', priority: 'low', timeBudgetMs: 0,
    };
    const sidecarPath = await dispatchWork(root, pkg);
    assert.ok(sidecarPath !== null);
    assert.ok(fs.existsSync(sidecarPath!));
    const record = JSON.parse(fs.readFileSync(sidecarPath!, 'utf8'));
    assert.strictEqual(record.taskId, 'T1');
    assert.strictEqual(record.vendor, 'kilocode');
  });

  test('writes task_claim to shared inbox', async () => {
    const root = makeTmp('dispatch-claim');
    const pkg: WorkPackage = {
      type: 'work_package', taskId: 'T2', taskName: 'Claim test',
      description: 'A test', filePaths: [], successCriteria: ['pass'],
      sprint: 1, assignToVendor: 'claude-code', priority: 'medium', timeBudgetMs: 0,
    };
    await dispatchWork(root, pkg);
    const sharedInbox = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared');
    const files = fs.readdirSync(sharedInbox).filter(f => f.endsWith('.json'));
    assert.ok(files.length > 0, 'Expected at least one message in shared inbox');
    const msg = JSON.parse(fs.readFileSync(path.join(sharedInbox, files[0]), 'utf8'));
    assert.strictEqual(msg.type, 'task_claim');
    assert.strictEqual(msg.task_id, 'T2');
  });
});

// ---------------------------------------------------------------------------
// getAgentRegistry
// ---------------------------------------------------------------------------

suite('getAgentRegistry', () => {
  test('returns empty for missing registry', async () => {
    const root = makeTmp('registry-missing');
    const health: HealthCheckResult = { entries: [], stalledIds: [], deadIds: [], healthyCount: 0, idleCount: 0 };
    const agents = await getAgentRegistry(root, health);
    assert.strictEqual(agents.length, 0);
  });

  test('joins registry with health data', async () => {
    const root = makeTmp('registry-join');
    writeHeartbeat(root, 'agent-a', 10_000);
    const registryPath = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'registry.json');
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({
      agents: [{ id: 'agent-a', inbox_path: '.autoclaw/orchestrator/comms/inboxes/agent-a/' }],
    }), 'utf8');
    const health = await healthCheck(root);
    const agents = await getAgentRegistry(root, health);
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].id, 'agent-a');
    assert.strictEqual(agents[0].state, 'alive');
  });
});

// ---------------------------------------------------------------------------
// runTick
// ---------------------------------------------------------------------------

suite('runTick', () => {
  test('runs a tick and returns a result', async () => {
    const root = makeTmp('tick-basic');
    writeHeartbeat(root, 'agent-a', 10_000);
    const state: LoopState = {
      tick: 0, startedAt: new Date().toISOString(), lastTickAt: null,
      totalAgentsSeen: 0, totalTicks: 0, totalErrors: 0, totalDispatches: 0,
      vendorStats: {},
    };
    const result = await runTick(root, state);
    assert.strictEqual(result.tick, 1);
    assert.ok(result.durationMs >= 0);
    assert.strictEqual(result.errors, 0);
  });

  test('persists loop state after tick', async () => {
    const root = makeTmp('tick-persist');
    const state: LoopState = {
      tick: 0, startedAt: new Date().toISOString(), lastTickAt: null,
      totalAgentsSeen: 0, totalTicks: 0, totalErrors: 0, totalDispatches: 0,
      vendorStats: {},
    };
    await runTick(root, state);
    const statePath = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'loop-state.json');
    assert.ok(fs.existsSync(statePath));
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(saved.tick, 1);
  });

  test('writes journal entries during tick', async () => {
    const root = makeTmp('tick-journal');
    const state: LoopState = {
      tick: 0, startedAt: new Date().toISOString(), lastTickAt: null,
      totalAgentsSeen: 0, totalTicks: 0, totalErrors: 0, totalDispatches: 0,
      vendorStats: {},
    };
    await runTick(root, state);
    const journalPath = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'loop-journal.jsonl');
    assert.ok(fs.existsSync(journalPath));
    const raw = fs.readFileSync(journalPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.ok(lines.length >= 2, 'Expected at least start + complete journal entries');
  });
});

// ---------------------------------------------------------------------------
// startOrchestratorLoop lifecycle
// ---------------------------------------------------------------------------

suite('startOrchestratorLoop lifecycle', () => {
  test('starts and stops cleanly', () => {
    const handle = startOrchestratorLoop({ workspaceRoot: '', tickMs: 60_000 });
    assert.strictEqual(handle.isRunning(), true);
    handle.stop();
    assert.strictEqual(handle.isRunning(), false);
  });

  test('getState reflects state after initial kick', () => {
    const handle = startOrchestratorLoop({ workspaceRoot: '', tickMs: 60_000 });
    const state = handle.getState();
    // The immediate kick() increments tick by 1
    assert.ok(state.tick >= 0);
    assert.strictEqual(state.totalErrors, 0);
    handle.stop();
  });

  test('double-stop is safe', () => {
    const handle = startOrchestratorLoop({ workspaceRoot: '', tickMs: 60_000 });
    handle.stop();
    handle.stop(); // should not throw
    assert.strictEqual(handle.isRunning(), false);
  });
});
