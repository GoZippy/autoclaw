/**
 * server.ts — `autoclaw-mcp` stdio server.
 *
 * A minimal, self-contained Model Context Protocol server speaking JSON-RPC
 * 2.0 over stdin/stdout. It exposes AutoClaw's read-only state (fleet status,
 * inboxes, recall, doctor) as MCP tools so any host (Claude Code, Cursor,
 * Kiro, Antigravity, …) can read AutoClaw state mid-session.
 *
 * Why a hand-rolled JSON-RPC loop instead of the official SDK:
 *   `@modelcontextprotocol/sdk` is NOT a declared dependency of this package
 *   (see package.json). Per the BP1 brief we must not add it, so this file
 *   implements the small slice of MCP we need (initialize / tools/list /
 *   tools/call) directly over a newline-delimited JSON-RPC stdio transport.
 *
 * TODO(BP2): swap to @modelcontextprotocol/sdk once the dependency is approved.
 *            The handler functions below (`handleInitialize`, `handleToolsList`,
 *            `handleToolsCall`) are written to drop cleanly behind the SDK's
 *            `Server` request handlers.
 *
 * Design constraints (RFC §7):
 *   - Cold start < 500 ms: no heavy imports, no daemon, no eager file scans.
 *     Work happens lazily inside `tools/call`.
 *   - Concurrent-safe: each host spawns its own subprocess; this module holds
 *     no cross-process locks and no shared mutable global state. The only
 *     writes are append-only cost-ledger rows (see costLedger.ts).
 *   - Read-only: BP1 tools never mutate workspace state.
 *
 * Sprint 2 — BP1 (WA-3)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { CostLedger, hashArgs } from './costLedger';
import {
  buildToolMap,
  listToolDefinitions,
  READ_ONLY_TOOLS,
} from './tools';
import { WRITE_TOOLS, checkWriteGate } from './writeTools';
import {
  JSON_RPC_ERRORS,
  MCP_PROTOCOL_VERSION,
  type InitializeResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpScope,
  type McpToolCallResult,
  type ToolContext,
  type ToolHandler,
} from './types';

const SERVER_NAME = 'autoclaw-mcp';
const SERVER_VERSION = '3.0.0';

// ---------------------------------------------------------------------------
// Environment / context resolution
// ---------------------------------------------------------------------------

/**
 * Locate the workspace `.autoclaw/` directory.
 *
 * The host launches the server with `cwd` set to the workspace (RFC §4.1), so
 * we walk up from cwd looking for `.autoclaw/`. If none is found we fall back
 * to `<cwd>/.autoclaw` — tools will then report `state_unreachable`/`not_found`
 * rather than serving stale data (RFC §7.3).
 */
export function resolveAutoclawDir(startDir: string): string {
  let dir = path.resolve(startDir);
  // Bounded walk — never more than filesystem depth.
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(dir, '.autoclaw');
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // not here — keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return path.join(path.resolve(startDir), '.autoclaw');
}

/**
 * Build the immutable {@link ToolContext} from process environment.
 *
 * - Scope comes from `AUTOCLAW_MCP_SCOPE` (`workspace` enables BP3 write tools;
 *   `global` / absent ⇒ read-only).
 * - Host id comes from `AUTOCLAW_MCP_HOST` when the installer set it; else a
 *   synthetic `pid-<n>` (RFC §4.2 — synthetic identity for hosts that expose none).
 * - Session id comes from `AUTOCLAW_MCP_SESSION` when the host exposes one.
 */
