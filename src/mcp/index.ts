/**
 * index.ts — Public API surface for the `autoclaw-mcp` server.
 *
 * The MCP server is a stdio JSON-RPC process that exposes AutoClaw's
 * state as Model Context Protocol tools. It is spawned per host
 * (Claude Code, Cursor, Kiro, Antigravity, …) so any agent can read fleet
 * status, inboxes, recall, and doctor output — and, when writes are enabled,
 * mutate workspace state — mid-session.
 *
 * BP1: read-only tool suite + cost ledger.
 * BP2: `autoclaw mcp install` — host detection + mcpServers.autoclaw merge
 *      (see install.ts).
 * BP3: write tools (note.add, inbox.send, inbox.archive, claim.task,
 *      dream.run, consensus.vote), gated on workspace scope + allowWrites
 *      (see writeTools.ts).
 *
 * Sprint 2 — BP1/BP2/BP3 (WA-3)
 */

// Types
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  McpServerInfo,
  InitializeResult,
  McpToolDefinition,
  McpContentBlock,
  McpToolCallResult,
  McpScope,
  ToolContext,
  ToolResult,
  ToolFailureReason,
  ToolHandler,
  CostLedgerEntry,
} from './types';
export { JSON_RPC_ERRORS, MCP_PROTOCOL_VERSION } from './types';

// Cost ledger
export { CostLedger, hashArgs } from './costLedger';

// Read-only tools
export {
  READ_ONLY_TOOLS,
  buildToolMap,
  listToolDefinitions,
} from './tools';

// Server
export {
  startStdioServer,
  dispatch,
  buildContext,
  resolveAutoclawDir,
  activeTools,
} from './server';

// Write tools (BP3)
export { WRITE_TOOLS, checkWriteGate } from './writeTools';
export type { WriteGateDecision } from './writeTools';

// `autoclaw mcp install` (BP2)
export {
  installAll,
  formatReport,
  buildServerEntry,
  serverEntriesEqual,
  mergeRegistryFile,
  mergeTomlRegistryFile,
  parseTomlAutoclawEntry,
} from './install';
export type {
  InstallScope,
  InstallOutcome,
  InstallResult,
  InstallOptions,
  HostId,
  McpServerEntry,
} from './install';
