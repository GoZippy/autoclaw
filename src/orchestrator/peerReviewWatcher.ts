/**
 * peerReviewWatcher.ts — Find new `task_complete` messages and auto-promote
 * each one into per-peer `review_request`s plus a `consensus/active/` stub.
 *
 * Idempotent: a "promotion ledger" file at
 * `consensus/_promoted/<msg-id>.json` is created with `wx` (fail-if-exists)
 * before sending anything. If the file already exists, the message has been
 * promoted already and we skip it. This means re-running the watcher on the
 * same tick or restarting the extension never double-fires reviews.
 *
 * @see ./peerReview for the pure builders this module calls.
 * @see docs/AGENT_SESSION_PROTOCOL.md §3 (REPORT)
 */

import * as fs from 'fs';
import * as path from 'path';

import type { Heartbeat } from '../comms';
import {
  buildConsensusStub,
  buildReviewRequest,
  computeReviewers,
  reviewRequestFilename,
  type ReviewerCandidate,
  type TaskCompleteLike,
} from './peerReview';
import { quorumRuleForPersona } from './reviewSla';
import { agentTypeForPersona } from '../fabric/agentTypes';

const fsp = fs.promises;

/* -------------------------------------------------------------------------- */
/*  Path helpers                                                              */
/* -------------------------------------------------------------------------- */

function commsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
}

function sharedInbox(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'inboxes', 'shared');
}

function heartbeatsDir(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'heartbeats');
}

function registryPath(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'registry.json');
}

function consensusActiveDir(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'consensus', 'active');
}

function promotedLedgerDir(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'consensus', '_promoted');
}

function inboxFor(workspaceRoot: string, agentId: string): string {
  return path.join(commsDir(workspaceRoot), 'inboxes', path.basename(agentId));
}

/* -------------------------------------------------------------------------- */
/*  Read helpers                                                              */
/* -------------------------------------------------------------------------- */

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as T;
  } catch { return null; }
}

async function listDir(dir: string): Promise<string[]> {
  try { return await fsp.readdir(dir); } catch { return []; }
}

/** Find every `task_complete` in shared/ and shared/processed/ (de-duped by msg.id). */
async function readSharedTaskCompletes(workspaceRoot: string): Promise<TaskCompleteLike[]> {
  const root = sharedInbox(workspaceRoot);
  const out: TaskCompleteLike[] = [];
  const seen = new Set<string>();
  for (const sub of ['', 'processed']) {
    const dir = sub ? path.join(root, sub) : root;
    const names = await listDir(dir);
    for (const name of names) {
      if (!name.endsWith('.json')) { continue; }
      const msg = await readJsonIfExists<TaskCompleteLike>(path.join(dir, name));
      if (!msg?.id || msg.type !== 'task_complete') { continue; }
      if (seen.has(msg.id)) { continue; }
      seen.add(msg.id);
      out.push(msg);
    }
  }
  return out;
}

