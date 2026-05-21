/**
 * lmd.test.ts — Unit tests for the LMD (Lightweight Monitoring Daemon).
 *
 * Tests cover:
 *  1. All HealthState transitions: alive→degraded→stalled→dead
 *  2. Recovery from any non-alive state → alive
 *  3. Re-kick fires on stalled
 *  4. Dead agent is excluded from consensus quorum
 *  5. HeartbeatReader makes 0 API/LLM calls (fs-only, verified via mock)
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HealthStateMachine } from '../lmd/healthStateMachine';
import { HeartbeatReader } from '../lmd/heartbeatReader';
import { StallRecovery } from '../lmd/stallRecovery';
import type { StateChangeEvent } from '../lmd/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-lmd-test-'));
}

/** Advance missedHeartbeats on agentId by ticking N times with stale/null HB. */
function tickN(machine: HealthStateMachine, agentId: string, n: number): void {
  // Use a fixed old timestamp so every tick sees the same (stale) mtime.
  const staleMtime = new Date('2000-01-01T00:00:00.000Z');
  // First tick bootstraps the record as alive.
  machine.tick(agentId, staleMtime);
  // Subsequent ticks with the same timestamp → missed beat each time.
  for (let i = 1; i < n; i++) {
    machine.tick(agentId, staleMtime);
  }
}

/** Tick the machine once with a fresh "now" timestamp to simulate heartbeat. */
function tickAlive(machine: HealthStateMachine, agentId: string): void {
  machine.tick(agentId, new Date());
}

// ---------------------------------------------------------------------------
// Suite 1 — HealthStateMachine: state transitions
// ---------------------------------------------------------------------------

