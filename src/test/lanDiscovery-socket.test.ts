import * as assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  LanDiscovery, shouldStartLanDiscovery, parseSeeds,
  LAN_MULTICAST_ADDR, LAN_DEFAULT_PORT,
  type LanSocket, type SocketFactory,
} from '../fleet/lanDiscovery';
import { parseAnnounce, buildSelfAnnounce } from '../fleet/lanPresence';
import { readBeacons, workspaceBeaconDir } from '../fleet/beacons';

// ---------------------------------------------------------------------------
// A FAKE udp socket — records every call, never touches node:dgram, never binds.
// ---------------------------------------------------------------------------
interface SendRec { payload: Buffer; port: number; address: string; }

class FakeSocket implements LanSocket {
  bound: number | null = null;
  broadcast: boolean | null = null;
  joined: string[] = [];
  sends: SendRec[] = [];
  closed = false;
  /** When set, bind() throws (emulates EADDRINUSE / no-permission). */
  failBind = false;
  /** When set, send() invokes its callback with an error (emulates a send failure). */
  failSend = false;
  private msgCb?: (msg: Buffer, rinfo: { address: string; port: number }) => void;
  private listeningCb?: () => void;
  private errorCb?: (err: Error) => void;

  on(event: 'message' | 'error' | 'listening', cb: any): void {
    if (event === 'message') { this.msgCb = cb; }
    else if (event === 'listening') { this.listeningCb = cb; }
    else { this.errorCb = cb; }
  }
  bind(port?: number): void {
    if (this.failBind) { throw new Error('bind failed'); }
    this.bound = port ?? 0;
    // dgram fires 'listening' asynchronously; emulate synchronously for determinism.
    this.listeningCb?.();
  }
  send(msg: Buffer, port: number, address: string, cb?: (err?: Error | null) => void): void {
    this.sends.push({ payload: msg, port, address });
    cb?.(this.failSend ? new Error('send fail') : null);
  }
  addMembership(addr: string): void { this.joined.push(addr); }
  setBroadcast(flag: boolean): void { this.broadcast = flag; }
  close(): void { this.closed = true; }

  // Test helpers
  emitMessage(raw: string | Buffer, address: string, port = 40000): void {
    const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
    this.msgCb?.(buf, { address, port });
  }
  emitError(err: Error): void { this.errorCb?.(err); }
}

function tmpComms(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-disco-'));
  return path.join(root, '.autoclaw', 'orchestrator', 'comms');
}

const NEVER_FIRES = 1_000_000_000; // announce interval large enough to never tick in a test

