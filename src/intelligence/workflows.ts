/**
 * workflows.ts — workflow-sequence mining for the AutoClaw Intelligence Layer.
 *
 * The `/learn` pipeline already learns *what* code was kept. This module learns
 * *how* an agent got there: the ordered sequence of tool actions inside a
 * session (Read → Edit → Bash → …) and whether sessions that follow a given
 * sub-sequence tend to SHIP or get DISCARDED. The result is a ranked set of
 * "successful workflows" and "anti-workflows" that feed back into the durable
 * memory + agent-style guidance.
 *
 * Source-agnostic by construction: it reads only the normalized
 * {@link UnifiedSession} contract. Tool actions are recovered from the
 * `[tool_use NAME …]` markers that {@link flattenClaudeContent} (and the other
 * transcript adapters) embed in message text, so adding a new source never
 * touches this file. Sessions that expose no tool markers contribute nothing
 * (they are simply skipped), so prose-only tools degrade cleanly.
 *
 * Outcome judgement is delegated to {@link deriveOutcome} so this module agrees
 * with the rest of the layer on what "shipped" means (git_commit >
 * applied_edit > user_approval > none).
 *
 * Pure + host-free: no `vscode`, no I/O, fully deterministic + unit-testable.
 */

import { SessionOutcome, UnifiedSession } from './types';
import { deriveOutcome } from './ranking';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One session reduced to its ordered tool-action sequence + derived outcome. */
export interface SessionWorkflow {
  /** Session id (provenance back to the transcript). */
  id: string;
  /** Human tool name that ran the session (e.g. "Claude Code"). */
  tool: string;
  /** Ordered tool-action names, e.g. `['Read','Edit','Bash']`. */
  steps: string[];
  /** Shipped / discarded / unknown per {@link deriveOutcome}. */
  outcome: SessionOutcome;
}

/** A tool-action sub-sequence and how it correlated with shipping. */
export interface WorkflowPattern {
  /** The n-gram of tool actions. */
  sequence: string[];
  /** `sequence.join(' → ')` for display. */
  label: string;
  /** Sessions containing this sub-sequence that SHIPPED. */
  shipped: number;
  /** Sessions containing this sub-sequence that were DISCARDED. */
  discarded: number;
  /** Sessions containing this sub-sequence with an unknown outcome. */
  unknown: number;
  /** Distinct sessions containing this sub-sequence (= shipped+discarded+unknown). */
  total: number;
  /** shipped / (shipped + discarded); 0 when no decided sessions. */
  shipRate: number;
}

/** The ranked workflow signal extracted from a corpus of sessions. */
export interface WorkflowInsights {
  /** High-ship sub-sequences with enough support, best first. */
  successful: WorkflowPattern[];
  /** Low-ship / discard-prone sub-sequences with enough support, worst first. */
  antiPatterns: WorkflowPattern[];
  /** Tool-action frequency across the whole corpus, most-used first. */
  stepFrequency: Array<{ tool: string; count: number }>;
  /** Sessions that exposed at least one tool action (the mineable population). */
  sessionsWithSteps: number;
}

/** Tunables for {@link mineWorkflows}. */
export interface MineWorkflowsOptions {
  /** Smallest n-gram length considered. Default 2. */
  minN?: number;
  /** Largest n-gram length considered. Default 3. */
  maxN?: number;
  /** Minimum distinct sessions a sub-sequence needs to be ranked. Default 3. */
  minSupport?: number;
  /** Minimum DECIDED sessions (shipped+discarded) for a ship rate to be trusted.
   *  Guards against a "100%" computed off one or two decided sessions. Default 3. */
  minDecided?: number;
  /** shipRate at/above which a pattern is "successful". Default 0.6. */
  shipThreshold?: number;
  /** shipRate at/below which a pattern is an "anti-pattern". Default 0.34. */
  antiThreshold?: number;
  /** Collapse runs of the same tool (Read,Read,Read → Read). Default true. */
  collapseConsecutive?: boolean;
  /** Cap on how many successful / anti patterns are returned each. Default 12. */
  maxPatterns?: number;
}

// ---------------------------------------------------------------------------
// Tool-action extraction
// ---------------------------------------------------------------------------

/**
 * Matches the `[tool_use NAME …]` marker emitted by the transcript adapters.
 * Tool names may contain dots / underscores / hyphens (e.g. `Read`, `Bash`,
 * `mcp__server__tool`), so the capture stops at whitespace or a closing bracket.
 */
const TOOL_USE_MARKER = /\[tool_use\s+([^\s\]]+)/g;

/** Pull the ordered tool-action names out of one session's transcript. */
export function extractToolSteps(
  session: UnifiedSession,
  collapseConsecutive = true,
): string[] {
  const steps: string[] = [];
  for (const m of session.messages) {
    const text = m.text ?? '';
    if (!text.includes('[tool_use')) {
      continue;
    }
    TOOL_USE_MARKER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOOL_USE_MARKER.exec(text)) !== null) {
      const name = match[1].trim();
      if (name) {
        steps.push(name);
      }
    }
  }
  if (!collapseConsecutive) {
    return steps;
  }
  const collapsed: string[] = [];
  for (const s of steps) {
    if (collapsed[collapsed.length - 1] !== s) {
      collapsed.push(s);
    }
  }
  return collapsed;
}