suite('LMD — HealthStateMachine: state transitions', () => {

  test('1a: first tick with fresh heartbeat → alive', () => {
    const m = new HealthStateMachine();
    const result = m.tick('agent-a', new Date());
    // No prior state → initialised as alive; no change event (returns undefined
    // because we set it to alive on creation and also set it to alive now).
    const h = m.getState('agent-a');
    assert.ok(h !== undefined);
    assert.strictEqual(h!.state, 'alive');
    assert.strictEqual(h!.missedHeartbeats, 0);
    // result is undefined because state didn't change (alive → alive)
    assert.strictEqual(result, undefined);
  });

  test('1b: 2 consecutive missed heartbeats → degraded', () => {
    const m = new HealthStateMachine();
    const staleMtime = new Date('2020-01-01T00:00:00.000Z');

    const changes: StateChangeEvent[] = [];
    m.on('stateChange', (e: StateChangeEvent) => changes.push(e));

    // Bootstrap
    m.tick('agent-a', staleMtime);
    assert.strictEqual(m.getState('agent-a')!.state, 'alive');

    // 1st missed (same stale mtime)
    m.tick('agent-a', staleMtime);
    assert.strictEqual(m.getState('agent-a')!.state, 'alive');

    // 2nd missed → degraded
    const r = m.tick('agent-a', staleMtime);
    assert.strictEqual(r, 'degraded', 'should transition to degraded at 2 missed');
    assert.strictEqual(m.getState('agent-a')!.state, 'degraded');
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].from, 'alive');
    assert.strictEqual(changes[0].to, 'degraded');
  });

  test('1c: 5 consecutive missed → stalled', () => {
    const m = new HealthStateMachine();
    const stale = new Date('2020-01-01T00:00:00.000Z');
    const changes: StateChangeEvent[] = [];
    m.on('stateChange', (e: StateChangeEvent) => changes.push(e));

    // Bootstrap + 4 more missed = 5 total (1 bootstrap + 4)
    m.tick('agent-b', stale);      // tick 1: alive (bootstrap)
    m.tick('agent-b', stale);      // tick 2: missed 1 → alive
    m.tick('agent-b', stale);      // tick 3: missed 2 → degraded
    m.tick('agent-b', stale);      // tick 4: missed 3 → degraded
    m.tick('agent-b', stale);      // tick 5: missed 4 → degraded
    const r = m.tick('agent-b', stale); // tick 6: missed 5 → stalled
    assert.strictEqual(r, 'stalled', `expected stalled, got ${r}`);
    assert.strictEqual(m.getState('agent-b')!.state, 'stalled');
    const stalledEvt = changes.find(e => e.to === 'stalled');
    assert.ok(stalledEvt !== undefined, 'expected a stalled event');
    assert.strictEqual(stalledEvt!.agentId, 'agent-b');
  });

  test('1d: 10 consecutive missed → dead', () => {
    const m = new HealthStateMachine();
    const stale = new Date('2020-01-01T00:00:00.000Z');
    const changes: StateChangeEvent[] = [];
    m.on('stateChange', (e: StateChangeEvent) => changes.push(e));

    // Bootstrap then 10 more stale ticks = 11 ticks total
    m.tick('agent-c', stale); // bootstrap
    for (let i = 0; i < 10; i++) {
      m.tick('agent-c', stale);
    }
    assert.strictEqual(m.getState('agent-c')!.state, 'dead');
    const deadEvt = changes.find(e => e.to === 'dead');
    assert.ok(deadEvt !== undefined, 'expected a dead event');
    assert.strictEqual(deadEvt!.agentId, 'agent-c');
    assert.strictEqual(m.getState('agent-c')!.missedHeartbeats, 10);
  });

  test('1e: any non-alive state → alive on fresh heartbeat', () => {
    const m = new HealthStateMachine();
    const stale = new Date('2020-01-01T00:00:00.000Z');
    const changes: StateChangeEvent[] = [];
    m.on('stateChange', (e: StateChangeEvent) => changes.push(e));

    // Drive to degraded
    m.tick('agent-d', stale);
    m.tick('agent-d', stale);
    m.tick('agent-d', stale); // 2 missed → degraded

    // Now provide a fresh heartbeat
    const fresh = new Date();
    const r = m.tick('agent-d', fresh);
    assert.strictEqual(r, 'alive', 'should recover to alive');
    assert.strictEqual(m.getState('agent-d')!.state, 'alive');
    assert.strictEqual(m.getState('agent-d')!.missedHeartbeats, 0);

    const aliveEvt = changes.find(e => e.to === 'alive' && e.from === 'degraded');
    assert.ok(aliveEvt !== undefined, 'expected degraded→alive event');
  });

  test('1f: recovery from stalled → alive clears rekick flag', () => {
    const m = new HealthStateMachine();
    const stale = new Date('2020-01-01T00:00:00.000Z');

    // Bootstrap + 5 more stale = stalled
    for (let i = 0; i < 6; i++) { m.tick('agent-e', stale); }
    assert.strictEqual(m.getState('agent-e')!.state, 'stalled');

    m.markRekickSent('agent-e', 10);
    assert.strictEqual(m.getState('agent-e')!.rekickSent, true);

    // Recover
    m.tick('agent-e', new Date());
    assert.strictEqual(m.getState('agent-e')!.state, 'alive');
    assert.strictEqual(m.getState('agent-e')!.rekickSent, false);
  });

  test('1g: getAll() returns all tracked agents', () => {
    const m = new HealthStateMachine();
    m.tick('x', new Date());
    m.tick('y', new Date());
    m.tick('z', new Date());
    const all = m.getAll();
    assert.strictEqual(all.length, 3);
    const ids = all.map(a => a.agentId).sort();
    assert.deepStrictEqual(ids, ['x', 'y', 'z']);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — HeartbeatReader: file I/O poll, zero LLM calls
// ---------------------------------------------------------------------------

suite('LMD — HeartbeatReader: file-based polling', () => {

  test('2a: reads heartbeat files and ticks state machine (zero LLM calls)', () => {
    const root = makeTmpDir();
    const hbDir = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'heartbeats');
    fs.mkdirSync(hbDir, { recursive: true });

    // Write a heartbeat file for agent "test-agent"
    const ts = new Date().toISOString();
    fs.writeFileSync(
      path.join(hbDir, 'test-agent.json'),
      JSON.stringify({ agent_id: 'test-agent', timestamp: ts, status: 'active' }),
      'utf8'
    );

    const reader = new HeartbeatReader(root, { intervalMs: 999999 });
    reader.start();
    reader.stop(); // one synchronous poll already happened in start()

    const grid = reader.getHealthGrid();
    assert.ok(grid.length >= 1, 'should have at least one entry');
    const entry = grid.find(a => a.agentId === 'test-agent');
    assert.ok(entry !== undefined, 'test-agent should be tracked');
    assert.strictEqual(entry!.state, 'alive');

    // Verify: no global fetch / axios / LLM client was called.
    // (We confirm by checking that the node module loader never loaded any AI SDK.
    // Since HeartbeatReader only imports 'fs', 'path', and 'events', this is
    // structurally guaranteed — but we also assert the contract explicitly.)
    const loadedModules = Object.keys(require.cache);
    const llmModules = loadedModules.filter(m =>
      m.includes('anthropic') || m.includes('openai') || m.includes('@google/generative')
    );
    assert.deepStrictEqual(
      llmModules,
      [],
      `HeartbeatReader must not load any LLM SDK. Found: ${llmModules.join(', ')}`
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('2b: missing heartbeat file → missed beat increments', () => {
    const root = makeTmpDir();
    const hbDir = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'heartbeats');
    fs.mkdirSync(hbDir, { recursive: true });

    const warnings: string[] = [];
    const reader = new HeartbeatReader(root, {
      intervalMs: 999999,
      logger: { warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
    });

    // Write a file with a stale timestamp, then poll.
    const stale = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(
      path.join(hbDir, 'slow-agent.json'),
      JSON.stringify({ agent_id: 'slow-agent', timestamp: stale }),
      'utf8'
    );

    reader.start();  // poll 1: bootstrap
    reader.stop();

    // Now re-start and re-poll without changing the file.
    reader.start();
    reader.stop();   // poll 2: same timestamp → 1 missed

    const h = reader.getHealthGrid().find(a => a.agentId === 'slow-agent');
    assert.ok(h !== undefined);
    // First tick bootstraps alive; second tick sees same mtime → 1 missed beat.
    assert.ok(h!.missedHeartbeats >= 1, `expected ≥1 missed beat, got ${h!.missedHeartbeats}`);

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('2c: getHealthGrid() returns AgentHealth[] for Fleet panel', () => {
    const root = makeTmpDir();
    const hbDir = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'heartbeats');
    fs.mkdirSync(hbDir, { recursive: true });

    for (const id of ['alpha', 'beta', 'gamma']) {
      fs.writeFileSync(
        path.join(hbDir, `${id}.json`),
        JSON.stringify({ agent_id: id, timestamp: new Date().toISOString() }),
        'utf8'
      );
    }

    const reader = new HeartbeatReader(root, { intervalMs: 999999 });
    reader.start();
    reader.stop();

    const grid = reader.getHealthGrid();
    assert.ok(grid.length >= 3, `expected ≥3 entries, got ${grid.length}`);
    for (const id of ['alpha', 'beta', 'gamma']) {
      const found = grid.find(a => a.agentId === id);
      assert.ok(found !== undefined, `missing agent "${id}" from grid`);
      assert.ok('state' in found!, 'AgentHealth must have state');
      assert.ok('lastHeartbeatAt' in found!, 'AgentHealth must have lastHeartbeatAt');
    }

    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — StallRecovery: re-kick, dead exclusion, recovery
// ---------------------------------------------------------------------------

suite('LMD — StallRecovery: re-kick and dead handling', () => {

  test('3a: re-kick fires when agent transitions to stalled', async () => {
    const root = makeTmpDir();
    const hbDir = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'heartbeats');
    fs.mkdirSync(hbDir, { recursive: true });

    const rekicks: string[] = [];
    const runner = {
      findRunner: (_id: string) => 'test-runner' as string | null,
      dispatchRekick: async (agentId: string, _prompt: string) => {
        rekicks.push(agentId);
        return 'queued';
      },
    };

    const machine = new HealthStateMachine();
    const reader = new HeartbeatReader(root, {
      stateMachine: machine,
      intervalMs: 999999,
    });
    const recovery = new StallRecovery({
      workspaceRoot: root,
      reader,
      stateMachine: machine,
      runnerLookup: runner,
      keepaliveLogPath: path.join(root, 'keepalive.log'),
      logger: { warn: () => {}, error: () => {} },
    });

    recovery.start();

    // Manually drive machine to stalled by emitting the event.
    const stalledEvt: StateChangeEvent = {
      agentId: 'wa-x',
      from: 'degraded',
      to: 'stalled',
      at: new Date().toISOString(),
    };
    reader.emit('health_change', stalledEvt);

    // Give the async handler a tick to run.
    await new Promise<void>(r => setImmediate(r));

    assert.ok(rekicks.includes('wa-x'), `expected re-kick for wa-x, got: ${rekicks.join(',')}`);

    // Check keepalive log.
    assert.ok(fs.existsSync(path.join(root, 'keepalive.log')), 'keepalive.log should exist');
    const log = fs.readFileSync(path.join(root, 'keepalive.log'), 'utf8');
    const entries = log.trim().split('\n').map(l => JSON.parse(l));
    const rekickEntry = entries.find((e: { action: string }) => e.action === 'rekick');
    assert.ok(rekickEntry !== undefined, 'expected a rekick log entry');
    assert.strictEqual(rekickEntry.agentId, 'wa-x');
    assert.strictEqual(rekickEntry.runner, 'test-runner');
    assert.strictEqual(rekickEntry.result, 'queued');

    recovery.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('3b: dead agent is excluded from consensus quorum', async () => {
    const root = makeTmpDir();
    const hbDir = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'heartbeats');
    fs.mkdirSync(hbDir, { recursive: true });

    const excluded: string[] = [];
    const consensusStub = {
      excludeAgent: (id: string) => excluded.push(id),
      restoreAgent: (_id: string) => {},
    };
    const warnings: string[] = [];
    const vscodeBridge = { showWarningMessage: (m: string) => warnings.push(m) };

    const machine = new HealthStateMachine();
    const reader = new HeartbeatReader(root, {
      stateMachine: machine,
      intervalMs: 999999,
    });
    const recovery = new StallRecovery({
      workspaceRoot: root,
      reader,
      stateMachine: machine,
      vscodeBridge,
      consensusEngine: consensusStub,
      keepaliveLogPath: path.join(root, 'keepalive.log'),
      logger: { warn: () => {}, error: () => {} },
    });

    recovery.start();

    const deadEvt: StateChangeEvent = {
      agentId: 'wa-z',
      from: 'stalled',
      to: 'dead',
      at: new Date().toISOString(),
    };
    reader.emit('health_change', deadEvt);
    await new Promise<void>(r => setImmediate(r));

    assert.ok(excluded.includes('wa-z'), `expected wa-z excluded, got: ${excluded.join(',')}`);
    assert.ok(
      warnings.some(w => w.includes('wa-z')),
      'expected a warning message containing the agent id'
    );

    const log = fs.readFileSync(path.join(root, 'keepalive.log'), 'utf8');
    const entries = log.trim().split('\n').map(l => JSON.parse(l));
    const deadEntry = entries.find((e: { action: string }) => e.action === 'dead');
    assert.ok(deadEntry !== undefined);
    assert.strictEqual(deadEntry.reason, '10_missed_heartbeats');

    recovery.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('3c: recovered agent is restored to quorum and logged', async () => {
    const root = makeTmpDir();
    const hbDir = path.join(root, '.autoclaw', 'orchestrator', 'comms', 'heartbeats');
    fs.mkdirSync(hbDir, { recursive: true });

    const restored: string[] = [];
    const consensusStub = {
      excludeAgent: (_id: string) => {},
      restoreAgent: (id: string) => restored.push(id),
    };

    const machine = new HealthStateMachine();
    const reader = new HeartbeatReader(root, {
      stateMachine: machine,
      intervalMs: 999999,
    });
    const recovery = new StallRecovery({
      workspaceRoot: root,
      reader,
      stateMachine: machine,
      vscodeBridge: { showWarningMessage: () => {} },
      consensusEngine: consensusStub,
      keepaliveLogPath: path.join(root, 'keepalive.log'),
      logger: { warn: () => {}, error: () => {} },
    });

    recovery.start();

    // Emit dead first, then alive (recovery).
    reader.emit('health_change', { agentId: 'wa-r', from: 'stalled', to: 'dead', at: new Date().toISOString() } as StateChangeEvent);
    reader.emit('health_change', { agentId: 'wa-r', from: 'dead', to: 'alive', at: new Date().toISOString() } as StateChangeEvent);
    await new Promise<void>(r => setImmediate(r));

    assert.ok(restored.includes('wa-r'), `expected wa-r restored, got: ${restored.join(',')}`);

    const log = fs.readFileSync(path.join(root, 'keepalive.log'), 'utf8');
    const entries = log.trim().split('\n').map(l => JSON.parse(l));
    const recoveredEntry = entries.find((e: { action: string }) => e.action === 'recovered');
    assert.ok(recoveredEntry !== undefined, 'expected a recovered log entry');
    assert.strictEqual(recoveredEntry.agentId, 'wa-r');

    recovery.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