/** Read registry + heartbeats and build the reviewer candidate pool. */
async function readReviewerPool(workspaceRoot: string): Promise<ReviewerCandidate[]> {
  const reg = await readJsonIfExists<{ agents?: Array<{ id: string; agent_type?: string }> }>(registryPath(workspaceRoot));
  const ids = new Set<string>();
  const typeById = new Map<string, string>();
  for (const a of reg?.agents ?? []) {
    if (typeof a?.id === 'string' && a.id.length > 0) {
      ids.add(a.id);
      if (typeof a.agent_type === 'string') { typeById.set(a.id, a.agent_type); }
    }
  }

  // Also pull from heartbeat filenames so an agent that wrote a heartbeat
  // but isn't in the registry yet still counts.
  const hbDir = heartbeatsDir(workspaceRoot);
  const hbFiles = await listDir(hbDir);
  const hbByAgent = new Map<string, Heartbeat>();
  for (const fn of hbFiles) {
    if (!fn.endsWith('.json')) { continue; }
    const stem = fn.slice(0, -5);
    // Skip session sidecars: those have more dash-separated segments than the agent id
    if (stem.split('-').length > 2) { continue; }
    const hb = await readJsonIfExists<Heartbeat>(path.join(hbDir, fn));
    if (!hb?.agent_id || !hb.timestamp) { continue; }
    ids.add(hb.agent_id);
    // Keep the freshest if duplicates.
    const prev = hbByAgent.get(hb.agent_id);
    if (!prev || new Date(hb.timestamp).getTime() > new Date(prev.timestamp).getTime()) {
      hbByAgent.set(hb.agent_id, hb);
    }
  }

  const out: ReviewerCandidate[] = [];
  for (const id of ids) {
    const hb = hbByAgent.get(id) ?? null;
    out.push({
      agent_id: id,
      last_heartbeat_at: hb?.timestamp ?? null,
      status: (hb?.status as ReviewerCandidate['status']) ?? 'unknown',
      ...(typeById.has(id) ? { agent_type: typeById.get(id) } : {}),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Promotion                                                                 */
/* -------------------------------------------------------------------------- */

/** Outcome of a single watcher run. */
export interface PromotionResult {
  /** task_complete messages found in shared/. */
  taskCompletesSeen: number;
  /** task_complete messages newly promoted to peer reviews this tick. */
  promoted: number;
  /** task_complete messages skipped because no eligible peer was online. */
  skippedNoPeers: number;
  /** task_complete messages skipped because already promoted previously. */
  skippedAlreadyPromoted: number;
  /** Per-promoted detail. */
  promotions: Array<{
    sourceMessageId: string;
    taskId: string | undefined;
    author: string;
    reviewers: string[];
  }>;
}

/** Options for {@link promotePendingTaskCompletes}. */
export interface PromotePendingOptions {
  /** Workspace root containing `.autoclaw/`. */
  workspaceRoot: string;
  /** Who the promoted `review_request` claims to be from. Default `orchestrator`. */
  fromAgent?: string;
  /** Optional review deadline in ms (added to `payload.deadline_iso`). */
  reviewDeadlineMs?: number;
  /** Clock for deterministic tests. */
  now?: Date;
  /** Override the reviewer pool — used by tests to skip FS reads. */
  reviewerPoolOverride?: ReviewerCandidate[];
  /** Override the task_complete pool — used by tests. */
  taskCompletesOverride?: TaskCompleteLike[];
}

/**
 * Scan `shared/` for `task_complete` messages, and for each one we haven't
 * promoted yet, write per-peer `review_request`s + a `consensus/active/` stub.
 *
 * Atomic ledger pattern: we open `consensus/_promoted/<msg-id>.json` with
 * `wx` (exclusive create) before doing anything. If that fails with EEXIST,
 * another tick already promoted this message — we skip it and move on.
 */
export async function promotePendingTaskCompletes(
  opts: PromotePendingOptions,
): Promise<PromotionResult> {
  const { workspaceRoot } = opts;
  const fromAgent = opts.fromAgent ?? 'orchestrator';
  const now = opts.now ?? new Date();

  const result: PromotionResult = {
    taskCompletesSeen: 0,
    promoted: 0,
    skippedNoPeers: 0,
    skippedAlreadyPromoted: 0,
    promotions: [],
  };

  const taskCompletes = opts.taskCompletesOverride
    ?? await readSharedTaskCompletes(workspaceRoot);
  result.taskCompletesSeen = taskCompletes.length;
  if (taskCompletes.length === 0) { return result; }

  const pool = opts.reviewerPoolOverride
    ?? await readReviewerPool(workspaceRoot);

  await fsp.mkdir(promotedLedgerDir(workspaceRoot), { recursive: true });
  await fsp.mkdir(consensusActiveDir(workspaceRoot), { recursive: true });

  for (const tc of taskCompletes) {
    const ledgerPath = path.join(promotedLedgerDir(workspaceRoot), `${tc.id}.json`);

    // Atomic claim of the ledger slot. If we lose, another run already promoted.
    let ledgerFd: fs.promises.FileHandle | null = null;
    try {
      ledgerFd = await fsp.open(ledgerPath, 'wx');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        result.skippedAlreadyPromoted++;
        continue;
      }
      throw err;
    }

    let reviewers = computeReviewers(tc.from, pool, { now: now.getTime() });
    if (reviewers.length === 0) {
      // No eligible peers right now — release the ledger so a future tick can retry.
      await ledgerFd.close();
      await fsp.unlink(ledgerPath).catch(() => undefined);
      result.skippedNoPeers++;
      continue;
    }

    // AF-8 §1+§2: derive the consensus rule + route security reviews to auditors.
    const personaId = typeof tc.payload?.persona_id === 'string' ? tc.payload.persona_id : undefined;
    const rule = quorumRuleForPersona(personaId);
    if (agentTypeForPersona(personaId) === 'auditor') {
      // Prefer live auditors, but never stall a review if none are online.
      const auditorReviewers = computeReviewers(
        tc.from,
        pool.filter(c => c.agent_type === 'auditor'),
        { now: now.getTime() },
      );
      if (auditorReviewers.length > 0) { reviewers = auditorReviewers; }
    }

    // Write the consensus stub first so the vote-collection target exists
    // before any reviewer sees the request.
    const stub = buildConsensusStub(tc, reviewers, { now, rule });
    const stubPath = path.join(consensusActiveDir(workspaceRoot), `${stub.task_id}.json`);
    await fsp.writeFile(stubPath, JSON.stringify(stub, null, 2), 'utf8');

    // Deliver per-peer review_request messages.
    for (const reviewer of reviewers) {
      const msg = buildReviewRequest(tc, reviewer, {
        from: fromAgent,
        now,
        deadlineMs: opts.reviewDeadlineMs,
      });
      const inbox = inboxFor(workspaceRoot, reviewer);
      await fsp.mkdir(inbox, { recursive: true });
      await fsp.writeFile(
        path.join(inbox, reviewRequestFilename(msg)),
        JSON.stringify(msg, null, 2),
        'utf8',
      );
    }

    // Commit the ledger with detail so an operator can see what happened.
    const ledgerBody = {
      source_task_complete_id: tc.id,
      task_id: tc.task_id ?? null,
      author: tc.from,
      promoted_at: now.toISOString(),
      promoted_by: fromAgent,
      reviewers,
    };
    await ledgerFd.writeFile(JSON.stringify(ledgerBody, null, 2), 'utf8');
    await ledgerFd.close();

    result.promoted++;
    result.promotions.push({
      sourceMessageId: tc.id,
      taskId: tc.task_id,
      author: tc.from,
      reviewers,
    });
  }

  return result;
}
