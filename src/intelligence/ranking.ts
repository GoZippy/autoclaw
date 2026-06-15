/**
 * ranking.ts — signal precedence + retrieval/style weighting for the AutoClaw
 * Intelligence Layer (Phase-2 intelligence-signal-and-rag, R1.3, R4.1, R4.2).
 *
 * Centralizes ONE policy for "how strong is this session's kept signal" so the
 * learn pipeline, retrieval, and style generation all agree:
 *
 *   precedence:  git_commit  >  applied_edit  >  user_approval  >  none
 *
 * `deriveOutcome` collapses a session's signals into a single
 * {@link DerivedOutcome} (outcome + signal type + confidence). `weightForSignal`
 * /`weightForRetrieval` turn that into a comparable weight where git-validated
 * signals always outrank heuristic-only ones (R4.1) — even a minimum-confidence
 * git signal outranks a maximum-confidence user-approval signal.
 * `provenanceForSession` produces the lightweight `{ confidence, signalType,
 * provenance }` envelope persisted with learnings (R4.2), a precursor to the
 * Phase-6 bitemporal migration.
 *
 * Pure module — no `vscode` import, no I/O, fully deterministic + unit-testable.
 */

import { KeptReason, SessionOutcome, UnifiedSession } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The kind of signal that drove a derived outcome (precedence order). */
export type SignalType = 'git_commit' | 'applied_edit' | 'user_approval' | 'none';

/** The collapsed judgement for a single session. */
export interface DerivedOutcome {
  /** Shipped / discarded / unknown after applying precedence. */
  outcome: SessionOutcome;
  /** Which signal won (strongest present). */
  signalType: SignalType;
  /** Confidence `[0,1]` in the derived outcome. */
  confidence: number;
}

/** Persisted confidence + provenance for a learning (R4.2). */
export interface SignalProvenance {
  signalType: SignalType;
  confidence: number;
  /** Present only when the winning signal was a git commit. */
  gitKeptCommit?: { hash: string; message: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fallback confidence per signal when no explicit KeptCode confidence exists. */
const DEFAULT_CONFIDENCE: Record<SignalType, number> = {
  git_commit: 0.9,
  applied_edit: 0.7,
  user_approval: 0.55,
  none: 0.1,
};

/**
 * Base retrieval weight per signal type. Chosen so the WORST-case git weight
 * (`1.0 * 0.5 = 0.5`) still exceeds the BEST-case user-approval weight
 * (`0.4 * 1.0 = 0.4`): git-validated always outranks heuristic-only (R4.1).
 */
const BASE_WEIGHT: Record<SignalType, number> = {
  git_commit: 1.0,
  applied_edit: 0.6,
  user_approval: 0.4,
  none: 0.1,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Highest confidence among kept entries of `reason`, or `undefined`. */
function maxConfidenceFor(
  session: UnifiedSession,
  reason: KeptReason,
): number | undefined {
  const matches = (session.signals?.keptCode ?? []).filter((k) => k.reason === reason);
  if (matches.length === 0) {
    return undefined;
  }
  return matches.reduce((acc, k) => Math.max(acc, clamp01(k.confidence)), 0);
}

// ---------------------------------------------------------------------------
// deriveOutcome (R1.3 — FR-1C.4 precedence)
// ---------------------------------------------------------------------------

/**
 * Collapse a session's signals into a single outcome by precedence:
 * `git_commit > applied_edit > user_approval > none`. A `gitKept === true`
 * flag is treated as a git-commit signal even without a matching KeptCode
 * entry. When a signal type is present its confidence is the strongest matching
 * KeptCode confidence, else a per-type default.
 */
export function deriveOutcome(session: UnifiedSession): DerivedOutcome {
  const signals = session.signals;

  const gitConf = maxConfidenceFor(session, 'git_commit');
  if (signals?.gitKept === true || gitConf !== undefined) {
    return {
      outcome: 'shipped',
      signalType: 'git_commit',
      confidence: gitConf ?? DEFAULT_CONFIDENCE.git_commit,
    };
  }

  const appliedConf = maxConfidenceFor(session, 'applied_edit');
  if (appliedConf !== undefined) {
    return { outcome: 'shipped', signalType: 'applied_edit', confidence: appliedConf };
  }

  const approvalConf = maxConfidenceFor(session, 'user_approval');
  if (approvalConf !== undefined) {
    return { outcome: 'shipped', signalType: 'user_approval', confidence: approvalConf };
  }

  if (signals?.outcome === 'discarded') {
    return { outcome: 'discarded', signalType: 'none', confidence: 0.5 };
  }
  if (signals?.outcome === 'shipped') {
    return { outcome: 'shipped', signalType: 'none', confidence: 0.4 };
  }
  return { outcome: 'unknown', signalType: 'none', confidence: DEFAULT_CONFIDENCE.none };
}

// ---------------------------------------------------------------------------
// Weighting (R4.1)
// ---------------------------------------------------------------------------

/**
 * Map a signal type + confidence to a comparable retrieval/style weight in
 * `[0,1]`. Git-validated signals always outrank heuristic-only ones regardless
 * of confidence (see {@link BASE_WEIGHT}).
 */
export function weightForSignal(signalType: SignalType, confidence: number): number {
  const base = BASE_WEIGHT[signalType] ?? BASE_WEIGHT.none;
  return clamp01(base * (0.5 + 0.5 * clamp01(confidence)));
}

/** Convenience: the retrieval weight for a whole session via {@link deriveOutcome}. */
export function weightForRetrieval(session: UnifiedSession): number {
  const derived = deriveOutcome(session);
  return weightForSignal(derived.signalType, derived.confidence);
}

// ---------------------------------------------------------------------------
// Provenance (R4.2)
// ---------------------------------------------------------------------------

/**
 * Build the persisted confidence + provenance envelope for a session. Stored
 * alongside distilled learnings so later specs can extend the signal model
 * without re-deriving it.
 */
export function provenanceForSession(session: UnifiedSession): SignalProvenance {
  const derived = deriveOutcome(session);
  const provenance: SignalProvenance = {
    signalType: derived.signalType,
    confidence: derived.confidence,
  };
  if (derived.signalType === 'git_commit' && session.signals?.gitKeptCommit) {
    provenance.gitKeptCommit = session.signals.gitKeptCommit;
  }
  return provenance;
}
