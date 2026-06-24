import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ClusterMapGossipBus, RemoteClusterMapTracker, clusterMapGossipDir,
  CLUSTER_MAP_BEAT_STALE_MS, type ClusterMapBeat,
} from '../lmd/clusterMapGossip';
import { emptyClusterMap, type ClusterMap, activeManagerFromLease } from '../orchestrator/clusterMap';

function makeWs(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmgossip-test-'));
  fs.mkdirSync(path.join(root, '.autoclaw', 'orchestrator', 'comms'), { recursive: true });
  return root;
}
const T0 = Date.parse('2026-06-24T12:00:00.000Z');
const iso = (t: number): string => new Date(t).toISOString();

/** A cluster map at (epoch, term) with an optional active holder. */
function mapAt(epoch: number, term: number, holder?: string): ClusterMap {
  const m = { ...emptyClusterMap(), epoch, term };
  if (holder) {
    m.active_manager = activeManagerFromLease({
      holder, acquired_at: iso(T0), heartbeat: iso(T0), expires: iso(T0 + 90_000),
    });
  }
  return m;
}
function beat(origin: string, map: ClusterMap, t = T0): ClusterMapBeat {
  return { origin, emittedAt: iso(t), map };
}

suite('clusterMapGossip — file-bus transport (E3a)', () => {
  test('publish → readBeats round-trips to a PEER origin', async () => {
    const ws = makeWs();
    const a = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-A' });
    const b = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-B' });
    await a.publish(beat('loop-A', mapAt(2, 1, 'loop-A')));
    const got = await b.readBeats(T0);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].origin, 'loop-A');
    assert.strictEqual(got[0].map.epoch, 2);
    assert.strictEqual(got[0].map.active_manager?.instance_id, 'loop-A');
  });

  test('NO self-echo: a bus never reads back its own origin', async () => {
    const ws = makeWs();
    const a = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-A' });
    await a.publish(beat('loop-A', mapAt(1, 1, 'loop-A')));
    assert.deepStrictEqual(await a.readBeats(T0), [], 'own beat is skipped');
  });

  test('STALE beats (emittedAt older than staleMs) are dropped', async () => {
    const ws = makeWs();
    const a = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-A' });
    const b = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-B' });
    await a.publish(beat('loop-A', mapAt(1, 1, 'loop-A'), T0));
    assert.deepStrictEqual(await b.readBeats(T0 + CLUSTER_MAP_BEAT_STALE_MS + 1), [], 'stale beat dropped');
    assert.strictEqual((await b.readBeats(T0 + 5_000)).length, 1, 'fresh beat delivered');
  });

  test('an UNPARSEABLE emittedAt fails CLOSED (dropped) — a corrupt-timestamp beat never ages in', async () => {
    const ws = makeWs();
    const dir = clusterMapGossipDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'loop-bad.json'),
      JSON.stringify({ origin: 'loop-bad', emittedAt: 'garbage-not-a-date', map: mapAt(99, 9, 'loop-bad') }), 'utf8');
    const b = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-B' });
    assert.deepStrictEqual(await b.readBeats(T0), [], 'a beat with a non-parseable timestamp is dropped, not kept forever');
  });

  test('the exact stale boundary emittedAt == now - staleMs is KEPT (strict >)', async () => {
    const ws = makeWs();
    const a = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-A' });
    const b = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-B' });
    await a.publish(beat('loop-A', mapAt(1, 1, 'loop-A'), T0));
    assert.strictEqual((await b.readBeats(T0 + CLUSTER_MAP_BEAT_STALE_MS)).length, 1, 'exactly-at-ttl is kept');
    assert.strictEqual((await b.readBeats(T0 + CLUSTER_MAP_BEAT_STALE_MS + 1)).length, 0, 'one ms past ttl is dropped');
  });

  test('distinct hex loop-instance origins map to DISTINCT files (the production keyspace is injective)', async () => {
    const ws = makeWs();
    const a = new ClusterMapGossipBus(ws, { selfOrigin: 'x' });
    await a.publish(beat('orchestrator-loop-ab12cd', mapAt(1, 1)));
    await a.publish(beat('orchestrator-loop-ef34gh', mapAt(2, 1)));
    const files = fs.readdirSync(clusterMapGossipDir(ws)).filter((f) => f.endsWith('.json'));
    assert.strictEqual(files.length, 2, 'two distinct hex origins → two files (no collision)');
  });

  test('a beat with a MALFORMED embedded map is dropped (coerceClusterMap rejects it)', async () => {
    const ws = makeWs();
    const dir = clusterMapGossipDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'loop-bad.json'), JSON.stringify({ origin: 'loop-bad', emittedAt: iso(T0), map: { nope: true } }), 'utf8');
    const b = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-B' });
    assert.deepStrictEqual(await b.readBeats(T0), [], 'no epoch/term → map coerces to null → dropped');
  });

  test('malformed JSON / non-.json / .tmp- siblings are skipped; missing dir → []', async () => {
    const ws = makeWs();
    const b = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-B' });
    assert.deepStrictEqual(await b.readBeats(T0), [], 'missing dir → []');
    const dir = clusterMapGossipDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'garbage.json'), '{not json', 'utf8');
    fs.writeFileSync(path.join(dir, 'loop-A.json.tmp-9-9'), JSON.stringify(beat('loop-A', mapAt(1, 1))), 'utf8');
    fs.writeFileSync(path.join(dir, 'loop-A.json'), JSON.stringify(beat('loop-A', mapAt(3, 2, 'loop-A'))), 'utf8');
    const got = await b.readBeats(T0);
    assert.deepStrictEqual(got.map((x) => x.origin), ['loop-A'], 'only the valid .json beat read');
    assert.strictEqual(got[0].map.epoch, 3);
  });

  test('the atomic publish leaves no .tmp- sibling', async () => {
    const ws = makeWs();
    const a = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-A' });
    await a.publish(beat('loop-A', mapAt(1, 1, 'loop-A')));
    assert.ok(!fs.readdirSync(clusterMapGossipDir(ws)).some((f) => f.includes('.tmp-')), 'no temp leak');
  });

  test('pruneStale reaps LONG-dead orphan beats (window-restart leftovers), keeps fresh + malformed', async () => {
    const ws = makeWs();
    const a = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-X' });
    await a.publish(beat('loop-fresh', mapAt(1, 1), T0));
    await a.publish(beat('loop-dead', mapAt(1, 1), T0 - CLUSTER_MAP_BEAT_STALE_MS * 11)); // 990s old > 10×TTL=900s
    const dir = clusterMapGossipDir(ws);
    fs.writeFileSync(path.join(dir, 'garbage.json'), '{bad', 'utf8');
    const removed = await a.pruneStale(T0);
    assert.strictEqual(removed, 1, 'only the long-dead orphan beat reaped');
    assert.ok(fs.existsSync(path.join(dir, 'loop-fresh.json')), 'a fresh beat is kept');
    assert.ok(!fs.existsSync(path.join(dir, 'loop-dead.json')), 'the long-dead orphan is reaped');
    assert.ok(fs.existsSync(path.join(dir, 'garbage.json')), 'a malformed file is left alone (transient-safe)');
  });
});

