/**
 * forwarding.ts — wires the (otherwise dormant) cloud relay into live data.
 *
 * The relay client in `relay.ts` knows how to SEND; this module knows WHAT to
 * send: it reads the local heartbeat files and forwards the low-sensitivity
 * subset. It is `vscode`-free so the gather/map logic is unit-testable; the
 * extension host just calls {@link forwardHeartbeats} on its heartbeat tick.
 *
 * Everything here is a safe no-op when the relay is inert (disabled / no
 * endpoint / no token / not entitled) — the relay client enforces that.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { CloudRelay, RelayHeartbeat, RelaySendResult, FleetHeartbeatRow } from './relay';
import { getState, markForwarded } from '../comms/inboxState';

const fsp = fs.promises;

function heartbeatsDir(autoclawDir: string): string {
  return path.join(autoclawDir, 'orchestrator', 'comms', 'heartbeats');
}

function inboxesDir(autoclawDir: string): string {
  return path.join(autoclawDir, 'orchestrator', 'comms', 'inboxes');
}

/**
 * Read the local heartbeat files and map each to the relay wire subset.
 *
 * SEC-1: `session_id` is intentionally NOT carried — it is not part of
 * {@link RelayHeartbeat}. Only agent_id/timestamp/status/current_task/sprint/
 * current_llm leave the machine, and even those only when the relay is active.
 */
export async function gatherHeartbeatsForRelay(autoclawDir: string): Promise<RelayHeartbeat[]> {
  let names: string[];
  try {
    names = await fsp.readdir(heartbeatsDir(autoclawDir));
  } catch {
    return [];
  }
  const out: RelayHeartbeat[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) { continue; }
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(heartbeatsDir(autoclawDir), name), 'utf8');
    } catch {
      continue;
    }
    let hb: Record<string, unknown>;
    try {
      hb = JSON.parse(raw.replace(/^﻿/, '')) as Record<string, unknown>;
    } catch {
      continue; // skip malformed
    }
    if (typeof hb.agent_id !== 'string' || typeof hb.timestamp !== 'string') { continue; }
    out.push({
      agent_id: hb.agent_id,
      timestamp: hb.timestamp,
      status: typeof hb.status === 'string' ? hb.status : 'unknown',
      current_task: typeof hb.current_task === 'string' ? hb.current_task : null,
      sprint: typeof hb.sprint === 'number' ? hb.sprint : null,
      ...(typeof hb.current_llm === 'string' ? { current_llm: hb.current_llm } : {}),
    });
  }
  return out;
}

/**
 * Forward the current local heartbeats through the relay. A no-op (returns the
 * relay's `skipped` result) when the relay is inert. Safe to call every tick.
 */
export async function forwardHeartbeats(autoclawDir: string, relay: CloudRelay): Promise<RelaySendResult> {
  const heartbeats = await gatherHeartbeatsForRelay(autoclawDir);
  return relay.sendHeartbeats(heartbeats);
}

// ---------------------------------------------------------------------------
// Inbox forwarding (AF-7) — forward each inbox/shared message to the relay once.
// ---------------------------------------------------------------------------

/** A message pending relay, plus where its `forwarded_at` marker lives. */
interface PendingInboxItem {
  msg: { id: string; to: string; from: string; type: string; timestamp: string; payload: unknown };
  inboxPath: string;
  stem: string;
}

/**
 * Collect inbox + shared messages that have NOT yet been forwarded (no
 * `forwarded_at` in their `_state/`). Oldest first, capped. Dedup is per-message
 * (a marker), not a watermark — messages arrive out of order across clients.
 */
