/**
 * reviewfleet/inbox.ts — RF-4c: Inbox adapter for the Review Fleet watcher.
 *
 * Pure IO plumbing — wires scanReviewRequests and markReviewRequestProcessed
 * against the real .autoclaw/orchestrator/comms/ tree.  The fleet itself
 * stays dormant; this module only reads and renames files.
 *
 * Idempotency convention (matching the live comms tree):
 *   A message is "already processed" when a file whose parsed `id` field
 *   matches the message id already exists inside the sibling `processed/`
 *   subdirectory of the same inbox dir.  This mirrors the atomic-rename
 *   pattern specified in AGENT_SESSION_PROTOCOL.md §3.2 and matches what
 *   the existing kilocode/claude-code sessions write in practice.
 *
 *   We do NOT rely on the `_state/<filename>.json` marker files — those are
 *   written by human-operated agents as a separate read receipt and are not
 *   guaranteed to be present for every processed message.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { PendingReviewRequest, ReviewFleetWatcherDeps } from './watcher';
import type { ReviewerCapacity } from './roster';
import { defaultReviewFleetDeps } from './prod';
import type { ReviewFleetProdOpts } from './prod';

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Safely parse a JSON file.  Returns the parsed object on success or null on
 * any error (missing file, malformed JSON, non-object result).
 *
 * Callers are responsible for the console.warn so the log message can carry
 * useful context (file path).
 */
function tryParseJson(filePath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read all *.json files in a directory and return their parsed id fields.
 * Non-parseable files and files without an `id` string are silently skipped.
 * Returns an empty set when the directory does not exist.
 */
function readProcessedIds(processedDir: string): Set<string> {
  const ids = new Set<string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(processedDir);
  } catch {
    // Directory does not exist or is not readable — no processed ids.
    return ids;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) { continue; }
    const obj = tryParseJson(path.join(processedDir, entry));
    if (obj !== null && typeof obj['id'] === 'string' && obj['id'] !== '') {
      ids.add(obj['id'] as string);
    }
  }
  return ids;
}

/**
 * Scan one inbox directory and return all un-processed review_request messages
 * mapped to PendingReviewRequest.
 *
 * @param inboxDir  Absolute path to an inbox directory (shared/ or <agent>/).
 * @returns Array of PendingReviewRequest; empty array if the dir doesn't exist.
 */
async function scanInboxDir(inboxDir: string): Promise<PendingReviewRequest[]> {
  const processedDir = path.join(inboxDir, 'processed');
  const processedIds = readProcessedIds(processedDir);

  let entries: string[];
  try {
    entries = await fs.promises.readdir(inboxDir);
  } catch {
    // Missing or unreadable inbox → contributes nothing.
    return [];
  }

  const results: PendingReviewRequest[] = [];

  for (const entry of entries) {
    // Only process *.json files directly in the inbox (not subdirectory entries).
    if (!entry.endsWith('.json')) { continue; }

    const filePath = path.join(inboxDir, entry);

    // Skip directories (e.g. processed/, _state/) — readdirSync returns names only,
    // so we guard with a stat check.
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) { continue; }

    const obj = tryParseJson(filePath);
    if (obj === null) {
      console.warn(`[ReviewFleetInbox] skipping malformed JSON: ${filePath}`);
      continue;
    }

    // Keep only review_request messages.
    if (obj['type'] !== 'review_request') { continue; }

    // Must have a string id.
    const id = obj['id'];
    if (typeof id !== 'string' || id === '') {
      console.warn(`[ReviewFleetInbox] skipping message without id: ${filePath}`);
      continue;
    }

    // Skip if already processed.
    if (processedIds.has(id)) { continue; }

    // Extract taskId: top-level task_id first, then payload.task_id.
    const topTaskId = obj['task_id'];
    const payload = obj['payload'];
    const payloadTaskId =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)['task_id']
        : undefined;

    const taskId =
      typeof topTaskId === 'string' && topTaskId !== ''
        ? topTaskId
        : typeof payloadTaskId === 'string' && payloadTaskId !== ''
          ? payloadTaskId
          : '';

    // Extract optional scaffold and ctx from payload.
    let scaffold: PendingReviewRequest['scaffold'] | undefined;
    let ctx: PendingReviewRequest['ctx'] | undefined;

    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      const p = payload as Record<string, unknown>;
      if (p['scaffold'] !== undefined) {
        // We trust the caller to have put a valid ScaffoldVariant here.
        scaffold = p['scaffold'] as PendingReviewRequest['scaffold'];
      }
      if (p['ctx'] !== undefined) {
        ctx = p['ctx'] as PendingReviewRequest['ctx'];
      }
    }

    const req: PendingReviewRequest = { id, taskId };
    if (scaffold !== undefined) { req.scaffold = scaffold; }
    if (ctx !== undefined) { req.ctx = ctx; }

    results.push(req);
  }

  return results;
}

/* -------------------------------------------------------------------------- */
/*  Public: scanReviewRequests                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Scan the real comms inbox tree for unprocessed review_request messages.
 *
 * Reads from:
 *   - `<commsDir>/inboxes/shared/`            (always)
 *   - `<commsDir>/inboxes/<agentId>/`         (when agentId is given)
 *
 * Idempotency: skips any message whose `id` already appears in the sibling
 * `processed/` directory.
 *
 * Error handling:
 *   - Missing inbox dir → contributes nothing, no throw.
 *   - Malformed JSON file → console.warn + skip, no throw.
 *   - Any other per-file error → skip, no throw.
 */
