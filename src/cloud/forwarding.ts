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

const fsp = fs.promises;

function heartbeatsDir(autoclawDir: string): string {
  return path.join(autoclawDir, 'orchestrator', 'comms', 'heartbeats');
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
