/**
 * fleetMetrics.ts — LANE C: per-agent metrics rollup from the LLM cost ledger.
 *
 * Surfaces real per-agent token + dollar figures (tokensIn / tokensOut /
 * tokensTotal / costUsd / dispatches) plus a fleet total, so the sidebar agent
 * card and the wide Manager can show a compact metrics line instead of guessing.
 *
 * Data source — IMPORTANT, three ledgers live in this tree and only ONE is right:
 *   - `.autoclaw/llm/cost-ledger.jsonl`         ← THIS module reads this one.
 *   - `.autoclaw/orchestrator/cost-ledger.jsonl`  (read by fleetData.readCostLedger;
 *                                                  single-number tokens + wallMs, has
 *                                                  agentId — DIFFERENT shape, do not mix.)
 *   - `.autoclaw/mcp/…`                           (MCP call ledger — unrelated.)
 *
 * The LLM ledger is written by {@link ../llm/costLedger.CostLedger} as `LedgerRow`
 * objects: `{ timestamp, provider, model, operation, tokens:{input,output},
 * costCents (INTEGER CENTS), runId?, sessionId?, callerPersonaId? }`. Two facts
 * drive everything below:
 *   1. `costCents` is **cents**, not dollars — `costUsd = costCents / 100`. A
 *      naive cents→dollars miss is a 100x error. Local-only fleets legitimately
 *      show $0.00 (local models cost 0 cents); that is NOT "broken".
 *   2. The row carries **no agentId**. We attribute each row to an agent via the
 *      caller's persona id / session id / run id (see {@link MetricsAttribution}).
 *      Rows that resolve to no known agent fall into an `unattributed` bucket —
 *      kept and surfaced, never dropped, so totals always reconcile. The single
 *      biggest correctness risk here is attribution: in a single-agent setup with
 *      no session id on the rows, everything lands in `unattributed` and per-agent
 *      rows read zero. That is expected, not a bug.
 *
 * Design constraints (so it stays unit-testable like {@link ../fleet/fleetDigest}):
 *   - PURE core. `buildAgentMetrics` takes ALREADY-PARSED rows + an attribution
 *     hint map + the timestamp as ARGUMENTS — no `vscode`, no `Date.now()`, no
 *     hidden state. Same `(rows, attribution, timestamp)` ⇒ identical output.
 *   - One thin fs reader ({@link readLlmLedgerRows}) is provided for the extension
 *     host's convenience. It is `fs`-only (no `vscode`) and swallows every error
 *     the same way `costLedger.readAll` does, so it is still exercised by unit
 *     tests against ephemeral ledger files. The pure builder never touches disk.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sentinel agent id for the fleet-wide total row. */
export const FLEET_TOTAL_AGENT_ID = '__fleet__' as const;

/** Bucket id rows land in when no agent can be attributed. */
export const UNATTRIBUTED_AGENT_ID = 'unattributed' as const;

/**
 * Workspace-relative path of the LLM cost ledger this module reads. Mirrors the
 * path {@link ../llm/costLedger.CostLedger} appends to.
 */
export const LLM_COST_LEDGER_REL_PATH = '.autoclaw/llm/cost-ledger.jsonl';

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/**
 * Structural subset of `../llm/costLedger.LedgerRow` we actually consume. Kept
 * as a local interface (not an import) so this module stays decoupled from the
 * LLM package's full type and tolerant of loosely-typed on-disk rows.
 */
export interface LlmLedgerRow {
  /** ISO timestamp the call finished. */
  timestamp?: string;
  /** Token counts. Either field may be missing/NaN on a malformed row. */
  tokens?: { input?: number; output?: number };
  /** Cost in **cents** (integer). 0 for local models. */
  costCents?: number;
  operation?: string;
  /** Correlation id (often a persona dispatch id). */
  runId?: string;
  /** Session id from the caller — the primary attribution bridge. */
  sessionId?: string;
  /** Persona id when the caller was a persona dispatch. */
  callerPersonaId?: string;
}

/**
 * Hint maps that bridge a ledger row (which has no agentId) to an agent.
 *
 * Resolution order in {@link buildAgentMetrics}, most specific first:
 *   1. `callerPersonaId` is itself a known agent id (direct match).
 *   2. `callerPersonaId` → `byPersona[callerPersonaId]`.
 *   3. `sessionId`       → `bySession[sessionId]`.
 *   4. `runId`           → `byPersona[runId]` then `bySession[runId]` (run ids
 *      are frequently persona dispatch ids, so we try both maps as a last hint).
 *   5. otherwise → {@link UNATTRIBUTED_AGENT_ID}.
 */
