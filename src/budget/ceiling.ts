/**
 * ceiling.ts — Cost-as-instrument: a spend / wall-clock ceiling that engages the
 * fleet kill switch when breached.
 *
 * Borrowed from openclaw/crabbox's cost guardrails (per-lease + monthly spend
 * caps that reject over-budget leases; `usage` rolls spend up). The LFD playbook
 * (IDEAS_LOG §L) frames the gap precisely: "a constraint without an instrument
 * is a vibe" — agents have no innate sense of money or elapsed time. This is the
 * instrument: a queryable spend/time status, plus enforcement that reuses the
 * existing fleet HALT switch (HKS-3) so an over-budget fleet stops dispatching
 * and the operator sees the reason.
 *
 * Local-first + opt-in: with no `.autoclaw/orchestrator/budget.json` there is no
 * ceiling and every function is a no-op (enabled:false). Spend is read from the
 * existing LLM cost ledger; the wall-clock is measured from a small armed-at
 * marker so the clock survives restarts.
 */

import * as fs from 'fs';
import * as path from 'path';

import { CostLedger } from '../llm/costLedger';
import { setFleetHalted, isFleetHalted } from '../hooks/fleetHalt';

const fsPromises = fs.promises;

/** Ceiling config location (workspace-relative). Absent ⇒ no ceiling. */
export const BUDGET_FILE_REL = path.join('.autoclaw', 'orchestrator', 'budget.json');
/** Wall-clock epoch marker (workspace-relative). Written lazily on first check. */
export const BUDGET_STATE_REL = path.join('.autoclaw', 'orchestrator', 'budget-state.json');

/** The spend / time ceiling. Either bound is optional; omit both ⇒ no limit. */
export interface BudgetCeiling {
  /** Hard cap on total spend (USD) read from the cost ledger. */
  max_spend_usd?: number;
  /** Hard cap on wall-clock (ms) since the budget clock was armed. */
  max_wallclock_ms?: number;
}

/** The result of a budget check — the queryable instrument output. */
export interface BudgetStatus {
  /** True when a ceiling is configured; false ⇒ everything below is inert. */
  enabled: boolean;
  /** True when no bound is breached (always true when disabled). */
  within: boolean;
  spend_usd: number;
  /** Elapsed wall-clock since arming; undefined when no time bound is set. */
  wallclock_ms?: number;
  /** Human-readable reasons, one per breached bound. */
  breaches: string[];
  ceiling?: BudgetCeiling;
}

/** Read the configured ceiling. Missing/empty/malformed ⇒ undefined (disabled). */
export async function readBudgetCeiling(workspaceRoot: string): Promise<BudgetCeiling | undefined> {
  try {
    const raw = (await fsPromises.readFile(path.join(workspaceRoot, BUDGET_FILE_REL), 'utf8')).replace(/^﻿/, '');
    const c = JSON.parse(raw) as BudgetCeiling;
    const hasSpend = typeof c.max_spend_usd === 'number' && c.max_spend_usd >= 0;
    const hasTime = typeof c.max_wallclock_ms === 'number' && c.max_wallclock_ms >= 0;
    if (!hasSpend && !hasTime) { return undefined; }
    return {
      ...(hasSpend ? { max_spend_usd: c.max_spend_usd } : {}),
      ...(hasTime ? { max_wallclock_ms: c.max_wallclock_ms } : {}),
    };
  } catch { return undefined; }
}

/**
 * Arm (or read) the wall-clock epoch — idempotent. Returns the armed-at ISO
 * timestamp; writes the marker the first time so the clock survives restarts.
 */
export async function armBudgetClock(workspaceRoot: string, now: Date = new Date()): Promise<string> {
  const file = path.join(workspaceRoot, BUDGET_STATE_REL);
  try {
    const raw = (await fsPromises.readFile(file, 'utf8')).replace(/^﻿/, '');
    const s = JSON.parse(raw) as { armed_at?: string };
    if (s.armed_at) { return s.armed_at; }
  } catch { /* not armed yet */ }
  const armed_at = now.toISOString();
  await fsPromises.mkdir(path.dirname(file), { recursive: true });
  await fsPromises.writeFile(file, JSON.stringify({ armed_at }, null, 2), 'utf8');
  return armed_at;
}

