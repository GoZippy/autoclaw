/**
 * query.ts — The `/recall` retrieval layer.
 *
 * `/recall` is the awake-side counterpart to `/dream`: it searches the
 * hierarchical memory tiers (core / recall / archive) and answers two query
 * shapes:
 *
 *  - **text recall** — token-overlap scoring over fact content, scoped to a
 *    tier (or all tiers). No embeddings — zero LLM / network, matching the
 *    `recall.query` MCP tool's BP1 contract.
 *  - **time-travel recall** — bi-temporal point queries and per-subject
 *    timelines, delegating to `memory/bitemporalFact.ts`.
 *
 * Pure logic: the caller loads facts off disk and hands them in. This module
 * never touches fs / vscode / network, so each function is unit-testable.
 *
 * Spec: docs/V3_PLAN.md §2, §6 Workstream C — tasks C3 + C4.
 */

import {
  type BitemporalFact,
  type Timeline,
  buildTimeline,
  factAsOf,
  currentFact,
  resolveChain,
} from '../../memory/bitemporalFact';
import { type MemoryTier, TIER_ORDER } from '../../memory/tiers';

// ---------------------------------------------------------------------------
// Text recall
// ---------------------------------------------------------------------------

/** Options for {@link recallQuery}. */
export interface RecallOptions {
  /** Restrict to one tier; omit to search every tier. */
  tier?: MemoryTier;
  /** Max hits to return. Default 8. */
  topK?: number;
  /**
   * Include superseded (historical) facts in the result set. Default false —
   * normal recall only surfaces live facts.
   */
  includeSuperseded?: boolean;
}

/** A scored recall hit. */
export interface RecallHit {
  fact: BitemporalFact;
  /** Relevance score in [0,1] — fraction of query tokens matched. */
  score: number;
  tier: MemoryTier;
}

/** Lower-cased word tokens, length >= 2, used for overlap scoring. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
}

/**
 * Text recall over the supplied facts. Scores each fact by the fraction of
 * distinct query tokens that appear in its subject+content, ranks descending,
 * and returns the top `topK`. A zero-overlap fact is never returned.
 */
export function recallQuery(
  facts: readonly BitemporalFact[],
  query: string,
  options: RecallOptions = {},
): RecallHit[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) {
    return [];
  }
  const topK = options.topK ?? 8;

  const hits: RecallHit[] = [];
  for (const fact of facts) {
    if (!options.includeSuperseded && fact.superseded_by !== null) {
      continue;
    }
    const factTier: MemoryTier = fact.tier ?? 'recall';
    if (options.tier && factTier !== options.tier) {
      continue;
    }
    const factTokens = new Set(tokenize(`${fact.subject} ${fact.content}`));
    let matched = 0;
    for (const qt of queryTokens) {
      if (factTokens.has(qt)) {
        matched++;
      }
    }
    if (matched === 0) {
      continue;
    }
    hits.push({ fact, score: matched / queryTokens.length, tier: factTier });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    // Tie-break: hotter tier first, then most recently recorded.
    const tierDelta = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
    if (tierDelta !== 0) {
      return tierDelta;
    }
    return b.fact.recorded_at.localeCompare(a.fact.recorded_at);
  });
  return hits.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Time-travel recall
// ---------------------------------------------------------------------------

/** A bi-temporal point query for `/recall <subject> --as-of <date>`. */
export interface TimeTravelQuery {
  subject: string;
  /** ISO8601 valid-time instant ("what was true on …"). */
  validAt: string;
  /** ISO8601 transaction-time instant ("…using what we knew by …"). */
  knownAt?: string;
}

/**
 * Answer a bi-temporal point query — the fact AutoClaw believed true about a
 * subject at a given valid-time, optionally constrained to knowledge recorded
 * by a given transaction-time. Returns `undefined` when nothing matched.
 */
export function recallAsOf(
  facts: readonly BitemporalFact[],
  q: TimeTravelQuery,
): BitemporalFact | undefined {
  return factAsOf(facts, q.subject, q.validAt, q.knownAt);
}

/**
 * Return the full bi-temporal {@link Timeline} for a subject — every fact ever
 * recorded about it, ordered oldest → newest. Backs `recall.timeline`.
 */
export function recallTimeline(
  facts: readonly BitemporalFact[],
  subject: string,
): Timeline {
  return buildTimeline(facts, subject);
}

/**
 * Return the current (live) fact for a subject, or `undefined` when the
 * subject is unknown. The default `/recall <subject>` answer.
 */
export function recallCurrent(
  facts: readonly BitemporalFact[],
  subject: string,
): BitemporalFact | undefined {
  return currentFact(facts, subject);
}

/**
 * Resolve and return the supersession chain rooted at a fact id, oldest →
 * newest — `/recall --history <fact-id>`. Throws on a cyclic chain.
 */
export function recallChain(
  facts: readonly BitemporalFact[],
  startId: string,
): BitemporalFact[] {
  return resolveChain(facts, startId);
}
