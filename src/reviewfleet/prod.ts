/**
 * reviewfleet/prod.ts — RF-4a: Production-default wiring for ReviewFleetDeps.
 *
 * Provides `defaultReviewFleetDeps(opts)` which returns a concrete
 * `ReviewFleetDeps` from service.ts.  Every "expensive" seam is DORMANT
 * by default:
 *
 *   - opts.enabled defaults to FALSE → no model call ever fires.
 *   - opts.budgetCents defaults to 0 → even when enabled, $0 is available.
 *
 * The dispatchReviewer safety gate checks both before any LLM call.
 * writeVote and scoreRun are always safe (pure file writes).
 *
 * NOTE: runner-kind dispatch is stubbed with a clear error (RF-4b seam).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ReviewFleetDeps, ReviewVerdict } from './service';
import type { ReviewerCapacity } from './roster';
import type { ScaffoldScoreInput } from '../workflows/scaffolds/score';
import type { AutomatedVote } from './service';

/* -------------------------------------------------------------------------- */
/*  LlmChat injectable signature                                               */
/* -------------------------------------------------------------------------- */

/**
 * Minimal chat function the fleet dispatcher calls.  The injectable accepts
 * the prompt string and returns text + optional costCents.
 *
 * Production default (when opts.llmChat is absent) lazy-requires LlmRegistry
 * and adapts LlmRegistry.chat(ChatOptions) → ChatResult:
 *   - passes prompt as a single user message
 *   - extracts result.response as text
 *   - extracts result.costCents
 *
 * Tests ALWAYS inject a fake so the network is never touched.
 */
export type LlmChatFn = (args: {
  prompt: string;
  model?: string;
}) => Promise<{ text: string; costCents?: number }>;

/* -------------------------------------------------------------------------- */
/*  Public opts type                                                           */
/* -------------------------------------------------------------------------- */

export interface ReviewFleetProdOpts {
  /** Absolute path to the workspace root. */
  workspaceRoot: string;
  /** Reviewer roster (from buildReviewerRoster or tests). */
  roster: ReviewerCapacity[];
  /**
   * Master kill switch.  DEFAULT FALSE — no paid model call ever happens
   * until a caller explicitly sets this to true.
   * This is the primary $0-until-enabled invariant.
   */
  enabled?: boolean;
  /**
   * Total budget in cents the dispatcher may spend across ALL calls.
   * DEFAULT 0 — even when enabled:true, no spend is permitted until an
   * explicit positive budget is provided.
   */
  budgetCents?: number;
  /**
   * Injectable LLM chat function.  When absent, the dispatcher lazy-requires
   * LlmRegistry and adapts its `chat()` method.  Tests ALWAYS inject a fake.
   */
  llmChat?: LlmChatFn;
  /**
   * Directory for consensus vote files.
   * Defaults to <workspaceRoot>/.autoclaw/orchestrator/comms.
   */
  commsDir?: string;
  /** Session id stamped on written vote files. */
  sessionId?: string;
  /** Timestamp factory — defaults to new Date().toISOString(). */
  now?: () => string;
}

/* -------------------------------------------------------------------------- */
/*  buildReviewPrompt                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build a content-free review prompt.  No secrets, no raw diff, no source
 * code — just a neutral instruction to review a task by its opaque id and
 * reply with one verdict token.
 *
 * The returned string is intentionally short and context-free so it is safe
 * to include in any log or audit trail.
 */
export function buildReviewPrompt(taskId: string, intent?: string): string {
  const intentClause = intent ? ` (intent: ${intent})` : '';
  return (
    `You are an automated reviewer for task ${taskId}${intentClause}. ` +
    `Review the task and reply with exactly one of: APPROVE, REQUEST_CHANGES, or REJECT. ` +
    `Reply with a single token only.`
  );
}

/* -------------------------------------------------------------------------- */
/*  parseVerdict                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Parse a model's text reply into a verdict enum value.
 *
 * Conservative mapping:
 *   APPROVE           → 'approve'
 *   REJECT            → 'reject'
 *   REQUEST_CHANGES   → 'request_changes'
 *   anything else     → 'request_changes'  (NEVER default to approve)
 *
 * Case-insensitive; extra whitespace is trimmed.
 */
export function parseVerdict(
  text: string,
): 'approve' | 'request_changes' | 'reject' {
  const t = text.trim().toUpperCase();
  if (t === 'APPROVE') {
    return 'approve';
  }
  if (t === 'REJECT') {
    return 'reject';
  }
  // REQUEST_CHANGES, empty, ambiguous, or unrecognised → conservative default.
  return 'request_changes';
}

/* -------------------------------------------------------------------------- */
/*  sanitizeVoter                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Make an arbitrary string safe to use as a single filename segment.
 *
 * Path-traversal hardening: both task_id and voter flow into the consensus
 * vote filename, and either could be attacker-influenced in a federated
 * setting. We (1) replace every char that is not [A-Za-z0-9._-] — which
 * removes path separators '/' and '\' and null bytes — and (2) prefix any
 * dots-only result ('.', '..') with '_' so it can never be a traversal or
 * the current/parent directory entry. The result cannot escape its directory.
 */
