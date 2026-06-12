/**
 * peerReview.ts — Auto-promote `task_complete` into peer `review_request`s.
 *
 * Pure module. Given a `task_complete` message and a snapshot of the agent
 * registry plus heartbeat freshness, decide which peers should review, build
 * the per-peer `review_request` messages, and build the `consensus/active/`
 * vote stub. No filesystem I/O — see {@link ../orchestrator/peerReviewWatcher}
 * for the watcher that consumes these helpers.
 *
 * Rationale: §3 of `docs/AGENT_SESSION_PROTOCOL.md` says agents SHOULD emit a
 * `review_request` after `task_complete`. In practice they often don't (model
 * drops the rule, session compacts, etc.), so the orchestrator promotes it on
 * their behalf. With this in place, the DRK-style "agent A → user copy/paste
 * → agent B" consensus loop becomes hands-off.
 *
 * @see docs/AGENT_SESSION_PROTOCOL.md §3 (REPORT), §5 (consensus)
 */

import * as crypto from 'crypto';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Heartbeat older than this is dropped from the reviewer pool. */
export const REVIEWER_LIVENESS_MS = 5 * 60_000;

/** Cap on reviewers per task — keeps inbox noise bounded on big fleets. */
export const MAX_REVIEWERS_PER_TASK = 3;

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/** What we need to know about an agent to decide if it can review. */
export interface ReviewerCandidate {
  /** Agent id ("claude-code", "kilocode", …). */
  agent_id: string;
  /** ISO timestamp of the agent's most recent heartbeat, or null if none. */
  last_heartbeat_at: string | null;
  /** Heartbeat-derived status. Halted / offline agents are skipped. */
  status?: 'active' | 'idle' | 'offline' | 'stalled' | 'overloaded' | 'halted' | 'unknown';
  /** When true, agent has opted out of being a reviewer (e.g. human-in-loop). */
  opt_out?: boolean;
  /** Fabric agent type (AF-8). Absent ⇒ 'coder'. Routes security reviews to auditors. */
  agent_type?: string;
}

/** Minimal shape of a `task_complete` we read from the shared inbox. */
export interface TaskCompleteLike {
  id: string;
  from: string;
  type: 'task_complete' | string;
  task_id?: string;
  sprint?: number;
  timestamp: string;
  payload?: Record<string, unknown>;
}

/** A peer `review_request` message ready to be written to `inboxes/<peer>/`. */
export interface ReviewRequestMessage {
  id: string;
  from: string;
  to: string;
  type: 'review_request';
  timestamp: string;
  sprint?: number;
  task_id?: string;
  requires_response: true;
  payload: {
    author: string;
    source_task_complete_id: string;
    reason: 'auto_promoted';
    review_policy: 'peer';
    deadline_iso?: string;
  };
}

/** The vote-collection stub written to `consensus/active/<task_id>.json`. */
export interface ConsensusActiveStub {
  task_id: string;
  sprint?: number;
  author: string;
  opened_at: string;
  reviewers: string[];
  rule: 'majority' | 'unanimous';
  votes: Array<{ voter: string; vote: 'approve' | 'request_changes' | 'reject'; timestamp: string; comments?: string }>;
  source_task_complete_id: string;
  status: 'open';
}

/** Options for {@link computeReviewers}. */
export interface ComputeReviewersOptions {
  /** Maximum reviewers to pick. Defaults to {@link MAX_REVIEWERS_PER_TASK}. */
  maxReviewers?: number;
  /** Reviewer-liveness window in ms. Defaults to {@link REVIEWER_LIVENESS_MS}. */
  livenessMs?: number;
  /** Clock for deterministic tests. */
  now?: number;
}

