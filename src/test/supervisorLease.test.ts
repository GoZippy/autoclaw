import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireSupervisorRole, releaseSupervisorRole, readSupervisorLease,
  supervisorLeasePath, clusterMapPath, SUPERVISOR_TTL_MS, CLUSTER_MAP_LOCK_TTL_MS,
} from '../orchestrator/supervisorLease';
import { emptyClusterMap, activeManagerFromLease, appendFenced, type ClusterMap, type Membership } from '../orchestrator/clusterMap';

function makeWs(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suplease-test-'));
  fs.mkdirSync(path.join(root, '.autoclaw', 'orchestrator', 'comms'), { recursive: true });
  return root;
}
const T0 = Date.parse('2026-06-17T12:00:00.000Z');

suite('Supervisor lease (SH-2 standby failover)', () => {

  test('acquiring an unheld lease makes the caller supervisor', async () => {
    const ws = makeWs();
    const r = await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    assert.strictEqual(r.isSupervisor, true);
    assert.strictEqual(r.stole, false);
    assert.strictEqual(r.holder, 'loop-A');
    assert.ok(fs.existsSync(supervisorLeasePath(ws)));
  });

  test('the same holder renews (stays supervisor, no steal)', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    const r = await acquireSupervisorRole(ws, 'loop-A', { now: T0 + 10_000 });
    assert.strictEqual(r.isSupervisor, true);
    assert.strictEqual(r.stole, false);
    const lease = await readSupervisorLease(ws);
    assert.strictEqual(lease!.heartbeat, new Date(T0 + 10_000).toISOString());
    // acquired_at preserved across renewal.
    assert.strictEqual(lease!.acquired_at, new Date(T0).toISOString());
  });

  test('another host stands by while the lease is fresh', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    const r = await acquireSupervisorRole(ws, 'loop-B', { now: T0 + 5_000 });
    assert.strictEqual(r.isSupervisor, false);
    assert.strictEqual(r.holder, 'loop-A');
    // The holder is unchanged on disk.
    assert.strictEqual((await readSupervisorLease(ws))!.holder, 'loop-A');
  });

  test('a standby steals a STALE lease and becomes supervisor', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    // Past the TTL with no renewal from A → B takes over.
    const r = await acquireSupervisorRole(ws, 'loop-B', { now: T0 + SUPERVISOR_TTL_MS + 1 });
    assert.strictEqual(r.isSupervisor, true);
    assert.strictEqual(r.stole, true);
    assert.strictEqual(r.holder, 'loop-B');
    assert.strictEqual((await readSupervisorLease(ws))!.holder, 'loop-B');
  });

  test('release only succeeds for the owning holder', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    assert.strictEqual(await releaseSupervisorRole(ws, 'loop-B'), false, 'non-owner cannot release');
    assert.strictEqual(await releaseSupervisorRole(ws, 'loop-A'), true);
    assert.strictEqual(await readSupervisorLease(ws), null);
  });

  test('after release, the next caller acquires cleanly (no steal)', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    await releaseSupervisorRole(ws, 'loop-A');
    const r = await acquireSupervisorRole(ws, 'loop-B', { now: T0 + 1000 });
    assert.strictEqual(r.isSupervisor, true);
    assert.strictEqual(r.stole, false);
  });
});

/**
 * E1b — the lease now lives in cluster-map.json with a compat mirror to the
 * legacy supervisor.lock.json and a read-fallback FROM it. These tests pin the
 * E1b-specific behavior; the SH-2 suite above is the backward-compat oracle
 * (it must stay green UNEDITED — it never references cluster-map.json).
 */
