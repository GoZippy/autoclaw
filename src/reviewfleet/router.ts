/**
 * reviewfleet/router.ts — RF-2: Tiered Review Router
 *
 * Pure decision function: given a ReviewScaffoldConfig + reviewer roster +
 * optional context, selects which reviewer(s) to use.
 *
 * Gate sequence (cheapest path first):
 *   gates-first flag → tier1-local → escalate to tier2-strong → panel → human
 *
 * No IO — does not read files, make network calls, or mutate inputs.
 */

import type { ReviewScaffoldConfig } from '../workflows/scaffolds/types';
import { rankReviewers } from './roster';
import type { ReviewerCapacity } from './roster';

/* -------------------------------------------------------------------------- */
/*  Public types                                                               */
/* -------------------------------------------------------------------------- */

/** Caller-supplied context that shapes routing decisions. */
export interface ReviewContext {
  /** Task intent label (e.g. 'code', 'security', 'test', 'docs'). */
  intent?: string;
  /**
   * Provider family of the authoring agent (e.g. 'anthropic', 'openai',
   * 'local'). Used to enforce cross-provider independence rules.
   */
  authorProvider?: string;
  /**
   * When true, forces escalation past tier1: a release gate, security review,
   * or scope-touching task that must not be rubber-stamped by a cheap model.
   */
  highStakes?: boolean;
}

/** The routing decision produced by planReview. */
export interface ReviewPlan {
  tier: 'tier1-local' | 'tier2-strong' | 'panel' | 'human';
  /** Selected reviewer(s); always [] when humanRequired or none available. */
  reviewers: ReviewerCapacity[];
  /** Pass through from config — run deterministic gates before model spend. */
  gatesFirst: boolean;
  /** True when the router moved past the requested tier due to stakes or gaps. */
  escalate: boolean;
  /** No eligible reviewer found, or tier is human — a human must review. */
  humanRequired: boolean;
  /** Short, content-free explanation of the routing decision. */
  reason: string;
}

/* -------------------------------------------------------------------------- */
/*  Provider family mapping                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Known runner id → provider family table.
 * Mirrors CLOUD_RUNNER_IDS in roster.ts plus the local/remote defaults.
 */
const RUNNER_PROVIDER: Record<string, string> = {
  'claude-code': 'anthropic',
  'claude-desktop': 'anthropic', // same vendor as claude-code — must NOT count as independent
  'claude': 'anthropic',
  'codex': 'openai',
  'openai-codex': 'openai',
  'cursor': 'cursor',
  'gemini-cli': 'google',
  'gemini': 'google',
  'kiro': 'kiro',
  'copilot': 'github',
  'continue': 'continue',
};

/**
 * Map a ReviewerCapacity to a coarse provider family string for cross-provider
 * independence checks.
 *
 * Resolution order:
 *  1. runner kind: look up RUNNER_PROVIDER table by id (known cloud runners).
 *     Unrecognised runner ids → 'local'.
 *  2. model kind: id is 'providerId:model' — use the part before the first ':'.
 *     locality 'local' → 'local'; locality 'lan' → 'local' (self-hosted);
 *     locality 'cloud' → the extracted providerId.
 *  3. remote kind: locality 'cloud' → 'remote-cloud'; otherwise → 'remote'.
 */
