/**
 * heartbeat.ts — Session-level heartbeat writer for the AutoClaw comms layer.
 *
 * Extends the primary `writeHeartbeat` / `readHeartbeat` in comms.ts by also
 * writing a per-session file so the panel can show per-session rows.
 *
 * File layout:
 *   <commsDir>/heartbeats/
 *     <agent_id>.json                   ← primary (always written)
 *     <agent_id>-<session_id>.json      ← session-level (written when session_id present)
 *
 * Stall detection:
 *   - The primary file is the authoritative stall signal (checked by
 *     `agentStatusFromHeartbeat` in comms.ts).
 *   - `readSessionHeartbeats` returns all `<agent_id>-*.json` session files so
 *     the panel can render per-session last-seen times.
 *
 * Sprint 1 — A5 (WA-3)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Heartbeat } from '../comms';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Session heartbeat writer
// ---------------------------------------------------------------------------

/**
 * Write the primary heartbeat (`<agent_id>.json`) AND, when `session_id` is
 * present, a session-level sidecar file (`<agent_id>-<session_id>.json`).
 *
 * The primary file is always overwritten (latest wins).  The session file is
 * written alongside and retains the full heartbeat payload so the panel can
 * show per-session details without re-reading the primary.
 */
export async function writeSessionHeartbeat(
  commsDir: string,
  hb: Heartbeat
): Promise<{ primaryPath: string; sessionPath: string | null }> {
  const dir = path.join(commsDir, 'heartbeats');
  await fsPromises.mkdir(dir, { recursive: true });

  const agentBase = path.basename(hb.agent_id);
  const primaryPath = path.join(dir, `${agentBase}.json`);
  const payload = JSON.stringify(hb, null, 2);

  await fsPromises.writeFile(primaryPath, payload, 'utf8');

  let sessionPath: string | null = null;
  if (hb.session_id) {
    // Sanitise session_id to be safe as a filename component.
    const safeSession = hb.session_id.replace(/[^A-Za-z0-9_-]/g, '_');
    sessionPath = path.join(dir, `${agentBase}-${safeSession}.json`);
    await fsPromises.writeFile(sessionPath, payload, 'utf8');
  }

  return { primaryPath, sessionPath };
}

// ---------------------------------------------------------------------------
// Session heartbeat reader
// ---------------------------------------------------------------------------

/**
 * Read all session-level heartbeat files for a given agent.
 *
 * Looks for files matching `<agent_id>-*.json` in the heartbeats directory.
 * Excludes the primary file (`<agent_id>.json`).
 *
 * Returns an empty array when the heartbeats directory does not exist or when
 * no session files are present.
 */
export async function readSessionHeartbeats(
  commsDir: string,
  agentId: string
): Promise<Heartbeat[]> {
  const dir = path.join(commsDir, 'heartbeats');
  try {
    const files = await fsPromises.readdir(dir);
    const agentBase = path.basename(agentId);
    const sessionFiles = files.filter(
      f => f.startsWith(`${agentBase}-`) && f.endsWith('.json')
    );
    const results: Heartbeat[] = [];
    for (const f of sessionFiles) {
      try {
        const raw = await fsPromises.readFile(path.join(dir, f), 'utf8');
        results.push(JSON.parse(raw.replace(/^﻿/, '')) as Heartbeat);
      } catch {
        /* skip malformed */
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stall detection helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the agent is considered stalled based on its primary
 * heartbeat AND all session-level files.
 *
 * An agent is stalled when:
 *   - Its primary heartbeat is older than `stallThresholdMs` (default 5 min).
 *   - It has an active sprint assignment at the time of that heartbeat.
 *
 * Individual session files are returned so the panel can render per-session
 * last-seen times — this function only checks the primary for the stall
 * signal (consistent with `agentStatusFromHeartbeat` in comms.ts).
 */
export async function checkStall(
  commsDir: string,
  agentId: string,
  options: { stallThresholdMs?: number; now?: number } = {}
): Promise<{
  stalled: boolean;
  primaryAge: number | null;
  sessions: Array<{ session_id: string | undefined; last_seen: string; age: number }>;
}> {
  const stallThresholdMs = options.stallThresholdMs ?? 5 * 60 * 1000;
  const now = options.now ?? Date.now();

  // Read primary heartbeat.
  let primaryAge: number | null = null;
  let stalled = false;
  try {
    const raw = await fsPromises.readFile(
      path.join(commsDir, 'heartbeats', `${path.basename(agentId)}.json`),
      'utf8'
    );
    const hb = JSON.parse(raw.replace(/^﻿/, '')) as Heartbeat;
    primaryAge = now - new Date(hb.timestamp).getTime();
    stalled = primaryAge >= stallThresholdMs && hb.sprint !== null && hb.sprint !== undefined;
  } catch {
    /* primary missing → offline, not stalled */
  }

  // Read session heartbeats.
  const sessionHbs = await readSessionHeartbeats(commsDir, agentId);
  const sessions = sessionHbs.map(hb => ({
    session_id: hb.session_id,
    last_seen: hb.timestamp,
    age: now - new Date(hb.timestamp).getTime(),
  }));

  return { stalled, primaryAge, sessions };
}
