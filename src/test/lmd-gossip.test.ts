/**
 * lmd-gossip.test.ts — Unit tests for the LMD gossip ring (E4).
 *
 * Covers:
 *  1. NATS transport reports unavailable (stub) so the ring falls back
 *  2. FilesystemGossipTransport publish + subscribe round-trip
 *  3. A transport never echoes its own beats back to itself
 *  4. RemoteHealthTracker merge / freshest-wins / stall detection / eviction
 *  5. GossipRing end-to-end: two rings on a shared dir see each other's health
 *  6. Cross-machine stall detection emits remote_stall
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  FilesystemGossipTransport,
  RemoteHealthTracker,
  GossipRing,
} from '../lmd/gossip';
import {
  NatsGossipTransport,
  hbSubject,
  HB_SUBJECT_WILDCARD,
} from '../lmd/natsGossip';
import type { GossipBeat } from '../lmd/natsGossip';
import type { AgentHealth } from '../lmd/types';

const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-gossip-'));
}

function beat(over: Partial<GossipBeat> = {}): GossipBeat {
  return {
    agentId: 'agent-x',
    state: 'alive',
    lastHeartbeatAt: new Date().toISOString(),
    missedHeartbeats: 0,
    origin: 'host-a',
    emittedAt: new Date().toISOString(),
    ...over,
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (predicate()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > timeoutMs) {
        clearInterval(iv); reject(new Error('waitFor timed out'));
      }
    }, 25);
  });
}

// ---------------------------------------------------------------------------

suite('LMD gossip — NATS transport (stub)', () => {
  test('hbSubject builds ac.hb.<agent>', () => {
    assert.strictEqual(hbSubject('claude-code'), 'ac.hb.claude-code');
    assert.strictEqual(HB_SUBJECT_WILDCARD, 'ac.hb.*');
  });

  test('connect resolves false (stubbed) so the ring can fall back', async () => {
    const t = new NatsGossipTransport({ logger: SILENT });
    const ok = await t.connect();
    assert.strictEqual(ok, false);
    assert.strictEqual(t.available, false);
  });

  test('publish / subscribe are safe no-ops while unavailable', async () => {
    const t = new NatsGossipTransport({ logger: SILENT });
    await t.connect();
    const unsub = t.subscribe(() => { /* never called */ });
    await t.publish(beat());
    unsub();
    await t.close();
  });
});

suite('LMD gossip — FilesystemGossipTransport', () => {
  test('publish then a peer transport receives the beat', async () => {
    const dir = tmpDir();
    const writer = new FilesystemGossipTransport({ gossipDir: dir, logger: SILENT });
    writer.setSelfOrigin('host-a');
    const reader = new FilesystemGossipTransport({
      gossipDir: dir, pollIntervalMs: 50, logger: SILENT,
    });
    reader.setSelfOrigin('host-b');
    await writer.connect();
    await reader.connect();

    const received: GossipBeat[] = [];
    reader.subscribe((b) => received.push(b));
    await writer.publish(beat({ origin: 'host-a', agentId: 'agent-1' }));

    await waitFor(() => received.length > 0);
    assert.strictEqual(received[0].agentId, 'agent-1');
    assert.strictEqual(received[0].origin, 'host-a');

    await writer.close();
    await reader.close();
  });

  test('a transport does not deliver its own beats back to itself', async () => {
    const dir = tmpDir();
    const t = new FilesystemGossipTransport({
      gossipDir: dir, pollIntervalMs: 50, logger: SILENT,
    });
    t.setSelfOrigin('host-self');
    await t.connect();
    const received: GossipBeat[] = [];
    t.subscribe((b) => received.push(b));
    await t.publish(beat({ origin: 'host-self' }));
    // Give the poll loop time to run.
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(received.length, 0);
    await t.close();
  });

  test('stale beats are ignored', async () => {
    const dir = tmpDir();
    const t = new FilesystemGossipTransport({
      gossipDir: dir, pollIntervalMs: 50, staleMs: 50, logger: SILENT,
    });
    t.setSelfOrigin('host-b');
    await t.connect();
    // Write an old beat directly.
    const old = beat({
      origin: 'host-a',
      emittedAt: new Date(Date.now() - 100_000).toISOString(),
    });
    fs.writeFileSync(path.join(dir, 'host-a__agent-x.json'), JSON.stringify(old));
    const received: GossipBeat[] = [];
    t.subscribe((b) => received.push(b));
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(received.length, 0);
    await t.close();
  });
});

