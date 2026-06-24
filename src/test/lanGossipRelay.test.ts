import * as assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  LanGossipRelay, encodeClusterMapBeat, parseClusterMapBeat, remoteBeatToLocal,
  isRelayedOrigin, LAN_GOSSIP_MAX_BYTES, LAN_GOSSIP_DEFAULT_PORT, LAN_GOSSIP_VERSION,
  MAX_REMOTE_ORIGINS,
} from '../fleet/lanGossipRelay';
import { ClusterMapGossipBus, CLUSTER_MAP_BEAT_STALE_MS, type ClusterMapBeat } from '../lmd/clusterMapGossip';
import { emptyClusterMap, type ClusterMap } from '../orchestrator/clusterMap';
import { writeBeacon } from '../fleet/beacons';
import type { LanSocket, SocketFactory } from '../fleet/lanDiscovery';

const T0 = Date.parse('2026-06-24T12:00:00.000Z');
const iso = (t: number): string => new Date(t).toISOString();
const GOSSIP_PORT = 48485;

function mapAt(epoch: number, term: number): ClusterMap {
  return { ...emptyClusterMap(), epoch, term };
}
function beat(origin: string, t: number, map: ClusterMap = emptyClusterMap()): ClusterMapBeat {
  return { origin, emittedAt: iso(t), map };
}

interface SendRec { payload: Buffer; port: number; address: string; }
class FakeSocket implements LanSocket {
  bound: number | null = null;
  sends: SendRec[] = [];
  closed = false;
  failBind = false;
  failSend = false;
  private msgCb?: (msg: Buffer, rinfo: { address: string; port: number }) => void;
  private errorCb?: (err: Error) => void;
  on(event: 'message' | 'error' | 'listening', cb: any): void {
    if (event === 'message') { this.msgCb = cb; }
    else if (event === 'error') { this.errorCb = cb; }
  }
  bind(port?: number): void { if (this.failBind) { throw new Error('bind failed'); } this.bound = port ?? 0; }
  send(msg: Buffer, port: number, address: string, cb?: (err?: Error | null) => void): void {
    this.sends.push({ payload: msg, port, address }); cb?.(this.failSend ? new Error('send fail') : null);
  }
  addMembership(): void { /* unused by the relay */ }
  setBroadcast(): void { /* unused by the relay */ }
  close(): void { this.closed = true; }
  emitMessage(raw: string | Buffer, address: string): void {
    this.msgCb?.(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw, { address, port: 40000 });
  }
}

function tmpWorkspace(): { root: string; comms: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-gossip-'));
  return { root, comms: path.join(root, '.autoclaw', 'orchestrator', 'comms') };
}

// ---------------------------------------------------------------------------
suite('lanGossipRelay — wire codec (pure, fail-closed)', () => {
  test('encode → parse round-trips a beat (origin/emittedAt/map)', () => {
    const b = beat('orchestrator-loop-AAA', T0, mapAt(5, 3));
    const parsed = parseClusterMapBeat(encodeClusterMapBeat(b));
    assert.ok(parsed);
    assert.strictEqual(parsed!.origin, 'orchestrator-loop-AAA');
    assert.strictEqual(parsed!.emittedAt, iso(T0));
    assert.strictEqual(parsed!.map.epoch, 5);
    assert.strictEqual(parsed!.map.term, 3);
  });

  test('parseClusterMapBeat FAILS CLOSED on malformed / hostile / oversized input', () => {
    assert.strictEqual(parseClusterMapBeat('{not json'), null, 'malformed JSON');
    assert.strictEqual(parseClusterMapBeat('null'), null, 'null');
    assert.strictEqual(parseClusterMapBeat('[1,2]'), null, 'non-object');
    assert.strictEqual(parseClusterMapBeat(JSON.stringify({ v: 2, origin: 'o', emittedAt: iso(T0), map: emptyClusterMap() })), null, 'wrong version');
    assert.strictEqual(parseClusterMapBeat(JSON.stringify({ v: 1, origin: '', emittedAt: iso(T0), map: emptyClusterMap() })), null, 'empty origin');
    assert.strictEqual(parseClusterMapBeat(JSON.stringify({ v: 1, origin: 'o', emittedAt: '', map: emptyClusterMap() })), null, 'empty emittedAt');
    assert.strictEqual(parseClusterMapBeat(JSON.stringify({ v: 1, origin: 'o', emittedAt: iso(T0), map: { junk: true } })), null, 'map fails coerce');
    assert.strictEqual(parseClusterMapBeat(JSON.stringify({ v: 1, origin: 'o', emittedAt: iso(T0) })), null, 'missing map');
    const big = JSON.stringify({ v: 1, origin: 'o', emittedAt: iso(T0), map: emptyClusterMap(), pad: 'x'.repeat(LAN_GOSSIP_MAX_BYTES) });
    assert.ok(Buffer.byteLength(big, 'utf8') > LAN_GOSSIP_MAX_BYTES);
    assert.strictEqual(parseClusterMapBeat(big), null, 'a datagram over the cap is dropped before parsing');
  });

  test('encode emits the versioned wire shape and nothing sensitive', () => {
    const wire = JSON.parse(encodeClusterMapBeat(beat('o', T0)).toString('utf8'));
    assert.deepStrictEqual(Object.keys(wire).sort(), ['emittedAt', 'map', 'origin', 'v']);
    assert.strictEqual(wire.v, LAN_GOSSIP_VERSION);
  });
});

