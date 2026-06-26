import * as assert from 'assert';
import type { SupervisorLease } from '../orchestrator/supervisorLease';
import {
  CLUSTER_MAP_VERSION,
  type ClusterMap,
  type ActiveManager,
  type Standby,
  emptyClusterMap,
  activeManagerFromLease,
  clusterMapFromLease,
  bootstrapQuorumOfOne,
  compareVersion,
  isStrictlyNewer,
  mergeClusterMap,
  bumpEpoch,
  bumpTerm,
  appendFenced,
  isFenced,
  clearFenced,
  toSupervisorLease,
  rankStandbys,
  coerceClusterMap,
  freshnessFactor,
  projectMonitors,
  projectStandbys,
  computeQuorumSize,
  applyMembership,
  type StandbyCandidate,
} from '../orchestrator/clusterMap';

const T0 = Date.parse('2026-06-24T12:00:00.000Z');

function lease(holder: string, t = T0): SupervisorLease {
  return {
    holder,
    acquired_at: new Date(t).toISOString(),
    heartbeat: new Date(t).toISOString(),
    expires: new Date(t + 90_000).toISOString(),
  };
}

function am(instanceId: string, t = T0): ActiveManager {
  return {
    instance_id: instanceId,
    acquired_at: new Date(t).toISOString(),
    lease_heartbeat: new Date(t).toISOString(),
    lease_expires: new Date(t + 90_000).toISOString(),
  };
}

/** A map at a given (epoch, term) with an optional active manager. */
function mapAt(epoch: number, term: number, active: ActiveManager | null = null): ClusterMap {
  return { ...emptyClusterMap(), epoch, term, active_manager: active };
}

suite('clusterMap — construction', () => {
  test('emptyClusterMap is version 1, epoch/term 0, quorum-of-one, no active', () => {
    const m = emptyClusterMap();
    assert.strictEqual(m.version, CLUSTER_MAP_VERSION);
    assert.strictEqual(m.version, 1);
    assert.strictEqual(m.epoch, 0);
    assert.strictEqual(m.term, 0);
    assert.strictEqual(m.active_manager, null);
    assert.strictEqual(m.quorum_size, 1);
    assert.deepStrictEqual(m.standbys, []);
    assert.deepStrictEqual(m.monitors, []);
    assert.deepStrictEqual(m.fenced, []);
  });

  test('activeManagerFromLease maps the four lease fields 1:1', () => {
    const a = activeManagerFromLease(lease('loop-A'));
    assert.strictEqual(a.instance_id, 'loop-A');
    assert.strictEqual(a.acquired_at, lease('loop-A').acquired_at);
    assert.strictEqual(a.lease_heartbeat, lease('loop-A').heartbeat);
    assert.strictEqual(a.lease_expires, lease('loop-A').expires);
    // No optional fields unless supplied.
    assert.strictEqual(a.agent_id, undefined);
    assert.strictEqual(a.machine_id, undefined);
  });

  test('activeManagerFromLease attaches optional agent_id / machine_id only when given', () => {
    const a = activeManagerFromLease(lease('loop-A'), { agent_id: 'claude-code', machine_id: 'box-1' });
    assert.strictEqual(a.agent_id, 'claude-code');
    assert.strictEqual(a.machine_id, 'box-1');
  });

  test('clusterMapFromLease(null) yields an empty map; a present lease becomes active at term 0', () => {
    assert.deepStrictEqual(clusterMapFromLease(null), emptyClusterMap());
    const m = clusterMapFromLease(lease('loop-A'));
    assert.strictEqual(m.epoch, 0);
    assert.strictEqual(m.term, 0);
    assert.strictEqual(m.active_manager?.instance_id, 'loop-A');
  });

  test('bootstrapQuorumOfOne installs the lone agent at epoch 1 / term 1, quorum 1', () => {
    const m = bootstrapQuorumOfOne(lease('loop-A'));
    assert.strictEqual(m.epoch, 1);
    assert.strictEqual(m.term, 1);
    assert.strictEqual(m.quorum_size, 1);
    assert.strictEqual(m.active_manager?.instance_id, 'loop-A');
    assert.deepStrictEqual(m.fenced, []);
  });
});