export async function scanReviewRequests(opts: {
  commsDir: string;
  agentId?: string;
}): Promise<PendingReviewRequest[]> {
  const { commsDir, agentId } = opts;

  const sharedInbox = path.join(commsDir, 'inboxes', 'shared');
  const sharedResults = await scanInboxDir(sharedInbox);

  let agentResults: PendingReviewRequest[] = [];
  if (agentId && agentId !== '') {
    const agentInbox = path.join(commsDir, 'inboxes', agentId);
    agentResults = await scanInboxDir(agentInbox);
  }

  // Dedup by id in case the same message appears in both inboxes.
  const seen = new Set<string>();
  const combined: PendingReviewRequest[] = [];
  for (const req of [...sharedResults, ...agentResults]) {
    if (!seen.has(req.id)) {
      seen.add(req.id);
      combined.push(req);
    }
  }

  return combined;
}

/* -------------------------------------------------------------------------- */
/*  Public: markReviewRequestProcessed                                         */
/* -------------------------------------------------------------------------- */

/**
 * Move the inbox file for `id` into its `processed/` subdirectory.
 *
 * Searches both the shared inbox and the agent inbox (if agentId provided).
 * If no matching file is found, this is a no-op (idempotent — safe to call twice).
 * The `processed/` directory is created if it does not exist.
 *
 * Uses rename for atomicity.  Falls back silently if rename fails (e.g. the
 * file was already moved by a concurrent process — idempotent by design).
 */
export async function markReviewRequestProcessed(
  opts: { commsDir: string; agentId?: string },
  id: string,
): Promise<void> {
  const { commsDir, agentId } = opts;

  const inboxDirs: string[] = [
    path.join(commsDir, 'inboxes', 'shared'),
  ];
  if (agentId && agentId !== '') {
    inboxDirs.push(path.join(commsDir, 'inboxes', agentId));
  }

  for (const inboxDir of inboxDirs) {
    // List files in the inbox.
    let entries: string[];
    try {
      entries = await fs.promises.readdir(inboxDir);
    } catch {
      continue; // Inbox doesn't exist — nothing to move.
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) { continue; }

      const filePath = path.join(inboxDir, entry);

      // Skip non-files.
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) { continue; }

      const obj = tryParseJson(filePath);
      if (obj === null || obj['id'] !== id) { continue; }

      // Found the matching file — move it to processed/.
      const processedDir = path.join(inboxDir, 'processed');
      try {
        await fs.promises.mkdir(processedDir, { recursive: true });
      } catch {
        // mkdir failed — proceed to rename anyway (it may already exist).
      }

      const destPath = path.join(processedDir, entry);
      try {
        await fs.promises.rename(filePath, destPath);
      } catch {
        // File already moved or permission error — idempotent, no-op.
      }

      // Done — a message id appears in at most one inbox file.
      return;
    }
  }
  // No matching file found — idempotent no-op.
}

/* -------------------------------------------------------------------------- */
/*  Public: defaultReviewFleetWatcherDeps                                      */
/* -------------------------------------------------------------------------- */

/**
 * Single-call factory to wire the watcher against the real comms tree.
 *
 * The fleet remains dormant unless the caller passes `enabled: true` AND a
 * positive `budgetCents`.  Without those, `deps.dispatchReviewer` throws
 * (inherited from defaultReviewFleetDeps in prod.ts).
 *
 * @param opts.workspaceRoot  Absolute path to the workspace.
 * @param opts.roster         Reviewer roster (from buildReviewerRoster or tests).
 * @param opts.enabled        Master kill switch — defaults to FALSE.
 * @param opts.budgetCents    Spend ceiling in cents — defaults to 0.
 * @param opts.sessionId      Stamped on written vote files.
 * @param opts.agentId        Used to locate the agent-specific inbox.
 * @param opts.commsDir       Defaults to <workspaceRoot>/.autoclaw/orchestrator/comms.
 */
export function defaultReviewFleetWatcherDeps(opts: {
  workspaceRoot: string;
  roster: ReviewerCapacity[];
  enabled?: boolean;
  budgetCents?: number;
  sessionId?: string;
  agentId?: string;
  commsDir?: string;
}): ReviewFleetWatcherDeps {
  const commsDir =
    opts.commsDir ??
    path.join(opts.workspaceRoot, '.autoclaw', 'orchestrator', 'comms');

  const prodOpts: ReviewFleetProdOpts = {
    workspaceRoot: opts.workspaceRoot,
    roster: opts.roster,
    enabled: opts.enabled,
    budgetCents: opts.budgetCents,
    sessionId: opts.sessionId,
    commsDir,
  };

  return {
    deps: defaultReviewFleetDeps(prodOpts),
    scanPendingRequests: () =>
      scanReviewRequests({ commsDir, agentId: opts.agentId }),
    markProcessed: (id: string) =>
      markReviewRequestProcessed({ commsDir, agentId: opts.agentId }, id),
    now: () => new Date().toISOString(),
  };
}