suite('lanDiscovery — socket adapter (T0b, FAKE socket, never binds real dgram)', () => {
  let fake: FakeSocket;
  let factory: SocketFactory;
  let factoryCalls: Array<{ type: string; reuseAddr?: boolean }>;
  let comms: string;
  let disco: LanDiscovery | null;

  setup(() => {
    fake = new FakeSocket();
    factoryCalls = [];
    factory = (opts) => { factoryCalls.push(opts); return fake; };
    comms = tmpComms();
    disco = null;
  });

  teardown(() => { disco?.stop(); });

  function make(over: Partial<Parameters<typeof newDisco>[0]> = {}): LanDiscovery {
    disco = newDisco({ comms, factory, ...over });
    return disco;
  }
  function newDisco(o: {
    comms: string; factory: SocketFactory; machineId?: string; host?: string;
    port?: number; mode?: 'seed' | 'multicast'; seeds?: { host: string; port: number }[];
    now?: () => number; enabled?: boolean; consentAckAt?: string | null;
    log?: (m: string) => void;
  }): LanDiscovery {
    return new LanDiscovery({
      // default to the gate OPEN so binding tests bind; gate tests override these.
      // NB: only `undefined` falls back — an explicit `null` (no-consent) is preserved.
      enabled: o.enabled ?? true,
      consentAckAt: o.consentAckAt === undefined ? '2026-06-24T11:00:00.000Z' : o.consentAckAt,
      machineId: o.machineId ?? 'self-machine',
      host: o.host ?? 'kiro',
      commsDir: o.comms,
      port: o.port ?? LAN_DEFAULT_PORT,
      mode: o.mode ?? 'seed',
      seeds: o.seeds ?? [{ host: '10.0.0.2', port: LAN_DEFAULT_PORT }],
      createSocket: o.factory,
      announceIntervalMs: NEVER_FIRES,
      now: o.now ?? (() => Date.parse('2026-06-24T12:00:00.000Z')),
      log: o.log,
    });
  }

  test('start() obtains its socket from the INJECTED factory and binds it (no real dgram)', () => {
    const d = make({ port: 51000 });
    d.start();
    assert.strictEqual(factoryCalls.length, 1, 'the injected factory was used exactly once');
    assert.deepStrictEqual(factoryCalls[0], { type: 'udp4', reuseAddr: true });
    assert.strictEqual(fake.bound, 51000, 'bound on the configured port');
    assert.strictEqual(d.isRunning(), true);
  });

  test('start() is idempotent — a second call does NOT create a second socket', () => {
    const d = make();
    d.start();
    d.start();
    assert.strictEqual(factoryCalls.length, 1, 'still one socket');
  });

  test('an incoming VALID foreign announce writes an origin-lan beacon to the workspace dir', async () => {
    const d = make();
    d.start();
    const announce = JSON.stringify(buildSelfAnnounce({ machineId: 'peer-xyz', host: 'cursor', port: 8787, now: 0 }));
    fake.emitMessage(announce, '192.168.1.50');
    await d.drain();

    const rows = await readBeacons(workspaceBeaconDir(comms), { includeStale: true });
    assert.strictEqual(rows.length, 1, 'exactly one discovered beacon written');
    const b = rows[0];
    assert.strictEqual(b.agent_id, 'lan:peer-xyz');
    assert.strictEqual(b.origin, 'lan', 'marked DISCOVERED/untrusted');
    assert.strictEqual(b.endpoint, '192.168.1.50:8787', 'endpoint from the datagram SOURCE addr + announced port');
    assert.strictEqual(b.machine_id, 'peer-xyz');
  });

  test('a MALFORMED or OVERSIZED datagram writes NOTHING', async () => {
    const d = make();
    d.start();
    fake.emitMessage('{not json', '192.168.1.51');
    fake.emitMessage(JSON.stringify({ v: 2, machine_id: 'p', host: 'h', port: 80 }), '192.168.1.52'); // wrong version
    fake.emitMessage('x'.repeat(600), '192.168.1.53'); // over the 512B cap
    await d.drain();
    const rows = await readBeacons(workspaceBeaconDir(comms), { includeStale: true }).catch(() => []);
    assert.strictEqual(rows.length, 0, 'no beacon is written for any malformed input');
  });

  test('our OWN announce echoed back (multicast loopback) writes NOTHING (self-skip)', async () => {
    const d = make({ machineId: 'self-machine' });
    d.start();
    const own = JSON.stringify(buildSelfAnnounce({ machineId: 'self-machine', host: 'kiro', port: LAN_DEFAULT_PORT, now: 0 }));
    fake.emitMessage(own, '127.0.0.1');
    await d.drain();
    const rows = await readBeacons(workspaceBeaconDir(comms), { includeStale: true }).catch(() => []);
    assert.strictEqual(rows.length, 0, 'a host never records itself as a discovered peer');
  });

  test('seed mode: start() sends one self-announce to EVERY seed', () => {
    const seeds = [{ host: '10.0.0.2', port: 48484 }, { host: '10.0.0.3', port: 49000 }];
    const d = make({ mode: 'seed', seeds, machineId: 'self-machine', port: 48484 });
    d.start();
    assert.strictEqual(fake.sends.length, seeds.length, 'one announce per seed');
    fake.sends.forEach((s, i) => {
      assert.strictEqual(s.address, seeds[i].host);
      assert.strictEqual(s.port, seeds[i].port);
      const a = parseAnnounce(s.payload);
      assert.ok(a, 'the payload is a well-formed announce');
      assert.strictEqual(a!.machine_id, 'self-machine', 'announces THIS host');
      assert.strictEqual(a!.port, 48484, 'advertises the bound port');
    });
  });

  test('multicast mode: joins the group on listening, sets broadcast, announces to the group', () => {
    const d = make({ mode: 'multicast', port: 48484 });
    d.start();
    assert.deepStrictEqual(fake.joined, [LAN_MULTICAST_ADDR], 'joined the multicast group on listening');
    assert.strictEqual(fake.broadcast, true);
    assert.strictEqual(fake.sends.length, 1, 'one announce to the group');
    assert.strictEqual(fake.sends[0].address, LAN_MULTICAST_ADDR);
    assert.strictEqual(fake.sends[0].port, 48484);
  });

  test('stop() closes the socket, is idempotent, and a socket error never throws', () => {
    const d = make();
    d.start();
    fake.emitError(new Error('boom')); // best-effort handler — must not throw
    d.stop();
    assert.strictEqual(fake.closed, true, 'socket closed');
    assert.strictEqual(d.isRunning(), false);
    d.stop(); // second stop is a safe no-op
    assert.strictEqual(d.isRunning(), false);
  });

  // --- the mechanism gate (defense-in-depth) — a bind requires flag ON + consent ---
  test('start() with the flag ON but consent MISSING binds NOTHING (mechanism gate)', () => {
    const d = make({ enabled: true, consentAckAt: null });
    d.start();
    assert.strictEqual(factoryCalls.length, 0, 'no socket created without consent');
    assert.strictEqual(d.isRunning(), false);
    assert.strictEqual(fake.bound, null, 'never bound');
  });

  test('start() with the flag OFF binds NOTHING (even if a consent stamp is present)', () => {
    const d = make({ enabled: false, consentAckAt: '2026-06-24T11:00:00.000Z' });
    d.start();
    assert.strictEqual(factoryCalls.length, 0, 'flag off ⇒ the adapter refuses to bind');
    assert.strictEqual(d.isRunning(), false);
  });

  // --- robustness: a broken log sink / failing send must never throw or unhandled-reject ---
  test('a throwing log sink never crashes start()/announce (no unhandledRejection)', () => {
    fake.failSend = true; // forces the send callback to deliver an error → logErr path
    const d = make({ log: () => { throw new Error('broken log sink'); } });
    assert.doesNotThrow(() => d.start(), 'a throwing log sink is swallowed');
    assert.strictEqual(d.isRunning(), true);
  });

  // --- best-effort lifecycle: a bind / socket-create failure must not crash the host ---
  test('bind() throwing is caught — start() does not throw, stop() still cleans up', () => {
    fake.failBind = true;
    const d = make();
    assert.doesNotThrow(() => d.start(), 'a bind failure is logged, never thrown');
    d.stop();
    assert.strictEqual(fake.closed, true, 'the socket is still closed on stop');
  });

  test('a socket factory that throws leaves the adapter STOPPED (retryable, no crash)', () => {
    disco = newDisco({ comms, factory: () => { throw new Error('no dgram'); } });
    assert.doesNotThrow(() => disco!.start());
    assert.strictEqual(disco!.isRunning(), false, 'started is reset so a later start() can retry');
  });

  test('announceNow() re-sends — the interval cadence re-announces (not just the first)', () => {
    const d = make({ seeds: [{ host: '10.0.0.9', port: 48484 }] });
    d.start();
    assert.strictEqual(fake.sends.length, 1, 'one immediate announce on start');
    d.announceNow(); // this is exactly what the setInterval calls each tick
    assert.strictEqual(fake.sends.length, 2, 'each cadence fires another announce');
  });
});

