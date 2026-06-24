/**
 * lanPresence.ts — LAN discovery presence (T0a, secure-multi-host T-track).
 *
 * The PURE, socket-free core of LAN peer discovery: the on-the-wire presence
 * announce, its strict parser, and the projection of a received announce into a
 * Beacon roster row. The thin UDP/seed socket adapter (T0b) imports these and is
 * the ONLY place a socket is ever bound — kept separate so this logic is fully
 * unit-testable without binding a real socket.
 *
 * SECURITY POSTURE (T0 = DISCOVERY ONLY):
 *  - The announce carries ONLY non-sensitive presence: a stable opaque machine_id,
 *    an IDE/runner label, and the port a peer answers on. It NEVER carries the
 *    workspace path, current task, IP, tokens, or any project data (mirrors the
 *    relay's wire-minimization and agent-card's "machine_ip only in authenticated
 *    extended cards"). The peer's network ADDRESS is observed from the datagram
 *    SOURCE at receive time (T0b) — a peer never announces its own IP.
 *  - A discovered peer maps to a Beacon with origin 'lan' = DISCOVERED, NOT
 *    AUTHENTICATED. It is observe-only telemetry; the trust ceiling is OFF until
 *    T2 (mTLS/SVID/biscuit) authenticates it. A 'lan' beacon is INERT data — the
 *    roster never executes/dispatches on it — and is explicitly excluded from the
 *    pending-agent admission path (see fleet/pending.ts).
 */

import type { Beacon } from './beacons';

/** Current LAN presence wire version (for forward-compat). */
export const LAN_ANNOUNCE_VERSION = 1 as const;

/** Hard cap on a parsed announce — a larger datagram is dropped (anti-DoS). */
export const LAN_ANNOUNCE_MAX_BYTES = 512;

/**
 * The LAN presence announce — a strict, non-sensitive subset of a Beacon. NOTHING
 * here is project/PII data: a peer announces only who it is (machine_id), a label
 * (host), and where it answers (port). The network address is observed from the
 * packet source, never sent.
 */
export interface LanAnnounce {
  v: typeof LAN_ANNOUNCE_VERSION;
  /** Stable, opaque per-install id (NOT a hostname/IP/PII). */
  machine_id: string;
  /** IDE / runner label, e.g. "kiro" — Beacon.host semantics, NOT an FQDN. */
  host: string;
  /** The port this peer answers on (the bridge/A2A port). */
  port: number;
  /** ISO emit time — informational only; the RECEIVER's clock drives staleness. */
  ts?: string;
}

/** Build this host's self-announce (caller injects identity + clock; no I/O). */
export function buildSelfAnnounce(opts: { machineId: string; host: string; port: number; now: number }): LanAnnounce {
  return {
    v: LAN_ANNOUNCE_VERSION,
    machine_id: opts.machineId,
    host: opts.host,
    port: opts.port,
    ts: new Date(opts.now).toISOString(),
  };
}

function isValidPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535;
}

/**
 * Wire-boundary allowlists for the two free-text identity fields. A LAN announce
 * is untrusted input that flows into the roster `agent_id` (`lan:<machine_id>`),
 * `host`, and the on-disk beacon filename — so both are bounded to a conservative
 * charset with NO control chars, newlines, path separators, or runaway length.
 * machine_id is an opaque per-install id; host is a short label (NOT an FQDN).
 */
const MACHINE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const HOST_LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Parse a received datagram into a LanAnnounce, or null. Fail-CLOSED on anything
 * malformed/oversized/wrong-version, exactly like beacons.isValidBeacon and the
 * gossip parsers — a hostile/garbage packet is silently dropped, never trusted.
 */
export function parseAnnounce(raw: string | Buffer): LanAnnounce | null {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length;
  if (bytes > LAN_ANNOUNCE_MAX_BYTES) { return null; }
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const o = JSON.parse(text.replace(/^﻿/, '')) as unknown;
    if (!o || typeof o !== 'object') { return null; }
    const a = o as Record<string, unknown>;
    if (a.v !== LAN_ANNOUNCE_VERSION) { return null; }
    if (typeof a.machine_id !== 'string' || !MACHINE_ID_RE.test(a.machine_id)) { return null; }
    if (typeof a.host !== 'string' || !HOST_LABEL_RE.test(a.host)) { return null; }
    if (!isValidPort(a.port)) { return null; }
    if (a.ts !== undefined && typeof a.ts !== 'string') { return null; }
    const out: LanAnnounce = { v: LAN_ANNOUNCE_VERSION, machine_id: a.machine_id, host: a.host, port: a.port };
    if (typeof a.ts === 'string') { out.ts = a.ts; }
    return out;
  } catch {
    return null;
  }
}

/**
 * Project a received announce into a Beacon roster row. PURE. `sourceAddr` is the
 * peer's network address observed from the datagram source (or the seed host) —
 * NOT from the announce payload. The beacon `timestamp` is the RECEIVE time (`now`),
 * so a peer cannot spoof its own freshness and the existing BEACON_TTL_MS staleness
 * ages it out when it stops announcing. origin 'lan' marks it discovered/untrusted.
 *
 * The dedupe id is `lan:<machine_id>` (per physical peer, stable across DHCP IP
 * changes), so a re-announce overwrites the row rather than spawning a duplicate.
 */
export function announceToBeacon(a: LanAnnounce, sourceAddr: string, now: number): Beacon {
  return {
    agent_id: `lan:${a.machine_id}`,
    machine_id: a.machine_id,
    host: a.host,
    endpoint: `${sourceAddr}:${a.port}`,
    timestamp: new Date(now).toISOString(),
    status: 'active',
    origin: 'lan',
  };
}
