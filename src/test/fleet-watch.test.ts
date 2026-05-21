/**
 * fleet-watch.test.ts — Unit tests for `autoclaw fleet watch` (Sprint 4 / WA-3 I3).
 *
 * Covers:
 *  1. parseInterval handles "5m", "30s", "1h", bare ms, and bad input.
 *  2. A tick re-kicks every stalled agent via the strategy chain.
 *  3. Healthy / degraded agents are NOT re-kicked.
 *  4. Every chain run is appended to .autoclaw/runtime/keepalive.log.
 *  5. fleetWatchStatusBarText reflects active/off state.
 *  6. watchFleetCommand toggles the watcher on/off.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  FleetWatcher,
  parseInterval,
  fleetWatchStatusBarText,
  watchFleetCommand,
  currentWatcher,
  DEFAULT_WATCH_INTERVAL_MS,
} from '../cli/fleet-watch';
import { HeartbeatReader } from '../lmd/heartbeatReader';
import { HealthStateMachine } from '../lmd/healthStateMachine';
import { StrategyChain } from '../keepalive/strategyChain';
import type { ChainResult } from '../keepalive/types';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-watch-'));
}

/** Build a HeartbeatReader whose state machine is pre-seeded to `state`. */
function readerWithStalled(agentIds: string[]): HeartbeatReader {
  const sm = new HealthStateMachine();
  const reader = new HeartbeatReader(tmpWorkspace(), {
    stateMachine: sm,
    heartbeatsDir: path.join(tmpWorkspace(), 'no-such-dir'),
    logger: silentLogger,
  });
  // Drive each agent to `stalled`: first tick bootstraps, then 5 missed beats.
  const t0 = new Date('2020-01-01T00:00:00Z');
  for (const id of agentIds) {
    sm.tick(id, t0);
    for (let i = 0; i < 5; i++) { sm.tick(id, t0); }
  }
  return reader;
}

/** A StrategyChain stub that records every run and reports success. */
class FakeChain extends StrategyChain {
  public runs: string[] = [];
  constructor() { super({ workspaceRoot: tmpWorkspace(), logger: silentLogger }); }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(config: { agentId: string }): Promise<ChainResult> {
    this.runs.push(config.agentId);
    return {
      agentId: config.agentId, ok: true, succeededWith: 'cli',
      attempts: [], at: new Date().toISOString(),
    };
  }
}

suite('fleet watch: parseInterval (I3)', () => {
  test('parses unit suffixes', () => {
    assert.strictEqual(parseInterval('5m'), 5 * 60_000);
    assert.strictEqual(parseInterval('30s'), 30_000);
    assert.strictEqual(parseInterval('1h'), 3_600_000);
    assert.strictEqual(parseInterval('45000'), 45_000);
  });
  test('falls back to default for empty / bad input', () => {
    assert.strictEqual(parseInterval(undefined), DEFAULT_WATCH_INTERVAL_MS);
    assert.strictEqual(parseInterval('garbage'), DEFAULT_WATCH_INTERVAL_MS);
  });
  test('clamps below a 10s floor', () => {
    assert.strictEqual(parseInterval('1s'), 10_000);
  });
});

suite('fleet watch: FleetWatcher.tick (I3)', () => {
  test('re-kicks every stalled agent via the strategy chain', async () => {
    const ws = tmpWorkspace();
    const chain = new FakeChain();
    const watcher = new FleetWatcher({
      workspaceRoot: ws,
      reader: readerWithStalled(['a1', 'a2']),
      chain,
      logger: silentLogger,
    });
    const result = await watcher.tick();
    assert.deepStrictEqual(result.stalled.sort(), ['a1', 'a2']);
    assert.deepStrictEqual(chain.runs.sort(), ['a1', 'a2']);
    assert.strictEqual(result.chains.length, 2);
    assert.strictEqual(watcher.lastStalledCount, 2);
  });

  test('does not re-kick when no agent is stalled', async () => {
    const ws = tmpWorkspace();
    const chain = new FakeChain();
    const watcher = new FleetWatcher({
      workspaceRoot: ws,
      reader: readerWithStalled([]), // empty fleet
      chain,
      logger: silentLogger,
    });
    const result = await watcher.tick();
    assert.strictEqual(result.stalled.length, 0);
    assert.strictEqual(chain.runs.length, 0);
  });

  test('appends watch_tick and chain_run entries to keepalive.log', async () => {
    const ws = tmpWorkspace();
    const watcher = new FleetWatcher({
      workspaceRoot: ws,
      reader: readerWithStalled(['a1']),
      chain: new FakeChain(),
      logger: silentLogger,
    });
    await watcher.tick();
    const logFile = path.join(ws, '.autoclaw', 'runtime', 'keepalive.log');
    assert.ok(fs.existsSync(logFile), 'keepalive.log must exist');
    const events = fs.readFileSync(logFile, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l).event);
    assert.ok(events.includes('watch_tick'), 'watch_tick must be logged');
    assert.ok(events.includes('chain_run'), 'chain_run must be logged');
  });
});

suite('fleet watch: status bar (I3)', () => {
  test('reflects active / off state', () => {
    assert.ok(/off/.test(fleetWatchStatusBarText(false)));
    assert.ok(/active/.test(fleetWatchStatusBarText(true)));
    assert.ok(/2 re-kicking/.test(fleetWatchStatusBarText(true, 2)));
  });
});

suite('fleet watch: watchFleetCommand toggle (I3)', () => {
  test('starts on first call and stops on the next', () => {
    const ws = tmpWorkspace();
    // Ensure clean slate — stop any leftover watcher.
    const leftover = currentWatcher();
    if (leftover) { leftover.stop(); }

    const first = watchFleetCommand({ workspaceRoot: ws, intervalMs: 60_000 });
    assert.strictEqual(first.active, true);
    assert.ok(/active/.test(first.statusBarText));
    assert.ok(currentWatcher(), 'a watcher should be registered');

    const second = watchFleetCommand({ workspaceRoot: ws });
    assert.strictEqual(second.active, false);
    assert.strictEqual(currentWatcher(), null, 'watcher should be cleared after toggle off');
  });
});
