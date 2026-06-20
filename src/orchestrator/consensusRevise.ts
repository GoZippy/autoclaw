/**
 * consensusRevise.ts — a bounded revise/converge round for consensus.
 *
 * The base protocol does ONE review round and then finalizes: a panel that
 * comes back with `request_changes`/`reject` is written straight to
 * `resolved/` as a dissent verdict, and the author never gets an automatic
 * "respond to the dissent before we re-tally" step. This module adds that step,
 * bounded so it can never loop forever:
 *
 *   - {@link detectDissentAndRevise} — pure decision: given a resolved tally +
 *     the stub's current round, should we finalize, or ask the author to revise
 *     and run another round?
 *   - {@link emitRevisionRequest} — FS effect: drop a `revision_request` into the
 *     author's inbox, reset the stub for the next round (bump `round`, clear the
 *     prior votes), and remove the per-agent vote files so round N+1 collects
 *     fresh votes.
 *
 * Backward compatible: with `maxRounds === 1` (the default) the decision is
 * always `keep_resolved`, i.e. identical to the pre-existing one-round behavior.
 * The revise round only engages when a caller opts in with `maxRounds >= 2`.
 *
 * @see ./consensusTally (tallyConsensus / resolvePendingConsensus — the caller)
 * @see docs/AGENT_SESSION_PROTOCOL.md §5 (consensus)
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ConsensusStub, ConsensusVerdict, TallyVote } from './consensusTally';

const fsp = fs.promises;

/* -------------------------------------------------------------------------- */
/*  Pure decision                                                             */
/* -------------------------------------------------------------------------- */

export interface ReviseDecision {
  /** `keep_resolved` → finalize now; `emit_revision_request` → run another round. */
  action: 'keep_resolved' | 'emit_revision_request';
  /** The round the stub is currently in (1-based). */
  round: number;
  /** The round to move to, set only when emitting a revision request. */
  nextRound?: number;
  /** Machine-readable reason, surfaced in journals/tests. */
  reason: string;
}

/** The slice of a tally the decision needs (verdict + whether it resolved). */
export type ReviseTally = { status: 'pending' | 'resolved'; verdict?: ConsensusVerdict };

/**
 * Decide whether a resolved tally should finalize or trigger a revise round.
 *
 * `emit_revision_request` only when ALL of:
 *   - the tally actually resolved with a dissent verdict
 *     (`changes_requested` or `rejected`), and
 *   - the stub is below `maxRounds` (rounds remain).
 *
 * Everything else — an approval, a still-pending tally, or a dissent that has
 * already used its rounds — is `keep_resolved`. Pure; no I/O.
 */
export function detectDissentAndRevise(
  tally: ReviseTally,
  stub: Pick<ConsensusStub, 'round'>,
  opts?: { maxRounds?: number },
): ReviseDecision {
  const maxRounds = Math.max(1, Math.floor(opts?.maxRounds ?? 1));
  const round = Math.max(1, Math.floor(stub.round ?? 1));

  const isDissent =
    tally.status === 'resolved' &&
    (tally.verdict === 'changes_requested' || tally.verdict === 'rejected');

  if (!isDissent) {
    return {
      action: 'keep_resolved',
      round,
      reason: tally.status === 'resolved' ? `verdict_${tally.verdict}` : 'pending',
    };
  }
  if (round >= maxRounds) {
    return { action: 'keep_resolved', round, reason: `max_rounds_${maxRounds}_reached` };
  }
  return {
    action: 'emit_revision_request',
    round,
    nextRound: round + 1,
    reason: `dissent_${tally.verdict}_round_${round}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  FS effect                                                                 */
/* -------------------------------------------------------------------------- */

function activeDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'consensus', 'active');
}
function inboxDir(workspaceRoot: string, agent: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'inboxes', agent);
}

export interface EmitRevisionOptions {
  workspaceRoot: string;
  /** The active stub being revised (needs `task_id`, `author`, `sprint`, …). */
  stub: ConsensusStub;
  /** The dissenting feedback the author should address (counted votes). */
  votes: TallyVote[];
  /** Round to advance to (from {@link detectDissentAndRevise}). */
  nextRound: number;
  /** Deterministic clock for tests. */
  now?: Date;
  /** Sender id stamped on the message. Default `orchestrator-loop`. */
  from?: string;
}

export interface EmitRevisionResult {
  /** Path of the revision_request message written, when an author existed. */
  messageFile?: string;
  /** True when the active stub was reset for the next round. */
  stubReset: boolean;
}

/**
 * Ask the author to respond to dissent and prepare a fresh round:
 *   1. write a `revision_request` message to the author's inbox (carrying the
 *      dissenting votes + comments so they know what to address),
 *   2. rewrite the active stub with `round = nextRound`, a `revision_requested_at`
 *      stamp, and an empty `votes[]`, and
 *   3. delete the per-agent `<task>-<voter>.json` vote files so the next round
 *      starts from zero.
 *
 * Best-effort and self-contained. Returns without writing a message when the
 * stub has no `author` to ask (the caller should finalize instead).
 */
export async function emitRevisionRequest(opts: EmitRevisionOptions): Promise<EmitRevisionResult> {
  const now = opts.now ?? new Date();
  const from = opts.from ?? 'orchestrator-loop';
  const stub = opts.stub;
  const taskId = stub.task_id;
  const author = stub.author;

  const out: EmitRevisionResult = { stubReset: false };
  if (!author) { return out; }

  const iso = now.toISOString();
  const message = {
    id: `msg-revision-${path.basename(taskId)}-r${opts.nextRound}`,
    from,
    to: author,
    type: 'revision_request',
    timestamp: iso,
    sprint: stub.sprint,
    task_id: taskId,
    requires_response: true,
    payload: {
      reason: 'dissent_in_consensus',
      round: opts.nextRound,
      source_task_complete_id: stub.source_task_complete_id,
      dissent_votes: opts.votes.filter(v => v.vote === 'request_changes' || v.vote === 'reject'),
      instructions:
        'Reviewers requested changes or rejected this work. Address each ' +
        'dissenting comment above (revise the work or reply), then re-broadcast ' +
        'task_complete so reviewers re-vote in the next round.',
    },
  };

  const inbox = inboxDir(opts.workspaceRoot, author);
  await fsp.mkdir(inbox, { recursive: true });
  const safeStamp = iso.replace(/[:.]/g, '-');
  const messageFile = path.join(inbox, `${safeStamp}-revision_request-${from}-${path.basename(taskId)}.json`);
  await fsp.writeFile(messageFile, JSON.stringify(message, null, 2) + '\n', 'utf8');
  out.messageFile = messageFile;

  // Reset the stub for the next round: bump round, stamp, clear votes.
  const aDir = activeDir(opts.workspaceRoot);
  const resetStub: ConsensusStub & { revision_requested_at?: string } = {
    ...stub,
    round: opts.nextRound,
    votes: [],
    revision_requested_at: iso,
  };
  const stubPath = path.join(aDir, `${path.basename(taskId)}.json`);
  await fsp.writeFile(stubPath, JSON.stringify(resetStub, null, 2) + '\n', 'utf8');
  out.stubReset = true;

  // Drop per-agent vote files for this task so the next round starts fresh.
  try {
    const names = await fsp.readdir(aDir);
    const prefix = `${path.basename(taskId)}-`;
    await Promise.all(
      names
        .filter(n => n.startsWith(prefix) && n.endsWith('.json'))
        .map(n => fsp.unlink(path.join(aDir, n)).catch(() => undefined)),
    );
  } catch {
    /* best-effort — a missing dir or unreadable entry must not break the round */
  }

  return out;
}
