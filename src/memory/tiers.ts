/**
 * tiers.ts — Hierarchical memory tiers (C3).
 *
 * AutoClaw memory under `.autoclaw/memory/` is split into three tiers, each
 * with a different cost/recall trade-off:
 *
 *  - `core/`    — always loaded into every agent prompt. Hard-capped small
 *                 (< 10 KB) so it never blows the context budget.
 *  - `recall/`  — a searchable index of consolidated facts. Not auto-loaded;
 *                 reached on demand via `/recall` and the `recall.query`
 *                 MCP tool.
 *  - `archive/` — older facts kept for history / time-travel. Compressed and
 *                 cold; surfaced only by explicit `tier: 'archive'` queries.
 *
 * Facts flow downhill over time (auto-promotion rules below). This module is
 * pure logic — directory layout, size accounting, and promotion decisions —
 * with no fs side-effects, so it is independently testable. The dream
 * pipeline and the recall query layer call into it.
 *
 * Spec: docs/V3_PLAN.md §6 Workstream C — task C3.
 */

import type { BitemporalFact } from './bitemporalFact';

// ---------------------------------------------------------------------------
// Tier model
// ---------------------------------------------------------------------------

/** The three memory tiers, from hottest to coldest. */
export type MemoryTier = 'core' | 'recall' | 'archive';

/** Ordered hottest → coldest. Index doubles as a "coldness" rank. */
export const TIER_ORDER: readonly MemoryTier[] = ['core', 'recall', 'archive'];

/** Hard ceiling for the always-loaded `core/` tier. */
export const CORE_TIER_MAX_BYTES = 10 * 1024;

/**
 * Default number of sessions a fact may sit untouched in `recall/` before it
 * is eligible for demotion to `archive/`. Tunable per workspace.
 */
export const DEFAULT_ARCHIVE_AFTER_SESSIONS = 8;

/** Relative directory name for a tier under `.autoclaw/memory/`. */
export function tierDir(tier: MemoryTier): string {
  return tier; // 1:1 — `.autoclaw/memory/core`, `/recall`, `/archive`
}

/**
 * Resolve the relative path (forward-slashed, per the kdream path rule) of a
 * tier directory under a given memory root.
 */