suite('LMD gossip — RemoteHealthTracker', () => {
  test('merge stores a peer agent', () => {
    const tr = new RemoteHealthTracker();
    const merged = tr.merge(beat({ agentId: 'a1', state: 'degraded' }));
    assert.ok(merged);
    assert.strictEqual(tr.get('a1')!.state, 'degraded');
  });

  test('freshest heartbeat wins; older beat is dropped', () => {
    const tr = new RemoteHealthTracker();
    const newer = new Date().toISOString();
    const older = new Date(Date.now() - 60_000).toISOString();
    tr.merge(beat({ agentId: 'a1', lastHeartbeatAt: newer, state: 'alive' }));
    const dropped = tr.merge(
      beat({ agentId: 'a1', lastHeartbeatAt: older, state: 'dead' }),
    );
    assert.strictEqual(dropped, undefined);
    assert.strictEqual(tr.get('a1')!.state, 'alive');
  });

  test('getStalled returns stalled + dead remote agents', () => {
    const tr = new RemoteHealthTracker();
    tr.merge(beat({ agentId: 'ok', state: 'alive' }));
    tr.merge(beat({ agentId: 'st', state: 'stalled' }));
    tr.merge(beat({ agentId: 'dd', state: 'dead' }));
    const stalled = tr.getStalled().map((a) => a.agentId).sort();
    assert.deepStrictEqual(stalled, ['dd', 'st']);
  });

  test('evictStale drops agents not heard from recently', async () => {
    const tr = new RemoteHealthTracker();
    tr.merge(beat({ agentId: 'a1' }));
    await new Promise((r) => setTimeout(r, 30));
    const evicted = tr.evictStale(10);
    assert.deepStrictEqual(evicted, ['a1']);
    assert.strictEqual(tr.get('a1'), undefined);
  });
});

suite('LMD gossip — GossipRing end-to-end', () => {
  function ring(workspaceRoot: string, origin: string, health: AgentHealth[]): GossipRing {
    return new GossipRing({
      workspaceRoot,
      origin,
      gossipDir: path.join(workspaceRoot, 'shared-gossip'),
      localHealth: () => health,
      publishIntervalMs: 100,
      logger: SILENT,
    });
  }

  test('two rings on a shared dir merge each other\'s health', async () => {
    const ws = tmpDir();
    const healthA: AgentHealth[] = [
      { agentId: 'agent-a', state: 'alive', lastHeartbeatAt: new Date().toISOString(), missedHeartbeats: 0 },
    ];
    const healthB: AgentHealth[] = [
      { agentId: 'agent-b', state: 'alive', lastHeartbeatAt: new Date().toISOString(), missedHeartbeats: 0 },
    ];
    const ringA = ring(ws, 'host-a', healthA);
    const ringB = ring(ws, 'host-b', healthB);

    await ringA.start();
    await ringB.start();

    // No NATS options -> filesystem transport selected.
    assert.strictEqual(ringA.transportName, 'filesystem');

    // Ring A should learn about agent-b; ring B about agent-a.
    await waitFor(() => ringA.tracker.get('agent-b') !== undefined);
    await waitFor(() => ringB.tracker.get('agent-a') !== undefined);

    assert.strictEqual(ringA.tracker.get('agent-b')!.origin, 'host-b');
    assert.strictEqual(ringB.tracker.get('agent-a')!.origin, 'host-a');

    await ringA.stop();
    await ringB.stop();
  });

  test('cross-machine stall emits remote_stall once', async () => {
    const ws = tmpDir();
    const stalledHealth: AgentHealth[] = [
      { agentId: 'agent-stuck', state: 'stalled', lastHeartbeatAt: new Date().toISOString(), missedHeartbeats: 6 },
    ];
    const observerHealth: AgentHealth[] = [
      { agentId: 'agent-obs', state: 'alive', lastHeartbeatAt: new Date().toISOString(), missedHeartbeats: 0 },
    ];
    const stallRing = ring(ws, 'host-stall', stalledHealth);
    const observer = ring(ws, 'host-obs', observerHealth);

    const stallEvents: string[] = [];
    observer.events.on('remote_stall', (rec: { agentId: string }) => {
      stallEvents.push(rec.agentId);
    });

    await stallRing.start();
    await observer.start();

    await waitFor(() => stallEvents.length > 0);
    assert.strictEqual(stallEvents[0], 'agent-stuck');
    // getStalled on the observer's tracker also reports it.
    assert.ok(observer.tracker.getStalled().some((a) => a.agentId === 'agent-stuck'));

    await stallRing.stop();
    await observer.stop();
  });

  test('ring with NATS opts falls back to filesystem when NATS unavailable', async () => {
    const ws = tmpDir();
    const r = new GossipRing({
      workspaceRoot: ws,
      origin: 'host-x',
      localHealth: () => [],
      nats: { servers: 'nats://127.0.0.1:4222' },
      publishIntervalMs: 1000,
      logger: SILENT,
    });
    await r.start();
    // NATS transport is stubbed unavailable -> filesystem fallback.
    assert.strictEqual(r.transportName, 'filesystem');
    await r.stop();
  });
});
