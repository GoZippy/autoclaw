import * as assert from 'assert';
import {
  buildSelfAnnounce, parseAnnounce, announceToBeacon,
  LAN_ANNOUNCE_VERSION, LAN_ANNOUNCE_MAX_BYTES, type LanAnnounce,
} from '../fleet/lanPresence';
import { computePendingAgents } from '../fleet/pending';
import { beaconsToLiveAgents } from '../fleet/needs';
import {
  normalizeBeacon, isDiscoveredUntrusted, BEACON_TTL_MS, type BeaconRow,
} from '../fleet/beacons';

const T0 = Date.parse('2026-06-24T12:00:00.000Z');
const iso = (t: number): string => new Date(t).toISOString();

function row(agent_id: string, origin: BeaconRow['origin'], extra: Partial<BeaconRow> = {}): BeaconRow {
  return { agent_id, timestamp: iso(T0), origin, workspace_id: '', age_ms: 0, stale: false, ...extra };
}

suite('lanPresence — announce build/parse (T0a, pure, no sockets)', () => {
  test('buildSelfAnnounce carries ONLY non-sensitive presence (v/machine_id/host/port/ts)', () => {
    const a = buildSelfAnnounce({ machineId: 'mid-abc', host: 'kiro', port: 8787, now: T0 });
    assert.deepStrictEqual(a, { v: LAN_ANNOUNCE_VERSION, machine_id: 'mid-abc', host: 'kiro', port: 8787, ts: iso(T0) });
    // No workspace / task / IP / token fields leak onto the wire.
    assert.deepStrictEqual(Object.keys(a).sort(), ['host', 'machine_id', 'port', 'ts', 'v']);
  });

  test('announce round-trips: build → JSON → parseAnnounce', () => {
    const a = buildSelfAnnounce({ machineId: 'mid-abc', host: 'kiro', port: 8787, now: T0 });
    assert.deepStrictEqual(parseAnnounce(JSON.stringify(a)), a);
    assert.deepStrictEqual(parseAnnounce(Buffer.from(JSON.stringify(a), 'utf8')), a, 'a Buffer parses identically');
  });

  test('parseAnnounce FAILS CLOSED on every malformed / hostile input', () => {
    const ok = JSON.stringify(buildSelfAnnounce({ machineId: 'm', host: 'h', port: 80, now: T0 }));
    assert.ok(parseAnnounce(ok), 'sanity: a valid announce parses');
    assert.strictEqual(parseAnnounce('{not json'), null, 'malformed JSON');
    assert.strictEqual(parseAnnounce('null'), null, 'null');
    assert.strictEqual(parseAnnounce('[1,2,3]'), null, 'non-object');
    assert.strictEqual(parseAnnounce(JSON.stringify({ v: 2, machine_id: 'm', host: 'h', port: 80 })), null, 'wrong version');
    assert.strictEqual(parseAnnounce(JSON.stringify({ v: 1, machine_id: '', host: 'h', port: 80 })), null, 'empty machine_id');
    assert.strictEqual(parseAnnounce(JSON.stringify({ v: 1, host: 'h', port: 80 })), null, 'missing machine_id');
    assert.strictEqual(parseAnnounce(JSON.stringify({ v: 1, machine_id: 'm', port: 80 })), null, 'missing host');
    assert.strictEqual(parseAnnounce(JSON.stringify({ v: 1, machine_id: 'm', host: 'h', port: 0 })), null, 'port 0');
    assert.strictEqual(parseAnnounce(JSON.stringify({ v: 1, machine_id: 'm', host: 'h', port: 65536 })), null, 'port > 65535');
    assert.strictEqual(parseAnnounce(JSON.stringify({ v: 1, machine_id: 'm', host: 'h', port: 80.5 })), null, 'non-integer port');
    assert.strictEqual(parseAnnounce(JSON.stringify({ v: 1, machine_id: 'm', host: 'h', port: '80' })), null, 'string port');
    assert.strictEqual(parseAnnounce(JSON.stringify({ v: 1, machine_id: 'm', host: 'h', port: 80, ts: 123 })), null, 'non-string ts');
  });

  test('parseAnnounce drops an OVER-SIZED datagram (anti-DoS bound)', () => {
    const big = JSON.stringify({ v: 1, machine_id: 'm', host: 'h', port: 80, pad: 'x'.repeat(LAN_ANNOUNCE_MAX_BYTES) });
    assert.ok(big.length > LAN_ANNOUNCE_MAX_BYTES);
    assert.strictEqual(parseAnnounce(big), null, 'a datagram larger than the cap is dropped before parsing');
  });

  test('parseAnnounce accepts a valid announce WITHOUT ts (ts is optional on the wire)', () => {
    const a = parseAnnounce(JSON.stringify({ v: 1, machine_id: 'm', host: 'h', port: 80 }));
    assert.deepStrictEqual(a, { v: 1, machine_id: 'm', host: 'h', port: 80 });
  });
});

