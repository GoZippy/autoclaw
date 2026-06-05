/**
 * reviewSla.ts — Review SLA timers, dynamic consensus quorum, claim tokens (B5).
 *
 * Three related coordination primitives, all pure of side effects unless a
 * caller asks for the bus write:
 *
 * 1. **Review SLA** — a `task_complete` that has not collected enough reviews
 *    within an SLA window must have its `review_request` re-broadcast. This
 *    module decides *when* a re-broadcast is due and *builds* the broadcast
 *    message; the caller writes it to `inboxes/shared/`.
 *
 * 2. **Dynamic consensus quorum** — AGENT_SESSION_PROTOCOL §2.2 says a
 *    heartbeat older than the stall threshold drops the session from the
 *    quorum. The required quorum is therefore not a fixed number: it is
 *    derived from the set of agents with a *fresh* heartbeat. This module
 *    computes the live-agent set and the 2/3-majority (or unanimous, for
 *    security findings) threshold over it.
 *
 * 3. **Claim tokens** — a UUID claim token with a 10s contention window
 *    (AGENT_SESSION_PROTOCOL §4; matches `CLAIM_TTL_MS` in `claim.ts`). Two
 *    agents minting a token for the same task within 10s are *in contention*;
 *    the deterministic tiebreak (lexicographically lowest token wins) lets
 *    both sides agree on the winner without another round trip.
 *
 * Sprint 3 — B5 (WA-3)
 *
 * @see docs/AGENT_SESSION_PROTOCOL.md §2.2, §4
 */

import * as crypto from 'crypto';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Contention window for a claim token (AGENT_SESSION_PROTOCOL §4 / claim.ts). */
export const CLAIM_CONTENTION_WINDOW_MS = 10_000;

/** Default heartbeat staleness threshold — AGENT_SESSION_PROTOCOL §2.2 (300 s). */
export const DEFAULT_HEARTBEAT_STALL_MS = 300_000;

/** Default review SLA window before a `review_request` is re-broadcast. */
export const DEFAULT_REVIEW_SLA_MS = 30 * 60_000; // 30 minutes

/* -------------------------------------------------------------------------- */
/*  1. Review SLA timer                                                       */
/* -------------------------------------------------------------------------- */

/** The bookkeeping a review SLA timer tracks for one `task_complete`. */
export interface ReviewSlaRecord {
  /** The task awaiting review. */
  task_id: string;
  /** The agent whose work is under review. */
  author: string;
  /** ISO timestamp the `task_complete` was broadcast. */
  completed_at: string;
  /** SLA window in ms; defaults to {@link DEFAULT_REVIEW_SLA_MS}. */
  sla_ms?: number;
  /** Reviews collected so far (peer agent ids). */
  reviews_received: string[];
  /** Number of reviews the task needs to clear its gate. */
  reviews_required: number;
  /** ISO timestamp of the most recent re-broadcast, if any. */
  last_rebroadcast_at?: string;
  /** How many times the request has been re-broadcast. */
  rebroadcast_count?: number;
}

/** The verdict of {@link evaluateReviewSla}. */
export interface ReviewSlaDecision {
  /** True when the task still needs more reviews. */
  pending: boolean;
  /** True when the SLA window has elapsed since the last broadcast. */
  breached: boolean;
  /** True when the caller should re-broadcast a `review_request` now. */
  shouldRebroadcast: boolean;
  /** Milliseconds until the SLA next breaches (0 when already breached). */
  msUntilBreach: number;
  /** Human-readable reason. */
  detail: string;
}

/**
 * Decide whether a review SLA has been breached and a `review_request`
 * should be re-broadcast.
 *
 * The SLA clock runs from the most recent of (`completed_at`,
 * `last_rebroadcast_at`) — re-broadcasting resets the window so the bus is
 * not flooded. A task that already has enough reviews is never re-broadcast.
 */
