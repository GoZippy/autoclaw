/**
 * inboxState.ts — Inbox state machine for the AutoClaw cross-agent comms layer.
 *
 * Manages per-message state in a `_state/` subdirectory alongside each agent
 * inbox.  Backwards-compatible: absence of `_state/<msgId>.json` means the
 * message is unread and (if `requires_response` is set) awaiting reply.
 *
 * File layout:
 *   <inboxPath>/                     ← agent inbox directory
 *     <msg-filename>.json            ← raw message files
 *     _state/
 *       <msg-filename>.json          ← InboxStateEntry (this module writes here)
 *
 * Sprint 1 — A4 (WA-3)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { InboxMessage } from './types';
import type { InboxStateEntry } from './types';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stateDir(inboxPath: string): string {
  return path.join(inboxPath, '_state');
}

function stateFilePath(inboxPath: string, msgId: string): string {
  return path.join(stateDir(inboxPath), `${path.basename(msgId)}.json`);
}

async function readStateFile(filePath: string): Promise<InboxStateEntry | null> {
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as InboxStateEntry;
  } catch {
    return null;
  }
}

async function writeStateFile(filePath: string, entry: InboxStateEntry): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, JSON.stringify(entry, null, 2), 'utf8');
}

/** Read a message file from the inbox. Returns null if malformed or missing. */
async function readMessageFile(inboxPath: string, filename: string): Promise<InboxMessage | null> {
  try {
    const raw = await fsPromises.readFile(path.join(inboxPath, filename), 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as InboxMessage;
  } catch {
    return null;
  }
}

/** List all message JSON filenames in the inbox (excludes _state/ directory). */
async function listMessageFiles(inboxPath: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(inboxPath, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Mark a message as read.  Idempotent: if `read_at` is already set it will not
 * be overwritten, preserving the original timestamp.
 */
export async function markRead(inboxPath: string, msgId: string): Promise<void> {
  const fp = stateFilePath(inboxPath, msgId);
  const existing = await readStateFile(fp);
  if (existing?.read_at) {
    return; // Already read — do not clobber the original timestamp.
  }
  const now = new Date().toISOString();
  await writeStateFile(fp, {
    msg_id: msgId,
    received_at: existing?.received_at ?? now,
    read_at: now,
    replied_at: existing?.replied_at ?? null,
    archived_at: existing?.archived_at ?? null,
  });
}

/**
 * Mark a message as replied.  Also sets `read_at` if not already set (replying
 * implies reading).
 */
export async function markReplied(inboxPath: string, msgId: string): Promise<void> {
  const fp = stateFilePath(inboxPath, msgId);
  const existing = await readStateFile(fp);
  const now = new Date().toISOString();
  await writeStateFile(fp, {
    msg_id: msgId,
    received_at: existing?.received_at ?? now,
    read_at: existing?.read_at ?? now,
    replied_at: now,
    archived_at: existing?.archived_at ?? null,
  });
}

/**
 * Archive a message.  Does NOT automatically mark it read — callers should call
 * `markRead` first if that is the desired UX.
 */
export async function archive(inboxPath: string, msgId: string): Promise<void> {
  const fp = stateFilePath(inboxPath, msgId);
  const existing = await readStateFile(fp);
  const now = new Date().toISOString();
  await writeStateFile(fp, {
    msg_id: msgId,
    received_at: existing?.received_at ?? now,
    read_at: existing?.read_at ?? null,
    replied_at: existing?.replied_at ?? null,
    archived_at: now,
  });
}

/**
 * Read the state for a single message.
 *
 * Returns an InboxStateEntry if a state file exists, or a synthetic entry
 * with all timestamps null (representing "unread, not replied, not archived")
 * when no state file is present (backwards-compatible).
 *
 * Returns `null` only when the message itself does not exist in the inbox.
 * Pass `strict: false` (default) to always return a state object if requested;
 * pass `strict: true` to get `null` when there is no state file.
 */
export async function getState(
  inboxPath: string,
  msgId: string,
  options: { strict?: boolean } = {}
): Promise<InboxStateEntry | null> {
  const fp = stateFilePath(inboxPath, msgId);
  const existing = await readStateFile(fp);
  if (existing) {
    return existing;
  }
  if (options.strict) {
    return null;
  }
  // Backwards-compat synthetic state (no state file = unread).
  return {
    msg_id: msgId,
    received_at: new Date().toISOString(),
    read_at: null,
    replied_at: null,
    archived_at: null,
  };
}

/**
 * List all messages in the inbox where `read_at` is null.
 *
 * Backwards compatible: messages without a `_state/` file are treated as unread.
 */
export async function listUnread(inboxPath: string): Promise<InboxMessage[]> {
  const filenames = await listMessageFiles(inboxPath);
  const unread: InboxMessage[] = [];

  for (const filename of filenames) {
    const msgId = filename.replace(/\.json$/, '');
    const state = await readStateFile(stateFilePath(inboxPath, msgId));
    // No state file OR read_at is null → unread.
    if (!state || !state.read_at) {
      const msg = await readMessageFile(inboxPath, filename);
      if (msg) {
        unread.push(msg);
      }
    }
  }

  return unread.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

/**
 * List all messages that require a response from this agent and have not yet
 * been replied to.
 *
 * Criteria:
 *   - `message.requires_response === true`
 *   - state `replied_at` is null (or no state file — backwards-compat)
 *   - message is not archived
 */
export async function listAwaitingMe(inboxPath: string): Promise<InboxMessage[]> {
  const filenames = await listMessageFiles(inboxPath);
  const awaiting: InboxMessage[] = [];

  for (const filename of filenames) {
    const msg = await readMessageFile(inboxPath, filename);
    if (!msg || !msg.requires_response) {
      continue;
    }
    const msgId = filename.replace(/\.json$/, '');
    const state = await readStateFile(stateFilePath(inboxPath, msgId));
    // Archived messages are not awaiting.
    if (state?.archived_at) {
      continue;
    }
    // Not replied → awaiting.
    if (!state || !state.replied_at) {
      awaiting.push(msg);
    }
  }

  return awaiting.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}