export function buildContext(env: NodeJS.ProcessEnv, cwd: string): ToolContext {
  const rawScope = (env.AUTOCLAW_MCP_SCOPE ?? '').toLowerCase();
  const scope: McpScope = rawScope === 'workspace' ? 'workspace' : 'global';
  const autoclawDir = resolveAutoclawDir(cwd);
  return {
    workspaceRoot: path.dirname(autoclawDir),
    autoclawDir,
    scope,
    host: env.AUTOCLAW_MCP_HOST || `pid-${process.pid}`,
    sessionId: env.AUTOCLAW_MCP_SESSION || undefined,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function rpcResult(id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(
  id: JsonRpcResponse['id'],
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// ---------------------------------------------------------------------------
// MCP method handlers
// ---------------------------------------------------------------------------

function handleInitialize(): InitializeResult {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

function handleToolsList(handlers: ToolHandler[]): { tools: ReturnType<typeof listToolDefinitions> } {
  return { tools: listToolDefinitions(handlers) };
}

/**
 * Resolve the active tool set for a context.
 *
 * BP1 read-only tools are always present. BP3 write tools are appended only
 * when the write gate opens — workspace scope AND `allowWrites` (see
 * {@link checkWriteGate}). When the gate is shut the write tools are not in
 * `tools/list` and not in the dispatch map, so a caller cannot invoke them.
 *
 * Computed per request (not cached) so toggling `.autoclaw/mcp/config.json`
 * takes effect on the next `tools/list` without restarting the host's
 * subprocess.
 */
export function activeTools(ctx: ToolContext, env: NodeJS.ProcessEnv): ToolHandler[] {
  if (checkWriteGate(ctx, env).allowed) {
    return [...READ_ONLY_TOOLS, ...WRITE_TOOLS];
  }
  return READ_ONLY_TOOLS;
}

/**
 * Execute a `tools/call` request. The tool's structured `ToolResult` is
 * serialised into a single MCP text content block. Tool-level failures
 * (`ok: false`) are surfaced via `isError: true` — they are NOT JSON-RPC
 * errors, because the transport call itself succeeded.
 */
async function handleToolsCall(
  ctx: ToolContext,
  toolMap: Map<string, ToolHandler>,
  ledger: CostLedger,
  params: Record<string, unknown> | undefined
): Promise<McpToolCallResult> {
  const name = typeof params?.name === 'string' ? params.name : '';
  const args = (params?.arguments as Record<string, unknown>) ?? {};
  const handler = toolMap.get(name);

  if (!handler) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'not_found', detail: `unknown tool "${name}"` }) }],
      isError: true,
    };
  }

  const started = Date.now();
  let result;
  try {
    result = await handler.run(ctx, args);
  } catch (err) {
    result = {
      ok: false as const,
      reason: 'internal_error' as const,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const duration = Date.now() - started;
  const text = JSON.stringify(result);

  // Telemetry — best-effort, never blocks or fails the call (RFC §8).
  void ledger.record({
    ts: new Date().toISOString(),
    tool: name,
    args_hash: hashArgs(args),
    duration_ms: duration,
    result_size_bytes: Buffer.byteLength(text, 'utf8'),
    ok: result.ok,
    host: ctx.host,
    ...(ctx.sessionId ? { session: ctx.sessionId } : {}),
  });

  return {
    content: [{ type: 'text', text }],
    isError: !result.ok,
  };
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a single parsed JSON-RPC request. Returns the response, or `null`
 * for notifications (requests without an `id`, e.g. `notifications/initialized`).
 *
 * The `toolMap` argument is accepted for backward compatibility but the
 * effective tool set is recomputed per request from `ctx` + `env` via
 * {@link activeTools}, so a write-gate toggle takes effect without a restart.
 * Pass `env` to override the gate inputs (tests / explicit scoping); it
 * defaults to `process.env`.
 */
export async function dispatch(
  req: JsonRpcRequest,
  ctx: ToolContext,
  toolMap: Map<string, ToolHandler>,
  ledger: CostLedger,
  env: NodeJS.ProcessEnv = process.env
): Promise<JsonRpcResponse | null> {
  const isNotification = req.id === undefined || req.id === null;
  const id = (req.id ?? null) as JsonRpcResponse['id'];

  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return isNotification ? null : rpcError(id, JSON_RPC_ERRORS.INVALID_REQUEST, 'invalid JSON-RPC request');
  }

  // Recompute the active tool set per request — cheap, and lets the write
  // gate (workspace scope + allowWrites) be toggled without a restart.
  const tools = activeTools(ctx, env);

  try {
    switch (req.method) {
      case 'initialize':
        return rpcResult(id, handleInitialize());

      case 'notifications/initialized':
      case 'initialized':
        // Lifecycle notification from the host — acknowledge by no-op.
        return null;

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, handleToolsList(tools));

      case 'tools/call': {
        const result = await handleToolsCall(ctx, buildToolMap(tools), ledger, req.params);
        return rpcResult(id, result);
      }

      default:
        return isNotification
          ? null
          : rpcError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `method not found: ${req.method}`);
    }
  } catch (err) {
    return rpcError(
      id,
      JSON_RPC_ERRORS.INTERNAL_ERROR,
      err instanceof Error ? err.message : 'internal error'
    );
  }
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

/**
 * Start the stdio JSON-RPC loop. Reads newline-delimited JSON requests from
 * stdin, writes newline-delimited JSON responses to stdout.
 *
 * Newline-delimited framing is the de-facto transport for MCP stdio servers
 * and is what every supported host emits; this avoids a Content-Length header
 * parser while remaining wire-compatible with those hosts.
 *
 * @returns a disposer that closes the reader (used by tests).
 */
export function startStdioServer(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): () => void {
  const ctx = buildContext(env, cwd);
  const toolMap = buildToolMap(READ_ONLY_TOOLS);
  const ledger = new CostLedger(ctx.autoclawDir);

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const write = (resp: JsonRpcResponse): void => {
    output.write(JSON.stringify(resp) + '\n');
  };

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      write(rpcError(null, JSON_RPC_ERRORS.PARSE_ERROR, 'parse error'));
      return;
    }
    // Each request is dispatched independently; responses may interleave,
    // which JSON-RPC permits since every response carries its request id.
    void dispatch(req, ctx, toolMap, ledger, env).then(resp => {
      if (resp) {
        write(resp);
      }
    });
  });

  return () => rl.close();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/* istanbul ignore next — process entry point, exercised via integration only. */
function isMain(): boolean {
  return require.main === module;
}

if (isMain()) {
  // Surface unexpected errors on stderr (stdout is reserved for JSON-RPC).
  process.on('uncaughtException', err => {
    process.stderr.write(`[autoclaw-mcp] uncaught: ${String(err)}\n`);
  });
  process.on('unhandledRejection', reason => {
    process.stderr.write(`[autoclaw-mcp] unhandled rejection: ${String(reason)}\n`);
  });
  startStdioServer();
}