export function reviewerProvider(cap: ReviewerCapacity): string {
  if (cap.kind === 'runner') {
    return RUNNER_PROVIDER[cap.id] ?? 'local';
  }

  if (cap.kind === 'model') {
    // id format: 'providerId:model'
    const colonIdx = cap.id.indexOf(':');
    const providerId = colonIdx >= 0 ? cap.id.slice(0, colonIdx) : cap.id;
    // Local and LAN models are self-hosted — treat as 'local' regardless of providerId.
    if (cap.locality === 'local' || cap.locality === 'lan') {
      return 'local';
    }
    // Cloud-locality model — provider matters for cross-provider checks.
    return providerId;
  }

  // remote kind
  return cap.locality === 'cloud' ? 'remote-cloud' : 'remote';
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Filter out reviewers whose provider family matches the author's provider.
 * Returns the full list unchanged when authorProvider is not supplied.
 */
function excludeAuthorProvider(
  candidates: ReviewerCapacity[],
  authorProvider: string | undefined,
): ReviewerCapacity[] {
  if (!authorProvider) { return candidates; }
  return candidates.filter((c) => reviewerProvider(c) !== authorProvider);
}

/**
 * Build a panel of up to `panelSize` reviewers, maximising provider diversity.
 * Greedy: iterate the ranked list and accept the next reviewer whose provider
 * is not yet in the panel; once diversity is exhausted (or crossProvider is
 * false), fill remaining slots from any remaining candidates.
 */
function buildPanel(
  ranked: ReviewerCapacity[],
  panelSize: number,
  crossProvider: boolean,
): ReviewerCapacity[] {
  const panel: ReviewerCapacity[] = [];
  const usedProviders = new Set<string>();
  const remaining: ReviewerCapacity[] = [];

  // First pass: diversity-first
  for (const r of ranked) {
    if (panel.length >= panelSize) { break; }
    const prov = reviewerProvider(r);
    if (!usedProviders.has(prov)) {
      panel.push(r);
      usedProviders.add(prov);
    } else {
      remaining.push(r);
    }
  }

  // Second pass: fill if diversity exhausted and crossProvider allows same-provider
  if (panel.length < panelSize && !crossProvider) {
    for (const r of remaining) {
      if (panel.length >= panelSize) { break; }
      panel.push(r);
    }
  }

  return panel;
}

/* -------------------------------------------------------------------------- */
/*  planReview — pure routing decision                                         */
/* -------------------------------------------------------------------------- */

/**
 * Decide which reviewer(s) to use for a review task.
 *
 * Pure function: no IO, no side effects, deterministic given the same inputs.
 *
 * @param config - The review scaffold configuration (tier, independence, etc.)
 * @param roster - The full reviewer roster from buildReviewerRoster / tests.
 * @param ctx    - Optional call-site context (author provider, high-stakes flag).
 */
export function planReview(
  config: ReviewScaffoldConfig,
  roster: ReviewerCapacity[],
  ctx?: ReviewContext,
): ReviewPlan {
  const gatesFirst = config.gatesFirst;
  const crossProvider =
    config.reviewerIndependence === 'different-provider' ||
    !!config.requiredProviderDiversity;
  const authorProvider = ctx?.authorProvider;
  const highStakes = !!ctx?.highStakes;

  // ── Step 1: Human gate ────────────────────────────────────────────────────
  if (config.tier === 'human' || config.reviewerIndependence === 'human') {
    return {
      tier: 'human',
      reviewers: [],
      gatesFirst,
      escalate: false,
      humanRequired: true,
      reason: 'config.tier or reviewerIndependence is human — human review required',
    };
  }

  // ── Step 2: Panel path ────────────────────────────────────────────────────
  if (config.tier === 'panel') {
    const panelSize = config.panelSize ?? 2;
    const ranked = rankReviewers(roster, { tier: 'tier2-strong' });
    const panel = buildPanel(ranked, panelSize, crossProvider);

    if (panel.length === 0) {
      return {
        tier: 'human',
        reviewers: [],
        gatesFirst,
        escalate: true,
        humanRequired: true,
        reason: 'panel requested but no eligible strong reviewers — human required',
      };
    }

    const providerNames = [...new Set(panel.map(reviewerProvider))].join(', ');
    return {
      tier: 'panel',
      reviewers: panel,
      gatesFirst,
      escalate: false,
      humanRequired: false,
      reason: `panel of ${panel.length} strong reviewer(s) selected (providers: ${providerNames})`,
    };
  }

  // ── Step 3: Tier1-local path ───────────────────────────────────────────────
  if (config.tier === 'tier1-local' && !highStakes) {
    let tier1Candidates = rankReviewers(roster, { tier: 'tier1-local' });
    if (crossProvider) {
      tier1Candidates = excludeAuthorProvider(tier1Candidates, authorProvider);
    }

    if (tier1Candidates.length > 0) {
      const picked = tier1Candidates[0];
      return {
        tier: 'tier1-local',
        reviewers: [picked],
        gatesFirst,
        escalate: false,
        humanRequired: false,
        reason: `tier1-local reviewer selected (${picked.detail ?? picked.id})`,
      };
    }

    // No tier1 available → fall through to tier2
    // (escalate=true, continue to tier2 block below)
  }

  // ── Step 4: Tier2-strong path (direct request, highStakes, or tier1 fallback) ──
  const escalated =
    config.tier === 'tier1-local' || // fell through from tier1
    highStakes;

  let tier2Candidates = rankReviewers(roster, { tier: 'tier2-strong' });
  if (crossProvider && authorProvider) {
    tier2Candidates = excludeAuthorProvider(tier2Candidates, authorProvider);
  }

  if (tier2Candidates.length > 0) {
    const picked = tier2Candidates[0];
    const escalateReason = highStakes
      ? 'high-stakes task — escalated to tier2-strong'
      : config.tier === 'tier1-local'
        ? 'no eligible tier1 reviewer — escalated to tier2-strong'
        : 'tier2-strong requested';

    return {
      tier: 'tier2-strong',
      reviewers: [picked],
      gatesFirst,
      escalate: escalated,
      humanRequired: false,
      reason: `${escalateReason} (${picked.detail ?? picked.id})`,
    };
  }

  // ── Step 5: Fail-safe — no reviewer available at any tier ─────────────────
  return {
    tier: 'human',
    reviewers: [],
    gatesFirst,
    escalate: true,
    humanRequired: true,
    reason: 'no eligible reviewer at any tier — human required',
  };
}