export function evaluateReviewSla(
  record: ReviewSlaRecord,
  now: number = Date.now(),
): ReviewSlaDecision {
  const slaMs = record.sla_ms ?? DEFAULT_REVIEW_SLA_MS;
  const pending = record.reviews_received.length < record.reviews_required;

  if (!pending) {
    return {
      pending: false,
      breached: false,
      shouldRebroadcast: false,
      msUntilBreach: 0,
      detail: `task "${record.task_id}" has ${record.reviews_received.length}/${record.reviews_required} reviews — gate satisfied`,
    };
  }

  const anchorIso = record.last_rebroadcast_at ?? record.completed_at;
  const anchor = new Date(anchorIso).getTime();
  if (!Number.isFinite(anchor)) {
    // Unparseable timestamp — treat as breached so the task is not stuck.
    return {
      pending: true,
      breached: true,
      shouldRebroadcast: true,
      msUntilBreach: 0,
      detail: `task "${record.task_id}" has an unparseable SLA anchor; re-broadcasting`,
    };
  }

  const elapsed = now - anchor;
  const breached = elapsed >= slaMs;
  return {
    pending: true,
    breached,
    shouldRebroadcast: breached,
    msUntilBreach: breached ? 0 : slaMs - elapsed,
    detail: breached
      ? `task "${record.task_id}" SLA breached (${Math.round(elapsed / 1000)}s ≥ ${Math.round(slaMs / 1000)}s) — re-broadcast`
      : `task "${record.task_id}" within SLA (${Math.round(elapsed / 1000)}s / ${Math.round(slaMs / 1000)}s)`,
  };
}

/** A `review_request` broadcast message ready to be written to `inboxes/shared/`. */
export interface ReviewRequestBroadcast {
  id: string;
  from: string;
  to: 'shared';
  type: 'review_request';
  timestamp: string;
  task_id: string;
  requires_response: true;
  payload: {
    author: string;
    reason: 'sla_timeout';
    reviews_received: string[];
    reviews_required: number;
    rebroadcast_count: number;
  };
}

/**
 * Build the `review_request` re-broadcast for an SLA-breached task. The
 * caller writes the result into `inboxes/shared/` and bumps the record's
 * `last_rebroadcast_at` / `rebroadcast_count` (use {@link markRebroadcast}).
 */
export function buildReviewRequestBroadcast(
  record: ReviewSlaRecord,
  from: string,
  now: Date = new Date(),
): ReviewRequestBroadcast {
  return {
    id: `msg-${crypto.randomUUID()}`,
    from,
    to: 'shared',
    type: 'review_request',
    timestamp: now.toISOString(),
    task_id: record.task_id,
    requires_response: true,
    payload: {
      author: record.author,
      reason: 'sla_timeout',
      reviews_received: [...record.reviews_received],
      reviews_required: record.reviews_required,
      rebroadcast_count: (record.rebroadcast_count ?? 0) + 1,
    },
  };
}

/** Return a copy of `record` with the re-broadcast bookkeeping advanced. */
export function markRebroadcast(
  record: ReviewSlaRecord,
  now: Date = new Date(),
): ReviewSlaRecord {
  return {
    ...record,
    last_rebroadcast_at: now.toISOString(),
    rebroadcast_count: (record.rebroadcast_count ?? 0) + 1,
  };
}

/* -------------------------------------------------------------------------- */
/*  2. Dynamic consensus quorum                                               */
/* -------------------------------------------------------------------------- */

/** Minimal heartbeat shape this module needs to judge liveness. */
export interface HeartbeatLike {
  agent_id: string;
  timestamp: string;
  /** `halted` agents are excluded from quorum even when fresh. */
  status?: string;
}

/** The result of {@link computeQuorum}. */
export interface QuorumResult {
  /** Agent ids with a fresh, non-halted heartbeat. */
  liveAgents: string[];
  /** Total number of live agents — the denominator. */
  liveCount: number;
  /** Votes needed to pass under the requested rule. */
  threshold: number;
  /** The rule applied. */
  rule: 'majority' | 'unanimous';
}

