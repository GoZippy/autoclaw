/**
 * reviewfleet/service.ts — RF-3: Review Fleet Service Core
 *
 * Orchestrates a review request end-to-end:
 *   1. Plan reviewers via RF-2 router (planReview)
 *   2. Dispatch each reviewer (best-effort; crashes are silently dropped)
 *   3. Aggregate verdicts conservatively (any reject→reject, any request_changes→request_changes)
 *   4. Emit a LABELED automated vote via injectable writeVote
 *   5. Score the run via injectable scoreRun (failure must not break the review)
 *
 * All real IO stays in injectable deps — processReviewRequest is deterministic
 * given stubbed deps, enabling fully offline unit testing.
 */

import { planReview } from './router';
import type { ReviewPlan, ReviewContext } from './router';
import type { ReviewerCapacity } from './roster';
import type { ScaffoldVariant, ReviewScaffoldConfig } from '../workflows/scaffolds/types';
import type { ScaffoldScoreInput, ScaffoldReviewOutcome } from '../workflows/scaffolds/score';
import type { WorkflowRunSummary } from '../workflows/runLedger';

/* -------------------------------------------------------------------------- */
/*  Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface ReviewVerdict {
  reviewerId: string;
  vote: 'approve' | 'request_changes' | 'reject';
  blockingFindings?: number;
  costCents?: number;
  /** Content-free summary (no prompt text, no model output). */
  summary?: string;
}

export interface AutomatedVote {
  /** LABELED automated voter — never silently impersonates a human. */
  voter: string;
  task_id: string;
  vote: 'approve' | 'request_changes' | 'reject';
  automated: true;
  reviewers: string[];
  timestamp: string;
  /** Short, content-free explanation of the routing decision + verdict. */
  reason: string;
}

export interface ReviewFleetInput {
  scaffold: ScaffoldVariant;           // .review holds the ReviewScaffoldConfig
  taskId: string;
  ctx?: ReviewContext;
  runSummary?: Partial<WorkflowRunSummary>;  // optional; used for scoring
}

export interface ReviewFleetDeps {
  roster: ReviewerCapacity[];
  /**
   * Dispatch a single reviewer and return a verdict.
   * Injectable: prod wires real LLM chat / runner dispatch.
   * If this throws, the reviewer is silently omitted (best-effort).
   */
  dispatchReviewer: (reviewer: ReviewerCapacity, taskId: string) => Promise<ReviewVerdict>;
  /**
   * Persist the automated vote.
   * Injectable: prod wires voteWriter that appends to consensus active/.
   */
  writeVote: (vote: AutomatedVote) => Promise<void>;
  /**
   * Score the scaffold run.
   * Injectable: prod wires scoreAndAppendScaffoldRun(workspaceRoot, input).
   * A failure here must NOT fail the review — scored will be set false.
   */
  scoreRun?: (input: ScaffoldScoreInput) => Promise<unknown>;
  /** Timestamp factory — defaults to new Date().toISOString(). */
  now?: () => string;
}

