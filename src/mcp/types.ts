/**
 * types.ts — Shared types for the `autoclaw-mcp` server.
 *
 * The MCP server is a stdio JSON-RPC process spawned per host. It is a pure
 * file-I/O reader for v3.0 (BP1) — zero LLM calls, zero network surface, no
 * shared mutable global state. Every symbol here is a plain TypeScript type.
 *
 * Spec: docs/rfc/mcp-server.md
 * Sprint 2 — BP1 (WA-3)
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelopes (MCP rides on JSON-RPC over stdio)
// ---------------------------------------------------------------------------

/** A JSON-RPC 2.0 request or notification (notification = no `id`). */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** A JSON-RPC 2.0 success/error response. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Standard JSON-RPC error codes used by the server. */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ---------------------------------------------------------------------------
// MCP protocol shapes (subset needed for stdio tool servers)
// ---------------------------------------------------------------------------

/** MCP protocol version this server speaks. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Server identity returned by the `initialize` handshake. */
export interface McpServerInfo {
  name: string;
  version: string;
}

/** Result of the `initialize` request. */
export interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools: Record<string, unknown>;
  };
  serverInfo: McpServerInfo;
}

/** A tool definition as returned by `tools/list`. */
export interface McpToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** A single content block in a `tools/call` result. */
export interface McpContentBlock {
  type: 'text';
  text: string;
}

/** Result of a `tools/call` request. */
export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Tool runtime
// ---------------------------------------------------------------------------

/**
 * The execution scope of the MCP server, derived from `AUTOCLAW_MCP_SCOPE`.
 *
 * - `workspace`: per-project install; write tools allowed (BP3).
 * - `global`: user-global install; read-only.
 *
 * BP1 ships read-only tools only; scope is recorded for the cost ledger and
 * for the BP3 write-tool gate.
 */
export type McpScope = 'workspace' | 'global';

/**
 * Context handed to every tool implementation. Immutable per process — there
 * is no shared mutable global state, so multiple host subprocesses are safe.
 */
export interface ToolContext {
  /** Absolute path to the workspace root (the server's cwd). */
  workspaceRoot: string;
  /** Absolute path to the `.autoclaw/` directory. */
  autoclawDir: string;
  /** Execution scope. */
  scope: McpScope;
  /** Best-effort host identifier (Claude Code, Cursor, …) for telemetry. */
  host: string;
  /** Caller's session id, when the host exposed one. */
  sessionId?: string;
}

/**
 * Uniform tool result. Tools never throw for expected conditions — they
 * return `{ ok: false }` so the JSON-RPC layer can still report success at
 * the transport level while signalling a tool-level failure to the caller.
 */
export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; reason: ToolFailureReason; detail?: string };

/** Typed failure reasons. `not_implemented` is used for BP2/BP3 stubs and
 *  for read tools whose backing data is not yet wired up (per RFC §9).
 *  `permission_denied` gates write tools when `allowWrites` is off (BP3);
 *  `conflict` covers a create-exclusive claim losing a race (BP3). */
export type ToolFailureReason =
  | 'not_implemented'
  | 'not_found'
  | 'invalid_params'
  | 'state_unreachable'
  | 'internal_error'
  | 'permission_denied'
  | 'conflict';

/** A read-only tool: pure function of (context, args) → ToolResult. */
export interface ToolHandler {
  definition: McpToolDefinition;
  /** Executes the tool. Must not write to disk (BP1 = read-only). */
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

/** One row appended to the per-invocation cost ledger (RFC §8). */
export interface CostLedgerEntry {
  /** ISO8601 timestamp of invocation completion. */
  ts: string;
  /** Tool name, e.g. `recall.query`. */
  tool: string;
  /** SHA-256 hash (hex, first 16 chars) of the JSON-serialised args. */
  args_hash: string;
  /** Wall-clock duration in milliseconds. */
  duration_ms: number;
  /** Size of the serialised result payload in bytes. */
  result_size_bytes: number;
  /** Whether the tool reported `ok: true`. */
  ok: boolean;
  /** Host identifier, for per-host rollups in `fleet.cards`. */
  host: string;
  /** Caller session id, when known. */
  session?: string;
}
