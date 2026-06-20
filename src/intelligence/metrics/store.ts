/**
 * metrics/store.ts — the learning-run metrics store for the AutoClaw
 * Intelligence Layer (intelligence-metrics-dashboard R1.1-R1.3).
 *
 * Records one {@link LearningRunStats} row per `/learn` run, persists to
 * `.autoclaw/metrics/token-metrics.json` with lock-protected writes, retains
 * the last {@link MAX_RUNS} runs, and precomputes summary + trend series so the
 * dashboard renders without recomputing on every paint.
 *
 * HOST-FREE: this module never imports `vscode`. It uses only the host-free
 * primitives (`fs`, `paths`, `fileLock`) so the whole metrics surface is
 * unit-testable outside the extension host (mirrors the rest of
 * `src/intelligence/`). The dashboard view (`src/views/intelligenceDashboard.ts`)
 * is the only file that bridges this into `vscode`.
 *
 * Corruption tolerance (design "Error handling"): a missing / unparseable /
 * wrong-shape store is treated as empty rather than throwing — a run in
 * progress is never lost because the prior file could not be read.
 */

import * as fs from 'fs';
import * as path from 'path';

import { acquireLock } from '../fileLock';
import { ensureDir, intelligencePaths, toForwardSlash } from '../paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bound on retained runs (R1.2 — "at least the last 100 runs"). */
export const MAX_RUNS = 100;

/** Schema version of the on-disk store, bumped on incompatible changes. */
export const METRICS_SCHEMA_VERSION = 1;

/** File name under `.autoclaw/metrics/`. */
export const METRICS_FILE_NAME = 'token-metrics.json';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Real token usage attached to a run when the cost ledger is available
 * (see `metrics/ledgerBridge.ts`). Absent ⇒ the run only has estimates.
 */
export interface RealTokenUsage {
  /** Prompt / input tokens summed across the run's LLM calls. */
  prompt: number;
  /** Completion / output tokens summed across the run's LLM calls. */
  completion: number;
  /** Dominant model id observed, when known. */
  model?: string;
  /** Dominant provider id observed, when known. */
  provider?: string;
}

/** A single recorded learning run (R1.1). */
export interface LearningRunStats {
  /** ISO timestamp the run completed. */
  ts: string;
  /** Number of (deduped) sessions analyzed this run. */
  sessionsAnalyzed: number;
  /** Total kept-code signals observed. */
  kept: number;
  /** kept / sessionsAnalyzed in 0..1 (0 when no sessions). */
  keptRate: number;
  /** Distilled patterns persisted this run (successful + avoided). */
  patternsLearned: number;
  /** Optional free-text focus the run was scoped to. */
  focus?: string;
  /** Distinct Source Adapter ids that contributed, sorted. */
  sources: string[];
  /** Estimated tokens consumed by the run (always present). */
  estTokens: number;
  /** Whether git enrichment ran for this run. */
  gitEnriched: boolean;
  /** Real token usage from the cost ledger when available (R2.4). */
  realTokens?: RealTokenUsage;
  /** Real cost in USD when the ledger reported it (cost is first-class, D-doc10). */
  costUsd?: number;
}

/** A single point on a time-series trend. */
export interface TrendPoint {
  ts: string;
  value: number;
}

/** Precomputed token totals split by provenance (R2.4 — real vs estimated). */
export interface TokenTotals {
  /** Sum of `estTokens` across retained runs. */
  estimated: number;
  /** Sum of real `prompt + completion` across runs that had ledger data. */
  real: number;
  /** True when at least one retained run carried real ledger tokens. */
  hasReal: boolean;
}

/** Rolled-up summary across the retained runs. */
export interface MetricsSummary {
  /** Count of retained runs. */
  totalRuns: number;
  /** Total sessions analyzed across retained runs. */
  totalSessions: number;
  /** Total kept-code signals across retained runs. */
  totalKept: number;
  /** Mean kept rate (0..1) across retained runs. */
  avgKeptRate: number;
  /** Total patterns learned across retained runs. */
  totalPatterns: number;
  /** Token totals split real vs estimated. */
  tokens: TokenTotals;
  /** Total real cost in USD across retained runs. */
  totalCostUsd: number;
  /** The most recent run, or null when the store is empty. */
  lastRun: LearningRunStats | null;
}