suite('lanGossipRelay — remoteBeatToLocal (re-key + receive-clamp)', () => {
  test('re-keys the origin under the lan: namespace (collision-disjoint from local files)', () => {
    const out = remoteBeatToLocal(beat('orchestrator-loop-PEER', T0 - 1000), T0);
    assert.strictEqual(out.origin, 'lan:orchestrator-loop-PEER');
    assert.ok(isRelayedOrigin(out.origin), 'marked relayed');
    assert.ok(!isRelayedOrigin('orchestrator-loop-PEER'), 'a LOCAL window origin is never lan:');
  });

  test('clamps emittedAt into [now-staleMs, now]: fresh kept, future→now, old→now-stale, garbage→now', () => {
    const within = remoteBeatToLocal(beat('p', T0 - 1000), T0);
    assert.strictEqual(within.emittedAt, iso(T0 - 1000), 'a recent emit time is preserved');
    const future = remoteBeatToLocal(beat('p', T0 + 60_000), T0);
    assert.strictEqual(future.emittedAt, iso(T0), 'a FUTURE timestamp cannot claim extra freshness');
    const old = remoteBeatToLocal(beat('p', T0 - CLUSTER_MAP_BEAT_STALE_MS - 10_000), T0);
    assert.strictEqual(old.emittedAt, iso(T0 - CLUSTER_MAP_BEAT_STALE_MS), 'a stale emit time ages out promptly');
    const garbage = remoteBeatToLocal({ origin: 'p', emittedAt: 'not-a-date', map: emptyClusterMap() }, T0);
    assert.strictEqual(garbage.emittedAt, iso(T0), 'an unparseable timestamp is treated as received-now');
  });

  test('preserves the map', () => {
    const out = remoteBeatToLocal(beat('p', T0, mapAt(9, 4)), T0);
    assert.strictEqual(out.map.epoch, 9);
    assert.strictEqual(out.map.term, 4);
  });
});