function sanitizeSegment(seg: string): string {
  const cleaned = seg.replace(/[^A-Za-z0-9._-]/g, '-');
  if (cleaned === '' ) { return '_'; }
  return /^\.+$/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/* -------------------------------------------------------------------------- */
/*  defaultReviewFleetDeps                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build a concrete `ReviewFleetDeps` for production use.
 *
 * The returned object is safe to hand directly to `processReviewRequest`.
 * All expensive seams are gated behind opts.enabled + opts.budgetCents.
 */
export function defaultReviewFleetDeps(opts: ReviewFleetProdOpts): ReviewFleetDeps {
  const nowFn = opts.now ?? (() => new Date().toISOString());
  const enabled = opts.enabled ?? false;
  const totalBudget = opts.budgetCents ?? 0;
  let spentCents = 0;

  const commsDir =
    opts.commsDir ??
    path.join(opts.workspaceRoot, '.autoclaw', 'orchestrator', 'comms');

  /**
   * Lazy-build the LlmChat adapter that wraps LlmRegistry.chat().
   * Only called if no opts.llmChat was injected AND enabled:true.
   * This function is never called in tests (tests always inject llmChat).
   */
  async function buildDefaultLlmChat(): Promise<LlmChatFn> {
    // Lazy require to avoid pulling the registry into tests.
    const { LlmRegistry } = await import('../llm/registry');
    const reg = new LlmRegistry({ workspaceRoot: opts.workspaceRoot });
    return async (args) => {
      // LlmRegistry.chat(ChatOptions, providerRef?) → ChatResult
      // ChatOptions.prompt is the single-user-message sugar form.
      const result = await reg.chat({ prompt: args.prompt, model: args.model });
      return {
        text: result.response ?? '',
        costCents: result.costCents,
      };
    };
  }

  // Cache the adapted chat fn after first lazy build.
  let resolvedLlmChat: LlmChatFn | undefined = opts.llmChat;

  /* ── dispatchReviewer ──────────────────────────────────────────────────── */
  const dispatchReviewer = async (
    reviewer: ReviewerCapacity,
    taskId: string,
  ): Promise<ReviewVerdict> => {
    // SAFETY GATE 1 — master kill switch.
    if (!enabled) {
      throw new Error(
        `ReviewFleet dispatchReviewer: fleet is disabled (opts.enabled is false). ` +
          `No model call will be made until the fleet is explicitly enabled.`,
      );
    }

    // SAFETY GATE 2 — budget check.
    const remaining = totalBudget - spentCents;
    if (remaining <= 0) {
      throw new Error(
        `ReviewFleet dispatchReviewer: budget exhausted ` +
          `(spent ${spentCents} of ${totalBudget} cents).`,
      );
    }

    // RF-4b seam — runner-kind reviewers are not wired yet.
    if (reviewer.kind === 'runner') {
      throw new Error(
        `ReviewFleet dispatchReviewer: runner dispatch not wired until RF-4b ` +
          `(reviewer id: ${reviewer.id}).`,
      );
    }

    // Build or reuse the LLM chat adapter.
    if (!resolvedLlmChat) {
      resolvedLlmChat = await buildDefaultLlmChat();
    }

    const prompt = buildReviewPrompt(taskId);
    let text = '';
    let rawCostCents: number | undefined;

    const chatResult = await resolvedLlmChat({ prompt });
    text = chatResult.text;
    rawCostCents = chatResult.costCents;

    // Track cost: use reported cost or fall back to a small fixed estimate.
    const callCostCents = rawCostCents ?? 1;
    spentCents += callCostCents;

    const vote = parseVerdict(text);

    return {
      reviewerId: reviewer.id,
      vote,
      costCents: callCostCents,
      summary: `model verdict: ${vote}`,
    };
  };

  /* ── writeVote ─────────────────────────────────────────────────────────── */
  const writeVote = async (vote: AutomatedVote): Promise<void> => {
    const consensusActiveDir = path.join(commsDir, 'consensus', 'active');
    await fs.promises.mkdir(consensusActiveDir, { recursive: true });

    const filename = `${sanitizeSegment(vote.task_id)}-${sanitizeSegment(vote.voter)}.json`;
    const filePath = path.join(consensusActiveDir, filename);

    const payload = {
      voter: vote.voter,
      session_id: opts.sessionId ?? '',
      task_id: vote.task_id,
      vote: vote.vote,
      timestamp: vote.timestamp,
      automated: true as const,
      comments: vote.reason ?? '',
    };

    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  };

  /* ── scoreRun ──────────────────────────────────────────────────────────── */
  const scoreRun = async (input: ScaffoldScoreInput): Promise<unknown> => {
    const { scoreAndAppendScaffoldRun } = await import('../workflows/scaffolds/score');
    return scoreAndAppendScaffoldRun(opts.workspaceRoot, input);
  };

  return {
    roster: opts.roster,
    dispatchReviewer,
    writeVote,
    scoreRun,
    now: nowFn,
  };
}