/** Precomputed trend series for fast rendering. */
export interface MetricsTrends {
  /** kept-rate (0..1) over time, oldest → newest. */
  keptRate: TrendPoint[];
  /** patterns-learned over time, oldest → newest. */
  patterns: TrendPoint[];
  /** estimated tokens over time, oldest → newest. */
  estTokens: TrendPoint[];
  /** real tokens (prompt + completion) over time; 0 where no ledger data. */
  realTokens: TrendPoint[];
}

/** On-disk shape of `.autoclaw/metrics/token-metrics.json`. */
export interface MetricsFile {
  version: number;
  runs: LearningRunStats[];
  summary: MetricsSummary;
  trends: MetricsTrends;
}

/** Shaped payload the dashboard webview consumes. */
export interface DashboardData {
  summary: MetricsSummary;
  trends: MetricsTrends;
  /** The retained runs (oldest → newest), capped to the requested limit. */
  runs: LearningRunStats[];
  /** True when there is nothing to show yet (drives the empty state). */
  empty: boolean;
  /**
   * Vector-backend presence for the at-a-glance indicator. Attached by the
   * dashboard provider (not the metrics store) so the webview can show a green
   * "online" pill and hide the Deploy-backend CTA when the backend is installed.
   */
  backend?: { installed: boolean; path: string };
}

// ---------------------------------------------------------------------------
// Validation / normalization (corruption tolerance)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Coerce one raw run into a valid {@link LearningRunStats}, or null if unusable. */
function normalizeRun(raw: unknown): LearningRunStats | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const ts = str(raw.ts);
  if (!ts) {
    return null; // a run without a timestamp is meaningless for trends
  }
  const sessionsAnalyzed = Math.max(0, Math.floor(num(raw.sessionsAnalyzed)));
  const kept = Math.max(0, Math.floor(num(raw.kept)));
  const keptRateRaw = num(raw.keptRate, sessionsAnalyzed > 0 ? kept / sessionsAnalyzed : 0);
  const keptRate = Math.min(1, Math.max(0, keptRateRaw));

  const run: LearningRunStats = {
    ts,
    sessionsAnalyzed,
    kept,
    keptRate,
    patternsLearned: Math.max(0, Math.floor(num(raw.patternsLearned))),
    sources: strArray(raw.sources),
    estTokens: Math.max(0, Math.floor(num(raw.estTokens))),
    gitEnriched: raw.gitEnriched === true,
  };

  const focus = str(raw.focus);
  if (focus) {
    run.focus = focus;
  }

  if (isPlainObject(raw.realTokens)) {
    const rt = raw.realTokens;
    const real: RealTokenUsage = {
      prompt: Math.max(0, Math.floor(num(rt.prompt))),
      completion: Math.max(0, Math.floor(num(rt.completion))),
    };
    const model = str(rt.model);
    const provider = str(rt.provider);
    if (model) {
      real.model = model;
    }
    if (provider) {
      real.provider = provider;
    }
    run.realTokens = real;
  }

  if (typeof raw.costUsd === 'number' && Number.isFinite(raw.costUsd)) {
    run.costUsd = Math.max(0, raw.costUsd);
  }

  return run;
}

// ---------------------------------------------------------------------------
// Pure computation (exported for tests)
// ---------------------------------------------------------------------------

/** Compute the rolled-up summary over the retained runs (oldest → newest). */
export function computeSummary(runs: LearningRunStats[]): MetricsSummary {
  if (runs.length === 0) {
    return {
      totalRuns: 0,
      totalSessions: 0,
      totalKept: 0,
      avgKeptRate: 0,
      totalPatterns: 0,
      tokens: { estimated: 0, real: 0, hasReal: false },
      totalCostUsd: 0,
      lastRun: null,
    };
  }

  let totalSessions = 0;
  let totalKept = 0;
  let keptRateSum = 0;
  let totalPatterns = 0;
  let estimated = 0;
  let real = 0;
  let hasReal = false;
  let totalCostUsd = 0;

  for (const r of runs) {
    totalSessions += r.sessionsAnalyzed;
    totalKept += r.kept;
    keptRateSum += r.keptRate;
    totalPatterns += r.patternsLearned;
    estimated += r.estTokens;
    if (r.realTokens) {
      real += r.realTokens.prompt + r.realTokens.completion;
      hasReal = true;
    }
    if (typeof r.costUsd === 'number') {
      totalCostUsd += r.costUsd;
    }
  }

  return {
    totalRuns: runs.length,
    totalSessions,
    totalKept,
    avgKeptRate: keptRateSum / runs.length,
    totalPatterns,
    tokens: { estimated, real, hasReal },
    totalCostUsd,
    lastRun: runs[runs.length - 1],
  };
}