suite('lanGossipRelay — socket adapter (FAKE socket, never binds real dgram)', () => {
  let fake: FakeSocket;
  let factory: SocketFactory;
  let factoryCalls: number;
  let ws: { root: string; comms: string };
  let relay: LanGossipRelay | null;

  setup(() => {
    fake = new FakeSocket();
    factoryCalls = 0;
    factory = () => { factoryCalls++; return fake; };
    ws = tmpWorkspace();
    relay = null;
  });
  teardown(() => { relay?.stop(); });

  function make(over: Partial<ConstructorParameters<typeof LanGossipRelay>[0]> = {}): LanGossipRelay {
    relay = new LanGossipRelay({
      enabled: true,
      consentAckAt: '2026-06-24T11:00:00.000Z',
      workspaceRoot: ws.root,
      commsDir: ws.comms,
      port: GOSSIP_PORT,
      seeds: [],
      createSocket: factory,
      broadcastIntervalMs: 1_000_000_000,
      now: () => T0,
      ...over,
    });
    return relay;
  }

  test('start() binds the GOSSIP port via the injected factory (distinct from discovery 48484)', () => {
    const d = make();
    d.start();
    assert.strictEqual(factoryCalls, 1);
    assert.strictEqual(fake.bound, GOSSIP_PORT);
    assert.notStrictEqual(fake.bound, 48484, 'never the discovery port');
    assert.strictEqual(d.isRunning(), true);
  });

  test('GATE: binds NOTHING unless flag-combined-enabled AND consent are both set', () => {
    make({ enabled: false }).start();
    assert.strictEqual(factoryCalls, 0, 'flag off ⇒ no socket');
    relay = null; fake = new FakeSocket(); factoryCalls = 0; factory = () => { factoryCalls++; return fake; };
    make({ enabled: true, consentAckAt: null }).start();
    assert.strictEqual(factoryCalls, 0, 'no consent ⇒ no socket');
  });

  test('an incoming VALID foreign beat is MIRRORED into the FS bus, re-keyed lan:', async () => {
    const d = make();
    d.start();
    const wire = encodeClusterMapBeat(beat('orchestrator-loop-PEER', T0 - 1000, mapAt(7, 2)));
    fake.emitMessage(wire, '192.168.1.50');
    await d.drain();
    const rows = await new ClusterMapGossipBus(ws.root).readBeats(T0);
    assert.strictEqual(rows.length, 1, 'one mirrored beat');
    assert.strictEqual(rows[0].origin, 'lan:orchestrator-loop-PEER', 're-keyed under lan:');
    assert.strictEqual(rows[0].map.epoch, 7);
  });

  test('a SELF-origin beat, an already-lan: beat, and malformed input mirror NOTHING', async () => {
    const d = make({ selfOrigin: 'orchestrator-loop-SELF' });
    d.start();
    fake.emitMessage(encodeClusterMapBeat(beat('orchestrator-loop-SELF', T0)), '10.0.0.1'); // own echo
    fake.emitMessage(encodeClusterMapBeat(beat('lan:orchestrator-loop-X', T0)), '10.0.0.2'); // re-relay
    fake.emitMessage('garbage{', '10.0.0.3');
    fake.emitMessage('x'.repeat(LAN_GOSSIP_MAX_BYTES + 50), '10.0.0.4'); // oversized
    await d.drain();
    const rows = await new ClusterMapGossipBus(ws.root).readBeats(T0).catch(() => []);
    assert.strictEqual(rows.length, 0, 'no beat is mirrored for self / re-relay / malformed / oversized');
  });

  test('broadcast: LOCAL beats go to discovered peers + seeds on the GOSSIP port; lan: beats do NOT (loop-free)', async () => {
    // a locally-originated beat (relayable) + a relayed lan: beat (must NOT be re-sent)
    const bus = new ClusterMapGossipBus(ws.root);
    await bus.publish(beat('orchestrator-loop-AAA', T0, mapAt(4, 1)));
    await bus.publish(beat('lan:orchestrator-loop-BBB', T0, mapAt(9, 9)));
    // a discovered peer (origin-'lan' beacon) → its IP becomes a target (on the gossip port)
    await writeBeacon(
      { agent_id: 'lan:peer', origin: 'lan', endpoint: '192.168.1.50:48484', timestamp: iso(T0), status: 'active', machine_id: 'peer' },
      { scope: 'workspace', commsDir: ws.comms },
    );
    const d = make({ seeds: [{ host: '10.0.0.9', port: 48484 }] });
    d.start();
    await d.drain(); // flush the startup broadcast tick deterministically (no race)

    // 1 local beat × 2 targets (discovered peer + seed) = 2 sends, all on the gossip port.
    assert.strictEqual(fake.sends.length, 2, 'only the local beat is relayed, to both targets');
    const addrs = fake.sends.map((s) => s.address).sort();
    assert.deepStrictEqual(addrs, ['10.0.0.9', '192.168.1.50']);
    for (const s of fake.sends) {
      assert.strictEqual(s.port, GOSSIP_PORT, 'dialed on the gossip port, NOT the announced discovery port');
      const sent = parseClusterMapBeat(s.payload);
      assert.strictEqual(sent!.origin, 'orchestrator-loop-AAA', 'the lan: beat is never re-broadcast');
    }
  });

  test('stop() closes the socket + is idempotent; a socket error never throws', () => {
    const d = make();
    d.start();
    d.stop();
    assert.strictEqual(fake.closed, true);
    assert.strictEqual(d.isRunning(), false);
    d.stop();
    assert.strictEqual(d.isRunning(), false);
  });

  test('a bind failure is caught — start() does not throw, stop() still cleans up', () => {
    fake.failBind = true;
    const d = make();
    assert.doesNotThrow(() => d.start());
    d.stop();
    assert.strictEqual(fake.closed, true);
  });

  test('start() is idempotent — a second call does NOT create a second socket', () => {
    const d = make();
    d.start();
    d.start();
    assert.strictEqual(factoryCalls, 1);
  });

  test('a socket factory that throws leaves the relay STOPPED (retryable, no crash)', () => {
    relay = new LanGossipRelay({
      enabled: true, consentAckAt: '2026-06-24T11:00:00.000Z', workspaceRoot: ws.root,
      commsDir: ws.comms, port: GOSSIP_PORT, seeds: [], now: () => T0,
      broadcastIntervalMs: 1_000_000_000, createSocket: () => { throw new Error('no dgram'); },
    });
    assert.doesNotThrow(() => relay!.start());
    assert.strictEqual(relay!.isRunning(), false, 'started is reset so a later start() can retry');
  });

  test('peerTargets reads ONLY the workspace beacon dir — a machine-global lan beacon is NOT a target', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-gossip-home-'));
    await writeBeacon( // a machine-global 'lan' beacon — must be IGNORED by the relay
      { agent_id: 'lan:machine-peer', origin: 'lan', endpoint: '203.0.113.9:48484', timestamp: iso(T0), status: 'active', machine_id: 'mp' },
      { scope: 'machine', homeDir: fakeHome },
    );
    await writeBeacon( // a workspace 'lan' peer — the ONLY legitimate target
      { agent_id: 'lan:ws-peer', origin: 'lan', endpoint: '192.168.1.77:48484', timestamp: iso(T0), status: 'active', machine_id: 'wp' },
      { scope: 'workspace', commsDir: ws.comms },
    );
    await new ClusterMapGossipBus(ws.root).publish(beat('orchestrator-loop-AAA', T0));
    const d = make();
    d.start();
    await d.drain();
    const addrs = fake.sends.map((s) => s.address);
    assert.deepStrictEqual(addrs, ['192.168.1.77'], 'only the workspace peer; the machine-global lan beacon is excluded');
  });

  test('a throwing log sink + failing send never crash the broadcast (no unhandledRejection)', async () => {
    fake.failSend = true;
    await new ClusterMapGossipBus(ws.root).publish(beat('orchestrator-loop-AAA', T0));
    await writeBeacon(
      { agent_id: 'lan:peer', origin: 'lan', endpoint: '192.168.1.50:48484', timestamp: iso(T0), status: 'active', machine_id: 'p' },
      { scope: 'workspace', commsDir: ws.comms },
    );
    const d = make({ log: () => { throw new Error('broken log'); } });
    assert.doesNotThrow(() => d.start());
    await assert.doesNotReject(() => d.drain());
  });

  test('mirrored lan_ files are bounded — an origin-rotating flood caps at MAX_REMOTE_ORIGINS', async () => {
    const d = make();
    d.start();
    for (let i = 0; i < MAX_REMOTE_ORIGINS + 8; i++) {
      fake.emitMessage(encodeClusterMapBeat(beat(`orchestrator-loop-peer${i}`, T0)), '10.0.0.1');
    }
    await d.drain();
    const rows = await new ClusterMapGossipBus(ws.root).readBeats(T0);
    assert.strictEqual(rows.length, MAX_REMOTE_ORIGINS, 'distinct relayed origins are capped; the flood overflow is dropped');
  });
});
