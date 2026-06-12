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

import type { CloudRelay, RelayHeartbeat, RelaySendResult } from './relay';
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
