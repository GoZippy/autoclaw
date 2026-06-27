/**
 * consensusTally.ts — Close the consensus loop.
 *
 * The peer-review watcher OPENS a `consensus/active/<task_id>.json` stub and
 * sends `review_request`s, but until now nothing tallied the votes back: votes
 * landed (embedded in the stub's `votes[]` and/or as per-agent
 * `<task_id>-<voter>.json` files from the panel's castVote handler) and just
 * sat there. An operator had to hand-write the `resolved/` record.
 *
 * This module is the missing tally. It is split pure-core + FS-runner, mirroring
 * peerReview.ts / peerReviewWatcher.ts:
 *   - {@link tallyConsensus} — pure decision over a stub + its votes.
 *   - {@link resolvePendingConsensus} — reads `active/`, applies the tally, and
 *     for every DECIDED task writes `resolved/<task_id>.json`, then clears the
 *     active stub + per-agent vote files. Idempotent and safe to run each tick.
 *
 * Rule (protocol §Consensus): 2/3 majority approval for tasks; UNANIMOUS for
 * security findings. The stub carries `rule: 'majority' | 'unanimous'`.
 *
 * @see ./peerReview (buildConsensusStub — the producer of the stubs read here)
 * @see ./voteWriter (the per-agent vote-file shape this reconciles)
 * @see docs/AGENT_SESSION_PROTOCOL.md §5 (consensus)
 */

import * as fs from 'fs';
import * as path from 'path';

import { detectDissentAndRevise, emitRevisionRequest } from './consensusRevise';

const fsp = fs.promises;

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type ProtocolVote = 'approve' | 'request_changes' | 'reject';
export type ConsensusRule = 'majority' | 'unanimous';
export type ConsensusVerdict = 'approved' | 'changes_requested' | 'rejected';

/** A single vote, normalised from either the stub array or a per-agent file. */
export interface TallyVote {
  voter: string;
  vote: ProtocolVote;
  timestamp?: string;
  comments?: string;
}

/** The `consensus/active/<task_id>.json` stub shape we tally (superset of buildConsensusStub). */
export interface ConsensusStub {
  task_id: string;
  sprint?: number;
  author?: string;
  opened_at?: string;
  reviewers?: string[];
  rule?: ConsensusRule;
  votes?: TallyVote[];
  source_task_complete_id?: string;
  status?: string;
  /** Review round (1-based). Bumped by the revise/converge loop on dissent. */
  round?: number;
  /** Set by peerReviewWatcher when the completing agent omitted a handoff note (§3.3). */
  missing_handoff_note?: boolean;
}

export interface TallyResult {
  task_id: string;
  /** 'pending' = not enough votes to decide yet; 'resolved' = decided. */
  status: 'pending' | 'resolved';
  rule: ConsensusRule;
  /** Set only when status === 'resolved'. */
  verdict?: ConsensusVerdict;
  reviewers: string[];
  /** Distinct counted votes (latest per voter, restricted to the panel). */
  approvals: number;
  changes: number;
  rejects: number;
  votesCast: number;
  /** Panel size used as the threshold denominator. */
  panelSize: number;
  /** Approvals needed to pass under the rule. */
  required: number;
  votes: TallyVote[];
}

/* -------------------------------------------------------------------------- */
/*  Pure tally                                                                */
/* -------------------------------------------------------------------------- */

/** Approvals required to pass: all of the panel when unanimous, else ceil(2/3). */
export function requiredApprovals(panelSize: number, rule: ConsensusRule): number {
  if (panelSize <= 0) { return 0; }
  return rule === 'unanimous' ? panelSize : Math.ceil((panelSize * 2) / 3);
}

/** Dedup votes to the latest per voter (a reviewer may change their mind). */
export function dedupeLatest(votes: TallyVote[]): TallyVote[] {
  const byVoter = new Map<string, TallyVote>();
  for (const v of votes) {
    if (!v?.voter || !v?.vote) { continue; }
    const prev = byVoter.get(v.voter);
    if (!prev) { byVoter.set(v.voter, v); continue; }
    const a = v.timestamp ? Date.parse(v.timestamp) : NaN;
    const b = prev.timestamp ? Date.parse(prev.timestamp) : NaN;
    // Later timestamp wins; if either is unparseable, the newer-seen one wins.
    if (!Number.isFinite(b) || (Number.isFinite(a) && a >= b)) { byVoter.set(v.voter, v); }
  }
  return [...byVoter.values()];
}

/**
 * Decide a single consensus task from its stub + votes. Pure — no I/O.
 *
 * A decision is reached as soon as it is mathematically certain:
 *   - APPROVED when approvals ≥ required.
 *   - DECIDED-AGAINST when the remaining unvoted panel members can no longer
 *     lift approvals to `required` (can't pass), OR the whole panel has voted
 *     and the bar wasn't met. Verdict is `rejected` if anyone rejected,
 *     otherwise `changes_requested`.
 *   - PENDING otherwise.
 */