suite('Supervisor lease — E1b cluster-map projection + compat shim', () => {

  test('acquire writes BOTH cluster-map.json and the legacy mirror, mirror == projected lease', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    assert.ok(fs.existsSync(clusterMapPath(ws)), 'cluster-map.json written');
    assert.ok(fs.existsSync(supervisorLeasePath(ws)), 'legacy mirror written');
    const map = JSON.parse(fs.readFileSync(clusterMapPath(ws), 'utf8'));
    const mirror = JSON.parse(fs.readFileSync(supervisorLeasePath(ws), 'utf8'));
    assert.strictEqual(map.active_manager.instance_id, 'loop-A');
    // The legacy mirror is exactly the flat projection of active_manager.
    assert.deepStrictEqual(mirror, {
      holder: map.active_manager.instance_id,
      acquired_at: map.active_manager.acquired_at,
      heartbeat: map.active_manager.lease_heartbeat,
      expires: map.active_manager.lease_expires,
    });
  });

  test('READ-FALLBACK: a legacy-only flat lease (no cluster map) is honored unchanged', async () => {
    const ws = makeWs();
    // Simulate an in-flight pre-E1b host: only supervisor.lock.json exists.
    fs.writeFileSync(supervisorLeasePath(ws), JSON.stringify({
      holder: 'loop-legacy',
      acquired_at: new Date(T0).toISOString(),
      heartbeat: new Date(T0).toISOString(),
      expires: new Date(T0 + SUPERVISOR_TTL_MS).toISOString(),
    }, null, 2), 'utf8');
    assert.ok(!fs.existsSync(clusterMapPath(ws)), 'no cluster map yet');
    // readSupervisorLease adopts the legacy holder with no blip.
    assert.strictEqual((await readSupervisorLease(ws))!.holder, 'loop-legacy');
    // A different fresh host stands by behind the adopted legacy lease.
    const r = await acquireSupervisorRole(ws, 'loop-B', { now: T0 + 5_000 });
    assert.strictEqual(r.isSupervisor, false);
    assert.strictEqual(r.holder, 'loop-legacy');
  });

  test('MIGRATION: the legacy holder renewing through E1b materializes cluster-map.json', async () => {
    const ws = makeWs();
    fs.writeFileSync(supervisorLeasePath(ws), JSON.stringify({
      holder: 'loop-legacy',
      acquired_at: new Date(T0).toISOString(),
      heartbeat: new Date(T0).toISOString(),
      expires: new Date(T0 + SUPERVISOR_TTL_MS).toISOString(),
    }, null, 2), 'utf8');
    // Same holder ticks again → renew → now the durable map exists, acquired_at preserved.
    const r = await acquireSupervisorRole(ws, 'loop-legacy', { now: T0 + 10_000 });
    assert.strictEqual(r.isSupervisor, true);
    assert.strictEqual(r.stole, false);
    assert.ok(fs.existsSync(clusterMapPath(ws)), 'cluster map materialized on migration');
    const lease = await readSupervisorLease(ws);
    assert.strictEqual(lease!.acquired_at, new Date(T0).toISOString(), 'acquired_at preserved across migration');
    assert.strictEqual(lease!.heartbeat, new Date(T0 + 10_000).toISOString());
  });

  test('cluster-map.json takes PRECEDENCE over a SAME-OR-OLDER divergent legacy mirror', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 }); // writes both files, holder loop-A @ T0
    // A divergent mirror at the SAME heartbeat is NOT a takeover — the map wins.
    fs.writeFileSync(supervisorLeasePath(ws), JSON.stringify({
      holder: 'loop-STALE', acquired_at: new Date(T0).toISOString(),
      heartbeat: new Date(T0).toISOString(), expires: new Date(T0 + SUPERVISOR_TTL_MS).toISOString(),
    }, null, 2), 'utf8');
    assert.strictEqual((await readSupervisorLease(ws))!.holder, 'loop-A', 'map wins over same-age legacy');
  });

  test('MIXED-VERSION STEAL: a strictly-NEWER legacy mirror under a different holder is honored (no split-brain)', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 }); // E1b host A: map+mirror = A @ T0
    // A pre-E1b peer B takes over by writing ONLY supervisor.lock.json, fresher.
    fs.writeFileSync(supervisorLeasePath(ws), JSON.stringify({
      holder: 'loop-B', acquired_at: new Date(T0 + 30_000).toISOString(),
      heartbeat: new Date(T0 + 30_000).toISOString(), expires: new Date(T0 + 30_000 + SUPERVISOR_TTL_MS).toISOString(),
    }, null, 2), 'utf8');
    // A's reader must SEE B's takeover (else A self-renews → two supervisors).
    assert.strictEqual((await readSupervisorLease(ws))!.holder, 'loop-B', 'newer mirror wins');
    // And A, ticking again, stands by behind B rather than renewing itself.
    const r = await acquireSupervisorRole(ws, 'loop-A', { now: T0 + 35_000 });
    assert.strictEqual(r.isSupervisor, false);
    assert.strictEqual(r.holder, 'loop-B');
  });

  test('release clears BOTH the cluster map and the legacy mirror (no orphan to resurrect)', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 });
    assert.ok(fs.existsSync(clusterMapPath(ws)) && fs.existsSync(supervisorLeasePath(ws)));
    assert.strictEqual(await releaseSupervisorRole(ws, 'loop-A'), true);
    assert.ok(!fs.existsSync(clusterMapPath(ws)), 'cluster map removed');
    assert.ok(!fs.existsSync(supervisorLeasePath(ws)), 'legacy mirror removed (no resurrection source)');
    assert.strictEqual(await readSupervisorLease(ws), null);
  });
});