/** Compute trend series over the retained runs (oldest → newest). */
export function computeTrends(runs: LearningRunStats[]): MetricsTrends {
  return {
    keptRate: runs.map((r) => ({ ts: r.ts, value: r.keptRate })),
    patterns: runs.map((r) => ({ ts: r.ts, value: r.patternsLearned })),
    estTokens: runs.map((r) => ({ ts: r.ts, value: r.estTokens })),
    realTokens: runs.map((r) => ({
      ts: r.ts,
      value: r.realTokens ? r.realTokens.prompt + r.realTokens.completion : 0,
    })),
  };
}

/** Build a complete {@link MetricsFile} from a list of runs (bounding + recompute). */
export function buildMetricsFile(runs: LearningRunStats[]): MetricsFile {
  const bounded = runs.slice(-MAX_RUNS);
  return {
    version: METRICS_SCHEMA_VERSION,
    runs: bounded,
    summary: computeSummary(bounded),
    trends: computeTrends(bounded),
  };
}

function emptyMetricsFile(): MetricsFile {
  return buildMetricsFile([]);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Resolve the `.autoclaw/metrics/token-metrics.json` path for a workspace. */
export function metricsFilePath(workspaceRoot: string): string {
  const { metricsDir } = intelligencePaths(workspaceRoot);
  return toForwardSlash(path.join(metricsDir, METRICS_FILE_NAME));
}

/**
 * Read + normalize the store. NEVER throws: a missing / unparseable / wrong
 * shape file yields an empty store (R1 error handling). Only the `runs` array
 * is trusted from disk; summary + trends are always recomputed so the file
 * cannot drift out of sync with its own runs.
 */
export function getMetrics(workspaceRoot: string): MetricsFile {
  const file = metricsFilePath(workspaceRoot);
  let raw: string;
  try {
    if (!fs.existsSync(file)) {
      return emptyMetricsFile();
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return emptyMetricsFile();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyMetricsFile(); // corruption → reinitialize empty
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.runs)) {
    return emptyMetricsFile();
  }

  const runs = parsed.runs
    .map(normalizeRun)
    .filter((r): r is LearningRunStats => r !== null);

  return buildMetricsFile(runs);
}

/**
 * Append a learning run and persist, lock-protected (R1.3). Reads the current
 * store under the lock, appends, bounds to the last {@link MAX_RUNS}, recomputes
 * summary + trends, and writes atomically-ish (single writeFile). Returns the
 * recomputed store.
 *
 * @param workspaceRoot directory that contains (or will contain) `.autoclaw`
 * @param stats         the run to record
 */
export async function recordLearningRun(
  workspaceRoot: string,
  stats: LearningRunStats,
): Promise<MetricsFile> {
  const { metricsDir } = intelligencePaths(workspaceRoot);
  await ensureDir(metricsDir);
  const file = metricsFilePath(workspaceRoot);

  const release = await acquireLock(file);
  try {
    const current = getMetrics(workspaceRoot);
    const normalized = normalizeRun(stats) ?? stats;
    const next = buildMetricsFile([...current.runs, normalized]);
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } finally {
    release();
  }
}

/**
 * Shape the store for the dashboard webview (R4). `limit` caps the number of
 * most-recent runs returned (default {@link MAX_RUNS}); summary + trends always
 * reflect the full retained window. `empty` drives the dashboard empty state.
 */
export function getDashboardData(workspaceRoot: string, limit: number = MAX_RUNS): DashboardData {
  const metrics = getMetrics(workspaceRoot);
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_RUNS;
  const runs = metrics.runs.slice(-cap);
  return {
    summary: metrics.summary,
    trends: metrics.trends,
    runs,
    empty: metrics.runs.length === 0,
  };
}
