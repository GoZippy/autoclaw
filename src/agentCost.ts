/**
 * agentCost.ts — per-agent cost rollup for the sidebar agent card.
 *
 * The sidebar agent card (renderAgentCard in src/webview-render.ts) shows a
 * compact "tokens · $ · runs" line per agent. The richer per-agent cost model
 * already exists, but it only renders in the command-only Manager tab. This
 * module is the additive, vscode-free reader that lets the *visible* sidebar
 * card surface the same signal — built as a small standalone module so it is
 * unit-testable without booting the Electron host.
 *
 * Source of truth is the LLM cost ledger
 *   `.autoclaw/llm/cost-ledger.jsonl`
 * written by {@link CostLedger} in src/llm/costLedger.ts (one row per `chat()`
 * call). Each row carries `tokens.{input,output}`, `costCents`, and a
 * `callerPersonaId` — the persona/agent dispatch id, which is how a ledger row
 * keys back to an agent on the board (matching the Manager's per-agent rollup
 * idea but replicated here to keep this module dependency-free).
 *
 * The per-MCP-tool ledger (`.autoclaw/mcp/cost-ledger.jsonl`) is folded in for
 * *dispatch counts only*: those rows carry neither an agent id nor token
 * counts, so they can only contribute a `dispatches` bump when their `session`
 * maps to an agent (no token/cost contamination).
 *
 * Robustness contract (mirrors CostLedger.readAll / readRecent):
 *   - missing file        → contributes nothing (overall {} when both absent)
 *   - malformed/BOM line   → skipped, never throws
 *   - prompt/response text  → never read (ledgers store counts only)
 */

import * as fs from 'fs';
import * as path from 'path';

/** Per-agent cost rollup attached to a sidebar agent-card model. */
export interface AgentCost {
  /** The agent id this rollup belongs to (matches AgentWithLive.id). */
  agentId: string;
  /** Summed prompt/input tokens across the agent's ledger rows. */
  tokensIn: number;
  /** Summed completion/output tokens across the agent's ledger rows. */
  tokensOut: number;
  /** Convenience: tokensIn + tokensOut. */
  tokensTotal: number;
  /** Summed cost in USD. Omitted when every contributing row reported 0. */
  costUsd?: number;
  /** Number of ledger rows (≈ dispatches / calls) attributed to this agent. */
  dispatches: number;
  /** ISO timestamp of the most recent contributing row, when known. */
  lastAt?: string;
}

/** Loosely-typed LLM ledger row — matches LedgerRow in src/llm/costLedger.ts.
 *  Kept inline so this reader has no cross-module type import. */
interface RawLlmRow {
  timestamp?: unknown;
  tokens?: { input?: unknown; output?: unknown } | null;
  costCents?: unknown;
  /** Persona id when the caller was a persona/agent dispatch — our agent key. */
  callerPersonaId?: unknown;
  /** Correlation id (often persona dispatch id) — fallback agent key. */
  runId?: unknown;
  /** Session id from the caller — last-resort agent key. */
  sessionId?: unknown;
}

/** Loosely-typed MCP ledger row — matches CostLedgerEntry in src/mcp/types.ts. */
interface RawMcpRow {
  ts?: unknown;
  session?: unknown;
}

/**
 * Read and aggregate per-agent cost from the workspace LLM cost ledger (and,
 * for dispatch counts, the MCP tool ledger).
 *
 * @param workspaceRoot Absolute path to the workspace root (the dir holding
 *   `.autoclaw/`).
 * @returns A map keyed by agent id. Empty object when no ledger exists or no
 *   row carries an agent key — so an un-augmented card is byte-identical.
 */
export function readAgentCosts(workspaceRoot: string): Record<string, AgentCost> {
  const out: Record<string, AgentCost> = {};
  if (!workspaceRoot || typeof workspaceRoot !== 'string') { return out; }

  const llmFile = path.join(workspaceRoot, '.autoclaw', 'llm', 'cost-ledger.jsonl');
  for (const line of readJsonlLines(llmFile)) {
    const row = parseJson<RawLlmRow>(line);
    if (!row) { continue; }
    const agentId = llmAgentKey(row);
    if (!agentId) { continue; } // a row with no agent attribution can't roll up

    const tIn = toCount(row.tokens?.input);
    const tOut = toCount(row.tokens?.output);
    const cents = toNonNegNumber(row.costCents);
    const ts = typeof row.timestamp === 'string' ? row.timestamp : undefined;

    const slot = (out[agentId] ??= blank(agentId));
    slot.tokensIn += tIn;
    slot.tokensOut += tOut;
    slot.tokensTotal += tIn + tOut;
    slot.dispatches += 1;
    // Accumulate cost in cents, convert to USD once at the end (avoid float drift).
    slot.costUsd = (slot.costUsd ?? 0) + cents / 100;
    slot.lastAt = laterIso(slot.lastAt, ts);
  }

  // MCP ledger: dispatch-count contribution only (no agent id, no tokens). A
  // row keys to an agent only when its `session` already appears as an agent
  // key above — otherwise it is unattributable and dropped (never invents an
  // agent). This keeps token/cost totals untouched.
  const mcpFile = path.join(workspaceRoot, '.autoclaw', 'mcp', 'cost-ledger.jsonl');
  for (const line of readJsonlLines(mcpFile)) {
    const row = parseJson<RawMcpRow>(line);
    if (!row) { continue; }
    const session = typeof row.session === 'string' ? row.session : '';
    if (!session || !(session in out)) { continue; }
    const slot = out[session];
    slot.dispatches += 1;
    if (typeof row.ts === 'string') { slot.lastAt = laterIso(slot.lastAt, row.ts); }
  }

  // Normalize: drop a zero-cost agent's costUsd so the card omits "$0.00".
  for (const slot of Object.values(out)) {
    if (!slot.costUsd || slot.costUsd <= 0) { delete slot.costUsd; }
    else { slot.costUsd = Math.round(slot.costUsd * 10000) / 10000; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers (all pure, no I/O except readJsonlLines)
// ---------------------------------------------------------------------------

/** Which field on an LLM ledger row identifies the agent, in priority order. */
function llmAgentKey(row: RawLlmRow): string {
  if (typeof row.callerPersonaId === 'string' && row.callerPersonaId) { return row.callerPersonaId; }
  if (typeof row.runId === 'string' && row.runId) { return row.runId; }
  if (typeof row.sessionId === 'string' && row.sessionId) { return row.sessionId; }
  return '';
}

function blank(agentId: string): AgentCost {
  return { agentId, tokensIn: 0, tokensOut: 0, tokensTotal: 0, dispatches: 0 };
}

/** Read a JSONL file into trimmed non-empty lines. Tolerates a leading BOM and
 *  a missing file (→ no lines). Never throws. */
function readJsonlLines(file: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  // Strip a UTF-8 BOM if the whole file (or first line) carries one.
  if (raw.charCodeAt(0) === 0xfeff) { raw = raw.slice(1); }
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^﻿/, '').trim())
    .filter((l) => l.length > 0);
}

function parseJson<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null; // torn / malformed line — skip
  }
}

/** Coerce a token count to a non-negative integer (0 on anything invalid). */
function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Coerce to a non-negative finite number (0 otherwise). */
function toNonNegNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Return the later of two ISO timestamps (either may be undefined). */
function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) { return b; }
  if (!b) { return a; }
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}