export async function gatherInboxForRelay(autoclawDir: string, cap = 100): Promise<PendingInboxItem[]> {
  const root = inboxesDir(autoclawDir);
  let agentDirs: string[];
  try {
    agentDirs = (await fsp.readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
  const items: PendingInboxItem[] = [];
  for (const agent of agentDirs) {
    const inboxPath = path.join(root, agent);
    let files: string[];
    try { files = await fsp.readdir(inboxPath); } catch { continue; }
    for (const fn of files) {
      if (!fn.endsWith('.json')) { continue; }
      const stem = fn.slice(0, -5);
      const state = await getState(inboxPath, stem, { strict: true });
      if (state?.forwarded_at) { continue; } // already relayed
      let raw: string;
      try { raw = await fsp.readFile(path.join(inboxPath, fn), 'utf8'); } catch { continue; }
      let m: Record<string, unknown>;
      try { m = JSON.parse(raw.replace(/^﻿/, '')) as Record<string, unknown>; } catch { continue; }
      if (typeof m.id !== 'string' || typeof m.timestamp !== 'string') { continue; }
      items.push({
        msg: {
          id: m.id, timestamp: m.timestamp,
          to: typeof m.to === 'string' ? m.to : agent,
          from: typeof m.from === 'string' ? m.from : '',
          type: typeof m.type === 'string' ? m.type : '',
          payload: m.payload,
        },
        inboxPath, stem,
      });
    }
  }
  items.sort((a, b) => new Date(a.msg.timestamp).getTime() - new Date(b.msg.timestamp).getTime());
  return items.slice(0, cap);
}

/**
 * Forward un-forwarded inbox messages through the relay. A no-op when the relay
 * is inert. Messages are marked `forwarded_at` ONLY when the relay actually
 * transmitted OR queued them (i.e. `result.skipped` is unset) — so a disabled/
 * unauthenticated relay forwards them later instead of dropping them.
 */
export async function forwardInbox(autoclawDir: string, relay: CloudRelay): Promise<RelaySendResult> {
  const items = await gatherInboxForRelay(autoclawDir);
  if (items.length === 0) { return { ok: true, detail: 'no inbox messages to forward' }; }
  const res = await relay.sendInbox(items.map(i => i.msg));
  if (!res.skipped) {
    for (const it of items) { await markForwarded(it.inboxPath, it.stem); }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Cross-machine fleet heartbeats (AF-10c) — pull remote heartbeats + cache them
// for the fleet view (CF-1/CF-2 already render origin:'relay' rows).
// ---------------------------------------------------------------------------

/** A remote machine's heartbeat, cached for the fleet view. */
export interface RemoteFleetHeartbeat {
  agent_id: string; timestamp: string; status: string;
  current_task: string | null; sprint: number | null; current_llm?: string;
  /** Origin machine (the remote installation id). */
  host: string;
  origin: 'relay';
}

function remoteHeartbeatsFile(autoclawDir: string): string {
  return path.join(autoclawDir, 'cloud', 'remote-heartbeats.json');
}

/**
 * Cache the relay's heartbeats as the fleet view's remote rows. Drops this
 * machine's own rows (by installation id) so only OTHER machines show as
 * remote, keeps the latest per (agent, host), and overwrites the cache each
 * pull (the relay returns the full current snapshot).
 */
export async function applyFetchedHeartbeats(
  autoclawDir: string,
  heartbeats: readonly FleetHeartbeatRow[],
  localInstallationId?: string,
): Promise<number> {
  const byKey = new Map<string, RemoteFleetHeartbeat>();
  for (const h of heartbeats) {
    if (!h?.agent_id || !h.installation_id) { continue; }
    if (localInstallationId && h.installation_id === localInstallationId) { continue; } // not "remote"
    const row: RemoteFleetHeartbeat = {
      agent_id: h.agent_id, timestamp: h.timestamp, status: h.status,
      current_task: h.current_task ?? null, sprint: h.sprint ?? null,
      ...(h.current_llm ? { current_llm: h.current_llm } : {}),
      host: h.installation_id, origin: 'relay',
    };
    const k = `${row.agent_id}::${row.host}`;
    const prev = byKey.get(k);
    if (!prev || new Date(row.timestamp).getTime() > new Date(prev.timestamp).getTime()) { byKey.set(k, row); }
  }
  const out = [...byKey.values()];
  const file = remoteHeartbeatsFile(autoclawDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(out, null, 2), 'utf8');
  return out.length;
}

/** Read the cached remote-machine heartbeats for the fleet view (empty when none). */
export async function readRemoteHeartbeats(autoclawDir: string): Promise<RemoteFleetHeartbeat[]> {
  try {
    return JSON.parse(await fsp.readFile(remoteHeartbeatsFile(autoclawDir), 'utf8')) as RemoteFleetHeartbeat[];
  } catch {
    return [];
  }
}

/** Pull remote heartbeats and refresh the fleet cache. No-op when inert. */
export async function fetchAndCacheHeartbeats(autoclawDir: string, relay: CloudRelay): Promise<number> {
  const res = await relay.fetchHeartbeats();
  if (res.skipped || !res.ok) { return 0; }
  return applyFetchedHeartbeats(autoclawDir, res.heartbeats, res.localInstallationId);
}

/** A message pulled from the relay (AF-7b), ready to land in a local inbox. */
export interface FetchedMessage {
  id: string; to: string; from: string; type: string; timestamp: string; payload: unknown;
}

/**
 * Write relay-pulled messages into their recipients' local inboxes (AF-7b).
 * Idempotent: a message already present (by id) is skipped, so repeated pulls
 * never duplicate. Returns how many were written vs skipped.
 */
export async function applyFetchedToInboxes(
  autoclawDir: string,
  messages: readonly FetchedMessage[],
): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;
  for (const m of messages) {
    if (!m?.id || !m?.to) { skipped++; continue; }
    const dir = path.join(inboxesDir(autoclawDir), m.to);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `fetched-${m.id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    try {
      await fsp.access(file);
      skipped++; // already landed — dedup
      continue;
    } catch { /* not present — write it */ }
    await fsp.writeFile(file, JSON.stringify(m), 'utf8');
    written++;
  }
  return { written, skipped };
}
