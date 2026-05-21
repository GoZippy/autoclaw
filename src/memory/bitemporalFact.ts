/**
 * bitemporalFact.ts — Bi-temporal fact schema and supersession chains (C4).
 *
 * A bi-temporal fact carries two independent time axes:
 *
 *  - `valid_from` — when the fact became true *in the world* (the domain /
 *    valid-time axis). A fact recorded today can be valid from last week.
 *  - `recorded_at` — when AutoClaw *learned* the fact (the system /
 *    transaction-time axis). Never edited after creation.
 *
 * When a newer fact contradicts an older one, the older fact is not deleted —
 * it is *superseded*: its `superseded_by` points at the newer fact's id. This
 * preserves history so `/recall` can answer time-travel queries ("what did we
 * believe about X as of date D").
 *
 * This module is pure (no fs, no vscode, no network) so each helper is
 * independently unit-testable. It mirrors the kg-daemon bi-temporal validity
 * model (v2.8.0) at the in-process layer.
 *
 * Spec: docs/V3_PLAN.md §2, §6 Workstream C — task C4.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * A single bi-temporal fact. Facts are append-only: to "change" a fact you
 * record a new one and mark the old one superseded.
 */
export interface BitemporalFact {
  /** Stable unique id. Filename stem when persisted; UUID-ish recommended. */
  id: string;
  /**
   * The subject the fact is *about*. Supersession and timeline queries are
   * grouped by subject, e.g. `"src/extension.ts"`, `"build-command"`.
   */
  subject: string;
  /** The fact content — a consolidated natural-language statement. */
  content: string;
  /** ISO8601 — when the fact became true in the world (valid-time axis). */
  valid_from: string;
  /**
   * ISO8601 — when the fact stopped being true in the world; `null` while the
   * fact is still valid. Set when a successor with an earlier `valid_from`
   * window closes this one.
   */
  valid_to: string | null;
  /** ISO8601 — when AutoClaw recorded the fact (transaction-time axis). */
  recorded_at: string;
  /**
   * Id of the fact that supersedes this one; `null` for the current head of
   * a supersession chain.
   */
  superseded_by: string | null;
  /** Memory tier the fact currently lives in. See tiers.ts. */
  tier?: 'core' | 'recall' | 'archive';
  /** Free-form provenance — transcript id, file path, /note origin, etc. */
  source?: string;
  /** Optional confidence in [0,1]; absent ⇒ treated as 1. */
  confidence?: number;
}

