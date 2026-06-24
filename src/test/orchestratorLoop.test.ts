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
  discoverWork,
  readClaimedAgentIds,
  readRecentNextDispatches,
  gcStaleNextDispatches,
  NEXT_DISPATCH_TTL_MS,
  buildWorkLoopPrompt,
  runTick,
  LOOP_INSTANCE_ID,
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
import { detectAutoclawHostAgent } from '../comms';

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

  test('grounding section points to a context pack file when set', () => {
    const pkg = { ...makePkg(), contextPackPath: '.autoclaw/orchestrator/sprints/T1.context.md' };
    const prompt = buildWorkLoopPrompt(pkg);
    assert.ok(prompt.includes('### Grounding — Context Pack'));
    assert.ok(prompt.includes('T1.context.md'), 'references the pack path');
    assert.ok(prompt.includes('Read `'), 'instructs the agent to read it first');
  });

  test('grounding section falls back to pull-on-demand when no pack path', () => {
    const prompt = buildWorkLoopPrompt(makePkg());
    assert.ok(prompt.includes('### Grounding — Context Pack'));
    assert.ok(prompt.includes('intelligence.contextPack'), 'mentions the MCP pull tool');
    assert.ok(prompt.includes('context-pack.js'), 'mentions the CLI fallback');
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

  test('AF-8 §3: dispatch to an assistant-typed agent is GATED (no sidecar, audit allowed:false)', async () => {
    const root = makeTmp('dispatch-gated');
    const commsDir = path.join(root, '.autoclaw', 'orchestrator', 'comms');
    fs.mkdirSync(commsDir, { recursive: true });
    fs.writeFileSync(path.join(commsDir, 'registry.json'), JSON.stringify({
      agents: [{ id: 'cursor', agent_type: 'assistant' }], ide: 'x', provisioned_at: 't',
    }));
    const pkg: WorkPackage = {
      type: 'work_package', taskId: 'G1', taskName: 'assistant task', description: '', filePaths: [],
      successCriteria: ['pass'], sprint: 1, assignToVendor: 'cursor', priority: 'low', timeBudgetMs: 0,
    };
    const res = await dispatchWork(root, pkg);
    assert.strictEqual(res, null, 'human-in-loop type ⇒ gated, no dispatch');
    const { readAuditLog } = await import('../fabric/governance');
    const rows = await readAuditLog(path.join(root, '.autoclaw'));
    assert.ok(rows.some(r => r.task_id === 'G1' && r.allowed === false), 'allowed:false audit row written');
  });

  test('AF-8 §3: dispatch to a coder agent proceeds + writes an allowed:true audit row', async () => {
    const root = makeTmp('dispatch-allowed');
    const pkg: WorkPackage = {
      type: 'work_package', taskId: 'G2', taskName: 'coder task', description: '', filePaths: [],
      successCriteria: ['pass'], sprint: 1, assignToVendor: 'kilocode', priority: 'low', timeBudgetMs: 0,
    };
    const res = await dispatchWork(root, pkg); // no registry agent_type ⇒ coder ⇒ allowed
    assert.ok(res !== null);
    const { readAuditLog } = await import('../fabric/governance');
    const rows = await readAuditLog(path.join(root, '.autoclaw'));
    assert.ok(rows.some(r => r.task_id === 'G2' && r.allowed === true), 'allowed:true audit row written');
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

function writeForeignLease(ws: string, holder = 'other-loop'): void {
  const now = Date.now();
  const lease = {
    holder,
    acquired_at: new Date(now - 5_000).toISOString(),
    heartbeat: new Date(now).toISOString(),       // fresh ⇒ not stale ⇒ we stand by
    expires: new Date(now + 90_000).toISOString(),
  };
  fs.writeFileSync(
    path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'supervisor.lock.json'),
    JSON.stringify(lease, null, 2), 'utf8',
  );
}
function boardJsonPath(ws: string): string {
  return path.join(ws, '.autoclaw', 'orchestrator', 'board.json');
}
function freshLoopStateForTest(): LoopState {
  return {
    tick: 0, startedAt: new Date().toISOString(), lastTickAt: null,
    totalAgentsSeen: 0, totalTicks: 0, totalErrors: 0, totalDispatches: 0, vendorStats: {},
  };
}

suite('L1: single-active manager gate', () => {
  test('a standby host (foreign fresh lease) does NOT write the board when singleActive', async () => {
    const root = makeTmp('l1-standby');
    try {
      writeForeignLease(root);
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true });
      assert.strictEqual(r.errors, 0);
      assert.strictEqual(fs.existsSync(boardJsonPath(root)), false, 'standby must not write board.json');
      const journal = fs.readFileSync(
        path.join(root, '.autoclaw', 'orchestrator', 'comms', 'loop-journal.jsonl'), 'utf8');
      assert.ok(journal.includes('manager_standby'), 'standby deferral is journalled');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('the same standby DOES write the board when singleActive is off (legacy)', async () => {
    const root = makeTmp('l1-legacy');
    try {
      writeForeignLease(root);
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: false });
      assert.strictEqual(r.errors, 0);
      assert.strictEqual(fs.existsSync(boardJsonPath(root)), true, 'legacy mode writes board on every host');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a solo host wins the lease and writes the board (default singleActive=true), no orphan temps', async () => {
    const root = makeTmp('l1-solo');
    try {
      const r = await runTick(root, freshLoopStateForTest(), {}); // default singleActive: true
      assert.strictEqual(r.errors, 0);
      assert.strictEqual(fs.existsSync(boardJsonPath(root)), true, 'solo host is supervisor → writes board');
      const orchDir = path.join(root, '.autoclaw', 'orchestrator');
      const leftovers = fs.readdirSync(orchDir).filter(f => f.includes('.tmp-'));
      assert.deepStrictEqual(leftovers, [], 'atomic publish leaves no orphan temp files');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // The HEADLINE fix: a standby must DISCOVER nothing, so two windows sharing a
  // project can't double-dispatch the same idle agent. Proven spawn-free: a
  // positive control shows the idle live agent IS discoverable, then the standby
  // tick gates `workFound` to [] anyway. (We assert on discovery, not real
  // dispatch — dispatchWork opens a KG handle and is exercised elsewhere.)
  // Deleting the `isActiveManager ? discoverWork(...) : []` guard fails this test.
  test('a standby gates discovery to [] even when an idle live agent is discoverable', async () => {
    const root = makeTmp('l1-disp-standby');
    try {
      writeHeartbeat(root, 'agent-a', 5_000); // fresh ⇒ alive + idle ⇒ discoverable
      // Positive control: prove the fixture really is discoverable (not an empty
      // result that would make the standby assertion vacuous).
      const health = await healthCheck(root);
      const discoverable = await discoverWork(root, health);
      assert.ok(discoverable.length >= 1, 'fixture sanity: an idle live agent is discoverable');
      // Standby: runTick must gate discovery to [] despite the discoverable agent.
      writeForeignLease(root);
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true });
      assert.strictEqual(r.errors, 0);
      assert.strictEqual(r.workFound.length, 0, 'standby gates discovery to [] despite a discoverable agent');
      assert.strictEqual(r.dispatched, 0, 'standby dispatches nothing');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // Proves a SECOND gated write phase (L0 task-catalog ingest) is also single-active:
  // a standby leaves state.json untouched; a solo supervisor materializes the catalog.
  test('a standby does NOT ingest the task catalog; a solo supervisor does', async () => {
    const SPRINT = [
      'sprint: 1', 'status: assigned', 'assignments:', '  - agent: WA-1', '    tasks:',
      '      - id: B1', '        name: "x"', '        status: pending', '    branch: b',
    ].join('\n');
    const statePath = (ws: string): string => path.join(ws, '.autoclaw', 'orchestrator', 'state.json');

    const standby = makeTmp('l1-ingest-standby');
    try {
      fs.writeFileSync(path.join(standby, '.autoclaw', 'orchestrator', 'sprints', 'sprint-1.yaml'), SPRINT, 'utf8');
      writeForeignLease(standby);
      await runTick(standby, freshLoopStateForTest(), { singleActive: true });
      assert.strictEqual(fs.existsSync(statePath(standby)), false, 'standby must not materialize state.tasks');
    } finally { fs.rmSync(standby, { recursive: true, force: true }); }

    const solo = makeTmp('l1-ingest-solo');
    try {
      fs.writeFileSync(path.join(solo, '.autoclaw', 'orchestrator', 'sprints', 'sprint-1.yaml'), SPRINT, 'utf8');
      await runTick(solo, freshLoopStateForTest(), { singleActive: true });
      const state = JSON.parse(fs.readFileSync(statePath(solo), 'utf8'));
      assert.deepStrictEqual(state.tasks.map((t: any) => t.id), ['B1'], 'solo supervisor materializes the catalog');
    } finally { fs.rmSync(solo, { recursive: true, force: true }); }
  });
});

suite('L3: wake idle peers (runTick integration)', () => {
  test('a solo supervisor writes a work_available nudge to an idle agent for a claimable task', async () => {
    const root = makeTmp('l3-wake');
    try {
      const orch = path.join(root, '.autoclaw', 'orchestrator');
      // A claimable task — seeded via a sprint YAML so the L0 catalog ingest (which
      // runs before writeBoard and would otherwise wipe a hand-seeded state.tasks)
      // materializes it into board.claimable.
      fs.writeFileSync(path.join(orch, 'sprints', 'sprint-1.yaml'), [
        'sprint: 1', 'status: assigned', 'assignments:', '  - agent: WA-1', '    tasks:',
        '      - id: T1', '        name: "Do T1"', '        status: pending', '    branch: b',
      ].join('\n'), 'utf8');
      fs.writeFileSync(path.join(orch, 'comms', 'registry.json'), JSON.stringify({
        agents: [{ id: 'kiro', agent_type: 'coder', capabilities: ['code'], trust_level: 'high' }],
      }, null, 2), 'utf8');
      writeHeartbeat(root, 'kiro', 5_000); // fresh ⇒ alive + idle

      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true });
      assert.strictEqual(r.errors, 0);

      const inbox = path.join(orch, 'comms', 'inboxes', 'kiro');
      const msgs = (fs.existsSync(inbox) ? fs.readdirSync(inbox) : [])
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8')));
      const wa = msgs.find((m: any) => m.type === 'work_available');
      assert.ok(wa, 'idle agent got a work_available nudge');
      assert.strictEqual(wa.task_id, 'T1');
      assert.strictEqual(wa.payload.board_grounded, true);
      assert.ok(wa.expires_at, 'nudge carries an expiry');

      const journal = fs.readFileSync(path.join(orch, 'comms', 'loop-journal.jsonl'), 'utf8');
      assert.ok(journal.includes('work_available_nudged'), 'the nudge is journalled');
    } finally {
      // dispatchWork opens a KG handle that can briefly lock the temp dir on Windows.
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

suite('E2b-ii: START LOOP monitor roster (runTick, fencing)', () => {
  function clusterMap(ws: string): any {
    return JSON.parse(fs.readFileSync(path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'cluster-map.json'), 'utf8'));
  }
  function monitorsDir(ws: string): string {
    return path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'monitors');
  }
  function seedPeerMonitor(ws: string, id: string): void {
    fs.mkdirSync(monitorsDir(ws), { recursive: true });
    // Fresh wall-clock timestamp so it is live when runTick reads at its own now.
    fs.writeFileSync(path.join(monitorsDir(ws), `${id}.json`), JSON.stringify({ instance_id: id, timestamp: new Date().toISOString() }), 'utf8');
  }

  test('a solo fenced host records ITSELF as the sole monitor (quorum-of-one)', async () => {
    const root = makeTmp('e2b-solo');
    try {
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true });
      assert.strictEqual(r.errors, 0);
      const m = clusterMap(root);
      assert.strictEqual(m.monitors.length, 1, 'self is the sole monitor');
      assert.strictEqual(m.monitors[0], m.active_manager.instance_id, 'the monitor IS self (the active manager)');
      assert.deepStrictEqual(m.standbys, [], 'no peers → no standbys');
      assert.strictEqual(m.quorum_size, 1, 'lone agent = quorum-of-one');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('a fenced active DISCOVERS a peer monitor and records it as a ranked standby (quorum 2)', async () => {
    const root = makeTmp('e2b-peer');
    try {
      seedPeerMonitor(root, 'loop-peer');
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true });
      assert.strictEqual(r.errors, 0);
      const m = clusterMap(root);
      const self = m.active_manager.instance_id;
      assert.deepStrictEqual([...m.monitors].sort(), [self, 'loop-peer'].sort(), 'both monitors recorded (self + peer)');
      assert.deepStrictEqual(m.standbys.map((s: any) => s.instance_id), ['loop-peer'], 'the peer is a standby; self (active) is excluded');
      assert.strictEqual(m.quorum_size, 2, 'majority quorum of 2 monitors = floor(2/2)+1 = 2');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('with fencing OFF the START LOOP is inert — no monitor presence, empty roster (E2b opt-in)', async () => {
    const root = makeTmp('e2b-off');
    try {
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true }); // no fencing
      assert.strictEqual(r.errors, 0);
      assert.deepStrictEqual(clusterMap(root).monitors, [], 'fencing off → no monitors projected');
      assert.ok(!fs.existsSync(monitorsDir(root)), 'no presence written when fencing off');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('a STALE peer presence is EXCLUDED from the roster through runTick (quorum stays 1)', async () => {
    const root = makeTmp('e2b-stale');
    try {
      fs.mkdirSync(monitorsDir(root), { recursive: true });
      // 200s old ≫ the 90s presence TTL → must be dropped before projection.
      fs.writeFileSync(path.join(monitorsDir(root), 'loop-stale.json'),
        JSON.stringify({ instance_id: 'loop-stale', timestamp: new Date(Date.now() - 200_000).toISOString() }), 'utf8');
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true });
      assert.strictEqual(r.errors, 0);
      const m = clusterMap(root);
      assert.deepStrictEqual(m.monitors, [m.active_manager.instance_id], 'stale peer absent → only self is a monitor');
      assert.deepStrictEqual(m.standbys, [], 'stale peer is not a standby');
      assert.strictEqual(m.quorum_size, 1, 'a stale peer does not inflate the quorum');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('runTick GCs a long-dead presence file (prune is wired into the loop)', async () => {
    const root = makeTmp('e2b-prune');
    try {
      fs.mkdirSync(monitorsDir(root), { recursive: true });
      const deadFile = path.join(monitorsDir(root), 'loop-crashed.json');
      // 1000s old ≫ the 10×TTL = 900s reaping threshold → runTick must unlink it.
      fs.writeFileSync(deadFile, JSON.stringify({ instance_id: 'loop-crashed', timestamp: new Date(Date.now() - 1_000_000).toISOString() }), 'utf8');
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true });
      assert.strictEqual(r.errors, 0);
      assert.ok(!fs.existsSync(deadFile), 'the long-dead presence file was reaped by runTick');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('a fenced STANDBY (behind a fresh foreign lease) still writes its OWN presence but persists NO roster', async () => {
    const root = makeTmp('e2b-standby');
    try {
      writeForeignLease(root); // a fresh foreign supervisor.lock.json → this host stands by
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true });
      assert.strictEqual(r.errors, 0);
      // Presence IS written on a standby (so the active manager can discover it).
      const presFiles = fs.existsSync(monitorsDir(root)) ? fs.readdirSync(monitorsDir(root)).filter((f) => f.endsWith('.json')) : [];
      assert.strictEqual(presFiles.length, 1, 'the standby wrote its own presence (discoverable)');
      // But a standby persists NO cluster map / roster (its fenced acquire stands by).
      assert.ok(!fs.existsSync(path.join(root, '.autoclaw', 'orchestrator', 'comms', 'cluster-map.json')), 'standby wrote no cluster map');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('a steady fenced roster does NOT churn the epoch across two ticks (the load-bearing no-churn property)', async () => {
    const root = makeTmp('e2b-nochurn');
    try {
      seedPeerMonitor(root, 'loop-peer');
      const state = freshLoopStateForTest();
      await runTick(root, state, { singleActive: true, fencing: true });
      const e1 = clusterMap(root).epoch;
      await runTick(root, state, { singleActive: true, fencing: true }); // same roster, peer still live
      const e2 = clusterMap(root).epoch;
      assert.strictEqual(e2, e1, 'a stable two-host roster must not advance the epoch every tick');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('multiple peers are recorded as standbys in a deterministic order (instance_id ASC under uniform score)', async () => {
    const root = makeTmp('e2b-multi');
    try {
      seedPeerMonitor(root, 'loop-peer-b');
      seedPeerMonitor(root, 'loop-peer-a');
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true });
      assert.strictEqual(r.errors, 0);
      const m = clusterMap(root);
      assert.deepStrictEqual(m.standbys.map((s: any) => s.instance_id), ['loop-peer-a', 'loop-peer-b'], 'deterministic ASC order');
      assert.strictEqual(m.quorum_size, 2, 'self + 2 peers = 3 monitors → majority 2');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });
});

suite('E3b: WAKE-ONLY cluster-map gossip (runTick)', () => {
  function gossipDir(ws: string): string {
    return path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'gossip', 'cluster-map');
  }
  function clusterMap(ws: string): any {
    return JSON.parse(fs.readFileSync(path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'cluster-map.json'), 'utf8'));
  }
  function seedPeerBeat(ws: string, peerId: string, epoch: number, term: number, activeId = peerId): void {
    fs.mkdirSync(gossipDir(ws), { recursive: true });
    const now = new Date().toISOString();
    const map = {
      version: 1, epoch, term,
      active_manager: { instance_id: activeId, acquired_at: now, lease_heartbeat: now, lease_expires: new Date(Date.now() + 90_000).toISOString() },
      standbys: [], monitors: [activeId], quorum_size: 1, fenced: [],
    };
    fs.writeFileSync(path.join(gossipDir(ws), `${peerId}.json`), JSON.stringify({ origin: peerId, emittedAt: now, map }), 'utf8');
  }
  function journalOf(ws: string): string {
    const p = path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'loop-journal.jsonl');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }

  test('a gossip-enabled active host PUBLISHES its map beat to the gossip bus', async () => {
    const root = makeTmp('e3-pub');
    try {
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true, gossip: true });
      assert.strictEqual(r.errors, 0);
      const files = fs.existsSync(gossipDir(root)) ? fs.readdirSync(gossipDir(root)).filter((f) => f.endsWith('.json')) : [];
      assert.strictEqual(files.length, 1, 'the active manager published exactly one map beat');
      const b = JSON.parse(fs.readFileSync(path.join(gossipDir(root), files[0]), 'utf8'));
      assert.strictEqual(b.map.active_manager.instance_id, b.origin, 'the beat carries this host as the active');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('gossip OFF is INERT — no gossip dir is written (byte-identical to E2b)', async () => {
    const root = makeTmp('e3-off');
    try {
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true }); // no gossip
      assert.strictEqual(r.errors, 0);
      assert.ok(!fs.existsSync(path.join(root, '.autoclaw', 'orchestrator', 'comms', 'gossip')), 'no gossip dir when off');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('a STRICTLY-NEWER peer beat is journalled but does NOT change what the host writes (single-active preserved)', async () => {
    const root = makeTmp('e3-peer');
    try {
      // A fake peer beat claims a DIFFERENT active at a much higher epoch (e.g. a dead window).
      seedPeerBeat(root, 'loop-peer', 99, 9);
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true, gossip: true });
      assert.strictEqual(r.errors, 0);
      const journal = fs.readFileSync(path.join(root, '.autoclaw', 'orchestrator', 'comms', 'loop-journal.jsonl'), 'utf8');
      assert.ok(journal.includes('gossip_peer_newer'), 'the peer-newer discrepancy is journalled (observability)');
      // CRITICAL: gossip is advisory — the host (solo active) still wrote ITSELF, from DISK.
      const m = clusterMap(root);
      assert.notStrictEqual(m.active_manager.instance_id, 'loop-peer', 'gossip did NOT resurrect the (dead) peer as active');
      assert.ok(m.epoch < 99, 'the gossiped epoch 99 did NOT leak into the authoritative cluster map');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('no epoch churn across two steady gossip ticks (publish/read never bumps the cluster-map epoch)', async () => {
    const root = makeTmp('e3-nochurn');
    try {
      const state = freshLoopStateForTest();
      await runTick(root, state, { singleActive: true, fencing: true, gossip: true });
      const e1 = clusterMap(root).epoch;
      await runTick(root, state, { singleActive: true, fencing: true, gossip: true });
      assert.strictEqual(clusterMap(root).epoch, e1, 'gossip publish/read must not churn the cluster-map epoch');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('an EQUAL-or-OLDER peer beat is NOT journalled (only a STRICTLY-newer one is a takeover)', async () => {
    const root = makeTmp('e3-older');
    try {
      seedPeerBeat(root, 'loop-peer', 1, 1); // older than the solo host's own map (epoch >= 2 under fencing)
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true, gossip: true });
      assert.strictEqual(r.errors, 0);
      assert.ok(!journalOf(root).includes('gossip_peer_newer'), 'an older/equal peer beat is not a takeover signal');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('a strictly-newer peer beat naming THIS host as active is NOT journalled (self is not a takeover)', async () => {
    const root = makeTmp('e3-selfnamed');
    try {
      // A peer gossips a FRESHER map that still names US as the active — not a takeover.
      seedPeerBeat(root, 'loop-peer', 99, 9, LOOP_INSTANCE_ID);
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true, gossip: true });
      assert.strictEqual(r.errors, 0);
      assert.ok(!journalOf(root).includes('gossip_peer_newer'), 'a fresher map that still names self as active is not a takeover');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('a STANDBY (foreign fresh lease) with gossip ON publishes NO beat (only the active manager does)', async () => {
    const root = makeTmp('e3-standby-pub');
    try {
      writeForeignLease(root); // a fresh foreign lease → this host stands by
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true, gossip: true });
      assert.strictEqual(r.errors, 0);
      const files = fs.existsSync(gossipDir(root)) ? fs.readdirSync(gossipDir(root)).filter((f) => f.endsWith('.json')) : [];
      assert.strictEqual(files.length, 0, 'a standby publishes no map beat');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('a gossip failure is SWALLOWED (best-effort) — r.errors stays 0 and the acquire still wrote the map', async () => {
    const root = makeTmp('e3-besteffort');
    try {
      // Pre-create comms/gossip as a FILE so the gossip publish mkdir throws ENOTDIR.
      const comms = path.join(root, '.autoclaw', 'orchestrator', 'comms');
      fs.mkdirSync(comms, { recursive: true });
      fs.writeFileSync(path.join(comms, 'gossip'), 'not a dir', 'utf8');
      const r = await runTick(root, freshLoopStateForTest(), { singleActive: true, fencing: true, gossip: true });
      assert.strictEqual(r.errors, 0, 'a gossip failure must not leak into r.errors');
      assert.ok(fs.existsSync(path.join(comms, 'cluster-map.json')), 'the acquire still wrote the authoritative map');
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });
});

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

// ---------------------------------------------------------------------------
// HB-FIX stability: discoverWork dedup
// ---------------------------------------------------------------------------

function makeHealth(agentIds: string[]): HealthCheckResult {
  const entries = agentIds.map(id => ({
    agentId: id,
    vendor: id as any,
    state: 'alive' as const,
    lastHeartbeatAt: new Date().toISOString(),
    missedTicks: 0,
    hasUnreadMessages: false,
    unreadCount: 0,
    currentSprint: null,
    currentTask: null,
  }));
  return { entries, stalledIds: [], deadIds: [], healthyCount: entries.length, idleCount: entries.length };
}

suite('HB-FIX: discoverWork dedup', () => {
  test('readClaimedAgentIds returns empty when no claims dir', async () => {
    const root = makeTmp('dedup-empty');
    const out = await readClaimedAgentIds(root);
    assert.strictEqual(out.size, 0);
  });

  test('readClaimedAgentIds returns agents with active claims', async () => {
    const root = makeTmp('dedup-active');
    const claimsDir = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    fs.writeFileSync(path.join(claimsDir, 'HB-FIX.json'), JSON.stringify({
      task_ids: ['HB-FIX'], claimed_by: 'claude-code',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }), 'utf8');
    const out = await readClaimedAgentIds(root);
    assert.ok(out.has('claude-code'));
    assert.strictEqual(out.size, 1);
  });

  test('readClaimedAgentIds skips expired claims', async () => {
    const root = makeTmp('dedup-expired');
    const claimsDir = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    fs.writeFileSync(path.join(claimsDir, 'STALE.json'), JSON.stringify({
      claimed_by: 'kilocode',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }), 'utf8');
    const out = await readClaimedAgentIds(root);
    assert.strictEqual(out.size, 0);
  });

  test('readRecentNextDispatches finds next-<agent> within window', async () => {
    const root = makeTmp('dedup-recent');
    const shared = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared');
    fs.writeFileSync(
      path.join(shared, '2026-05-29T05-59-59-057Z-task_claim-next-claude-code.json'),
      JSON.stringify({ type: 'task_claim' }),
      'utf8'
    );
    const out = await readRecentNextDispatches(root, 60 * 60 * 1000);
    assert.ok(out.has('claude-code'));
  });

  test('discoverWork dispatches to truly idle agents', async () => {
    const root = makeTmp('discover-fresh');
    const work = await discoverWork(root, makeHealth(['claude-code']));
    assert.strictEqual(work.length, 1);
    assert.strictEqual(work[0].item.taskId, 'next-claude-code');
  });

  test('discoverWork skips agent with active claim', async () => {
    const root = makeTmp('discover-claimed');
    const claimsDir = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    fs.writeFileSync(path.join(claimsDir, 'X.json'), JSON.stringify({
      claimed_by: 'claude-code',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }), 'utf8');
    const work = await discoverWork(root, makeHealth(['claude-code', 'kilocode']));
    const ids = work.map(w => w.item.assignToVendor);
    assert.ok(!ids.includes('claude-code'), 'claimed agent must not be re-dispatched');
    assert.ok(ids.includes('kilocode'), 'unclaimed agent still gets work');
  });

  test('discoverWork skips agent in cooldown window', async () => {
    const root = makeTmp('discover-cooldown');
    const shared = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared');
    fs.writeFileSync(
      path.join(shared, '2026-05-29T05-59-59-057Z-task_claim-next-claude-code.json'),
      JSON.stringify({ type: 'task_claim' }),
      'utf8'
    );
    const work = await discoverWork(root, makeHealth(['claude-code']));
    assert.strictEqual(work.length, 0, 'agent in cooldown must not be re-spammed');
  });
});

// ---------------------------------------------------------------------------
// #1 dispatch GC/TTL: gcStaleNextDispatches
// ---------------------------------------------------------------------------

suite('gcStaleNextDispatches', () => {
  function sharedDir(root: string): string {
    return path.join(root, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared');
  }
  function writeNext(root: string, agent: string, fileTs: string, expiresAt?: string): string {
    const name = `${fileTs}-task_claim-next-${agent}.json`;
    const body: Record<string, unknown> = { type: 'task_claim', task_id: `next-${agent}` };
    if (expiresAt) { body.expires_at = expiresAt; }
    fs.writeFileSync(path.join(sharedDir(root), name), JSON.stringify(body), 'utf8');
    return name;
  }

  test('removes placeholders past their expires_at', async () => {
    const root = makeTmp('gc-expired');
    const name = writeNext(root, 'claude-code', '2026-05-29T00-00-00-000Z', new Date(Date.now() - 60_000).toISOString());
    const removed = await gcStaleNextDispatches(root);
    assert.strictEqual(removed, 1);
    assert.ok(!fs.existsSync(path.join(sharedDir(root), name)), 'expired placeholder reaped');
  });

  test('keeps a live placeholder', async () => {
    const root = makeTmp('gc-live');
    const name = writeNext(root, 'kilocode', '2026-05-29T00-00-01-000Z', new Date(Date.now() + 60_000).toISOString());
    const removed = await gcStaleNextDispatches(root);
    assert.strictEqual(removed, 0);
    assert.ok(fs.existsSync(path.join(sharedDir(root), name)), 'live placeholder kept');
  });

  test('coalesces duplicate live placeholders to the newest per agent', async () => {
    const root = makeTmp('gc-coalesce');
    const future = new Date(Date.now() + 60_000).toISOString();
    const older = writeNext(root, 'kiro', '2026-05-29T00-00-00-000Z', future);
    const newer = writeNext(root, 'kiro', '2026-05-29T00-05-00-000Z', future);
    // Make the "newer"-named file actually newer on disk so mtime ordering is deterministic.
    const newerPath = path.join(sharedDir(root), newer);
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(sharedDir(root), older), t - 10, t - 10);
    fs.utimesSync(newerPath, t, t);

    const removed = await gcStaleNextDispatches(root);
    assert.strictEqual(removed, 1, 'one duplicate coalesced');
    assert.ok(fs.existsSync(newerPath), 'newest kept');
    assert.ok(!fs.existsSync(path.join(sharedDir(root), older)), 'older duplicate removed');
  });

  test('reaps corrupt placeholder files', async () => {
    const root = makeTmp('gc-corrupt');
    const name = '2026-05-29T00-00-00-000Z-task_claim-next-codex.json';
    fs.writeFileSync(path.join(sharedDir(root), name), '{ not json', 'utf8');
    const removed = await gcStaleNextDispatches(root);
    assert.strictEqual(removed, 1);
  });

  test('legacy file without expires_at falls back to mtime + TTL', async () => {
    const root = makeTmp('gc-legacy');
    const name = writeNext(root, 'claude-code', '2026-05-29T00-00-00-000Z'); // no expires_at
    const p = path.join(sharedDir(root), name);
    const old = (Date.now() - NEXT_DISPATCH_TTL_MS - 60_000) / 1000;
    fs.utimesSync(p, old, old);
    const removed = await gcStaleNextDispatches(root);
    assert.strictEqual(removed, 1, 'legacy placeholder older than TTL reaped');
  });
});

// ---------------------------------------------------------------------------
// HB-FIX stability: detectAutoclawHostAgent (session_id ownership)
// ---------------------------------------------------------------------------

suite('HB-FIX: detectAutoclawHostAgent', () => {
  test('Antigravity host', () => assert.strictEqual(detectAutoclawHostAgent('Antigravity'), 'antigravity'));
  test('Kiro host',        () => assert.strictEqual(detectAutoclawHostAgent('Kiro'), 'kiro'));
  test('Cursor host',      () => assert.strictEqual(detectAutoclawHostAgent('Cursor'), 'cursor'));
  test('Windsurf host',    () => assert.strictEqual(detectAutoclawHostAgent('Windsurf'), 'windsurf'));
  test('Stock VS Code falls back to claude-code', () => {
    assert.strictEqual(detectAutoclawHostAgent('Visual Studio Code'), 'claude-code');
  });
  test('Empty appName falls back to claude-code', () => {
    assert.strictEqual(detectAutoclawHostAgent(''), 'claude-code');
  });
});