/** Reduce a session to its {@link SessionWorkflow} (steps + derived outcome). */
export function extractSessionWorkflow(
  session: UnifiedSession,
  collapseConsecutive = true,
): SessionWorkflow {
  return {
    id: session.id,
    tool: session.tool || session.source || 'unknown',
    steps: extractToolSteps(session, collapseConsecutive),
    outcome: deriveOutcome(session).outcome,
  };
}

// ---------------------------------------------------------------------------
// n-gram accumulation
// ---------------------------------------------------------------------------

interface Tally {
  sequence: string[];
  shipped: number;
  discarded: number;
  unknown: number;
}

/** Distinct n-grams of length `n` within `steps`, key → ordered tokens. */
function distinctNGrams(steps: string[], n: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (steps.length < n) {
    return out;
  }
  for (let i = 0; i + n <= steps.length; i++) {
    const gram = steps.slice(i, i + n);
    const key = gram.join('');
    if (!out.has(key)) {
      out.set(key, gram);
    }
  }
  return out;
}

function shipRateOf(t: Tally): number {
  const decided = t.shipped + t.discarded;
  return decided > 0 ? t.shipped / decided : 0;
}

function toPattern(t: Tally): WorkflowPattern {
  const total = t.shipped + t.discarded + t.unknown;
  const shipRate = shipRateOf(t);
  return {
    sequence: t.sequence,
    label: t.sequence.join(' → '),
    shipped: t.shipped,
    discarded: t.discarded,
    unknown: t.unknown,
    total,
    shipRate,
  };
}

// ---------------------------------------------------------------------------
// mineWorkflows
// ---------------------------------------------------------------------------

/**
 * Mine ranked workflow patterns from a corpus of sessions. Each session is
 * counted at most once per distinct sub-sequence it contains, so a session that
 * repeats a loop cannot dominate the tally. A pattern is "successful" when it
 * clears `minSupport` and its `shipRate >= shipThreshold`; an "anti-pattern"
 * when it clears `minSupport`, has at least one discard, and
 * `shipRate <= antiThreshold`.
 */
export function mineWorkflows(
  sessions: UnifiedSession[],
  options: MineWorkflowsOptions = {},
): WorkflowInsights {
  const minN = Math.max(1, options.minN ?? 2);
  const maxN = Math.max(minN, options.maxN ?? 3);
  const minSupport = Math.max(1, options.minSupport ?? 3);
  const minDecided = Math.max(1, options.minDecided ?? 3);
  const shipThreshold = options.shipThreshold ?? 0.6;
  const antiThreshold = options.antiThreshold ?? 0.34;
  const collapse = options.collapseConsecutive ?? true;
  const maxPatterns = Math.max(1, options.maxPatterns ?? 12);

  const tallies = new Map<string, Tally>();
  const stepFreq = new Map<string, number>();
  let sessionsWithSteps = 0;

  for (const session of sessions) {
    const wf = extractSessionWorkflow(session, collapse);
    if (wf.steps.length === 0) {
      continue;
    }
    sessionsWithSteps++;
    for (const step of wf.steps) {
      stepFreq.set(step, (stepFreq.get(step) ?? 0) + 1);
    }

    // Collect every distinct sub-sequence this session contributes, across all
    // requested n, then credit each ONCE with the session's outcome.
    const seen = new Map<string, string[]>();
    for (let n = minN; n <= maxN; n++) {
      for (const [key, gram] of distinctNGrams(wf.steps, n)) {
        if (!seen.has(key)) {
          seen.set(key, gram);
        }
      }
    }
    for (const [key, gram] of seen) {
      let t = tallies.get(key);
      if (!t) {
        t = { sequence: gram, shipped: 0, discarded: 0, unknown: 0 };
        tallies.set(key, t);
      }
      if (wf.outcome === 'shipped') {
        t.shipped++;
      } else if (wf.outcome === 'discarded') {
        t.discarded++;
      } else {
        t.unknown++;
      }
    }
  }

  const patterns = Array.from(tallies.values())
    .filter((t) => t.shipped + t.discarded + t.unknown >= minSupport)
    .map(toPattern);

  const successful = patterns
    .filter((p) => p.shipped + p.discarded >= minDecided && p.shipRate >= shipThreshold && p.shipped > 0)
    .sort(
      (a, b) =>
        b.shipRate - a.shipRate ||
        b.shipped - a.shipped ||
        b.sequence.length - a.sequence.length ||
        a.label.localeCompare(b.label),
    )
    .slice(0, maxPatterns);

  const antiPatterns = patterns
    .filter((p) => p.shipped + p.discarded >= minDecided && p.discarded > 0 && p.shipRate <= antiThreshold)
    .sort(
      (a, b) =>
        a.shipRate - b.shipRate ||
        b.discarded - a.discarded ||
        b.sequence.length - a.sequence.length ||
        a.label.localeCompare(b.label),
    )
    .slice(0, maxPatterns);

  const stepFrequency = Array.from(stepFreq.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tool, count]) => ({ tool, count }));

  return { successful, antiPatterns, stepFrequency, sessionsWithSteps };
}

// ---------------------------------------------------------------------------
// Labels (consumed by learn.ts when folding workflows into durable memory)
// ---------------------------------------------------------------------------

/**
 * A compact human label: `Read → Edit → Bash (ships 86%, n=14)`. `n` is the
 * DECIDED support (shipped + discarded) — the base the percentage is actually
 * computed over — not the raw total (which includes unlabeled sessions).
 */
export function workflowPatternLabel(p: WorkflowPattern): string {
  const pct = Math.round(p.shipRate * 100);
  return `${p.label} (ships ${pct}%, n=${p.shipped + p.discarded})`;
}