export function tierPath(memoryRoot: string, tier: MemoryTier): string {
  const root = memoryRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${root}/${tierDir(tier)}`;
}

// ---------------------------------------------------------------------------
// Per-fact tier bookkeeping
// ---------------------------------------------------------------------------

/**
 * Promotion metadata tracked alongside a fact. Kept separate from
 * {@link BitemporalFact} so the canonical fact schema stays stable; persisted
 * in a sidecar index (`recall/index.json`) by the recall layer.
 */
export interface TierRecord {
  /** The fact this record annotates. */
  fact_id: string;
  /** Current tier. */
  tier: MemoryTier;
  /** Session ordinal in which the fact was last read or matched a query. */
  last_accessed_session: number;
  /** Session ordinal in which the fact entered its current tier. */
  entered_tier_session: number;
}

/** Size of a fact's serialised content, in bytes (UTF-8). */
export function factBytes(fact: BitemporalFact): number {
  return Buffer.byteLength(`${fact.subject}\n${fact.content}`, 'utf8');
}

/**
 * Total byte footprint of a set of facts — used to police the `core/` budget.
 */
export function totalBytes(facts: readonly BitemporalFact[]): number {
  return facts.reduce((sum, f) => sum + factBytes(f), 0);
}

/**
 * `true` when adding `facts` to `core/` would still fit under
 * {@link CORE_TIER_MAX_BYTES}.
 */
export function coreTierFits(facts: readonly BitemporalFact[]): boolean {
  return totalBytes(facts) <= CORE_TIER_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// Auto-promotion rules
// ---------------------------------------------------------------------------

/** Configuration for the {@link planPromotions} pass. */
export interface PromotionConfig {
  /** Current session ordinal — monotonically increasing per workspace. */
  currentSession: number;
  /** Sessions of inactivity before recall → archive. */
  archiveAfterSessions: number;
}

/** Default {@link PromotionConfig} given just the current session ordinal. */
export function defaultPromotionConfig(currentSession: number): PromotionConfig {
  return {
    currentSession,
    archiveAfterSessions: DEFAULT_ARCHIVE_AFTER_SESSIONS,
  };
}

/** A single decision produced by {@link planPromotions}. */
export interface TierTransition {
  fact_id: string;
  from: MemoryTier;
  to: MemoryTier;
  /** Human-readable rationale, for the cost ledger / activity feed. */
  because: string;
}

/**
 * Decide tier transitions for a batch of {@link TierRecord}s. Two rules:
 *
 *  1. **capture → recall after /dream.** A freshly captured fact still in
 *     `core/` that entered before the current session is moved to `recall/`
 *     once `/dream` consolidates it. (`core/` is reserved for the small
 *     curated always-load set; raw capture should not accumulate there.)
 *  2. **recall → archive after N sessions.** A `recall/` fact untouched for
 *     `archiveAfterSessions` sessions is demoted to `archive/`.
 *
 * Superseded facts are always demoted toward `archive/` — historical, not
 * live — regardless of access recency.
 *
 * Pure: returns the list of transitions; the caller applies them to storage.
 */
export function planPromotions(
  records: readonly TierRecord[],
  facts: readonly BitemporalFact[],
  config: PromotionConfig,
): TierTransition[] {
  const factById = new Map(facts.map((f) => [f.id, f]));
  const transitions: TierTransition[] = [];

  for (const rec of records) {
    const fact = factById.get(rec.fact_id);
    const superseded = fact ? fact.superseded_by !== null : false;

    // Rule: superseded facts belong in archive.
    if (superseded && rec.tier !== 'archive') {
      transitions.push({
        fact_id: rec.fact_id,
        from: rec.tier,
        to: 'archive',
        because: 'fact superseded by a newer fact',
      });
      continue;
    }

    // Rule 1: capture (core) → recall after a dream cycle.
    if (rec.tier === 'core' && rec.entered_tier_session < config.currentSession) {
      transitions.push({
        fact_id: rec.fact_id,
        from: 'core',
        to: 'recall',
        because: 'consolidated by /dream — moved out of always-loaded core',
      });
      continue;
    }

    // Rule 2: recall → archive after N idle sessions.
    if (rec.tier === 'recall') {
      const idle = config.currentSession - rec.last_accessed_session;
      if (idle >= config.archiveAfterSessions) {
        transitions.push({
          fact_id: rec.fact_id,
          from: 'recall',
          to: 'archive',
          because: `idle ${idle} sessions (>= ${config.archiveAfterSessions}) — demoted to archive`,
        });
      }
    }
  }

  return transitions;
}

/**
 * Apply a set of {@link TierTransition}s to a list of {@link TierRecord}s,
 * returning a new list (pure). `entered_tier_session` is reset to
 * `currentSession` for any record that moved.
 */
export function applyTransitions(
  records: readonly TierRecord[],
  transitions: readonly TierTransition[],
  currentSession: number,
): TierRecord[] {
  const moveTo = new Map(transitions.map((t) => [t.fact_id, t.to]));
  return records.map((rec) => {
    const dest = moveTo.get(rec.fact_id);
    if (!dest || dest === rec.tier) {
      return rec;
    }
    return { ...rec, tier: dest, entered_tier_session: currentSession };
  });
}

// ---------------------------------------------------------------------------
// Core-tier overflow guard
// ---------------------------------------------------------------------------

/**
 * When `core/` exceeds {@link CORE_TIER_MAX_BYTES}, pick the facts to evict to
 * `recall/` (largest-first, then oldest-recorded-first) until the tier fits.
 * Returns the eviction transitions; an empty array when core already fits.
 */
export function planCoreOverflow(
  coreFacts: readonly BitemporalFact[],
): TierTransition[] {
  if (coreTierFits(coreFacts)) {
    return [];
  }
  // Eviction priority: biggest payload first; tie-break oldest recorded_at.
  const ordered = coreFacts.slice().sort((a, b) => {
    const sizeDelta = factBytes(b) - factBytes(a);
    return sizeDelta !== 0 ? sizeDelta : a.recorded_at.localeCompare(b.recorded_at);
  });

  const transitions: TierTransition[] = [];
  const kept = coreFacts.slice();
  for (const victim of ordered) {
    if (coreTierFits(kept)) {
      break;
    }
    const idx = kept.findIndex((f) => f.id === victim.id);
    if (idx >= 0) {
      kept.splice(idx, 1);
    }
    transitions.push({
      fact_id: victim.id,
      from: 'core',
      to: 'recall',
      because: `core tier over ${CORE_TIER_MAX_BYTES}B budget — evicted largest fact`,
    });
  }
  return transitions;
}
