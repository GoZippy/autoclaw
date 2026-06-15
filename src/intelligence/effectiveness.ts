/**
 * effectiveness.ts — tool × project effectiveness matrix for the AutoClaw
 * Intelligence Layer.
 *
 * The metrics store tracks *per-run* aggregates (kept rate, tokens, cost). This
 * module pivots the SAME session corpus a different way: for every (tool) and
 * every (tool × project) it computes ship rate, kept-signal density, and a
 * rough token-ROI (estimated tokens per kept signal). That turns "session
 * mining" into routing fuel — e.g. "for this repo, Claude Code ships 0.82 vs
 * Cursor 0.55" — which the capability router / model oracle can consume.
 *
 * Source-agnostic: reads only the normalized {@link UnifiedSession} contract and
 * delegates the ship/discard judgement to {@link deriveOutcome} so it agrees
 * with `learn` and `ranking`. Pure + host-free: no `vscode`, no I/O, fully
 * deterministic + unit-testable. Persistence lives in
 * `metrics/effectivenessStore.ts`.
 */

import { UnifiedSession } from './types';
import { deriveOutcome } from './ranking';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One row of the matrix: a tool, optionally scoped to a project. */
export interface EffectivenessCell {
  /** Human tool name (e.g. "Claude Code"). */
  tool: string;
  /** Project key (resolved path) for per-project rows; `'(all)'` for tool rows. */
  project: string;
  /** Friendly short project label (basename) for display; `'(all)'` for tool rows. */
  projectLabel: string;
  /** Sessions counted in this cell. */
  sessions: number;
  /** Sessions whose derived outcome was `shipped`. */
  shipped: number;
  /** Sessions whose derived outcome was `discarded`. */
  discarded: number;
  /** Total kept-code signals summed across the cell's sessions. */
  keptSignals: number;
  /** Estimated tokens summed across the cell's sessions. */
  estTokens: number;
  /** shipped / sessions in 0..1. */
  shipRate: number;
  /** keptSignals / sessions. */
  keptPerSession: number;
  /** estTokens / max(1, keptSignals) — lower is more token-efficient. */
  tokensPerKept: number;
}

/** The full effectiveness snapshot. */
export interface EffectivenessMatrix {
  /** ISO timestamp the matrix was computed. */
  generatedAt: string;
  /** Total sessions that fed the matrix. */
  totalSessions: number;
  /** One row per tool, ranked best (highest ship rate) first. */
  byTool: EffectivenessCell[];
  /** One row per tool × project, ranked best first. */
  byToolProject: EffectivenessCell[];
}

export interface ComputeEffectivenessOptions {
  /** ISO timestamp to stamp; injectable for deterministic tests. */
  now?: string;
  /** Drop tool×project rows below this session count. Default 1. */
  minSessionsPerCell?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL = '(all)';

/** Rough token estimate for a single session: real usage hint, else ~4 chars/token. */
function estimateSessionTokens(s: UnifiedSession): number {
  const usage = s.signals?.tokenUsage;
  if (usage) {
    return Math.max(0, usage.prompt) + Math.max(0, usage.completion);
  }
  let chars = 0;
  for (const m of s.messages) {
    chars += (m.text ?? '').length;
    for (const b of m.codeBlocks ?? []) {
      chars += (b.code ?? '').length;
    }
  }
  return Math.ceil(chars / 4);
}

/** Short label for a project path (last path segment), or `(unknown)`. */
function projectLabelOf(project: string | undefined): string {
  if (!project || project.trim() === '') {
    return '(unknown)';
  }
  const parts = project.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || project;
}

interface Acc {
  tool: string;
  project: string;
  projectLabel: string;
  sessions: number;
  shipped: number;
  discarded: number;
  keptSignals: number;
  estTokens: number;
}

function emptyAcc(tool: string, project: string, projectLabel: string): Acc {
  return {
    tool,
    project,
    projectLabel,
    sessions: 0,
    shipped: 0,
    discarded: 0,
    keptSignals: 0,
    estTokens: 0,
  };
}

function finalize(a: Acc): EffectivenessCell {
  return {
    tool: a.tool,
    project: a.project,
    projectLabel: a.projectLabel,
    sessions: a.sessions,
    shipped: a.shipped,
    discarded: a.discarded,
    keptSignals: a.keptSignals,
    estTokens: a.estTokens,
    shipRate: a.sessions > 0 ? a.shipped / a.sessions : 0,
    keptPerSession: a.sessions > 0 ? a.keptSignals / a.sessions : 0,
    tokensPerKept: a.estTokens / Math.max(1, a.keptSignals),
  };
}

function rank(a: EffectivenessCell, b: EffectivenessCell): number {
  return (
    b.shipRate - a.shipRate ||
    b.sessions - a.sessions ||
    a.tokensPerKept - b.tokensPerKept ||
    a.tool.localeCompare(b.tool) ||
    a.projectLabel.localeCompare(b.projectLabel)
  );
}

// ---------------------------------------------------------------------------
// computeEffectiveness
// ---------------------------------------------------------------------------

/** Build the {@link EffectivenessMatrix} from a corpus of sessions. */
export function computeEffectiveness(
  sessions: UnifiedSession[],
  options: ComputeEffectivenessOptions = {},
): EffectivenessMatrix {
  const now = options.now ?? new Date().toISOString();
  const minCell = Math.max(1, options.minSessionsPerCell ?? 1);

  const byTool = new Map<string, Acc>();
  const byToolProject = new Map<string, Acc>();

  for (const s of sessions) {
    const tool = (s.tool || s.source || 'unknown').trim() || 'unknown';
    const project = s.project ?? '(unknown)';
    const label = projectLabelOf(s.project);
    const outcome = deriveOutcome(s).outcome;
    const kept = s.signals?.keptCode?.length ?? 0;
    const tokens = estimateSessionTokens(s);

    const tAcc = byTool.get(tool) ?? emptyAcc(tool, ALL, ALL);
    byTool.set(tool, tAcc);
    const tpKey = `${tool}::${project}`;
    const tpAcc = byToolProject.get(tpKey) ?? emptyAcc(tool, project, label);
    byToolProject.set(tpKey, tpAcc);

    for (const acc of [tAcc, tpAcc]) {
      acc.sessions++;
      acc.keptSignals += kept;
      acc.estTokens += tokens;
      if (outcome === 'shipped') {
        acc.shipped++;
      } else if (outcome === 'discarded') {
        acc.discarded++;
      }
    }
  }

  return {
    generatedAt: now,
    totalSessions: sessions.length,
    byTool: Array.from(byTool.values()).map(finalize).sort(rank),
    byToolProject: Array.from(byToolProject.values())
      .filter((a) => a.sessions >= minCell)
      .map(finalize)
      .sort(rank),
  };
}