export function tallyConsensus(stub: ConsensusStub, extraVotes: TallyVote[] = []): TallyResult {
  const rule: ConsensusRule = stub.rule === 'unanimous' ? 'unanimous' : 'majority';
  const reviewers = Array.isArray(stub.reviewers) ? stub.reviewers.filter(Boolean) : [];

  const all = dedupeLatest([...(stub.votes ?? []), ...extraVotes]);
  // Count only votes from declared reviewers when a panel is known; otherwise
  // (legacy stubs with no reviewers) count every distinct voter.
  const counted = reviewers.length > 0 ? all.filter(v => reviewers.includes(v.voter)) : all;

  const panelSize = reviewers.length > 0 ? reviewers.length : counted.length;
  const approvals = counted.filter(v => v.vote === 'approve').length;
  const changes = counted.filter(v => v.vote === 'request_changes').length;
  const rejects = counted.filter(v => v.vote === 'reject').length;
  const votesCast = counted.length;
  const required = requiredApprovals(panelSize, rule);

  const base: TallyResult = {
    task_id: stub.task_id,
    status: 'pending',
    rule, verdict: undefined,
    reviewers, approvals, changes, rejects, votesCast, panelSize, required,
    votes: counted,
  };

  if (panelSize === 0) { return base; }

  if (approvals >= required && required > 0) {
    return { ...base, status: 'resolved', verdict: 'approved' };
  }

  const maxPossibleApprovals = approvals + Math.max(0, panelSize - votesCast);
  const cannotPass = maxPossibleApprovals < required;
  const panelComplete = votesCast >= panelSize;
  if (cannotPass || panelComplete) {
    return { ...base, status: 'resolved', verdict: rejects > 0 ? 'rejected' : 'changes_requested' };
  }

  return base;
}

/* -------------------------------------------------------------------------- */
/*  Path helpers                                                              */
/* -------------------------------------------------------------------------- */

function commsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
}
function activeDir(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'consensus', 'active');
}
function resolvedDir(workspaceRoot: string): string {
  return path.join(commsDir(workspaceRoot), 'consensus', 'resolved');
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try { return JSON.parse((await fsp.readFile(filePath, 'utf8')).replace(/^﻿/, '')) as T; }
  catch { return null; }
}
async function listJson(dir: string): Promise<string[]> {
  try { return (await fsp.readdir(dir)).filter(n => n.endsWith('.json')); }
  catch { return []; }
}

/* -------------------------------------------------------------------------- */
/*  FS runner                                                                 */
/* -------------------------------------------------------------------------- */

export interface ResolveConsensusResult {
  /** Stubs examined this run. */
  scanned: number;
  /** Tasks newly resolved this run. */
  resolved: Array<{ task_id: string; verdict: ConsensusVerdict; approvals: number; panelSize: number; rule: ConsensusRule }>;
  /** Tasks still waiting on votes. */
  pending: string[];
  /** Tasks that got a revise/converge request this run (kept open for re-vote). */
  revised: Array<{ task_id: string; round: number }>;
}

export interface ResolveConsensusOptions {
  workspaceRoot: string;
  /** Stamped on the resolved record + used for deterministic tests. */
  now?: Date;
  /** Who closed the gate. Default 'orchestrator-loop'. */
  resolvedBy?: string;
  /**
   * Max review rounds before a dissent verdict is finalized. Default 1 = the
   * original one-round behavior (finalize on first dissent). Set ≥ 2 to enable
   * the revise/converge loop: on dissent, the author is asked to respond and the
   * panel re-votes, up to this many rounds total.
   */
  reviseMaxRounds?: number;
}

/**
 * Tally every open stub under `consensus/active/`, and for each DECIDED task:
 *   1. write `consensus/resolved/<task_id>.json` (the durable verdict record),
 *   2. delete the active stub + any per-agent `<task_id>-<voter>.json` vote files.
 *
 * Idempotent: a task already present under `resolved/` is skipped (and its stale
 * active stub cleared). Per-task failures are isolated — one bad stub never
 * aborts the sweep.
 */
