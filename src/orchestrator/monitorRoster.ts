/**
 * monitorRoster.ts — the START LOOP monitor-presence roster (E2b-ii).
 *
 * Each ticking orchestrator loop writes ITS OWN loop-instance presence file at
 * `comms/monitors/<instance_id>.json` every tick — a keepalive in the SAME
 * keyspace as `cluster-map.active_manager.instance_id` (= LOOP_INSTANCE_ID). The
 * active manager reads the whole directory to DISCOVER the live monitor set and
 * standby candidates, then projects them into the cluster map (clusterMap.ts E2a
 * helpers). This is what makes peers discoverable in the correct loop-instance
 * keyspace, which agent-id-keyed heartbeats/beacons cannot provide.
 *
 * Single-FS only — NO sockets (cross-host gossip is the T-track / E3). fs-only
 * (no vscode), `now` injectable. The presence write is atomic (temp + rename) so
 * a concurrent reader never sees a torn file; reads are tolerant (skip malformed).
 *
 * The `comms/monitors/` path is default-denied by the L2 board-refresh predicate
 * (makeShouldRefreshBoard: `monitors` is not on the allow-list), so a presence
 * write never retriggers the board watch.
 */

import * as fs from 'fs';
import * as path from 'path';

const fsp = fs.promises;
const COMMS_REL = path.join('.autoclaw', 'orchestrator', 'comms');

/** A monitor missing ~3 loop ticks (30s) is stale — mirrors SUPERVISOR_TTL_MS. */
export const MONITOR_PRESENCE_TTL_MS = 90_000;

/** The on-disk monitor presence (a ticking orchestrator loop instance). */
export interface MonitorPresence {
  /** The loop-instance id (= LOOP_INSTANCE_ID = the cluster-map keyspace). */
  instance_id: string;
  /** Optional agent id of the host (display only). */
  agent_id?: string;
  /** Optional session id of the host (display only). */
  session_id?: string;
  /** ISO timestamp of this keepalive. */
  timestamp: string;
}

/** A presence enriched with its age relative to `now`. */
export interface MonitorPresenceRow extends MonitorPresence {
  age_ms: number;
}

export function monitorDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, COMMS_REL, 'monitors');
}

function safeFrag(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function monitorPresencePath(workspaceRoot: string, instanceId: string): string {
  return path.join(monitorDir(workspaceRoot), `${safeFrag(instanceId)}.json`);
}

function isValidPresence(o: unknown): o is MonitorPresence {
  if (!o || typeof o !== 'object') { return false; }
  const p = o as Record<string, unknown>;
  return typeof p.instance_id === 'string' && p.instance_id.length > 0
    && typeof p.timestamp === 'string' && p.timestamp.length > 0;
}

let writeSeq = 0;

/**
 * Write this loop instance's presence (the JOIN/keepalive), atomically. Returns
 * the path written. The temp sibling ends in `.tmp-<pid>-<seq>` (not `.json`) so
 * readers and the board watcher both skip it.
 */
export async function writeMonitorPresence(workspaceRoot: string, presence: MonitorPresence): Promise<string> {
  const dir = monitorDir(workspaceRoot);
  await fsp.mkdir(dir, { recursive: true });
  const file = monitorPresencePath(workspaceRoot, presence.instance_id);
  const tmp = `${file}.tmp-${process.pid}-${++writeSeq}`;
  await fsp.writeFile(tmp, JSON.stringify(presence, null, 2) + '\n', 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }
  return file;
}

/**
 * Read the live monitor roster. Missing dir → []. Malformed files are skipped.
 * Stale presences (age > ttlMs) are dropped unless `includeStale`.
 */
export async function readMonitorRoster(
  workspaceRoot: string,
  opts: { now?: number; ttlMs?: number; includeStale?: boolean } = {},
): Promise<MonitorPresenceRow[]> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? MONITOR_PRESENCE_TTL_MS;
  const dir = monitorDir(workspaceRoot);
  let files: string[];
  try { files = await fsp.readdir(dir); } catch { return []; }
  const rows: MonitorPresenceRow[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) { continue; }
    try {
      const raw = await fsp.readFile(path.join(dir, f), 'utf8');
      const parsed = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
      if (!isValidPresence(parsed)) { continue; }
      const t = new Date(parsed.timestamp).getTime();
      const age = Number.isFinite(t) ? Math.max(0, now - t) : Number.POSITIVE_INFINITY;
      if (age > ttlMs && !opts.includeStale) { continue; }
      rows.push({ ...parsed, age_ms: age });
    } catch {
      /* skip malformed */
    }
  }
  return rows;
}

/**
 * Best-effort GC of long-dead presence files (a crashed window leaves an orphan).
 * Reaps only VALID presences older than a generous multiple of the TTL, so a
 * merely-slow but live window is never reaped and a transient/torn file is left
 * alone (the atomic write makes torn files impossible anyway). Returns the count.
 */
export async function pruneStaleMonitorPresence(
  workspaceRoot: string,
  opts: { now?: number; ttlMs?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? MONITOR_PRESENCE_TTL_MS;
  const deadMs = ttlMs * 10;
  const dir = monitorDir(workspaceRoot);
  let files: string[];
  try { files = await fsp.readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) { continue; }
    try {
      const raw = await fsp.readFile(path.join(dir, f), 'utf8');
      const parsed = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
      if (!isValidPresence(parsed)) { continue; } // leave malformed (transient) alone
      const t = new Date(parsed.timestamp).getTime();
      const age = Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY;
      if (age > deadMs) {
        await fsp.unlink(path.join(dir, f)).catch(() => undefined);
        removed++;
      }
    } catch {
      /* skip on read error */
    }
  }
  return removed;
}
