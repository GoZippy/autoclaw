/**
 * lanDiscovery.ts — the thin UDP/seed socket adapter for LAN peer discovery (T0b).
 *
 * This is the ONLY place in the T0 layer that ever touches a real socket, and it
 * binds NOTHING until {@link LanDiscovery.start} is called by a caller that has
 * already passed the flag + consent gate (see {@link shouldStartLanDiscovery} and
 * extension.startLanDiscovery). The pure wire logic (announce build/parse, beacon
 * projection, the trust ceiling) lives in {@link ./lanPresence} and is reused here.
 *
 * SECURITY POSTURE (unchanged from T0a):
 *  - NETWORK OFF BY DEFAULT. No socket is created at import time — the dgram module
 *    is lazily required INSIDE start(), and start() is only reached when the
 *    autoclaw.cluster.lan flag is on AND the user has acknowledged the one-time
 *    consent. Tests inject a FAKE socket factory, so a unit run never binds.
 *  - A discovered peer is written as a Beacon with origin 'lan' = DISCOVERED, NOT
 *    AUTHENTICATED. It flows through the existing presence layer, which is already
 *    trust-ceiling-guarded (beacons.isDiscoveredUntrusted) at every admit / panel /
 *    census sink. Discovery is observe-only telemetry until T2 authenticates.
 *  - The wire carries only the non-sensitive announce; the peer's network address
 *    is taken from the datagram SOURCE, never from the payload; freshness is the
 *    RECEIVE clock. Datagrams that fail parseAnnounce (malformed / oversized /
 *    wrong-version / hostile) write nothing.
 */

import { buildSelfAnnounce, parseAnnounce, announceToBeacon } from './lanPresence';
import { writeBeacon } from './beacons';

/** Admin-scoped IPv4 multicast group for AutoClaw LAN presence (multicast mode). */
export const LAN_MULTICAST_ADDR = '239.255.42.99';

/** Default UDP port a peer answers/announces on (overridable via flag). */
export const LAN_DEFAULT_PORT = 48484;

/** Default self-announce cadence — a peer re-announces so others see it stay fresh. */
export const LAN_DEFAULT_ANNOUNCE_MS = 30_000;

/** LAN discovery mode: unicast to a configured seed list, or an IPv4 multicast group. */
export type LanMode = 'seed' | 'multicast';

/**
 * The minimal subset of node:dgram's Socket this adapter uses. Keeping it tiny lets
 * a test inject a FAKE socket with no real binding. The real dgram.Socket is
 * structurally compatible (cast in {@link defaultSocketFactory}).
 */
export interface LanSocket {
  on(event: 'message', cb: (msg: Buffer, rinfo: { address: string; port: number }) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'listening', cb: () => void): void;
  bind(port?: number, cb?: () => void): void;
  send(msg: Buffer, port: number, address: string, cb?: (err?: Error | null) => void): void;
  addMembership(multicastAddress: string): void;
  setBroadcast(flag: boolean): void;
  close(cb?: () => void): void;
}

/** Factory the adapter calls (once, inside start()) to obtain a socket. */
export type SocketFactory = (opts: { type: 'udp4'; reuseAddr?: boolean }) => LanSocket;

/** A single seed target parsed from the `host:port` strings in the flag. */
export interface SeedTarget { host: string; port: number; }

/**
 * Pure: the flag + consent double-gate. LAN discovery starts ONLY when the user has
 * turned the flag on AND acknowledged the one-time network consent. Either missing
 * ⇒ no socket is ever bound. Extracted so the gate is unit-testable without vscode.
 */
export function shouldStartLanDiscovery(opts: { enabled: boolean; consentAckAt?: string | null }): boolean {
  return opts.enabled === true && typeof opts.consentAckAt === 'string' && opts.consentAckAt.length > 0;
}

/**
 * Pure: parse the `lan.seeds` flag (an array of `host:port` or bare `host` strings)
 * into seed targets, defaulting a missing port to `defaultPort`. Malformed entries
 * (empty host, non-numeric / out-of-range port) are dropped — fail-closed, like the
 * wire parser. An IPv6 literal with multiple colons is rejected (kept simple: T0
 * targets IPv4 LANs; bracketed/typed addressing arrives with T1's transport).
 */
