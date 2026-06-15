/**
 * beacons.ts — the universal cross-tool agent check-in.
 *
 * A "beacon" is one JSON file that any agent — a different IDE (Kiro, Cursor),
 * a headless runner (Hermes, openclaw, AutoGPT), or a shell one-liner — writes
 * to announce presence without the VS Code extension. Beacons let the fleet
 * panel show agents working from other tools / workspaces / machines.
 *
 * Two homes (see docs/FLEET_ARCHITECTURE.md §4):
 *   - workspace: <ws>/.autoclaw/orchestrator/comms/beacons/<id>[-<session>].json
 *   - machine:   ~/.autoclaw/beacons/<id>[-<session>].json
 *
 * The shape is a superset of the comms Heartbeat, so a beacon doubles as a
 * heartbeat. This module is pure of vscode; it touches fs only for read/write
 * of the beacon files themselves.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fsp = fs.promises;

/** Where presence reached the panel from. */
export type BeaconOrigin = 'local' | 'relay' | 'beacon';

/** On-disk beacon document (superset-compatible with Heartbeat). */
export interface Beacon {
  agent_id: string;
  session_id?: string;
  timestamp: string;
  status?: 'active' | 'idle';
  current_task?: string | null;
  current_llm?: string;
  /** Self-declared role hint (the user's fleet.json still wins). */
  role?: string;
  agent_type?: string;
  /** IDE / runner name, e.g. "kiro", "hermes", "openclaw". */
  host?: string;
  machine_id?: string;
  /** Absolute workspace path the agent is working in. */
  workspace?: string;
  /** Short slug of the workspace (folder basename when absent). */
  workspace_id?: string;
  origin?: BeaconOrigin;
  /** Optional HTTP endpoint for runner-style agents. */
  endpoint?: string;
}

/** A beacon enriched for the panel (origin forced, workspace_id derived). */
export interface BeaconRow extends Beacon {
  origin: BeaconOrigin;
  workspace_id: string;
  /** Age of the beacon in ms, relative to the read `now`. */
  age_ms: number;
  /** True when older than the freshness window. */
  stale: boolean;
}

/** Default freshness window — a beacon older than this reads as stale. */
export const BEACON_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** The machine-global beacon directory (`~/.autoclaw/beacons`). */
export function machineBeaconDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.autoclaw', 'beacons');
}

/** A workspace's beacon directory. */
export function workspaceBeaconDir(commsDir: string): string {
  return path.join(commsDir, 'beacons');
}

/** Derive a stable workspace slug from an absolute path (folder basename). */
export function workspaceSlug(workspacePath?: string): string {
  if (!workspacePath) { return ''; }
  // Split on both POSIX and Windows separators so the slug is identical
  // regardless of host OS (Node's path.basename is platform-specific).
  const trimmed = workspacePath.replace(/[\\/]+$/, '');
  const segs = trimmed.split(/[\\/]+/);
  const base = segs[segs.length - 1] ?? '';
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Sanitize an id/session fragment for use in a filename. */
function safeFrag(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

/** True if `b` has the minimum fields to be a usable beacon. */
export function isValidBeacon(b: unknown): b is Beacon {
  if (!b || typeof b !== 'object') { return false; }
  const o = b as Record<string, unknown>;
  return typeof o.agent_id === 'string' && o.agent_id.length > 0
    && typeof o.timestamp === 'string' && o.timestamp.length > 0;
}

/** Enrich a raw beacon into a BeaconRow (origin, workspace_id, staleness). */
export function normalizeBeacon(b: Beacon, now: number, ttlMs: number = BEACON_TTL_MS): BeaconRow {
  const t = new Date(b.timestamp).getTime();
  const age = Number.isFinite(t) ? Math.max(0, now - t) : Number.POSITIVE_INFINITY;
  return {
    ...b,
    origin: b.origin ?? 'beacon',
    workspace_id: b.workspace_id || workspaceSlug(b.workspace) || '',
    age_ms: age,
    stale: age > ttlMs,
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read every beacon in a directory, normalized and (by default) with stale
 * ones dropped. Missing dir → []. Malformed files are skipped silently.
 */
export async function readBeacons(
  dir: string,
  opts: { now?: number; ttlMs?: number; includeStale?: boolean } = {},
): Promise<BeaconRow[]> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? BEACON_TTL_MS;
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const rows: BeaconRow[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) { continue; }
    try {
      const raw = await fsp.readFile(path.join(dir, f), 'utf8');
      const parsed = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
      if (!isValidBeacon(parsed)) { continue; }
      const row = normalizeBeacon(parsed, now, ttlMs);
      if (row.stale && !opts.includeStale) { continue; }
      rows.push(row);
    } catch {
      /* skip malformed */
    }
  }
  return rows;
}

/**
 * Read both machine-global and workspace beacons, deduped by
 * (agent_id, session_id) keeping the freshest. `commsDir` may be omitted to
 * read only the machine dir.
 */
export async function readAllBeacons(
  opts: { commsDir?: string; homeDir?: string; now?: number; ttlMs?: number; includeStale?: boolean } = {},
): Promise<BeaconRow[]> {
  const dirs = [machineBeaconDir(opts.homeDir)];
  if (opts.commsDir) { dirs.push(workspaceBeaconDir(opts.commsDir)); }
  const all: BeaconRow[] = [];
  for (const d of dirs) {
    all.push(...await readBeacons(d, opts));
  }
  // Dedup: freshest wins per (agent_id|session_id).
  const best = new Map<string, BeaconRow>();
  for (const r of all) {
    const key = `${r.agent_id}|${r.session_id ?? ''}`;
    const prev = best.get(key);
    if (!prev || r.age_ms < prev.age_ms) { best.set(key, r); }
  }
  return Array.from(best.values());
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write a beacon so internal runners / helpers don't hand-roll the format.
 * `scope: 'machine'` writes to ~/.autoclaw/beacons; 'workspace' needs commsDir.
 * Returns the path written.
 */
export async function writeBeacon(
  beacon: Beacon,
  opts: { scope?: 'machine' | 'workspace'; commsDir?: string; homeDir?: string } = {},
): Promise<string> {
  const scope = opts.scope ?? 'machine';
  const dir = scope === 'workspace' && opts.commsDir
    ? workspaceBeaconDir(opts.commsDir)
    : machineBeaconDir(opts.homeDir);
  await fsp.mkdir(dir, { recursive: true });
  const frag = beacon.session_id ? `${safeFrag(beacon.agent_id)}-${safeFrag(beacon.session_id)}` : safeFrag(beacon.agent_id);
  const file = path.join(dir, `${frag}.json`);
  const body: Beacon = {
    ...beacon,
    origin: beacon.origin ?? 'beacon',
    workspace_id: beacon.workspace_id || workspaceSlug(beacon.workspace) || undefined,
  };
  await fsp.writeFile(file, JSON.stringify(body, null, 2), 'utf8');
  return file;
}