/**
 * Compute the live-agent set and the consensus threshold.
 *
 * AGENT_SESSION_PROTOCOL §2.2: an agent whose heartbeat is older than the
 * stall threshold is dropped from quorum. The threshold is therefore dynamic
 * — it follows the live fleet, not a fixed registry count.
 *
 * - `majority`  — 2/3 of the live count, rounded up (the protocol's default
 *                 review gate). One live agent ⇒ threshold 1.
 * - `unanimous` — all live agents must vote yes (security findings).
 *
 * A `halted` heartbeat is excluded even when fresh: a halted session cannot
 * cast a vote.
 */
/**
 * PA-4: personas whose findings are SECURITY-TIER — their review uses the
 * unanimous rule, not 2/3 majority (AGENT_SESSION_PROTOCOL §2.2). A
 * subcontract carrying one of these `persona_id`s, or a `finding_report`
 * authored by one, must clear unanimously before merge.
 */
export const SECURITY_TIER_PERSONAS: readonly string[] = [
  'security-auditor',
  'supply-chain-auditor',
];

/**
 * The consensus rule to apply for a review, given the optional persona that
 * produced the work/finding. Security-tier personas ⇒ `unanimous`; everything
 * else ⇒ `majority`.
 */
export function quorumRuleForPersona(personaId?: string): 'majority' | 'unanimous' {
  return personaId && SECURITY_TIER_PERSONAS.includes(personaId) ? 'unanimous' : 'majority';
}

export function computeQuorum(
  heartbeats: HeartbeatLike[],
  opts: {
    now?: number;
    stallMs?: number;
    rule?: 'majority' | 'unanimous';
  } = {},
): QuorumResult {
  const now = opts.now ?? Date.now();
  const stallMs = opts.stallMs ?? DEFAULT_HEARTBEAT_STALL_MS;
  const rule = opts.rule ?? 'majority';

  // Dedupe by agent_id, keeping the freshest heartbeat per agent.
  const freshest = new Map<string, HeartbeatLike>();
  for (const hb of heartbeats) {
    if (!hb?.agent_id || !hb.timestamp) {
      continue;
    }
    const prev = freshest.get(hb.agent_id);
    if (!prev || new Date(hb.timestamp).getTime() > new Date(prev.timestamp).getTime()) {
      freshest.set(hb.agent_id, hb);
    }
  }

  const liveAgents: string[] = [];
  for (const hb of freshest.values()) {
    const age = now - new Date(hb.timestamp).getTime();
    if (!Number.isFinite(age) || age >= stallMs) {
      continue; // stale → dropped from quorum
    }
    if (hb.status === 'halted') {
      continue; // halted → cannot vote
    }
    liveAgents.push(hb.agent_id);
  }
  liveAgents.sort();

  const liveCount = liveAgents.length;
  const threshold =
    rule === 'unanimous'
      ? liveCount
      : liveCount === 0
        ? 0
        : Math.ceil((liveCount * 2) / 3);

  return { liveAgents, liveCount, threshold, rule };
}

/**
 * Decide whether a set of approve votes meets the dynamic quorum. `approvals`
 * is counted only for agents that are currently live (a vote from a since-
 * stalled agent does not count toward a live quorum).
 */