/**
 * E1c — opt-in fencing (autoclaw.cluster.fencing): LIVE epoch/term, deposed-holder
 * fencing, self-fence stand-down, all serialized by a create-exclusive wx-lock.
 * The pure (epoch,term)/fence/steal logic is already pinned in clusterMap.test.ts;
 * these are the fs-level WIRING tests. They pass { fencing: true } explicitly — the
 * SH-2 + E1b suites above pass NO fencing and stay byte-identical (flag OFF).
 */
suite('Supervisor lease — E1c fencing + wx-lock (opt-in)', () => {
  function readMap(ws: string): ClusterMap {
    return JSON.parse(fs.readFileSync(clusterMapPath(ws), 'utf8'));
  }
  function lockPath(ws: string): string {
    return path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'cluster-map.json.lock');
  }
  /** Seed cluster-map.json directly (fixture style) — bypasses acquire. */
  function seedMap(ws: string, m: ClusterMap): void {
    fs.writeFileSync(clusterMapPath(ws), JSON.stringify(m, null, 2) + '\n', 'utf8');
  }

  test('FLAG OFF byte-identity: acquire WITHOUT fencing leaves epoch/term INERT (0/0)', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 }); // no fencing
    const m = readMap(ws);
    assert.strictEqual(m.epoch, 0, 'epoch inert without the flag');
    assert.strictEqual(m.term, 0, 'term inert without the flag');
    assert.ok(!fs.existsSync(lockPath(ws)), 'no wx-lock artifact when flag off');
  });

  test('term++ on a fresh acquire (empty 0/0 -> 1/1)', async () => {
    const ws = makeWs();
    const r = await acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true });
    assert.strictEqual(r.isSupervisor, true);
    const m = readMap(ws);
    assert.strictEqual(m.epoch, 1);
    assert.strictEqual(m.term, 1);
    assert.strictEqual(m.active_manager?.instance_id, 'loop-A');
  });

  test('a same-holder RENEW bumps NEITHER epoch nor term (and preserves acquired_at)', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true }); // -> 1/1
    const r = await acquireSupervisorRole(ws, 'loop-A', { now: T0 + 10_000, fencing: true });
    assert.strictEqual(r.isSupervisor, true);
    assert.strictEqual(r.stole, false);
    const m = readMap(ws);
    assert.strictEqual(m.epoch, 1, 'renew does not bump epoch');
    assert.strictEqual(m.term, 1, 'renew does not bump term');
    assert.strictEqual(m.active_manager?.acquired_at, new Date(T0).toISOString(), 'acquired_at preserved');
    assert.strictEqual(m.active_manager?.lease_heartbeat, new Date(T0 + 10_000).toISOString());
  });

  test('a steal bumps the term AND fences the deposed holder at its OLD term', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true }); // A active at term 1
    const r = await acquireSupervisorRole(ws, 'loop-B', { now: T0 + SUPERVISOR_TTL_MS + 1, fencing: true });
    assert.strictEqual(r.isSupervisor, true);
    assert.strictEqual(r.stole, true);
    assert.strictEqual(r.holder, 'loop-B');
    const m = readMap(ws);
    assert.strictEqual(m.epoch, 2);
    assert.strictEqual(m.term, 2);
    assert.strictEqual(m.active_manager?.instance_id, 'loop-B');
    assert.strictEqual(m.fenced.length, 1);
    assert.strictEqual(m.fenced[0].instance_id, 'loop-A');
    assert.strictEqual(m.fenced[0].fenced_at_term, 1, 'deposed at the term A actually held, not the new term');
  });

  test('SELF-FENCE: a fenced holder stands down (no renew, no write) even with the active naming it', async () => {
    const ws = makeWs();
    // Seed a map where loop-A is BOTH the named active AND fenced — the dangerous
    // resurrection case: a naive renew would write A back into power.
    const seeded: ClusterMap = {
      ...emptyClusterMap(),
      epoch: 5, term: 3,
      active_manager: activeManagerFromLease({
        holder: 'loop-A', acquired_at: new Date(T0).toISOString(),
        heartbeat: new Date(T0).toISOString(), expires: new Date(T0 + SUPERVISOR_TTL_MS).toISOString(),
      }),
      fenced: [{ instance_id: 'loop-A', fenced_at_term: 3, fenced_at: new Date(T0).toISOString() }],
    };
    seedMap(ws, seeded);
    const r = await acquireSupervisorRole(ws, 'loop-A', { now: T0 + 1_000, fencing: true });
    assert.strictEqual(r.isSupervisor, false, 'self-fenced holder stands down');
    const m = readMap(ws);
    assert.strictEqual(m.term, 3, 'no term bump — the fenced holder did not write');
    assert.strictEqual(m.active_manager?.lease_heartbeat, new Date(T0).toISOString(), 'active not renewed');
  });

  test('LIVENESS: a fenced holder CAN reclaim a STALE/abandoned lease (clears its own fence, fences the deposed)', async () => {
    // The sole-survivor case: loop-A was deposed (fenced) by loop-B, then loop-B died.
    // loop-A, the only live host, MUST be able to reclaim the abandoned role — a fence
    // blocks RESURRECTION (renewing a fresh self-claim), never legitimate FAILOVER.
    const ws = makeWs();
    const stale: ClusterMap = {
      ...emptyClusterMap(),
      epoch: 2, term: 2,
      active_manager: activeManagerFromLease({
        holder: 'loop-B', acquired_at: new Date(T0).toISOString(),
        heartbeat: new Date(T0).toISOString(), expires: new Date(T0 + SUPERVISOR_TTL_MS).toISOString(),
      }),
      fenced: [{ instance_id: 'loop-A', fenced_at_term: 1, fenced_at: new Date(T0).toISOString() }],
    };
    seedMap(ws, stale);
    const past = T0 + SUPERVISOR_TTL_MS + 1; // B's lease is now stale → role abandoned
    const r = await acquireSupervisorRole(ws, 'loop-A', { now: past, fencing: true });
    assert.strictEqual(r.isSupervisor, true, 'fenced loop-A reclaims the abandoned role (no permanent strand)');
    assert.strictEqual(r.stole, true);
    const m = readMap(ws);
    assert.strictEqual(m.active_manager?.instance_id, 'loop-A');
    assert.ok(!m.fenced.some((f) => f.instance_id === 'loop-A'), 'loop-A fence cleared on re-admission');
    assert.ok(m.fenced.some((f) => f.instance_id === 'loop-B'), 'deposed loop-B now fenced');
  });

  test('WX-LOCK: two concurrent fencing acquires yield EXACTLY ONE supervisor', async () => {
    // The lock serializes the RMW; the second acquirer then reads the first window's
    // committed map and stands by (Case D). One winner per round — run many rounds.
    for (let i = 0; i < 30; i++) {
      const ws = makeWs();
      const [ra, rb] = await Promise.all([
        acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true }),
        acquireSupervisorRole(ws, 'loop-B', { now: T0, fencing: true }),
      ]);
      const winners = [ra, rb].filter((r) => r.isSupervisor);
      assert.strictEqual(winners.length, 1, `round ${i}: exactly one window wins`);
      assert.strictEqual(readMap(ws).active_manager?.instance_id, winners[0].holder, 'map names the winner');
      assert.ok(!fs.existsSync(lockPath(ws)), 'lock released after the RMW');
    }
  });

  test('WX-LOCK: two concurrent acquires REAPING one stale orphan still yield EXACTLY ONE supervisor', async () => {
    // The double-winner race the rename-claim reap closes: two reapers of the same
    // orphan must not both win. Many rounds, since the unlink-then-open bug was ~1.5%.
    for (let i = 0; i < 30; i++) {
      const ws = makeWs();
      fs.writeFileSync(lockPath(ws), ''); // a crashed holder's orphan lock
      const old = (T0 - CLUSTER_MAP_LOCK_TTL_MS - 10_000) / 1000;
      fs.utimesSync(lockPath(ws), old, old); // older than the reaping TTL → reapable
      const [ra, rb] = await Promise.all([
        acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true }),
        acquireSupervisorRole(ws, 'loop-B', { now: T0, fencing: true }),
      ]);
      const winners = [ra, rb].filter((r) => r.isSupervisor);
      assert.strictEqual(winners.length, 1, `round ${i}: concurrent orphan reap → exactly one winner`);
    }
  });

  test('WX-LOCK: a FRESH foreign lock blocks (stand by, reports incumbent); a STALE orphan lock is reaped', async () => {
    const ws = makeWs();
    // A fresh lock held by someone mid-RMW → this acquire stands by, writes nothing.
    fs.writeFileSync(lockPath(ws), '');
    const blocked = await acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true });
    assert.strictEqual(blocked.isSupervisor, false, 'fresh lock → stand by');
    assert.strictEqual(blocked.holder, 'loop-A', 'no incumbent yet → reports the caller');
    assert.ok(!fs.existsSync(clusterMapPath(ws)), 'blocked acquire wrote no map');
    // Back-date the lock past the reaping TTL → a crashed holder; the next acquire reaps it.
    const old = (T0 - CLUSTER_MAP_LOCK_TTL_MS - 1_000) / 1000;
    fs.utimesSync(lockPath(ws), old, old);
    const reaped = await acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true });
    assert.strictEqual(reaped.isSupervisor, true, 'stale orphan lock reaped → acquire succeeds');
    assert.strictEqual(readMap(ws).active_manager?.instance_id, 'loop-A');
  });

  test('appendFenced fixture helper stays consistent with the live steal fence (sanity)', async () => {
    // Guards the test fixtures against drift from the production appendFenced contract.
    const m = appendFenced({ ...emptyClusterMap(), term: 4 }, 'loop-X', T0);
    assert.strictEqual(m.fenced[0].fenced_at_term, 4);
  });
});