export async function resolvePendingConsensus(opts: ResolveConsensusOptions): Promise<ResolveConsensusResult> {
  const { workspaceRoot } = opts;
  const now = opts.now ?? new Date();
  const resolvedBy = opts.resolvedBy ?? 'orchestrator-loop';
  const reviseMaxRounds = Math.max(1, Math.floor(opts.reviseMaxRounds ?? 1));
  const result: ResolveConsensusResult = { scanned: 0, resolved: [], pending: [], revised: [] };

  const aDir = activeDir(workspaceRoot);
  const rDir = resolvedDir(workspaceRoot);
  const names = await listJson(aDir);
  if (names.length === 0) { return result; }

  // Per-agent vote files are `<task>-<voter>.json`; the stub is `<task>.json`.
  // Read every file once, then group the per-agent ones by their stub task_id.
  const stubs: Array<{ file: string; stub: ConsensusStub }> = [];
  const perAgent: Array<{ file: string; vote: TallyVote & { task_id?: string } }> = [];
  for (const name of names) {
    const obj = await readJson<ConsensusStub & { vote?: ProtocolVote; task_id?: string }>(path.join(aDir, name));
    if (!obj) { continue; }
    // A stub has reviewers/status/votes; a per-agent vote file has a top-level `vote`.
    if (typeof (obj as { vote?: unknown }).vote === 'string' && obj.task_id) {
      perAgent.push({ file: name, vote: obj as TallyVote & { task_id?: string } });
    } else if (obj.task_id) {
      stubs.push({ file: name, stub: obj });
    }
  }

  const votesByTask = new Map<string, TallyVote[]>();
  for (const { vote } of perAgent) {
    const tid = vote.task_id!;
    const arr = votesByTask.get(tid) ?? [];
    arr.push({ voter: vote.voter, vote: vote.vote, timestamp: vote.timestamp, comments: vote.comments });
    votesByTask.set(tid, arr);
  }

  await fsp.mkdir(rDir, { recursive: true });

  for (const { file, stub } of stubs) {
    result.scanned++;
    try {
      const resolvedPath = path.join(rDir, `${path.basename(stub.task_id)}.json`);
      const already = await readJson<unknown>(resolvedPath);

      const tally = tallyConsensus(stub, votesByTask.get(stub.task_id) ?? []);

      if (already) {
        // Loop already closed for this task — just clear the stale active files.
        await clearActiveFor(workspaceRoot, stub.task_id, file, perAgent);
        continue;
      }

      if (tally.status !== 'resolved' || !tally.verdict) {
        result.pending.push(stub.task_id);
        continue;
      }

      // Revise/converge: a dissent verdict with rounds left + a known author is
      // sent back for one more round instead of being finalized. Default
      // reviseMaxRounds=1 makes this a no-op (finalize on first dissent).
      const revise = detectDissentAndRevise(tally, stub, { maxRounds: reviseMaxRounds });
      if (revise.action === 'emit_revision_request' && stub.author && revise.nextRound) {
        await emitRevisionRequest({
          workspaceRoot, stub, votes: tally.votes, nextRound: revise.nextRound, now, from: resolvedBy,
        });
        result.revised.push({ task_id: stub.task_id, round: revise.nextRound });
        result.pending.push(stub.task_id);
        continue;
      }

      const record = {
        task_id: stub.task_id,
        sprint: stub.sprint,
        author: stub.author,
        round: Math.max(1, Math.floor(stub.round ?? 1)),
        rule: tally.rule,
        verdict: tally.verdict,
        approvals: tally.approvals,
        changes_requested: tally.changes,
        rejects: tally.rejects,
        panel_size: tally.panelSize,
        required_approvals: tally.required,
        reviewers: tally.reviewers,
        votes: tally.votes,
        source_task_complete_id: stub.source_task_complete_id,
        opened_at: stub.opened_at,
        resolved_at: now.toISOString(),
        resolved_by: resolvedBy,
        // Preserve the handoff-note-missing flag so the audit trail is complete
        // even after the active stub is deleted (§3.3).
        ...(stub.missing_handoff_note ? { missing_handoff_note: true } : {}),
      };
      // Atomic publish: temp + rename so a reader never sees a half-written file.
      const tmp = resolvedPath + `.tmp-${process.pid}`;
      await fsp.writeFile(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
      await fsp.rename(tmp, resolvedPath);

      await clearActiveFor(workspaceRoot, stub.task_id, file, perAgent);
      result.resolved.push({
        task_id: stub.task_id, verdict: tally.verdict,
        approvals: tally.approvals, panelSize: tally.panelSize, rule: tally.rule,
      });
    } catch {
      // Isolate per-task failures; a malformed stub must not abort the sweep.
      result.pending.push(stub.task_id);
    }
  }

  return result;
}

/** Delete the active stub + every per-agent vote file for one task. Best-effort. */
async function clearActiveFor(
  workspaceRoot: string,
  taskId: string,
  stubFile: string,
  perAgent: Array<{ file: string; vote: { task_id?: string } }>,
): Promise<void> {
  const aDir = activeDir(workspaceRoot);
  await fsp.unlink(path.join(aDir, stubFile)).catch(() => undefined);
  for (const { file, vote } of perAgent) {
    if (vote.task_id === taskId) {
      await fsp.unlink(path.join(aDir, file)).catch(() => undefined);
    }
  }
}