/** Reset the wall-clock epoch (e.g. when raising the ceiling and resuming). */
export async function resetBudgetClock(workspaceRoot: string): Promise<void> {
  try { await fsPromises.unlink(path.join(workspaceRoot, BUDGET_STATE_REL)); } catch { /* already clear */ }
}

/** Pure decision: which bounds (if any) are breached by the measured spend/time. */
export function evaluateBudget(
  ceiling: BudgetCeiling,
  measured: { spend_usd: number; wallclock_ms?: number }
): { within: boolean; breaches: string[] } {
  const breaches: string[] = [];
  if (typeof ceiling.max_spend_usd === 'number' && measured.spend_usd > ceiling.max_spend_usd) {
    breaches.push(`spend $${measured.spend_usd.toFixed(2)} exceeds cap $${ceiling.max_spend_usd.toFixed(2)}`);
  }
  if (
    typeof ceiling.max_wallclock_ms === 'number' &&
    typeof measured.wallclock_ms === 'number' &&
    measured.wallclock_ms > ceiling.max_wallclock_ms
  ) {
    breaches.push(`wall-clock ${Math.round(measured.wallclock_ms / 1000)}s exceeds cap ${Math.round(ceiling.max_wallclock_ms / 1000)}s`);
  }
  return { within: breaches.length === 0, breaches };
}

/**
 * Compute the current budget status — the queryable instrument. Reads the
 * ceiling, sums ledger spend (USD), and measures wall-clock since arming.
 * `readSpendUsd`/`now` are injectable for tests.
 */
export async function checkBudget(
  workspaceRoot: string,
  opts: { now?: Date; readSpendUsd?: () => Promise<number> } = {}
): Promise<BudgetStatus> {
  const ceiling = await readBudgetCeiling(workspaceRoot);
  if (!ceiling) { return { enabled: false, within: true, spend_usd: 0, breaches: [] }; }

  const now = opts.now ?? new Date();
  const spend_usd = opts.readSpendUsd ? await opts.readSpendUsd() : await ledgerSpendUsd(workspaceRoot);

  let wallclock_ms: number | undefined;
  if (typeof ceiling.max_wallclock_ms === 'number') {
    const armedAt = await armBudgetClock(workspaceRoot, now);
    wallclock_ms = Math.max(0, now.getTime() - new Date(armedAt).getTime());
  }

  const { within, breaches } = evaluateBudget(ceiling, { spend_usd, wallclock_ms });
  return { enabled: true, within, spend_usd, wallclock_ms, breaches, ceiling };
}

/**
 * Check the budget and, when a configured ceiling is breached, engage the fleet
 * HALT kill switch (once — does nothing if already halted) so dispatch stops and
 * the operator sees the reason. Returns the status either way. Enforcement is the
 * instrument→action link; `halt`/`isHalted` are injectable for tests.
 */
export async function enforceBudget(
  workspaceRoot: string,
  opts: {
    now?: Date;
    readSpendUsd?: () => Promise<number>;
    halt?: (reason: string) => Promise<void>;
    isHalted?: () => boolean;
  } = {}
): Promise<BudgetStatus> {
  const status = await checkBudget(workspaceRoot, opts);
  if (status.enabled && !status.within) {
    const alreadyHalted = (opts.isHalted ?? (() => isFleetHalted(workspaceRoot)))();
    if (!alreadyHalted) {
      const reason = `budget ceiling exceeded: ${status.breaches.join('; ')}`;
      await (opts.halt ?? ((r: string) => setFleetHalted(workspaceRoot, true, r)))(reason);
    }
  }
  return status;
}

/** Total ledger spend in USD (cents/100). */
async function ledgerSpendUsd(workspaceRoot: string): Promise<number> {
  const rows = await new CostLedger(workspaceRoot).readAll();
  const cents = rows.reduce((s, r) => s + (r.costCents ?? 0), 0);
  return cents / 100;
}