export interface MetricsAttribution {
  /** sessionId → agentId. Built from agent heartbeats' `session_id`. */
  bySession: Record<string, string>;
  /** Optional personaId → agentId. */
  byPersona?: Record<string, string>;
  /** Set of agent ids the fleet knows about (registry profiles). */
  knownAgents: string[];
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** One agent's (or bucket's) collapsed metrics. */
export interface AgentMetrics {
  agentId: string;
  /** Summed `tokens.input` across attributed rows. */
  tokensIn: number;
  /** Summed `tokens.output` across attributed rows. */
  tokensOut: number;
  /** `tokensIn + tokensOut`, precomputed for the dashboard. */
  tokensTotal: number;
  /** Summed `costCents / 100`, rounded to cents (2 dp). */
  costUsd: number;
  /** Number of ledger rows attributed to this agent. */
  dispatches: number;
}

/** The full per-fleet metrics envelope. */
export interface FleetMetrics {
  /** Per-agent rows, sorted by costUsd desc → tokensTotal desc → agentId asc. */
  perAgent: AgentMetrics[];
  /** Fleet-wide total across every row (attributed + unattributed). */
  total: AgentMetrics & { agentId: typeof FLEET_TOTAL_AGENT_ID };
  /** Rows that could not be attributed to a known agent. Kept, never dropped. */
  unattributed: AgentMetrics;
  /** ISO timestamp; supplied by the caller, never `Date.now()` here. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Normalize a number|string timestamp to a stable ISO string. */
function toIso(timestamp: number | string): string {
  if (typeof timestamp === 'string') { return timestamp; }
  return new Date(timestamp).toISOString();
}

/** Coerce an unknown to a finite number, defaulting non-numbers/NaN to 0. */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round to cents (2 dp) without floating-point drift creeping in. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Fresh zeroed accumulator for an agent id. */
function emptyMetrics(agentId: string): AgentMetrics {
  return { agentId, tokensIn: 0, tokensOut: 0, tokensTotal: 0, costUsd: 0, dispatches: 0 };
}

/**
 * Compact a token count to a human label: `840`, `12.3k`, `1.2M`. Used by the
 * renderers (sidebar pip + dashboard) so the two views format identically. Pure
 * + locale-free so unit tests can pin the exact string.
 */
export function formatTokens(tokens: number): string {
  const n = num(tokens);
  const abs = Math.abs(n);
  if (abs < 1000) { return String(Math.round(n)); }
  if (abs < 1_000_000) { return trimZero(n / 1000) + 'k'; }
  return trimZero(n / 1_000_000) + 'M';
}

/** One decimal place, but drop a trailing `.0` (`1.0k` → `1k`). */
function trimZero(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * Format a dollar amount for the dashboard: `$0.00`, `$1.20`, `$14.50`. Kept
 * here next to {@link formatTokens} so both views agree on currency rendering.
 */
export function formatUsd(usd: number): string {
  return '$' + num(usd).toFixed(2);
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * The {@link MetricsAttribution} maps pre-resolved once per build: the
 * `knownAgents` array is hoisted into a `Set` so per-row lookups are O(1).
 */
interface ResolvedAttribution {
  known: Set<string>;
  bySession: Record<string, string>;
  byPersona: Record<string, string>;
}

/**
 * Resolve the agent a ledger row belongs to, or {@link UNATTRIBUTED_AGENT_ID}.
 * Resolution order matches the doc on {@link MetricsAttribution}.
 */
function attribute(row: LlmLedgerRow, attribution: ResolvedAttribution): string {
  const known = attribution.known;
  const bySession = attribution.bySession;
  const byPersona = attribution.byPersona;

  const persona = row.callerPersonaId;
  if (persona) {
    // 1. callerPersonaId is itself a known agent id.
    if (known.has(persona)) { return persona; }
    // 2. callerPersonaId → mapped agent.
    if (byPersona[persona]) { return byPersona[persona]; }
  }

  // 3. sessionId → mapped agent.
  const session = row.sessionId;
  if (session && bySession[session]) { return bySession[session]; }

  // 4. runId is frequently a persona dispatch / session id — try both maps.
  const run = row.runId;
  if (run) {
    if (known.has(run)) { return run; }
    if (byPersona[run]) { return byPersona[run]; }
    if (bySession[run]) { return bySession[run]; }
  }

  return UNATTRIBUTED_AGENT_ID;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Roll up parsed LLM-ledger rows into per-agent metrics + a fleet total.
 *
 * Pure + deterministic: the caller passes `timestamp` (no `Date.now()` here),
 * so the same `(rows, attribution, timestamp)` triple always yields the same
 * object. Tolerant of garbage input — non-object rows are skipped, missing /
 * NaN tokens + costs coerce to 0, and an empty `rows` array yields a fully
 * zeroed total.
 *
 * @param rows        Already-parsed ledger rows (see {@link readLlmLedgerRows}).
 * @param attribution sessionId/persona → agent maps + the known-agents set.
 * @param timestamp   ISO string or epoch-ms the rollup was generated at.
 */
export function buildAgentMetrics(
  rows: LlmLedgerRow[],
  attribution: MetricsAttribution,
  timestamp: number | string,
): FleetMetrics {
  // Pre-resolve the known-agents set once; reused inside attribute().
  const resolved: ResolvedAttribution = {
    known: new Set((attribution?.knownAgents ?? []).filter((a) => typeof a === 'string' && a.length > 0)),
    bySession: attribution?.bySession ?? {},
    byPersona: attribution?.byPersona ?? {},
  };

  const byAgent = new Map<string, AgentMetrics>();
  const total = emptyMetrics(FLEET_TOTAL_AGENT_ID);
  const unattributed = emptyMetrics(UNATTRIBUTED_AGENT_ID);

  for (const raw of Array.isArray(rows) ? rows : []) {
    // Skip non-object / null rows — never throw on bad input.
    if (!raw || typeof raw !== 'object') { continue; }
    const row = raw as LlmLedgerRow;

    const tokensIn = Math.max(0, num(row.tokens?.input));
    const tokensOut = Math.max(0, num(row.tokens?.output));
    // costCents is integer cents; coerce, floor negatives to 0, → USD.
    const usd = Math.max(0, num(row.costCents)) / 100;

    const agentId = attribute(row, resolved);
    const bucket = agentId === UNATTRIBUTED_AGENT_ID
      ? unattributed
      : (byAgent.get(agentId) ?? byAgent.set(agentId, emptyMetrics(agentId)).get(agentId)!);

    bucket.tokensIn += tokensIn;
    bucket.tokensOut += tokensOut;
    bucket.dispatches += 1;
    bucket.costUsd += usd;

    total.tokensIn += tokensIn;
    total.tokensOut += tokensOut;
    total.dispatches += 1;
    total.costUsd += usd;
  }

  // Finalize derived + rounded fields on every bucket.
  const perAgent = [...byAgent.values()];
  for (const m of [...perAgent, total, unattributed]) {
    m.tokensTotal = m.tokensIn + m.tokensOut;
    m.costUsd = round2(m.costUsd);
  }

  // Deterministic order: biggest spend first, then biggest token use, then id.
  perAgent.sort((a, b) =>
    b.costUsd - a.costUsd ||
    b.tokensTotal - a.tokensTotal ||
    a.agentId.localeCompare(b.agentId),
  );

  return {
    perAgent,
    total: total as AgentMetrics & { agentId: typeof FLEET_TOTAL_AGENT_ID },
    unattributed,
    generatedAt: toIso(timestamp),
  };
}

// ---------------------------------------------------------------------------
// Thin fs reader (fs-only, vscode-free — still unit-testable on temp files)
// ---------------------------------------------------------------------------

/**
 * Read + parse the LLM cost ledger at `<workspaceRoot>/.autoclaw/llm/cost-ledger.jsonl`.
 *
 * Best-effort and totally non-throwing, mirroring `costLedger.readAll`:
 *   - Missing file ⇒ `[]` (callers then build a zeroed rollup).
 *   - A leading UTF-8 BOM is stripped.
 *   - Blank lines are skipped; a malformed JSON line is skipped (not fatal).
 *
 * The ledger is append-only and unrotated on the LLM side, so `limit` keeps the
 * read bounded on a long-lived workspace: when set, only the **last** `limit`
 * non-blank lines are parsed (the most recent activity), mirroring the MCP
 * ledger's `readRecent(limit)`. Omit `limit` to read everything.
 */
export async function readLlmLedgerRows(
  workspaceRoot: string,
  limit?: number,
): Promise<LlmLedgerRow[]> {
  const file = path.join(workspaceRoot, '.autoclaw', 'llm', 'cost-ledger.jsonl');
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    // Missing/unreadable ledger ⇒ no rows. Never throw.
    return [];
  }

  // Strip a leading BOM if present, then split on either newline style.
  if (raw.charCodeAt(0) === 0xfeff) { raw = raw.slice(1); }
  let lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (typeof limit === 'number' && limit >= 0 && lines.length > limit) {
    lines = lines.slice(lines.length - limit);
  }

  const out: LlmLedgerRow[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') { out.push(parsed as LlmLedgerRow); }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/**
 * Convenience: read the ledger and roll it up in one call. Equivalent to
 * `buildAgentMetrics(await readLlmLedgerRows(root, limit), attribution, ts)`.
 * Returns a fully-zeroed rollup when the ledger is missing.
 */
export async function gatherAgentMetrics(
  workspaceRoot: string,
  attribution: MetricsAttribution,
  timestamp: number | string,
  limit?: number,
): Promise<FleetMetrics> {
  const rows = await readLlmLedgerRows(workspaceRoot, limit);
  return buildAgentMetrics(rows, attribution, timestamp);
}