suite('lanPresence — announceToBeacon (T0a projection)', () => {
  const a: LanAnnounce = { v: 1, machine_id: 'mid-xyz', host: 'kiro', port: 8787, ts: iso(T0 - 999_999) };

  test('projects to a Beacon keyed lan:<machine_id>, origin lan, endpoint from the SOURCE addr', () => {
    const b = announceToBeacon(a, '192.168.1.42', T0);
    assert.strictEqual(b.agent_id, 'lan:mid-xyz', 'deduped per physical peer, not per IP');
    assert.strictEqual(b.machine_id, 'mid-xyz');
    assert.strictEqual(b.host, 'kiro');
    assert.strictEqual(b.endpoint, '192.168.1.42:8787', 'endpoint uses the observed source addr + announced port');
    assert.strictEqual(b.origin, 'lan', 'marked discovered/untrusted');
    assert.strictEqual(b.status, 'active');
  });

  test('beacon timestamp is the RECEIVE time (now), NOT the (spoofable) announce ts', () => {
    const b = announceToBeacon(a, '10.0.0.1', T0);
    assert.strictEqual(b.timestamp, iso(T0), 'receiver clock drives staleness — a peer cannot fake its own freshness');
    assert.notStrictEqual(b.timestamp, a.ts);
  });

  test('the projected beacon carries NO workspace / task / IP-on-wire fields', () => {
    const b = announceToBeacon(a, '10.0.0.1', T0);
    assert.strictEqual((b as any).workspace, undefined);
    assert.strictEqual((b as any).current_task, undefined);
  });
});

suite('lanPresence — trust ceiling (a LAN peer is NOT admittable)', () => {
  test('computePendingAgents EXCLUDES origin lan beacons (discovery is not an admission path)', () => {
    const beacons: BeaconRow[] = [
      row('kiro', 'beacon'),          // a normal beacon-origin agent → admittable
      row('lan:mid-xyz', 'lan'),      // a LAN-discovered peer → must NOT be admittable
    ];
    const pending = computePendingAgents(beacons, null, []);
    assert.deepStrictEqual(pending.map((p) => p.agent_id), ['kiro'], 'the lan peer is not offered for admission');
  });

  test('a LAN peer alone yields an empty pending tray', () => {
    assert.deepStrictEqual(computePendingAgents([row('lan:mid-xyz', 'lan')], null, []), []);
  });
});

suite('lanPresence — trust ceiling is centralized + symmetric across ALL sinks', () => {
  // The T0a verify caught the trust ceiling enforced at only ONE of three beacon
  // sinks. isDiscoveredUntrusted is now the SINGLE source of truth; these pin
  // that every sink (pending tray, panel roster, role-coverage census) excludes
  // origin lan via it, so a future sink that forgets the guard is the only gap.
  test('isDiscoveredUntrusted is true ONLY for origin lan (the predicate every sink calls)', () => {
    assert.strictEqual(isDiscoveredUntrusted({ origin: 'lan' }), true);
    assert.strictEqual(isDiscoveredUntrusted({ origin: 'beacon' }), false);
    assert.strictEqual(isDiscoveredUntrusted({ origin: 'local' }), false);
    assert.strictEqual(isDiscoveredUntrusted({ origin: 'relay' }), false);
    assert.strictEqual(isDiscoveredUntrusted({}), false, 'a legacy beacon with no origin is trusted-by-default');
  });

  test('role-coverage census (needs.beaconsToLiveAgents) EXCLUDES origin lan', () => {
    const beacons: BeaconRow[] = [
      row('kiro', 'beacon', { role: 'reviewer' }),
      row('lan:mid-xyz', 'lan', { role: 'reviewer' }), // a spoofed peer must NOT count toward coverage
    ];
    const live = beaconsToLiveAgents(beacons);
    assert.deepStrictEqual(live.map((a) => a.agent_id), ['kiro'], 'the lan peer is not a live agent');
    // Even WITH a role hint a lan peer cannot suppress hiring pressure for that role.
    assert.strictEqual(live.some((a) => a.agent_id.startsWith('lan:')), false);
  });
});