suite('clusterMap — ordering by integer (epoch, term)', () => {
  test('higher epoch wins regardless of term', () => {
    const a = mapAt(2, 0);
    const b = mapAt(1, 99);
    assert.strictEqual(compareVersion(a, b), 1);
    assert.strictEqual(isStrictlyNewer(a, b), true);
    assert.strictEqual(isStrictlyNewer(b, a), false);
  });

  test('equal epoch → higher term wins', () => {
    const a = mapAt(5, 7);
    const b = mapAt(5, 6);
    assert.strictEqual(compareVersion(a, b), 1);
    assert.strictEqual(compareVersion(b, a), -1);
  });

  test('equal (epoch, term) compares 0 and is NOT strictly newer (no churn)', () => {
    const a = mapAt(3, 3);
    const b = mapAt(3, 3);
    assert.strictEqual(compareVersion(a, b), 0);
    assert.strictEqual(isStrictlyNewer(a, b), false);
    assert.strictEqual(isStrictlyNewer(b, a), false);
  });

  test('CLOCK SKEW IMMUNITY: the (epoch,term)-newer map wins even with an OLDER heartbeat', () => {
    // newer by version, but its lease heartbeat is timestamped EARLIER than the
    // older map's — a timestamp-based merge would wrongly pick the stale one.
    const newer = mapAt(2, 2, am('loop-B', T0 - 60_000)); // older clock
    const older = mapAt(1, 1, am('loop-A', T0));           // newer clock
    assert.strictEqual(isStrictlyNewer(newer, older), true);
    assert.strictEqual(mergeClusterMap(older, newer).active_manager?.instance_id, 'loop-B');
  });
});

suite('clusterMap — mergeClusterMap (freshest-wins, generalized from gossip)', () => {
  test('strictly-newer incoming wins WHOLE', () => {
    const local = mapAt(1, 1, am('loop-A'));
    const incoming = mapAt(2, 1, am('loop-B'));
    const merged = mergeClusterMap(local, incoming);
    assert.strictEqual(merged, incoming);
    assert.strictEqual(merged.active_manager?.instance_id, 'loop-B');
  });

  test('older / out-of-order incoming is DROPPED (incumbent local returned unchanged)', () => {
    const local = mapAt(3, 2, am('loop-A'));
    const incoming = mapAt(2, 9, am('loop-B'));
    assert.strictEqual(mergeClusterMap(local, incoming), local);
  });

  test('equal-version incoming is a no-op (keeps local, no churn)', () => {
    const local = mapAt(4, 4, am('loop-A'));
    const incoming = mapAt(4, 4, am('loop-B')); // same version, different content
    assert.strictEqual(mergeClusterMap(local, incoming), local);
  });
});