export function quorumReached(
  approvals: string[],
  quorum: QuorumResult,
): { reached: boolean; effectiveApprovals: number; detail: string } {
  const live = new Set(quorum.liveAgents);
  const effective = new Set(approvals.filter(a => live.has(a)));
  const effectiveApprovals = effective.size;
  if (quorum.liveCount === 0) {
    return {
      reached: false,
      effectiveApprovals,
      detail: 'no live agents — quorum cannot be reached',
    };
  }
  const reached = effectiveApprovals >= quorum.threshold;
  return {
    reached,
    effectiveApprovals,
    detail: `${effectiveApprovals}/${quorum.threshold} (${quorum.rule}) live approvals — ${reached ? 'PASS' : 'pending'}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  3. Claim tokens with a contention window                                  */
/* -------------------------------------------------------------------------- */

/** A claim token: a UUID minted at a point in time. */
export interface ClaimToken {
  /** The task being claimed. */
  task_id: string;
  /** The agent that minted the token. */
  agent: string;
  /** The UUID token value. */
  token: string;
  /** ISO timestamp the token was minted. */
  minted_at: string;
  /** Contention window in ms; defaults to {@link CLAIM_CONTENTION_WINDOW_MS}. */
  contention_window_ms?: number;
}

/** Mint a fresh claim token for `agent` claiming `task_id`. */
export function mintClaimToken(
  task_id: string,
  agent: string,
  opts: { now?: Date; contentionWindowMs?: number } = {},
): ClaimToken {
  const now = opts.now ?? new Date();
  return {
    task_id,
    agent,
    token: crypto.randomUUID(),
    minted_at: now.toISOString(),
    ...(opts.contentionWindowMs !== undefined
      ? { contention_window_ms: opts.contentionWindowMs }
      : {}),
  };
}

/**
 * Two claim tokens for the *same task* are in contention when both were
 * minted within either token's contention window of each other.
 */
export function tokensInContention(a: ClaimToken, b: ClaimToken): boolean {
  if (a.task_id !== b.task_id) {
    return false;
  }
  const ta = new Date(a.minted_at).getTime();
  const tb = new Date(b.minted_at).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) {
    return false;
  }
  const window = Math.max(
    a.contention_window_ms ?? CLAIM_CONTENTION_WINDOW_MS,
    b.contention_window_ms ?? CLAIM_CONTENTION_WINDOW_MS,
  );
  return Math.abs(ta - tb) < window;
}

/**
 * Resolve a contended claim deterministically.
 *
 * Among all tokens for one task minted inside the contention window, the
 * winner is the *earliest* mint; ties on mint time break on the
 * lexicographically lowest token value. Because the rule uses only data
 * carried in the tokens themselves, every contending agent computes the same
 * winner without a further round trip — no leader election needed.
 *
 * @returns the winning token, or `null` when `tokens` is empty or the tokens
 *          span more than one `task_id`.
 */
export function resolveContention(tokens: ClaimToken[]): ClaimToken | null {
  if (tokens.length === 0) {
    return null;
  }
  const taskId = tokens[0].task_id;
  if (tokens.some(t => t.task_id !== taskId)) {
    return null; // mixed tasks — caller error
  }
  const sorted = [...tokens].sort((x, y) => {
    const tx = new Date(x.minted_at).getTime();
    const ty = new Date(y.minted_at).getTime();
    if (tx !== ty) {
      return tx - ty; // earliest mint wins
    }
    return x.token < y.token ? -1 : x.token > y.token ? 1 : 0; // lexicographic tiebreak
  });
  return sorted[0];
}

/**
 * Decide whether `mine` wins against a set of competing tokens for the same
 * task. Convenience over {@link resolveContention} for the common "did I win
 * the claim?" question an agent asks after minting.
 */
export function claimWon(mine: ClaimToken, competitors: ClaimToken[]): boolean {
  const winner = resolveContention([mine, ...competitors]);
  return winner !== null && winner.token === mine.token;
}

/**
 * Whether a token's contention window has fully elapsed — past this point the
 * claim is settled and no late competitor can dispute it.
 */
export function contentionWindowClosed(token: ClaimToken, now: number = Date.now()): boolean {
  const minted = new Date(token.minted_at).getTime();
  if (!Number.isFinite(minted)) {
    return true;
  }
  const window = token.contention_window_ms ?? CLAIM_CONTENTION_WINDOW_MS;
  return now - minted >= window;
}