export function parseSeeds(raw: string[] | undefined, defaultPort: number): SeedTarget[] {
  const out: SeedTarget[] = [];
  for (const entry of raw ?? []) {
    if (typeof entry !== 'string') { continue; }
    const s = entry.trim();
    if (s.length === 0) { continue; }
    const colon = s.lastIndexOf(':');
    let host = s;
    let port = defaultPort;
    if (colon >= 0) {
      // Reject anything that looks like IPv6 (more than one colon) — out of T0 scope.
      if (s.indexOf(':') !== colon) { continue; }
      host = s.slice(0, colon);
      const p = Number(s.slice(colon + 1));
      if (!Number.isInteger(p) || p < 1 || p > 65535) { continue; }
      port = p;
    }
    if (host.length === 0) { continue; }
    out.push({ host, port });
  }
  return out;
}

/** Construction options for {@link LanDiscovery}. */
export interface LanDiscoveryOptions {
  /**
   * The `autoclaw.cluster.lan` flag. start() is a hard no-op (binds NOTHING) unless
   * this is true AND {@link consentAckAt} is set — the same {@link shouldStartLanDiscovery}
   * double-gate the caller checks, re-enforced HERE so the adapter itself can never
   * open a socket without the explicit opt-in (defense-in-depth + unit-testable).
   */
  enabled: boolean;
  /** ISO timestamp of the one-time network-consent ack; absent/empty ⇒ never binds. */
  consentAckAt?: string | null;
  /** Stable opaque per-install id (the receiver echoes none of it back). */
  machineId: string;
  /** IDE / runner label (NOT an FQDN) — the announce's `host`. */
  host: string;
  /** `<ws>/.autoclaw/orchestrator/comms` — where discovered beacons are written. */
  commsDir: string;
  /** UDP port to bind / announce on. */
  port: number;
  /** 'seed' (unicast to seeds) or 'multicast' (join LAN_MULTICAST_ADDR). */
  mode: LanMode;
  /** Seed targets (seed mode). */
  seeds: SeedTarget[];
  /** Injected socket factory; defaults to a LAZY node:dgram require inside start(). */
  createSocket?: SocketFactory;
  /** Self-announce cadence (ms). */
  announceIntervalMs?: number;
  /** Injectable clock (receive-time stamping). */
  now?: () => number;
  /** Best-effort log sink (no throw on log failure). */
  log?: (msg: string) => void;
}

/** Default factory: a LAZY node:dgram socket. Never evaluated until start() runs. */
function defaultSocketFactory(opts: { type: 'udp4'; reuseAddr?: boolean }): LanSocket {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dgram = require('node:dgram') as typeof import('node:dgram');
  return dgram.createSocket(opts) as unknown as LanSocket;
}

/**
 * The LAN discovery socket adapter. Constructing it binds NOTHING — only start()
 * creates a socket (via the injected/lazy factory). Idempotent start()/stop().
 */
export class LanDiscovery {
  private readonly opts: LanDiscoveryOptions;
  private readonly createSocket: SocketFactory;
  private readonly now: () => number;
  private socket: LanSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** In-flight beacon writes — exposed via drain() so a caller (or test) can flush. */
  private readonly inflight = new Set<Promise<void>>();

  constructor(opts: LanDiscoveryOptions) {
    this.opts = opts;
    this.createSocket = opts.createSocket ?? defaultSocketFactory;
    this.now = opts.now ?? Date.now;
  }

  /** True once start() has bound a socket (until stop()). */
  isRunning(): boolean { return this.started; }

  /** Await any in-flight discovered-beacon writes (graceful shutdown / test flush). */
  async drain(): Promise<void> { await Promise.allSettled([...this.inflight]); }