suite('clusterMap — bump helpers (pure + immutable)', () => {
  test('bumpEpoch increments epoch only, leaves term, does not mutate input', () => {
    const before = mapAt(2, 5, am('loop-A'));
    const after = bumpEpoch(before);
    assert.strictEqual(after.epoch, 3);
    assert.strictEqual(after.term, 5);
    assert.strictEqual(before.epoch, 2, 'input not mutated');
    assert.notStrictEqual(after, before, 'returns a fresh object');
  });

  test('bumpTerm increments BOTH epoch and term and installs the new active', () => {
    const before = mapAt(2, 5, am('loop-A'));
    const after = bumpTerm(before, am('loop-B'));
    assert.strictEqual(after.epoch, 3, 'a new active is also a membership change');
    assert.strictEqual(after.term, 6);
    assert.strictEqual(after.active_manager?.instance_id, 'loop-B');
    assert.strictEqual(before.active_manager?.instance_id, 'loop-A', 'input not mutated');
  });

  test('appendFenced records the deposed holder at the CURRENT term, before a term bump', () => {
    const before = mapAt(2, 5, am('loop-A'));
    const fenced = appendFenced(before, 'loop-A', T0);
    assert.strictEqual(fenced.fenced.length, 1);
    assert.strictEqual(fenced.fenced[0].instance_id, 'loop-A');
    assert.strictEqual(fenced.fenced[0].fenced_at_term, 5, 'captures the term it held');
    assert.strictEqual(fenced.fenced[0].fenced_at, new Date(T0).toISOString());
    assert.deepStrictEqual(before.fenced, [], 'input not mutated');
  });

  test('appendFenced is idempotent for the same id at the same term', () => {
    const a = appendFenced(mapAt(2, 5), 'loop-A', T0);
    const b = appendFenced(a, 'loop-A', T0 + 1000);
    assert.strictEqual(b, a, 'no-op returns the same object');
    assert.strictEqual(b.fenced.length, 1);
  });

  test('steal composition: append (old term) THEN bumpTerm captures the deposed term correctly', () => {
    const before = mapAt(2, 5, am('loop-A'));
    const stolen = bumpTerm(appendFenced(before, 'loop-A', T0), am('loop-B'));
    assert.strictEqual(stolen.term, 6);
    assert.strictEqual(stolen.active_manager?.instance_id, 'loop-B');
    assert.strictEqual(stolen.fenced[0].instance_id, 'loop-A');
    assert.strictEqual(stolen.fenced[0].fenced_at_term, 5, 'deposed at the term it actually held');
  });

  test('appendFenced dedup is PER-TERM: the same id fenced at two different terms yields two entries', () => {
    // Pins the `&& f.fenced_at_term === map.term` clause: a holder deposed at
    // term 5, re-admitted, then deposed again at term 6 must get BOTH fences.
    const atTerm5 = appendFenced(mapAt(2, 5), 'loop-A', T0);
    const atTerm6 = appendFenced(bumpTerm(atTerm5, am('loop-B')), 'loop-A', T0 + 1000);
    assert.strictEqual(atTerm6.fenced.length, 2);
    assert.deepStrictEqual(atTerm6.fenced.map((f) => f.fenced_at_term).sort(), [5, 6]);
  });

  test('merge orders by EPOCH first: racing standby epoch bumps outrank a single term bump (why acquire must be wx-serialized)', () => {
    // The honest semantics behind the bumpTerm docstring: a manager change is
    // strictly newer than the SAME base, but does NOT dominate an unrelated map
    // that advanced epoch further. Two bumpEpoch (→ epoch+2, term) beat one
    // bumpTerm (→ epoch+1, term+1). E1c serializes acquires with a wx-lock so
    // this race cannot occur on the shared map; merge is only the cross-host tie-break.
    const start = mapAt(5, 3, am('old'));
    const standbyTwice = bumpEpoch(bumpEpoch(start)); // (7, 3)
    const election = bumpTerm(start, am('new'));      // (6, 4)
    assert.strictEqual(isStrictlyNewer(election, start), true, 'an election beats its own base');
    const winner = mergeClusterMap(standbyTwice, election);
    assert.strictEqual(winner.epoch, 7);
    assert.strictEqual(winner.term, 3);
    assert.strictEqual(winner.active_manager?.instance_id, 'old', 'epoch dominance keeps the un-elected map');
  });

  test('isFenced / clearFenced membership round-trip', () => {
    const fenced = appendFenced(mapAt(1, 1), 'loop-A', T0);
    assert.strictEqual(isFenced(fenced, 'loop-A'), true);
    assert.strictEqual(isFenced(fenced, 'loop-B'), false);
    const cleared = clearFenced(fenced, 'loop-A');
    assert.strictEqual(isFenced(cleared, 'loop-A'), false);
    assert.strictEqual(clearFenced(cleared, 'loop-A'), cleared, 'clearing nothing is a no-op');
  });
});

suite('clusterMap — projection round-trip (backward-compat seam)', () => {
  test('lease → activeManagerFromLease → toSupervisorLease preserves all four fields byte-for-byte', () => {
    const original = lease('loop-A');
    const projected = toSupervisorLease({ ...emptyClusterMap(), active_manager: activeManagerFromLease(original) });
    assert.deepStrictEqual(projected, original);
  });

  test('toSupervisorLease(no active) is null → drives the L4 chip "none" branch', () => {
    assert.strictEqual(toSupervisorLease(emptyClusterMap()), null);
  });

  test('E1b PRODUCTION PATH: disk JSON → coerceClusterMap → toSupervisorLease round-trips all four fields', () => {
    // This is the chain the L4 chip / readSupervisorLease will run in E1b:
    // read cluster-map.json, JSON.parse, coerce, project down to the flat lease.
    const original = lease('loop-A');
    const onDisk = JSON.stringify({ ...emptyClusterMap(), active_manager: activeManagerFromLease(original) }, null, 2);
    const projected = toSupervisorLease(coerceClusterMap(JSON.parse(onDisk))!);
    assert.deepStrictEqual(projected, original);
  });
});

