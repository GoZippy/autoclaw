/**
 * metrics/ledgerBridge.ts — real-token bridge to the existing LLM cost ledger
 * (intelligence-metrics-dashboard R2.1-R2.4, decision D2).
 *
 * Decision D2: capture REAL token usage by reading AutoClaw's existing
 * `src/llm` cost ledger (`.autoclaw/llm/cost-ledger.jsonl`) rather than wrapping
 * SDKs in a parallel token store. The v5 reference `llm-token-logger.js` only
 * informs *what* is captured (prompt/completion tokens, model, provider) — it is
 * NOT shipped as a second logger.
 *
 * HOST-FREE: no `vscode` import. The reader is injectable (`LedgerLike`) so tests
 * drive it with a stubbed ledger; the default reads the real `CostLedger`.
 *
 * Privacy / config: when `config.tokenLogging.enabled` is false, this surfaces
 * NO real-token records (R2.3) — the dashboard then shows estimates only.
 */

import { CostLedger, LedgerRow } from '../../llm/costLedger';
import { IntelligenceConfig } from '../types';
import { RealTokenUsage } from './store';

// ---------------------------------------------------------------------------
// Injectable ledger surface (the subset of CostLedger this bridge needs)
// ---------------------------------------------------------------------------

/** Minimal read surface of the cost ledger — lets tests stub it. */
export interface LedgerLike {
  readAll(): Promise<LedgerRow[]>;
}

/** Options narrowing which ledger rows count toward a run's real usage. */
export interface AggregateOptions {
  /** Only rows whose `timestamp` is >= this epoch-ms watermark (per-run scope). */
  sinceTs?: number;
  /** Only rows with this `runId` (precise per-run attribution when present). */
  runId?: string;
  /** Only rows with this `sessionId`. */
  sessionId?: string;
  /** Only these operations (default: `['chat']` — completions drive token cost). */
  operations?: LedgerRow['operation'][];
  /** Injected ledger reader; defaults to a real {@link CostLedger}. */
  ledger?: LedgerLike;
}

/** Result of aggregating real token usage from the ledger. */
export interface LedgerAggregate {
  /** True when token logging is enabled AND at least one matching row existed. */
  available: boolean;
  /** Marks these tokens as real (true) vs estimated. Always true when available. */
  real: boolean;
  /** Aggregated prompt/completion tokens + dominant model/provider. */
  usage: RealTokenUsage;
  /** Real cost in USD (ledger stores cents). */
  costUsd: number;
  /** Number of ledger rows that contributed. */
  rowCount: number;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** The "nothing available" result (disabled, or no matching rows). */
function unavailable(): LedgerAggregate {
  return {
    available: false,
    real: false,
    usage: { prompt: 0, completion: 0 },
    costUsd: 0,
    rowCount: 0,
  };
}

/** Pick the most frequent value in a tally map (ties broken lexicographically). */
function dominant(tally: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = -1;
  for (const [key, count] of tally) {
    if (count > bestCount || (count === bestCount && best !== undefined && key < best)) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function rowMatches(row: LedgerRow, opts: AggregateOptions, ops: Set<string>): boolean {
  if (!ops.has(row.operation)) {
    return false;
  }
  if (opts.runId !== undefined && row.runId !== opts.runId) {
    return false;
  }
  if (opts.sessionId !== undefined && row.sessionId !== opts.sessionId) {
    return false;
  }
  if (opts.sinceTs !== undefined) {
    const t = Date.parse(row.timestamp);
    if (!Number.isFinite(t) || t < opts.sinceTs) {
      return false;
    }
  }
  return true;
}

/**
 * Aggregate REAL token usage + cost from the cost ledger for the workspace.
 *
 * Honors `config.tokenLogging.enabled` (R2.3): when disabled, returns the
 * unavailable result and reads nothing. When enabled, reads the ledger (real or
 * stubbed), filters by {@link AggregateOptions}, and sums prompt/completion
 * tokens + cost, choosing the dominant model/provider for display.
 *
 * The returned `real`/`available` flags let the store + UI mark real tokens as
 * distinct from estimates (R2.4).
 */
export async function aggregateRealTokens(
  workspaceRoot: string,
  config: IntelligenceConfig,
  opts: AggregateOptions = {},
): Promise<LedgerAggregate> {
  if (!config.tokenLogging?.enabled) {
    return unavailable(); // R2.3 — no token logs when disabled
  }

  const ledger: LedgerLike = opts.ledger ?? new CostLedger(workspaceRoot);
  const ops = new Set<string>(opts.operations ?? ['chat']);

  let rows: LedgerRow[];
  try {
    rows = await ledger.readAll();
  } catch {
    return unavailable(); // ledger unreadable → estimates only
  }

  let prompt = 0;
  let completion = 0;
  let costCents = 0;
  let rowCount = 0;
  const models = new Map<string, number>();
  const providers = new Map<string, number>();

  for (const row of rows) {
    if (!row || !row.tokens || !rowMatches(row, opts, ops)) {
      continue;
    }
    prompt += Math.max(0, Math.floor(row.tokens.input ?? 0));
    completion += Math.max(0, Math.floor(row.tokens.output ?? 0));
    costCents += Math.max(0, row.costCents ?? 0);
    rowCount += 1;
    if (row.model) {
      models.set(row.model, (models.get(row.model) ?? 0) + 1);
    }
    if (row.provider) {
      providers.set(row.provider, (providers.get(row.provider) ?? 0) + 1);
    }
  }

  if (rowCount === 0) {
    return unavailable(); // enabled but no matching usage → estimates only
  }

  const usage: RealTokenUsage = { prompt, completion };
  const model = dominant(models);
  const provider = dominant(providers);
  if (model) {
    usage.model = model;
  }
  if (provider) {
    usage.provider = provider;
  }

  return {
    available: true,
    real: true,
    usage,
    costUsd: costCents / 100,
    rowCount,
  };
}
