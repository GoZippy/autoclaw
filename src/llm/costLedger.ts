/**
 * LLM cost ledger — ZICO-aligned schema.
 *
 * Appends one row per `chat()` call to
 * `.autoclaw/llm/cost-ledger.jsonl`. Schema matches ZICO's
 * ZICO's BudgetTracker schema
 * (`provider`, `model`, `operation`, `tokens`, `costCents`, `runId`)
 * so a future merge into a shared `@gozippy/billing` package is cheap.
 *
 * Prompt content and response text are NEVER written here — counts only.
 *
 * @see docs/rfc/llm-provider-abstraction.md §8 open question 2
 * @see docs/specs/llm-provider-s1/spec.md (Cost ledger schema section)
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ProviderId, ModelId, EndpointId } from './types';

export type LedgerOperation = 'chat' | 'embed' | 'validate';

export interface LedgerRow {
  /** ISO timestamp the call finished. */
  timestamp: string;
  provider: ProviderId;
  model: ModelId;
  operation: LedgerOperation;
  tokens: { input: number; output: number };
  /** Cost in **cents** (ZICO-aligned). 0 for local; ZMLR-reported when paid. */
  costCents: number;
  /** Correlation id (often persona dispatch id). */
  runId?: string;
  /** Session id from the caller. */
  sessionId?: string;
  /** Persona id when the caller was a persona dispatch. */
  callerPersonaId?: string;
  /** True when the oracle's failsafe rung served the call. */
  failsafe?: boolean;
  /** Endpoint id served, when known (e.g. from oracle pick). */
  endpointId?: EndpointId;
  /** Single-line note (never prompt/response content). */
  notes?: string;
}

export class CostLedger {
  constructor(private readonly workspaceRoot: string) {}

  /** Append one row. Best-effort — failure to write is logged but does not throw. */
  async append(row: LedgerRow): Promise<void> {
    try {
      const file = path.join(this.workspaceRoot, '.autoclaw', 'llm', 'cost-ledger.jsonl');
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const line = JSON.stringify(sanitize(row));
      await fs.promises.appendFile(file, line + '\n', 'utf8');
    } catch {
      // Don't break the loop because we can't persist.
    }
  }

  /** Read all rows. Returns empty when the file does not exist. */
  async readAll(): Promise<LedgerRow[]> {
    const file = path.join(this.workspaceRoot, '.autoclaw', 'llm', 'cost-ledger.jsonl');
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      return raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as LedgerRow);
    } catch {
      return [];
    }
  }

  /** Roll up cost in cents grouped by provider for the current ledger. */
  async summarizeByProvider(): Promise<Record<ProviderId, { calls: number; cents: number }>> {
    const rows = await this.readAll();
    const out: Record<ProviderId, { calls: number; cents: number }> = {};
    for (const r of rows) {
      const slot = out[r.provider] ?? { calls: 0, cents: 0 };
      slot.calls += 1;
      slot.cents += r.costCents ?? 0;
      out[r.provider] = slot;
    }
    return out;
  }
}

/**
 * Strip anything that smells like prompt/response content. Defensive —
 * callers shouldn't pass it, but if they do, we drop it on the floor.
 */
function sanitize(row: LedgerRow): LedgerRow {
  const safe: LedgerRow = {
    timestamp: row.timestamp,
    provider: row.provider,
    model: row.model,
    operation: row.operation,
    tokens: {
      input: Math.max(0, Math.floor(row.tokens.input)),
      output: Math.max(0, Math.floor(row.tokens.output)),
    },
    costCents: Math.max(0, Math.round(row.costCents ?? 0)),
  };
  if (row.runId) safe.runId = row.runId;
  if (row.sessionId) safe.sessionId = row.sessionId;
  if (row.callerPersonaId) safe.callerPersonaId = row.callerPersonaId;
  if (typeof row.failsafe === 'boolean') safe.failsafe = row.failsafe;
  if (row.endpointId) safe.endpointId = row.endpointId;
  if (row.notes) {
    // Single-line, max 200 chars, no JSON-looking content.
    safe.notes = row.notes.split('\n')[0].slice(0, 200);
  }
  return safe;
}