/** A minimal shape accepted by {@link createFact} — timestamps are filled in. */
export interface NewFactInput {
  id: string;
  subject: string;
  content: string;
  /** Defaults to `recorded_at` when omitted (fact valid as of when learned). */
  valid_from?: string;
  /** Defaults to `now`. */
  recorded_at?: string;
  tier?: BitemporalFact['tier'];
  source?: string;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** ISO8601 timestamp for "now". Extracted so tests can stay deterministic. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build a well-formed {@link BitemporalFact} from a partial input. A freshly
 * created fact is always the head of its (single-element) chain:
 * `valid_to` and `superseded_by` are `null`.
 */
export function createFact(input: NewFactInput): BitemporalFact {
  const recorded_at = input.recorded_at ?? nowIso();
  return {
    id: input.id,
    subject: input.subject,
    content: input.content,
    valid_from: input.valid_from ?? recorded_at,
    valid_to: null,
    recorded_at,
    superseded_by: null,
    tier: input.tier ?? 'recall',
    source: input.source,
    confidence: input.confidence,
  };
}

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

/** Outcome of {@link supersede}: the closed predecessor + the new head. */
export interface SupersessionResult {
  /** The previously-current fact, now closed (`superseded_by` + `valid_to` set). */
  superseded: BitemporalFact;
  /** The new head of the chain (returned unchanged for convenience). */
  successor: BitemporalFact;
}

/**
 * Record that `successor` supersedes `predecessor`.
 *
 * The predecessor's `superseded_by` is pointed at the successor, and its
 * valid-time window is closed at the successor's `valid_from` (the moment the
 * old fact stopped being true in the world). Inputs are not mutated — fresh
 * objects are returned, keeping the function pure.
 *
 * Throws when the subjects differ (supersession is always within a subject)
 * or when the predecessor is already superseded.
 */
export function supersede(
  predecessor: BitemporalFact,
  successor: BitemporalFact,
): SupersessionResult {
  if (predecessor.subject !== successor.subject) {
    throw new Error(
      `supersede: subject mismatch ("${predecessor.subject}" vs "${successor.subject}")`,
    );
  }
  if (predecessor.id === successor.id) {
    throw new Error('supersede: a fact cannot supersede itself');
  }
  if (predecessor.superseded_by !== null) {
    throw new Error(
      `supersede: "${predecessor.id}" is already superseded by "${predecessor.superseded_by}"`,
    );
  }
  // Close the old window at the point the successor became valid; never let
  // valid_to predate valid_from (clamp for clock-skew / out-of-order input).
  const closeAt =
    successor.valid_from < predecessor.valid_from
      ? predecessor.valid_from
      : successor.valid_from;
  return {
    superseded: { ...predecessor, superseded_by: successor.id, valid_to: closeAt },
    successor,
  };
}

/**
 * Resolve the supersession chain for `startId` into chronological order
 * (oldest → newest). Cycles are detected and reported rather than looping
 * forever. A missing successor reference terminates the walk cleanly.
 */
export function resolveChain(
  facts: readonly BitemporalFact[],
  startId: string,
): BitemporalFact[] {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const chain: BitemporalFact[] = [];
  const seen = new Set<string>();
  let current = byId.get(startId);
  while (current) {
    if (seen.has(current.id)) {
      throw new Error(`resolveChain: cycle detected at "${current.id}"`);
    }
    seen.add(current.id);
    chain.push(current);
    if (current.superseded_by === null) {
      break;
    }
    current = byId.get(current.superseded_by);
  }
  return chain;
}

/**
 * Return the current (non-superseded) head fact for `subject`. When several
 * un-superseded facts share a subject — e.g. two independent chains — the one
 * with the latest `valid_from` wins, then latest `recorded_at` as a tiebreak.
 * Returns `undefined` when the subject is unknown.
 */
export function currentFact(
  facts: readonly BitemporalFact[],
  subject: string,
): BitemporalFact | undefined {
  const heads = facts.filter(
    (f) => f.subject === subject && f.superseded_by === null,
  );
  if (heads.length === 0) {
    return undefined;
  }
  return heads.reduce((best, f) => {
    if (f.valid_from !== best.valid_from) {
      return f.valid_from > best.valid_from ? f : best;
    }
    return f.recorded_at > best.recorded_at ? f : best;
  });
}

// ---------------------------------------------------------------------------
// Timeline — bi-temporal history for a subject
// ---------------------------------------------------------------------------

/** One entry in a {@link Timeline}: a fact plus its derived display window. */
export interface TimelineEntry {
  fact: BitemporalFact;
  /** True when the fact is the live head of its chain. */
  isCurrent: boolean;
  /** Valid-time window end — `valid_to`, or `"open"` while still valid. */
  validUntil: string | 'open';
}

/** The bi-temporal history of a single subject, ordered oldest → newest. */
export interface Timeline {
  subject: string;
  entries: TimelineEntry[];
}

/**
 * Build the {@link Timeline} for `subject` — every fact ever recorded about
 * it, ordered by `valid_from` then `recorded_at`. This is the data behind the
 * `recall.timeline` MCP tool and `/recall --history`.
 */
export function buildTimeline(
  facts: readonly BitemporalFact[],
  subject: string,
): Timeline {
  const relevant = facts
    .filter((f) => f.subject === subject)
    .slice()
    .sort((a, b) =>
      a.valid_from === b.valid_from
        ? a.recorded_at.localeCompare(b.recorded_at)
        : a.valid_from.localeCompare(b.valid_from),
    );
  return {
    subject,
    entries: relevant.map((fact) => ({
      fact,
      isCurrent: fact.superseded_by === null,
      validUntil: fact.valid_to ?? 'open',
    })),
  };
}

/**
 * Bi-temporal point query: what did AutoClaw *believe was true* about
 * `subject`, given two independent cut-offs:
 *
 *  - `validAt`   — the valid-time instant of interest ("true on date X").
 *  - `knownAt`   — the transaction-time instant ("...using only what we'd
 *                   recorded by date Y"). Defaults to `validAt`.
 *
 * Returns the matching fact, or `undefined` when nothing was known/valid.
 * Among candidates the latest `valid_from` wins (most specific), then the
 * latest `recorded_at` (most recently learned).
 */
export function factAsOf(
  facts: readonly BitemporalFact[],
  subject: string,
  validAt: string,
  knownAt: string = validAt,
): BitemporalFact | undefined {
  const candidates = facts.filter((f) => {
    if (f.subject !== subject) {
      return false;
    }
    if (f.recorded_at > knownAt) {
      return false; // not yet learned at the transaction cut-off
    }
    if (f.valid_from > validAt) {
      return false; // not yet valid at the valid-time cut-off
    }
    if (f.valid_to !== null && f.valid_to <= validAt) {
      return false; // valid window already closed
    }
    return true;
  });
  if (candidates.length === 0) {
    return undefined;
  }
  return candidates.reduce((best, f) => {
    if (f.valid_from !== best.valid_from) {
      return f.valid_from > best.valid_from ? f : best;
    }
    return f.recorded_at > best.recorded_at ? f : best;
  });
}
