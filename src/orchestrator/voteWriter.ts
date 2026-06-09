/**
 * voteWriter.ts — RV-1 (integrate-automate-v3.2, Lane A).
 *
 * Writes a single consensus vote file when the panel's review-decision UI
 * fires a `castVote` message. Before v3.2 the Approve / Request changes /
 * Reject buttons posted `castVote` but extension.ts had no handler, so the
 * buttons were no-ops. This module is the durable end of that round trip.
 *
 * The file shape matches the cross-agent protocol and the existing
 * per-agent vote files under comms/consensus/active/:
 *
 *   { voter, session_id, task_id, vote, timestamp, comments }
 *
 * Ownership rule (protocol Hard Rule #3): an agent only ever writes its OWN
 * vote file, `<task_id>-<voter>.json`. A re-vote overwrites that same file
 * and never another agent's. The file name is sanitised so a task id can't
 * escape the consensus/active/ directory.
 *
 * Kept free of any `vscode` import so it is unit-testable in isolation.
 */

import * as fs from 'fs';
import * as path from 'path';

const fsp = fs.promises;

/** The three valid consensus votes (protocol §Consensus). */
export const VALID_VOTES = ['approve', 'request_changes', 'reject'] as const;
export type ConsensusVote = (typeof VALID_VOTES)[number];

export interface CastVoteInput {
  /** Consensus directory: `<commsDir>/consensus/active`. */
  consensusActiveDir: string;
  /** The task being voted on. */
  taskId: string;
  /** The voting agent (the host agent id). */
  voter: string;
  /** The voter's session_id (stamped per protocol). */
  sessionId: string;
  /** One of VALID_VOTES. Rejected otherwise. */
  vote: string;
  /** Free-text justification; defaults to ''. */
  comment?: string;
  /** Override timestamp (tests); defaults to now. */
  timestamp?: string;
}

export interface CastVoteResult {
  ok: boolean;
  /** Absolute path of the vote file written (when ok). */
  file?: string;
  /** The normalised vote object written (when ok). */
  vote?: ConsensusVoteRecord;
  /** Reason when !ok. */
  error?: string;
}

export interface ConsensusVoteRecord {
  voter: string;
  session_id: string;
  task_id: string;
  vote: ConsensusVote;
  timestamp: string;
  comments: string;
}

/** True when `v` is one of the three protocol-valid votes. */
export function isValidVote(v: string): v is ConsensusVote {
  return (VALID_VOTES as readonly string[]).includes(v);
}

/**
 * Sanitise a task id (or voter) into a safe single path segment. Strips any
 * directory separators and `..` so a crafted task id can't write outside
 * consensus/active/. Mirrors the real ids in the tree (e.g. `A3,A6,A7`,
 * `C5_statusbar`) — commas, dots and underscores are kept; slashes are not.
 */
export function sanitizeSegment(raw: string): string {
  return raw
    .replace(/[\\/]/g, '_')   // no directory separators
    .replace(/\.\.+/g, '_')   // no parent-dir traversal
    .replace(/_+/g, '_')      // collapse the runs the two steps above can create
    .trim();
}

/**
 * Write the voter's consensus vote file. Create-or-overwrite, but only ever
 * the voter's own `<task>-<voter>.json` file — idempotent re-votes are
 * expected (a reviewer can change their mind). Returns a tagged result
 * rather than throwing so the caller can surface a friendly toast.
 */
export async function writeConsensusVote(input: CastVoteInput): Promise<CastVoteResult> {
  const taskId = (input.taskId ?? '').trim();
  const voter = (input.voter ?? '').trim();
  if (!taskId) { return { ok: false, error: 'missing task_id' }; }
  if (!voter) { return { ok: false, error: 'missing voter' }; }
  if (!isValidVote(input.vote)) {
    return { ok: false, error: `invalid vote '${input.vote}' (expected ${VALID_VOTES.join(' | ')})` };
  }

  const record: ConsensusVoteRecord = {
    voter,
    session_id: input.sessionId ?? '',
    task_id: taskId,
    vote: input.vote,
    timestamp: input.timestamp ?? new Date().toISOString(),
    comments: input.comment ?? '',
  };

  const fileName = `${sanitizeSegment(taskId)}-${sanitizeSegment(voter)}.json`;
  const dir = path.resolve(input.consensusActiveDir);
  const file = path.resolve(dir, fileName);

  // Defence in depth: even though sanitizeSegment strips separators and `..`,
  // verify the resolved path is a direct child of the consensus dir before we
  // ever touch the filesystem. A vote file is always `<dir>/<name>.json`.
  if (path.dirname(file) !== dir) {
    return { ok: false, error: 'refusing to write outside the consensus directory' };
  }

  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return { ok: true, file, vote: record };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