suite('clusterMapGossip — RemoteClusterMapTracker (merge by epoch/term, no churn)', () => {
  test('a STRICTLY-NEWER beat advances best-seen (changed=true)', () => {
    const t = new RemoteClusterMapTracker();
    assert.strictEqual(t.merge(beat('loop-A', mapAt(1, 1))).changed, true, 'first beat is a change');
    assert.strictEqual(t.merge(beat('loop-B', mapAt(2, 1))).changed, true, 'higher epoch advances');
    assert.strictEqual(t.best()?.epoch, 2);
  });

  test('an EQUAL-version beat is a no-op (changed=false, same ref) — THE no-churn guard', () => {
    const t = new RemoteClusterMapTracker();
    t.merge(beat('loop-A', mapAt(3, 2, 'loop-A')));
    const before = t.best();
    const r = t.merge(beat('loop-B', mapAt(3, 2, 'loop-B'))); // same (epoch,term), different content
    assert.strictEqual(r.changed, false, 'equal version does not advance');
    assert.strictEqual(t.best(), before, 'best-seen is the SAME object (no churn)');
  });

  test('an OLDER beat is dropped (best-seen unchanged)', () => {
    const t = new RemoteClusterMapTracker();
    t.merge(beat('loop-A', mapAt(5, 3)));
    assert.strictEqual(t.merge(beat('loop-B', mapAt(2, 9))).changed, false, 'lower epoch dropped even with higher term');
    assert.strictEqual(t.best()?.epoch, 5);
  });

  test('mergeAll converges to the freshest of a batch', () => {
    const t = new RemoteClusterMapTracker();
    const r = t.mergeAll([beat('a', mapAt(1, 1)), beat('b', mapAt(4, 2)), beat('c', mapAt(3, 5))]);
    assert.strictEqual(r.changed, true);
    assert.strictEqual(t.best()?.epoch, 4, 'epoch 4 wins (epoch dominates term)');
  });

  test('REPLAY: re-reading the SAME unchanged beat across ticks is changed=false (the merge IS the dedup)', async () => {
    // The design note: there is deliberately NO emittedAt-dedupe set because readBeats
    // re-delivers the same file every tick and the equal-(epoch,term) merge no-ops it.
    const ws = makeWs();
    const a = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-A' });
    const b = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-B' });
    const trackerB = new RemoteClusterMapTracker();
    await a.publish(beat('loop-A', mapAt(3, 2, 'loop-A')));
    const tick1 = trackerB.mergeAll(await b.readBeats(T0));        // first delivery
    const seen = trackerB.best();
    const tick2 = trackerB.mergeAll(await b.readBeats(T0 + 1_000)); // same file re-delivered next tick
    assert.strictEqual(tick1.changed, true, 'first delivery advances');
    assert.strictEqual(tick2.changed, false, 'replay of the same beat is a NO-OP (no spurious change)');
    assert.strictEqual(trackerB.best(), seen, 'best-seen is the SAME object across the replay (no churn)');
  });
});

suite('clusterMapGossip — two-bus convergence (end to end)', () => {
  test('bus B learns the peer newer map over the file bus and converges via mergeClusterMap', async () => {
    const ws = makeWs();
    const a = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-A' });
    const b = new ClusterMapGossipBus(ws, { selfOrigin: 'loop-B' });
    const trackerB = new RemoteClusterMapTracker();
    // B starts with a stale local view (epoch 1); A publishes a fresher map (epoch 5, A active).
    trackerB.merge(beat('loop-B', mapAt(1, 1, 'loop-B')));
    await a.publish(beat('loop-A', mapAt(5, 3, 'loop-A')));
    const advanced = trackerB.mergeAll(await b.readBeats(T0));
    assert.strictEqual(advanced.changed, true, 'B advanced on the peer beat');
    assert.strictEqual(trackerB.best()?.epoch, 5);
    assert.strictEqual(trackerB.best()?.active_manager?.instance_id, 'loop-A',
      'B now sees A as the active — its next acquire will stand down (single-active preserved)');
  });
});