suite('lanDiscovery — flag + consent gate (pure, no vscode)', () => {
  test('shouldStartLanDiscovery requires BOTH the flag on AND a consent timestamp', () => {
    assert.strictEqual(shouldStartLanDiscovery({ enabled: false, consentAckAt: '2026-06-24T00:00:00Z' }), false, 'flag off ⇒ never');
    assert.strictEqual(shouldStartLanDiscovery({ enabled: true, consentAckAt: null }), false, 'enabled but no consent ⇒ never');
    assert.strictEqual(shouldStartLanDiscovery({ enabled: true, consentAckAt: undefined }), false, 'enabled, consent undefined ⇒ never');
    assert.strictEqual(shouldStartLanDiscovery({ enabled: true, consentAckAt: '' }), false, 'enabled, empty consent ⇒ never');
    assert.strictEqual(shouldStartLanDiscovery({ enabled: true, consentAckAt: '2026-06-24T00:00:00Z' }), true, 'both ⇒ start');
  });
});

suite('lanDiscovery — parseSeeds (pure, fail-closed)', () => {
  test('parses host and host:port, defaulting a missing port', () => {
    assert.deepStrictEqual(parseSeeds(['10.0.0.2'], 48484), [{ host: '10.0.0.2', port: 48484 }]);
    assert.deepStrictEqual(parseSeeds(['10.0.0.2:49000'], 48484), [{ host: '10.0.0.2', port: 49000 }]);
    assert.deepStrictEqual(
      parseSeeds(['a', 'b:1234'], 48484),
      [{ host: 'a', port: 48484 }, { host: 'b', port: 1234 }],
    );
  });
  test('drops malformed entries (empty, bad port, IPv6-ish multi-colon)', () => {
    assert.deepStrictEqual(parseSeeds(['', '   '], 48484), [], 'blank entries dropped');
    assert.deepStrictEqual(parseSeeds(['h:0', 'h:70000', 'h:abc'], 48484), [], 'out-of-range / non-numeric ports dropped');
    assert.deepStrictEqual(parseSeeds(['fe80::1:48484'], 48484), [], 'IPv6-ish multi-colon out of T0 scope');
    assert.deepStrictEqual(parseSeeds(undefined, 48484), [], 'undefined list ⇒ empty');
  });
});