suite('clusterMap — rankStandbys (deterministic, pure)', () => {
  test('sorts DESC by score, tie-break ASC by instance_id, without mutating input', () => {
    const input: Standby[] = [
      { instance_id: 'loop-C', score: 5, last_seen: new Date(T0).toISOString() },
      { instance_id: 'loop-A', score: 9, last_seen: new Date(T0).toISOString() },
      { instance_id: 'loop-B', score: 9, last_seen: new Date(T0).toISOString() },
      { instance_id: 'loop-D', score: 5, last_seen: new Date(T0).toISOString() },
    ];
    const ranked = rankStandbys(input);
    assert.deepStrictEqual(ranked.map((s) => s.instance_id), ['loop-A', 'loop-B', 'loop-C', 'loop-D']);
    assert.strictEqual(input[0].instance_id, 'loop-C', 'input array not mutated');
  });

  test('rankStandbys handles empty and single-element inputs and returns a NEW array', () => {
    assert.deepStrictEqual(rankStandbys([]), []);
    const one: Standby[] = [{ instance_id: 'loop-A', score: 1, last_seen: new Date(T0).toISOString() }];
    const ranked = rankStandbys(one);
    assert.deepStrictEqual(ranked.map((s) => s.instance_id), ['loop-A']);
    assert.notStrictEqual(ranked, one, 'returns a fresh array, not the input');
  });
});

suite('clusterMap — coerceClusterMap (tolerant shape guard)', () => {
  test('a well-formed object coerces and defaults the version', () => {
    const m = coerceClusterMap({ version: 1, epoch: 3, term: 2, active_manager: null, standbys: [], monitors: [], quorum_size: 2, fenced: [] });
    assert.ok(m);
    assert.strictEqual(m!.epoch, 3);
    assert.strictEqual(m!.term, 2);
    assert.strictEqual(m!.quorum_size, 2);
  });

  test('non-objects and missing/NaN epoch/term coerce to null', () => {
    assert.strictEqual(coerceClusterMap(null), null);
    assert.strictEqual(coerceClusterMap('nope'), null);
    assert.strictEqual(coerceClusterMap({ term: 1 }), null);
    assert.strictEqual(coerceClusterMap({ epoch: 'x', term: 1 }), null);
  });

  test('missing arrays/quorum are defensively filled; an ABSENT active is null', () => {
    const m = coerceClusterMap({ epoch: 1, term: 1 });
    assert.ok(m);
    assert.deepStrictEqual(m!.standbys, []);
    assert.deepStrictEqual(m!.monitors, []);
    assert.deepStrictEqual(m!.fenced, []);
    assert.strictEqual(m!.quorum_size, 1);
    assert.strictEqual(m!.active_manager, null);
  });

  test('a MALFORMED active_manager object coerces to null (instance_id guard)', () => {
    // Present-but-not-a-string instance_id, or a junk object → active null.
    assert.strictEqual(coerceClusterMap({ epoch: 1, term: 1, active_manager: { instance_id: 123 } })!.active_manager, null);
    assert.strictEqual(coerceClusterMap({ epoch: 1, term: 1, active_manager: { foo: 'bar' } })!.active_manager, null);
    // Present-but-not-an-object (e.g. an array or a string) → active null.
    assert.strictEqual(coerceClusterMap({ epoch: 1, term: 1, active_manager: 'loop-A' })!.active_manager, null);
    assert.strictEqual(coerceClusterMap({ epoch: 1, term: 1, active_manager: ['loop-A'] })!.active_manager, null);
  });

  test('an active with a string instance_id but MISSING date fields defaults them to empty strings', () => {
    const m = coerceClusterMap({ epoch: 1, term: 1, active_manager: { instance_id: 'loop-A' } });
    const active = m!.active_manager;
    assert.ok(active);
    assert.strictEqual(active!.instance_id, 'loop-A');
    assert.strictEqual(active!.acquired_at, '');
    assert.strictEqual(active!.lease_heartbeat, '');
    assert.strictEqual(active!.lease_expires, '');
    // Optional ids are omitted unless they are strings.
    assert.strictEqual(active!.agent_id, undefined);
    assert.strictEqual(active!.machine_id, undefined);
  });

  test('a valid nested active_manager is preserved through coercion (all four fields)', () => {
    const m = coerceClusterMap({ epoch: 1, term: 1, active_manager: am('loop-A') });
    const active = m!.active_manager;
    assert.strictEqual(active?.instance_id, 'loop-A');
    assert.strictEqual(active?.acquired_at, am('loop-A').acquired_at);
    assert.strictEqual(active?.lease_heartbeat, am('loop-A').lease_heartbeat);
    assert.strictEqual(active?.lease_expires, am('loop-A').lease_expires);
  });

  test('coerced map round-trips through merge (proves it is a usable ClusterMap)', () => {
    const local = coerceClusterMap({ epoch: 1, term: 1 })!;
    const incoming = coerceClusterMap({ epoch: 2, term: 1 })!;
    assert.strictEqual(mergeClusterMap(local, incoming).epoch, 2);
  });
});

