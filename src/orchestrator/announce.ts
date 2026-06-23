/**
 * announce.ts — CL-1: auto-announce on session start.
 *
 * On REGISTER an agent should automatically describe itself to the rest of the
 * fleet WITHOUT a human asking: it writes a structured `session_announce`
 * message to the shared board AND refreshes a session heartbeat sidecar carrying
 * `current_task` / `branch` / `file_scope`. CL-5 (`fleet.brief`) and the panel
 * read those fields back so every active session is self-describing.
 *
 * This module is vscode-free and dependency-light (node fs/path only) so it
 * unit-tests without an editor host. It reuses the shared contracts from
 * `./coordination` (SESSION_ANNOUNCE_TYPE, SessionDescriptor, CommsMessage) —
 * it does NOT redefine them.
 *
 * Filesystem layout it touches (relative to workspaceRoot):
 *   .autoclaw/orchestrator/comms/
 *     inboxes/shared/<iso-ts-millis>-session_announce-<agent>-<frag>.json
 *     heartbeats/<agent>-<frag>.json
 *
 * where `<frag>` = first 8 chars of session_id (matches the panel/CL-5 reader's
 * `<agent_id>-*.json` glob in comms/heartbeat.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { SESSION_ANNOUNCE_TYPE } from './coordination';
import type { SessionDescriptor, CommsMessage } from './coordination';

const fsPromises = fs.promises;

/** How recently a prior announce for the same session suppresses a duplicate. */
const ANNOUNCE_DEDUPE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/** What the caller hands us to describe the freshly-started session. */
export interface AnnounceInput {
  agent_id: string;
  session_id: string;
  /** The git branch this session is working on. */
  branch?: string | null;
  /** One-line description of what this session is doing. */
  current_task?: string | null;
  /** File globs this session has declared it is editing (mirrors CL-4 leases). */
  file_scope?: string[];
  /** Free-form human note carried only in the announce payload. */
  note?: string | null;
}

export interface AnnounceOptions {
  /** Injectable clock for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

export interface AnnounceResult {
  /** True when a NEW session_announce message was written this call. False when
   *  deduped (an announce for this session already exists in the window). The
   *  heartbeat sidecar is refreshed in BOTH cases. */
  announced: boolean;
  /** Absolute path to the session heartbeat sidecar that was written. */
  heartbeatPath: string;
  /** Absolute path to the announce message, when one was written. */
  messagePath?: string;
}

function commsDirOf(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
}

/** First 8 chars of the session id, sanitised for use as a filename component. */
export function sessionFrag(sessionId: string): string {
  return String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 8);
}

/** Filesystem-safe filename timestamp at millisecond precision (never
 *  whole-second — two announces in the same second would otherwise overwrite). */
function tsForFilename(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

/**
 * Has a `session_announce` for this exact session already landed in the shared
 * inbox within `windowMs`? Used to dedupe so re-running REGISTER (or a quick
 * reactivation) refreshes the heartbeat without spamming the board. Best-effort:
 * a missing/unreadable tree means "no prior announce" → we proceed to announce.
 */
async function hasRecentAnnounce(
  sharedDir: string, agentId: string, sessionId: string, now: number, windowMs: number
): Promise<boolean> {
  let files: string[];
  try {
    files = await fsPromises.readdir(sharedDir);
  } catch {
    return false;
  }
  const cutoff = now - windowMs;
  for (const f of files) {
    // Cheap pre-filter on the filename shape before parsing.
    if (!f.endsWith('.json') || !f.includes(`-${SESSION_ANNOUNCE_TYPE}-`)) { continue; }
    try {
      const raw = (await fsPromises.readFile(path.join(sharedDir, f), 'utf8')).replace(/^﻿/, '');
      const msg = JSON.parse(raw) as CommsMessage;
      if (msg.type !== SESSION_ANNOUNCE_TYPE) { continue; }
      if (msg.from !== agentId || msg.session_id !== sessionId) { continue; }
      const t = msg.timestamp ? new Date(msg.timestamp).getTime() : NaN;
      // No/garbled timestamp ⇒ treat as recent (conservatively dedupe).
      if (Number.isNaN(t) || t >= cutoff) { return true; }
    } catch {
      /* skip malformed */
    }
  }
  return false;
}

/**
 * Announce a freshly-started session and refresh its heartbeat sidecar.
 *
 * - Writes the heartbeat sidecar `heartbeats/<agent>-<frag>.json` carrying the
 *   SessionDescriptor fields (status default 'active') ALWAYS.
 * - Writes a `session_announce` message to `inboxes/shared/` ONCE per session
 *   per dedupe window; a re-announce inside the window refreshes the heartbeat
 *   only (announced=false).
 *
 * Best-effort and never throws: any I/O failure resolves with
 * `{ announced:false, heartbeatPath }` so activation is never blocked.
 */
export async function announceSession(
  workspaceRoot: string,
  desc: AnnounceInput,
  opts: AnnounceOptions = {}
): Promise<AnnounceResult> {
  const now = opts.now ?? Date.now();
  const iso = new Date(now).toISOString();
  const agentBase = path.basename(desc.agent_id);
  const frag = sessionFrag(desc.session_id);

  const commsDir = commsDirOf(workspaceRoot);
  const sharedDir = path.join(commsDir, 'inboxes', 'shared');
  const heartbeatsDir = path.join(commsDir, 'heartbeats');
  const heartbeatPath = path.join(heartbeatsDir, `${agentBase}-${frag}.json`);

  const result: AnnounceResult = { announced: false, heartbeatPath };

  // 1) Always refresh the session heartbeat sidecar (the self-describing record
  //    CL-5 + the panel read). mkdir -p; best-effort.
  const descriptor: SessionDescriptor = {
    agent_id: desc.agent_id,
    session_id: desc.session_id,
    timestamp: iso,
    status: 'active',
    current_task: desc.current_task ?? null,
    branch: desc.branch ?? null,
    file_scope: desc.file_scope ?? [],
  };
  try {
    await fsPromises.mkdir(heartbeatsDir, { recursive: true });
    await fsPromises.writeFile(heartbeatPath, JSON.stringify(descriptor, null, 2), 'utf8');
  } catch {
    /* heartbeat write failed — keep going; announce may still land */
  }

  // 2) Announce to the shared board, deduped by recent prior announce.
  try {
    if (await hasRecentAnnounce(sharedDir, desc.agent_id, desc.session_id, now, ANNOUNCE_DEDUPE_WINDOW_MS)) {
      return result; // refreshed heartbeat, suppressed duplicate announce
    }
    const message: CommsMessage = {
      id: `msg-${tsForFilename(iso)}-${frag}`,
      from: desc.agent_id,
      to: 'shared',
      type: SESSION_ANNOUNCE_TYPE,
      timestamp: iso,
      requires_response: false,
      session_id: desc.session_id,
      payload: {
        current_task: desc.current_task ?? null,
        branch: desc.branch ?? null,
        file_scope: desc.file_scope ?? [],
        note: desc.note ?? null,
      },
    };
    const filename = `${tsForFilename(iso)}-${SESSION_ANNOUNCE_TYPE}-${agentBase}-${frag}.json`;
    const messagePath = path.join(sharedDir, filename);
    await fsPromises.mkdir(sharedDir, { recursive: true });
    await fsPromises.writeFile(messagePath, JSON.stringify(message, null, 2), 'utf8');
    result.announced = true;
    result.messagePath = messagePath;
  } catch {
    /* announce write failed — heartbeat already refreshed; do not throw */
  }

  return result;
}