/* -------------------------------------------------------------------------- */
/*  computeReviewers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Pick the peers that should review this `task_complete`.
 *
 * Filters out: the author, opted-out agents, halted/offline agents, agents
 * with a stale heartbeat. Sorts deterministically by agent_id so two
 * orchestrator processes seeing the same fleet pick the same reviewers.
 *
 * Returns at most `maxReviewers` candidates. An empty list means "no peers
 * available right now" — the caller should leave the `task_complete` in the
 * pending pool and retry on the next tick (a new agent may have come online).
 */
export function computeReviewers(
  authorId: string,
  candidates: ReviewerCandidate[],
  opts: ComputeReviewersOptions = {},
): string[] {
  const now = opts.now ?? Date.now();
  const livenessMs = opts.livenessMs ?? REVIEWER_LIVENESS_MS;
  const maxReviewers = opts.maxReviewers ?? MAX_REVIEWERS_PER_TASK;

  const eligible: string[] = [];
  for (const c of candidates) {
    if (!c?.agent_id) { continue; }
    if (c.agent_id === authorId) { continue; }
    if (c.opt_out) { continue; }
    if (c.status === 'halted' || c.status === 'offline') { continue; }
    if (!c.last_heartbeat_at) { continue; }
    const age = now - new Date(c.last_heartbeat_at).getTime();
    if (!Number.isFinite(age) || age >= livenessMs) { continue; }
    eligible.push(c.agent_id);
  }

  eligible.sort();
  return eligible.slice(0, Math.max(0, maxReviewers));
}

/* -------------------------------------------------------------------------- */
/*  buildReviewRequest                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build a `review_request` message addressed to `reviewer` for the given
 * `task_complete`. The caller writes the result to
 * `inboxes/<reviewer>/<filename>.json` (use
 * {@link reviewRequestFilename} for the filename).
 */
export function buildReviewRequest(
  taskComplete: TaskCompleteLike,
  reviewer: string,
  opts: {
    from?: string;
    now?: Date;
    deadlineMs?: number;
  } = {},
): ReviewRequestMessage {
  const now = opts.now ?? new Date();
  const from = opts.from ?? 'orchestrator';
  const deadlineIso = opts.deadlineMs !== undefined
    ? new Date(now.getTime() + opts.deadlineMs).toISOString()
    : undefined;

  return {
    id: `msg-${crypto.randomUUID()}`,
    from,
    to: reviewer,
    type: 'review_request',
    timestamp: now.toISOString(),
    sprint: taskComplete.sprint,
    task_id: taskComplete.task_id,
    requires_response: true,
    payload: {
      author: taskComplete.from,
      source_task_complete_id: taskComplete.id,
      reason: 'auto_promoted',
      review_policy: 'peer',
      ...(deadlineIso ? { deadline_iso: deadlineIso } : {}),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  buildConsensusStub                                                        */
/* -------------------------------------------------------------------------- */

/** Build the `consensus/active/<task_id>.json` vote-collection stub. */
export function buildConsensusStub(
  taskComplete: TaskCompleteLike,
  reviewers: string[],
  opts: { now?: Date; rule?: 'majority' | 'unanimous' } = {},
): ConsensusActiveStub {
  const now = opts.now ?? new Date();
  return {
    task_id: taskComplete.task_id ?? `unknown-${taskComplete.id.slice(-8)}`,
    sprint: taskComplete.sprint,
    author: taskComplete.from,
    opened_at: now.toISOString(),
    reviewers: [...reviewers].sort(),
    rule: opts.rule ?? 'majority',
    votes: [],
    source_task_complete_id: taskComplete.id,
    status: 'open',
  };
}

/* -------------------------------------------------------------------------- */
/*  Filename helper                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build the filename for a `review_request` written to `inboxes/<peer>/`.
 * Matches the protocol's format: ISO-with-millis + type + sender + msg-id-frag.
 * `:` and `.` are replaced with `-` for filesystem safety.
 */
export function reviewRequestFilename(msg: ReviewRequestMessage): string {
  const ts = msg.timestamp.replace(/[:.]/g, '-');
  return `${ts}-review_request-${msg.from}-${msg.id.slice(-8)}.json`;
}