suite('clusterMap — membership projection (E2a: START LOOP monitors/standbys/quorum)', () => {
  const TTL = 90_000;
  const iso = (t: number) => new Date(t).toISOString();

  test('freshnessFactor: 1 fresh, linear to 0 at ttl, 0 past ttl, clamps negative age', () => {
    assert.strictEqual(freshnessFactor(0, TTL), 1);
    assert.strictEqual(freshnessFactor(TTL / 2, TTL), 0.5);
    assert.strictEqual(freshnessFactor(TTL, TTL), 0);
    assert.strictEqual(freshnessFactor(TTL * 2, TTL), 0);
    assert.strictEqual(freshnessFactor(-5_000, TTL), 1, 'clock skew clamps to fresh');
    assert.strictEqual(freshnessFactor(0, 0), 0, 'non-positive ttl → 0');
  });

  test('projectMonitors: keeps LIVE ids, drops stale, de-dupes, sorts', () => {
    const m = projectMonitors([
      { instance_id: 'loop-C', age_ms: 1_000 },
      { instance_id: 'loop-A', age_ms: 1_000 },
      { instance_id: 'loop-A', age_ms: 2_000 }, // dup
      { instance_id: 'loop-D', age_ms: TTL + 1 }, // stale → dropped
    ], TTL);
    assert.deepStrictEqual(m, ['loop-A', 'loop-C']);
  });

  test('computeQuorumSize: MAJORITY threshold floor(n/2)+1 — lone agent is quorum-of-one', () => {
    assert.strictEqual(computeQuorumSize(0), 1);
    assert.strictEqual(computeQuorumSize(1), 1);
    assert.strictEqual(computeQuorumSize(2), 2);
    assert.strictEqual(computeQuorumSize(3), 2, 'majority of 3 is 2, not unanimity');
    assert.strictEqual(computeQuorumSize(4), 3);
    assert.strictEqual(computeQuorumSize(5), 3);
  });

  test('projectMonitors: exact-TTL age is STALE (dropped); empty roster → []', () => {
    assert.deepStrictEqual(projectMonitors([{ instance_id: 'loop-A', age_ms: TTL }], TTL), [], 'age==ttl is stale');
    assert.deepStrictEqual(projectMonitors([], TTL), []);
  });

  test('NaN age is dropped by BOTH projectMonitors and projectStandbys (no poisoned score)', () => {
    assert.deepStrictEqual(projectMonitors([{ instance_id: 'loop-A', age_ms: NaN }], TTL), []);
    const s = projectStandbys([{ instance_id: 'loop-A', need_score: 1, age_ms: NaN, last_seen: iso(0) }], null, TTL);
    assert.deepStrictEqual(s, [], 'NaN-age candidate dropped, never a NaN-score standby');
  });

  test('projectStandbys: a NaN need_score is dropped (never poisons the rank)', () => {
    const s = projectStandbys([{ instance_id: 'loop-A', need_score: NaN, age_ms: 0, last_seen: iso(0) }], null, TTL);
    assert.deepStrictEqual(s, []);
  });

  test('projectStandbys: de-dupes the same instance_id, keeping the FRESHEST signal', () => {
    const s = projectStandbys([
      { instance_id: 'loop-B', need_score: 1, age_ms: TTL / 2, last_seen: iso(0) }, // score 0.5
      { instance_id: 'loop-B', need_score: 1, age_ms: 0, last_seen: iso(1000) },    // fresher → score 1.0 wins
    ], null, TTL);
    assert.strictEqual(s.length, 1, 'one entry per instance_id');
    assert.ok(Math.abs(s[0].score - 1.0) < 1e-9, 'kept the freshest signal');
    assert.strictEqual(s[0].last_seen, iso(1000));
  });

  test('projectStandbys: equal scores are tie-broken ASC by instance_id (deterministic)', () => {
    const s = projectStandbys([
      { instance_id: 'loop-C', need_score: 1, age_ms: 0, last_seen: iso(0) },
      { instance_id: 'loop-A', need_score: 1, age_ms: 0, last_seen: iso(0) },
      { instance_id: 'loop-B', need_score: 1, age_ms: 0, last_seen: iso(0) },
    ], null, TTL);
    assert.deepStrictEqual(s.map((x) => x.instance_id), ['loop-A', 'loop-B', 'loop-C']);
  });

  test('all-stale roster → empty monitors + standbys + quorum-of-one', () => {
    const stale = [{ instance_id: 'loop-A', age_ms: TTL + 1 }];
    const monitors = projectMonitors(stale, TTL);
    assert.deepStrictEqual(monitors, []);
    assert.deepStrictEqual(projectStandbys([{ instance_id: 'loop-A', need_score: 1, age_ms: TTL + 1, last_seen: iso(0) }], null, TTL), []);
    assert.strictEqual(computeQuorumSize(monitors.length), 1);
  });

  test('applyMembership: changing ONLY quorum_size bumps epoch (pins the quorum clause)', () => {
    const seeded = applyMembership({ ...emptyClusterMap(), epoch: 1 }, {
      monitors: ['loop-A'], standbys: [], quorum_size: 1,
    });
    const out = applyMembership(seeded, { monitors: ['loop-A'], standbys: [], quorum_size: 2 });
    assert.notStrictEqual(out, seeded, 'a quorum-only delta is NOT a no-op');
    assert.strictEqual(out.quorum_size, 2);
    assert.strictEqual(out.epoch, seeded.epoch + 1, 'epoch bumped for the quorum change');
  });

  test('applyMembership: no-op is reflexive under TIED standby scores (no epoch churn)', () => {
    const tied: Standby[] = [
      { instance_id: 'loop-A', score: 0.5, last_seen: iso(0) },
      { instance_id: 'loop-B', score: 0.5, last_seen: iso(0) },
    ];
    const seeded = applyMembership({ ...emptyClusterMap(), epoch: 1 }, { monitors: [], standbys: tied, quorum_size: 1 });
    // Re-apply the SAME tied set in reversed order — normalization must compare equal.
    const again = applyMembership(seeded, { monitors: [], standbys: [tied[1], tied[0]], quorum_size: 1 });
    assert.strictEqual(again, seeded, 'tied-score re-apply is a no-op, epoch stable');
  });

  test('applyMembership: a -0 score equals a +0 score (JSON round-trip stable — no epoch churn)', () => {
    // The disk path JSON.stringify(-0)="0" → JSON.parse → +0; a stable -0 standby
    // read back as +0 MUST still no-op, else the epoch churns every renew.
    const onDisk = applyMembership({ ...emptyClusterMap(), epoch: 1 }, {
      monitors: [], standbys: [{ instance_id: 'loop-A', score: 0, last_seen: iso(0) }], quorum_size: 1,
    });
    const reapplyMinusZero = applyMembership(onDisk, {
      monitors: [], standbys: [{ instance_id: 'loop-A', score: -0, last_seen: iso(0) }], quorum_size: 1,
    });
    assert.strictEqual(reapplyMinusZero, onDisk, '-0 vs +0 is a no-op, epoch stable');
  });

  test('projectStandbys: excludes the active, drops stale, scores by need_score (freshness GATES only), ranks DESC', () => {
    const cands: StandbyCandidate[] = [
      { instance_id: 'loop-ACTIVE', need_score: 9, age_ms: 0, last_seen: iso(0) },
      { instance_id: 'loop-B', agent_id: 'kilo', need_score: 0.8, age_ms: 0, last_seen: iso(0) },
      { instance_id: 'loop-C', need_score: 1.0, age_ms: TTL / 2, last_seen: iso(0) },   // fresh → gate passes → score = need 1.0
      { instance_id: 'loop-D', need_score: 1.0, age_ms: TTL + 1, last_seen: iso(0) },   // stale → dropped by the gate
    ];
    const ranked = projectStandbys(cands, 'loop-ACTIVE', TTL);
    assert.deepStrictEqual(ranked.map((s) => s.instance_id), ['loop-C', 'loop-B'], 'active + stale excluded, ranked by CAPABILITY score');
    assert.ok(Math.abs(ranked[0].score - 1.0) < 1e-9 && Math.abs(ranked[1].score - 0.8) < 1e-9, 'score = need_score; freshness does not multiply it');
    assert.strictEqual(ranked.find((s) => s.instance_id === 'loop-B')!.agent_id, 'kilo', 'optional ids preserved');
  });

  test('projectStandbys is STABLE as a live peer AGES → applyMembership no-op (no epoch churn)', () => {
    const at = (age: number): StandbyCandidate[] => [{ instance_id: 'loop-B', need_score: 1, age_ms: age, last_seen: iso(0) }];
    const seeded = applyMembership({ ...emptyClusterMap(), epoch: 1 },
      { monitors: ['loop-A'], standbys: projectStandbys(at(5_000), 'loop-A', TTL), quorum_size: 1 });
    // The peer is older now (age grew 5s → 35s) but still fresh — the projection must NOT change.
    const again = applyMembership(seeded,
      { monitors: ['loop-A'], standbys: projectStandbys(at(35_000), 'loop-A', TTL), quorum_size: 1 });
    assert.strictEqual(again, seeded, 'an aged-but-live peer does not churn the epoch (score is capability, not freshness)');
  });

  test('projectStandbys keeps a LIVE zero-score candidate (only dead presence is dropped)', () => {
    const ranked = projectStandbys(
      [{ instance_id: 'loop-Z', need_score: 0, age_ms: 1_000, last_seen: iso(0) }],
      null, TTL,
    );
    assert.deepStrictEqual(ranked.map((s) => s.instance_id), ['loop-Z']);
    assert.strictEqual(ranked[0].score, 0);
  });

  test('applyMembership: a change bumps EPOCH (not term) and sets the fields; sorts/ranks', () => {
    const base = { ...emptyClusterMap(), epoch: 4, term: 3 };
    const out = applyMembership(base, {
      monitors: ['loop-C', 'loop-A'],
      standbys: [
        { instance_id: 'loop-B', score: 0.2, last_seen: iso(0) },
        { instance_id: 'loop-A', score: 0.9, last_seen: iso(0) },
      ],
      quorum_size: 2,
    });
    assert.strictEqual(out.epoch, 5, 'membership change bumps epoch');
    assert.strictEqual(out.term, 3, 'term unchanged');
    assert.deepStrictEqual(out.monitors, ['loop-A', 'loop-C'], 'monitors stored sorted');
    assert.deepStrictEqual(out.standbys.map((s) => s.instance_id), ['loop-A', 'loop-B'], 'standbys stored ranked');
    assert.strictEqual(out.quorum_size, 2);
    assert.strictEqual(base.epoch, 4, 'input not mutated');
  });

  test('applyMembership: an UNCHANGED projection is a no-op (same ref, no epoch churn)', () => {
    const seeded = applyMembership({ ...emptyClusterMap(), epoch: 1 }, {
      monitors: ['loop-A'], standbys: [{ instance_id: 'loop-B', score: 1, last_seen: iso(0) }], quorum_size: 1,
    });
    // Re-apply the same projection (monitors unsorted, standbys unranked — must normalize equal).
    const again = applyMembership(seeded, {
      monitors: ['loop-A'], standbys: [{ instance_id: 'loop-B', score: 1, last_seen: iso(0) }], quorum_size: 1,
    });
    assert.strictEqual(again, seeded, 'no change → same object, epoch stable');
  });

  test('applyMembership end-to-end: projected monitors+standbys+quorum fold into the map', () => {
    const base = emptyClusterMap();
    const monitors = projectMonitors([{ instance_id: 'loop-A', age_ms: 0 }, { instance_id: 'loop-B', age_ms: 0 }], TTL);
    const standbys = projectStandbys(
      [{ instance_id: 'loop-B', need_score: 1, age_ms: 0, last_seen: iso(0) }], 'loop-A', TTL,
    );
    const out = applyMembership(base, { monitors, standbys, quorum_size: computeQuorumSize(monitors.length) });
    assert.deepStrictEqual(out.monitors, ['loop-A', 'loop-B']);
    assert.deepStrictEqual(out.standbys.map((s) => s.instance_id), ['loop-B']);
    assert.strictEqual(out.quorum_size, 2);
    assert.strictEqual(out.epoch, 1, 'bumped from empty 0 → 1');
  });
});