suite('lanPresence — parseAnnounce hardening (wire boundary)', () => {
  const okPort = 80;
  test('machine_id / host are charset+length bounded (no control chars, separators, runaway length)', () => {
    const mk = (mid: string, host: string): string =>
      JSON.stringify({ v: 1, machine_id: mid, host, port: okPort });
    // valid identities still parse
    assert.ok(parseAnnounce(mk('host-01.local', 'kiro')), 'a normal id+label parses');
    assert.ok(parseAnnounce(mk('uuid:1a2b_3c.4d', 'open-vsx')), 'opaque punctuated id parses');
    // hostile machine_id
    assert.strictEqual(parseAnnounce(mk('a\nb', 'h')), null, 'newline in machine_id');
    assert.strictEqual(parseAnnounce(mk('a\u0000b', 'h')), null, 'NUL in machine_id');
    assert.strictEqual(parseAnnounce(mk('../../etc/passwd', 'h')), null, 'path traversal in machine_id');
    assert.strictEqual(parseAnnounce(mk('a/b', 'h')), null, 'separator in machine_id');
    assert.strictEqual(parseAnnounce(mk('x'.repeat(129), 'h')), null, 'machine_id over 128 chars');
    // hostile host label
    assert.strictEqual(parseAnnounce(mk('m', 'my host')), null, 'space in host label');
    assert.strictEqual(parseAnnounce(mk('m', 'a\tb')), null, 'tab in host label');
    assert.strictEqual(parseAnnounce(mk('m', 'x'.repeat(65))), null, 'host over 64 chars');
  });

  test('unknown wire fields are STRIPPED and __proto__ cannot pollute', () => {
    const raw = '{"v":1,"machine_id":"m","host":"h","port":80,"evil":"x","__proto__":{"polluted":true}}';
    const out = parseAnnounce(raw);
    assert.deepStrictEqual(out, { v: 1, machine_id: 'm', host: 'h', port: 80 }, 'only the whitelisted fields survive');
    assert.strictEqual((out as any).evil, undefined, 'an unknown field never reaches the projection');
    assert.strictEqual(({} as any).polluted, undefined, 'Object.prototype was not polluted');
  });

  function sized(nBytes: number): string {
    const base = { v: 1, machine_id: 'm', host: 'h', port: 80, ts: '' };
    const baseLen = Buffer.byteLength(JSON.stringify(base), 'utf8');
    base.ts = 'x'.repeat(Math.max(0, nBytes - baseLen));
    return JSON.stringify(base);
  }

  test('the 512-byte cap is an inclusive boundary (== accepted, +1 dropped)', () => {
    const at = sized(LAN_ANNOUNCE_MAX_BYTES);
    assert.strictEqual(Buffer.byteLength(at, 'utf8'), LAN_ANNOUNCE_MAX_BYTES);
    assert.ok(parseAnnounce(at), 'a datagram exactly at the cap is accepted');
    const over = sized(LAN_ANNOUNCE_MAX_BYTES + 1);
    assert.strictEqual(Buffer.byteLength(over, 'utf8'), LAN_ANNOUNCE_MAX_BYTES + 1);
    assert.strictEqual(parseAnnounce(over), null, 'one byte over the cap is dropped');
  });
});

suite('lanPresence — discovered beacon ages out + dedupes (end-to-end through beacons.ts)', () => {
  const a: LanAnnounce = { v: 1, machine_id: 'mid-age', host: 'kiro', port: 8787 };

  test('the RECEIVE-time beacon ages out via the existing BEACON_TTL_MS (no special lan path)', () => {
    const beacon = announceToBeacon(a, '10.0.0.5', T0);
    const fresh = normalizeBeacon(beacon, T0 + 1000);
    assert.strictEqual(fresh.stale, false, 'a just-received peer is live');
    const aged = normalizeBeacon(beacon, T0 + BEACON_TTL_MS + 1);
    assert.strictEqual(aged.stale, true, 'a peer that stopped announcing ages out for free when it goes silent');
  });

  test('two announces from the SAME machine_id collapse to one roster row (dedupe key)', () => {
    const b1 = announceToBeacon({ v: 1, machine_id: 'dup', host: 'kiro', port: 80 }, '10.0.0.1', T0);
    const b2 = announceToBeacon({ v: 1, machine_id: 'dup', host: 'cursor', port: 81 }, '10.0.0.2', T0 + 1000);
    assert.strictEqual(b1.agent_id, b2.agent_id, 'one physical peer = one agent_id, regardless of IP/port');
    // readAllBeacons dedups on `${agent_id}|${session_id??""}` — identical here → one row, freshest wins.
    const key = (b: typeof b1): string => `${b.agent_id}|${b.session_id ?? ''}`;
    assert.strictEqual(key(b1), key(b2), 'the dedupe key collapses the two announces');
  });
});