/**
 * E2b-i — the START LOOP membership roster (monitors/standbys/quorum) folds into the
 * SAME wx-locked acquire write, ONLY on the fenced path. acquire-without-membership is
 * byte-identical to E1c; the non-fenced path ignores membership entirely.
 */
suite('Supervisor lease — E2b membership fold (opt-in, fenced only)', () => {
  function readMap(ws: string): ClusterMap {
    return JSON.parse(fs.readFileSync(clusterMapPath(ws), 'utf8'));
  }
  function lockPath(ws: string): string {
    return path.join(ws, '.autoclaw', 'orchestrator', 'comms', 'cluster-map.json.lock');
  }
  const member = (monitors: string[], quorum: number, standbys: Membership['standbys'] = []): Membership =>
    ({ monitors, standbys, quorum_size: quorum });
  const lease = (holder: string, t = T0) => activeManagerFromLease({
    holder, acquired_at: new Date(t).toISOString(),
    heartbeat: new Date(t).toISOString(), expires: new Date(t + SUPERVISOR_TTL_MS).toISOString(),
  });
  const seed = (ws: string, m: ClusterMap) => fs.writeFileSync(clusterMapPath(ws), JSON.stringify(m, null, 2) + '\n', 'utf8');

  test('fenced acquire WITH membership folds monitors/standbys/quorum into the one write (active is a monitor of itself)', async () => {
    const ws = makeWs();
    const r = await acquireSupervisorRole(ws, 'loop-A', {
      now: T0, fencing: true,
      membership: member(['loop-A', 'loop-B'], 2, [{ instance_id: 'loop-B', score: 0.9, last_seen: new Date(T0).toISOString() }]),
    });
    assert.strictEqual(r.isSupervisor, true);
    const m = readMap(ws);
    assert.deepStrictEqual(m.monitors, ['loop-A', 'loop-B'], 'roster round-trips, including the active itself');
    assert.strictEqual(m.standbys[0]?.instance_id, 'loop-B');
    assert.strictEqual(m.quorum_size, 2);
    assert.strictEqual(m.active_manager?.instance_id, 'loop-A', 'membership rides the active-manager write');
    // Fresh acquire = bumpTerm (1/1) THEN applyMembership bumps epoch for the new roster → 2/1.
    assert.strictEqual(m.epoch, 2, 'fresh acquire + new roster lands at epoch 2');
    assert.strictEqual(m.term, 1, 'term is 1 (one election); membership never bumps term');
  });

  test('a fenced STEAL WITH membership writes the new roster AND fences the deposed in ONE write', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true }); // A active, term 1
    const r = await acquireSupervisorRole(ws, 'loop-B', {
      now: T0 + SUPERVISOR_TTL_MS + 1, fencing: true, membership: member(['loop-B'], 1),
    });
    assert.strictEqual(r.stole, true);
    const m = readMap(ws);
    assert.strictEqual(m.active_manager?.instance_id, 'loop-B');
    assert.deepStrictEqual(m.monitors, ['loop-B'], 'steal folds the new roster');
    assert.strictEqual(m.quorum_size, 1);
    assert.ok(m.fenced.some((f) => f.instance_id === 'loop-A'), 'deposed loop-A fenced in the SAME write');
  });

  test('a STAND-BY (fresh foreign active) WITH membership persists NO roster', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true }); // A active, fresh
    const r = await acquireSupervisorRole(ws, 'loop-B', { now: T0 + 5_000, fencing: true, membership: member(['loop-B', 'loop-X'], 2) });
    assert.strictEqual(r.isSupervisor, false, 'B stands by behind fresh A');
    assert.deepStrictEqual(readMap(ws).monitors, [], 'a standby never persists the roster');
  });

  test('a SELF-FENCE WITH membership persists NO roster (no write at all)', async () => {
    const ws = makeWs();
    seed(ws, { // loop-A active AND fenced — the resurrection-guard case
      ...emptyClusterMap(), epoch: 5, term: 3, active_manager: lease('loop-A'),
      fenced: [{ instance_id: 'loop-A', fenced_at_term: 3, fenced_at: new Date(T0).toISOString() }],
    });
    const r = await acquireSupervisorRole(ws, 'loop-A', { now: T0 + 1_000, fencing: true, membership: member(['loop-A', 'loop-X'], 2) });
    assert.strictEqual(r.isSupervisor, false, 'self-fenced stands down');
    const m = readMap(ws);
    assert.deepStrictEqual(m.monitors, [], 'self-fence wrote no roster');
    assert.strictEqual(m.term, 3, 'no write at all');
  });

  test('a LOCK-LOSER WITH membership persists NO map', async () => {
    const ws = makeWs();
    fs.writeFileSync(lockPath(ws), ''); // a fresh foreign wx-lock
    const r = await acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true, membership: member(['loop-A'], 1) });
    assert.strictEqual(r.isSupervisor, false, 'lock-loser stands by');
    assert.ok(!fs.existsSync(clusterMapPath(ws)), 'lock-loser wrote no map (no roster leak)');
  });

  test('a stable -0-scored standby does NOT churn the epoch across renews (disk round-trip)', async () => {
    const ws = makeWs();
    const m0 = member(['loop-A'], 1, [{ instance_id: 'loop-B', score: -0, last_seen: new Date(T0).toISOString() }]);
    await acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true, membership: m0 });
    const e1 = readMap(ws).epoch;
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 + 10_000, fencing: true, membership: m0 });
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 + 20_000, fencing: true, membership: m0 });
    assert.strictEqual(readMap(ws).epoch, e1, '-0 score reads back as +0 but still no-ops — epoch stable');
  });

  test('fenced acquire WITHOUT membership leaves the roster empty (E1c byte-identical)', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true });
    const m = readMap(ws);
    assert.deepStrictEqual(m.monitors, []);
    assert.deepStrictEqual(m.standbys, []);
    assert.strictEqual(m.quorum_size, 1, 'emptyClusterMap default');
  });

  test('the NON-fenced path IGNORES membership (the roster write requires the wx-lock)', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0, membership: member(['loop-A'], 1) }); // no fencing
    assert.deepStrictEqual(readMap(ws).monitors, [], 'non-fenced acquire wrote no roster');
  });

  test('a renew with STABLE membership does NOT churn the epoch', async () => {
    const ws = makeWs();
    const m0 = member(['loop-A'], 1);
    await acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true, membership: m0 });
    const e1 = readMap(ws).epoch;
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 + 10_000, fencing: true, membership: m0 });
    assert.strictEqual(readMap(ws).epoch, e1, 'stable membership renew = no epoch bump');
  });

  test('a renew with a CHANGED membership (a peer joins) bumps the epoch', async () => {
    const ws = makeWs();
    await acquireSupervisorRole(ws, 'loop-A', { now: T0, fencing: true, membership: member(['loop-A'], 1) });
    const e1 = readMap(ws).epoch;
    await acquireSupervisorRole(ws, 'loop-A', { now: T0 + 10_000, fencing: true, membership: member(['loop-A', 'loop-B'], 2) });
    const m = readMap(ws);
    assert.ok(m.epoch > e1, 'a peer joining the monitor set bumps epoch');
    assert.deepStrictEqual(m.monitors, ['loop-A', 'loop-B']);
    assert.strictEqual(m.active_manager?.lease_heartbeat, new Date(T0 + 10_000).toISOString(), 'still a renew (heartbeat advanced)');
  });
});
