/**
 * scoping.ts — Workspace-vs-global scoping helpers for the MCP server (BP3).
 *
 * The `autoclaw-mcp` server runs in one of two scopes (RFC §4 / `McpScope`):
 *
 *   - `workspace` — a per-project install. There is a project on disk to
 *                   read *and* write; BP3 write tools are available.
 *   - `global`    — a user-global install. There is no single project, so
 *                   the server is strictly read-only.
 *
 * `server.ts` already derives the scope from `AUTOCLAW_MCP_SCOPE` and gates
 * the write *tool set* with `checkWriteGate`. This module is the smaller,
 * reusable layer underneath: predicates and a structured `ScopingDecision`
 * that any tool (read or write) can consult, plus the per-tool authorization
 * policy that BP3 layers on top of the coarse `allowWrites` boolean.
 *
 * Keeping this in its own file means the per-tool policy table has a single
 * home and is independently unit-testable, and `writeTools.ts` imports a
 * named decision function rather than re-deriving the rules inline.
 *
 * Sprint 3 — BP3 (WA-3)
 *
 * @see docs/rfc/runner-bridge-contract.md §4
 * @see docs/rfc/mcp-server.md §3.2
 */

import type { McpScope, ToolContext } from './types';

/* -------------------------------------------------------------------------- */
/*  Coarse scope predicates                                                   */
/* -------------------------------------------------------------------------- */

/** True when the server is a per-project (`workspace`) install. */
export function isWorkspaceScoped(ctx: Pick<ToolContext, 'scope'>): boolean {
  return ctx.scope === 'workspace';
}

/** True when the server is a user-global install (read-only). */
export function isGlobalScoped(ctx: Pick<ToolContext, 'scope'>): boolean {
  return ctx.scope === 'global';
}

/**
 * Normalise an arbitrary string into an {@link McpScope}. Anything that is not
 * exactly `workspace` falls back to `global` — the safe, read-only scope.
 */
export function normalizeScope(raw: string | undefined): McpScope {
  return (raw ?? '').trim().toLowerCase() === 'workspace' ? 'workspace' : 'global';
}

/* -------------------------------------------------------------------------- */
/*  Per-tool authorization policy                                             */
/* -------------------------------------------------------------------------- */

/**
 * The write tools BP3 ships. Used as the key space for the per-tool
 * authorization policy below.
 */
export type WriteToolName =
  | 'note.add'
  | 'inbox.send'
  | 'inbox.archive'
  | 'claim.task'
  | 'dream.run'
  | 'consensus.vote'
  | 'llm.chat'
  | 'llm.models'
  | 'llm.health'
  | 'kg.record'
  | 'kg.relate';

/** Every BP3 write tool name, for iteration / validation. */
export const WRITE_TOOL_NAMES: readonly WriteToolName[] = [
  'note.add',
  'inbox.send',
  'inbox.archive',
  'claim.task',
  'dream.run',
  'consensus.vote',
  'llm.chat',
  'llm.models',
  'llm.health',
  'kg.record',
  'kg.relate',
];

/**
 * Per-tool authorization beyond the coarse `allowWrites` boolean (BP3).
 *
 * `allowWrites: true` is necessary but not always sufficient: an operator can
 * enable writes broadly yet still want to withhold a *specific* tool (e.g.
 * disallow `dream.run` from MCP because a daemon already schedules it, or
 * forbid `consensus.vote` so votes only ever come from a real review pass).
 *
 * The policy is read from `.autoclaw/mcp/config.json`:
 *
 * ```json
 * {
 *   "allowWrites": true,
 *   "tools": {
 *     "dream.run":      { "allow": false, "reason": "daemon owns dream scheduling" },
 *     "consensus.vote": { "allow": true }
 *   }
 * }
 * ```
 *
 * Deny-by-default applies only to the *coarse* gate; a tool absent from the
 * `tools` map inherits the coarse decision (allowed once `allowWrites` is on).
 * An explicit `{ "allow": false }` always denies that tool.
 */
export interface ToolAuthEntry {
  /** Explicit allow/deny for this tool. */
  allow: boolean;
  /** Optional operator-supplied rationale, surfaced in the denial detail. */
  reason?: string;
}

/** The `tools` sub-object of `.autoclaw/mcp/config.json`. */
export type ToolAuthPolicy = Partial<Record<string, ToolAuthEntry>>;

/** A structured authorization decision for one (scope, allowWrites, tool) triple. */
export interface ScopingDecision {
  /** Whether the tool may run. */
  allowed: boolean;
  /** Machine-readable reason code. */
  code:
    | 'ok'
    | 'global_scope'
    | 'writes_disabled'
    | 'tool_denied';
  /** Human-readable detail. */
  detail: string;
}

/**
 * Validate and extract the per-tool authorization policy from a parsed
 * `config.json` object. A malformed `tools` map (or malformed individual
 * entries) is dropped — a bad policy must not silently *widen* access, so an
 * unparseable entry is simply absent (the tool then inherits the coarse gate;
 * if an operator wanted a deny they must write a well-formed entry).
 */
export function parseToolAuthPolicy(config: unknown): ToolAuthPolicy {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return {};
  }
  const toolsRaw = (config as Record<string, unknown>).tools;
  if (toolsRaw === null || typeof toolsRaw !== 'object' || Array.isArray(toolsRaw)) {
    return {};
  }
  const policy: ToolAuthPolicy = {};
  for (const [name, entryRaw] of Object.entries(toolsRaw as Record<string, unknown>)) {
    if (entryRaw === null || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) {
      continue;
    }
    const entry = entryRaw as Record<string, unknown>;
    if (typeof entry.allow !== 'boolean') {
      continue; // malformed — drop (do not default-allow)
    }
    policy[name] = {
      allow: entry.allow,
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
    };
  }
  return policy;
}

/**
 * Decide whether a specific write tool may run, combining all three gates:
 *
 *   1. Scope — a `global` install is always read-only.
 *   2. Coarse — `allowWrites` must be `true`.
 *   3. Fine — the per-tool policy must not explicitly deny the tool.
 *
 * `server.ts`'s `checkWriteGate` covers gates 1–2 for the whole tool set;
 * this function adds gate 3 and is the one a write tool calls per-invocation
 * so an operator can withhold an individual tool without disabling all writes.
 */
export function authorizeWriteTool(
  ctx: Pick<ToolContext, 'scope'>,
  allowWrites: boolean,
  toolName: string,
  policy: ToolAuthPolicy,
): ScopingDecision {
  if (!isWorkspaceScoped(ctx)) {
    return {
      allowed: false,
      code: 'global_scope',
      detail: `"${toolName}" requires a workspace-scoped MCP install (scope is global)`,
    };
  }
  if (!allowWrites) {
    return {
      allowed: false,
      code: 'writes_disabled',
      detail:
        `"${toolName}" is disabled: set "allowWrites": true in .autoclaw/mcp/config.json ` +
        '(or AUTOCLAW_MCP_ALLOW_WRITES=true)',
    };
  }
  const entry = policy[toolName];
  if (entry && entry.allow === false) {
    return {
      allowed: false,
      code: 'tool_denied',
      detail:
        `"${toolName}" is denied by per-tool policy in .autoclaw/mcp/config.json` +
        (entry.reason ? ` — ${entry.reason}` : ''),
    };
  }
  return { allowed: true, code: 'ok', detail: `"${toolName}" authorized` };
}