export interface ReviewFleetResult {
  plan: ReviewPlan;
  verdicts: ReviewVerdict[];
  /** Absent when humanRequired — a human must vote, not an automated label. */
  vote?: AutomatedVote;
  humanRequired: boolean;
  scored: boolean;
  reason: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A safe default review config used when scaffold.review is absent.
 * Conservative: gatesFirst=true, cross-provider independence, local tier.
 */
export function defaultReviewConfig(): ReviewScaffoldConfig {
  return {
    tier: 'tier1-local',
    reviewerIndependence: 'different-provider',
    gatesFirst: true,
  };
}

/**
 * Aggregate verdicts conservatively:
 *   any 'reject'          → 'reject'
 *   any 'request_changes' → 'request_changes'
 *   all 'approve'         → 'approve'
 *
 * Called only when verdicts.length > 0.
 */
function aggregateVerdicts(
  verdicts: ReviewVerdict[],
): 'approve' | 'request_changes' | 'reject' {
  if (verdicts.some((v) => v.vote === 'reject')) {
    return 'reject';
  }
  if (verdicts.some((v) => v.vote === 'request_changes')) {
    return 'request_changes';
  }
  return 'approve';
}

/* -------------------------------------------------------------------------- */
/*  processReviewRequest                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Core service entry point for RF-3.
 *
 * Invariants:
 * - NEVER writes an automated vote when humanRequired.
 * - NEVER silently approves when all dispatchers failed (fail-safe → humanRequired).
 * - A scoreRun failure NEVER causes the review to throw or return humanRequired.
 */
export async function processReviewRequest(
  input: ReviewFleetInput,
  deps: ReviewFleetDeps,
): Promise<ReviewFleetResult> {

  // Step 1 — resolve config and plan reviewers
  const config: ReviewScaffoldConfig = input.scaffold.review ?? defaultReviewConfig();
  const plan: ReviewPlan = planReview(config, deps.roster, input.ctx);

  // Step 2 — human gate: do NOT write a vote, do NOT score
  if (plan.humanRequired) {
    return {
      plan,
      verdicts: [],
      humanRequired: true,
      scored: false,
      reason: `human review required: ${plan.reason}`,
    };
  }

  // Step 3 — dispatch reviewers best-effort (crashes omitted, never counted as approve)
  const verdicts: ReviewVerdict[] = [];
  for (const reviewer of plan.reviewers) {
    try {
      const verdict = await deps.dispatchReviewer(reviewer, input.taskId);
      verdicts.push(verdict);
    } catch {
      // Silently omit this reviewer — do NOT count as approve
    }
  }

  // Step 4 — fail-safe: no verdicts at all → human required (never silent approve)
  if (verdicts.length === 0) {
    return {
      plan,
      verdicts: [],
      humanRequired: true,
      scored: false,
      reason: 'no reviewer verdict — human required',
    };
  }

  // Step 5 — aggregate (conservative)
  const aggregated = aggregateVerdicts(verdicts);

  // Step 6 — build and emit the labeled automated vote
  const ts = deps.now?.() ?? new Date().toISOString();
  const voter = config.automatedVoteLabel ?? `automated:${input.scaffold.id}`;
  const reviewerIds = verdicts.map((v) => v.reviewerId);
  const vote: AutomatedVote = {
    voter,
    task_id: input.taskId,
    vote: aggregated,
    automated: true,
    reviewers: reviewerIds,
    timestamp: ts,
    reason: `tier:${plan.tier} reviewer(s):${reviewerIds.length} verdict:${aggregated}`,
  };
  await deps.writeVote(vote);

  // Step 7 — score (if deps.scoreRun and runSummary provided); failure must NOT break review
  let scored = false;
  if (deps.scoreRun && input.runSummary !== undefined) {
    try {
      const reviewOutcome: ScaffoldReviewOutcome = {
        verifierPass: aggregated === 'approve',
        judgeVeto: aggregated === 'reject',
      };

      // Sum verdicts' costCents into a copy of runSummary.costCents
      const additionalCost = verdicts.reduce(
        (sum, v) => sum + (v.costCents ?? 0),
        0,
      );
      const runCopy: Partial<WorkflowRunSummary> = {
        ...input.runSummary,
        costCents: (input.runSummary.costCents ?? 0) + additionalCost,
      };

      const scoreInput: ScaffoldScoreInput = {
        scaffold: input.scaffold,
        run: runCopy,
        review: reviewOutcome,
      };

      await deps.scoreRun(scoreInput);
      scored = true;
    } catch {
      // Scoring failure must NOT propagate — review is still valid
      scored = false;
    }
  }

  // Step 8 — return
  return {
    plan,
    verdicts,
    vote,
    humanRequired: false,
    scored,
    reason: `tier:${plan.tier} verdict:${aggregated} reviewers:${reviewerIds.length}`,
  };
}