  /**
   * Bind the socket, wire the receive handler, join the group (multicast mode),
   * announce once immediately, then on the announce interval. Idempotent — a second
   * start() while running is a no-op. Best-effort: a bind/listen error is logged,
   * never thrown (a discovery failure must never break the host).
   */
  start(): void {
    if (this.started) { return; }
    // Defense-in-depth: the adapter refuses to bind a socket unless the flag is on
    // AND the user has acknowledged consent — even if a caller forgot to gate. A
    // mutation that tries to bind on the flag alone is caught here (and in tests).
    if (!shouldStartLanDiscovery({ enabled: this.opts.enabled, consentAckAt: this.opts.consentAckAt })) { return; }
    this.started = true;
    let socket: LanSocket;
    try {
      socket = this.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      this.started = false;
      this.logErr('socket create failed', err);
      return;
    }
    this.socket = socket;

    socket.on('message', (msg, rinfo) => this.onDatagram(msg, rinfo.address));
    socket.on('error', (err) => this.logErr('socket error', err));
    socket.on('listening', () => {
      if (this.opts.mode === 'multicast') {
        try { socket.addMembership(LAN_MULTICAST_ADDR); }
        catch (err) { this.logErr('addMembership failed', err); }
      }
    });

    try {
      socket.bind(this.opts.port);
      if (this.opts.mode === 'multicast') { socket.setBroadcast(true); }
    } catch (err) {
      this.logErr('bind failed', err);
    }

    // Announce now, then on the interval. announceNow auto-binds the socket for
    // sending if bind() has not completed yet (dgram permits send-before-listen).
    this.announceNow();
    const intervalMs = this.opts.announceIntervalMs ?? LAN_DEFAULT_ANNOUNCE_MS;
    this.timer = setInterval(() => this.announceNow(), intervalMs);
  }

  /** Send one self-announce to every target (seeds, or the multicast group). */
  announceNow(): void {
    if (!this.socket) { return; }
    const announce = buildSelfAnnounce({
      machineId: this.opts.machineId,
      host: this.opts.host,
      port: this.opts.port,
      now: this.now(),
    });
    const payload = Buffer.from(JSON.stringify(announce), 'utf8');
    const targets: SeedTarget[] = this.opts.mode === 'multicast'
      ? [{ host: LAN_MULTICAST_ADDR, port: this.opts.port }]
      : this.opts.seeds;
    for (const t of targets) {
      try {
        this.socket.send(payload, t.port, t.host, (err) => { if (err) { this.logErr('send failed', err); } });
      } catch (err) {
        this.logErr('send threw', err);
      }
    }
  }

  /** Clear the announce timer + close the socket. Idempotent — safe to call twice. */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.socket) {
      try { this.socket.close(); } catch { /* already closed */ }
      this.socket = null;
    }
    this.started = false;
  }

  /**
   * Handle one received datagram. Fail-closed: a packet that does not parse, or one
   * that is our OWN announce echoed back (multicast loopback), writes nothing. A
   * valid foreign announce is projected to an origin-'lan' beacon stamped with the
   * SOURCE address + the RECEIVE clock, then written to the workspace beacon dir.
   */
  private onDatagram(raw: Buffer, sourceAddr: string): void {
    const announce = parseAnnounce(raw);
    if (!announce) { return; }
    // Never record ourselves — a multicast group echoes our own announce back.
    if (announce.machine_id === this.opts.machineId) { return; }
    const beacon = announceToBeacon(announce, sourceAddr, this.now());
    // Best-effort, fire-and-forget: a write failure must not crash the receive path.
    // Tracked in `inflight` so drain() can flush it (graceful shutdown / tests).
    const p = writeBeacon(beacon, { scope: 'workspace', commsDir: this.opts.commsDir })
      .then(() => undefined)
      .catch((err) => this.logErr('writeBeacon failed', err));
    this.inflight.add(p);
    // .catch on the finally chain: if logErr ever threw, the finally would reject and
    // surface as an unhandledRejection — swallow it (the write is already best-effort).
    void p.finally(() => this.inflight.delete(p)).catch(() => undefined);
  }

  private logErr(what: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    // A broken log sink must NEVER crash discovery or trigger an unhandledRejection.
    try { this.opts.log?.(`[lan-discovery] ${what}: ${msg}`); } catch { /* ignore */ }
  }
}
