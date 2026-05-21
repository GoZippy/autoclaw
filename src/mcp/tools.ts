/**
 * tools.ts — Read-only tool implementations for the `autoclaw-mcp` server.
 *
 * Every tool here is a pure file-I/O reader of the workspace `.autoclaw/`
 * state. No tool writes to disk, makes a network call, or holds mutable
 * global state — so any number of host subprocesses can run concurrently
 * (RFC §7.2).
 *
 * Tools whose backing data is not yet wired up return a typed
 * `{ ok: false, reason: 'not_implemented' }` rather than throwing (RFC §9).
 *
 * BP3 write tools (note.add, inbox.send, inbox.archive, claim.task,
 * dream.run, consensus.vote) live in writeTools.ts and are appended to the
 * active tool set by server.ts (`activeTools`) only when the write gate is
 * open — workspace scope AND `autoclaw.mcp.allowWrites`.
 *
 * Sprint 2 — BP1 (WA-3)
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  ToolContext,
  ToolHandler,
  ToolResult,
  McpToolDefinition,
} from './types';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Shared file-reading helpers (read-only)
// ---------------------------------------------------------------------------

/** Strip a UTF-8 BOM if present, then JSON.parse. Returns null on any error. */
function parseJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(raw.replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}

/** Read + parse a JSON file. Returns null if missing or malformed. */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return parseJsonSafe<T>(raw);
  } catch {
    return null;
  }
}

/** List `.json` files (filenames only) in a directory, excluding `_state/`. */
async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => e.name);
  } catch {
    return [];
  }
}

/** Path to the orchestrator comms directory. */
function commsDir(ctx: ToolContext): string {
  return path.join(ctx.autoclawDir, 'orchestrator', 'comms');
}

/** Path to the orchestrator state file. */
function statePath(ctx: ToolContext): string {
  return path.join(ctx.autoclawDir, 'orchestrator', 'state.json');
}

// ---------------------------------------------------------------------------
// Minimal shapes for the orchestrator files we read.
// (Kept local — we deliberately do NOT import src/orchestrator or src/comms
//  so the MCP server cold-starts fast and stays inside its own scope.)
// ---------------------------------------------------------------------------

interface OrchestratorAgentEntry {
  status: string;
  sprint: number | null;
  tasks: string[];
  last_heartbeat?: string;
}

interface OrchestratorState {
  project?: string;
  current_sprint?: number | null;
  tasks_total?: number;
  tasks_complete?: number;
  status?: string;
  agents?: Record<string, OrchestratorAgentEntry>;
  sprint_statuses?: Record<string, string>;
  message_ledger?: Record<string, unknown>;
  last_updated?: string;
}

interface HeartbeatFile {
  agent_id: string;
  timestamp: string;
  status: string;
  current_task: string | null;
  sprint: number | null;
  session_id?: string;
  current_llm?: string;
  queue_depth?: number;
}

interface InboxMessageFile {
  id: string;
  from: string;
  to: string;
  type: string;
  timestamp: string;
  sprint?: number;
  task_id?: string;
  payload?: Record<string, unknown>;
  requires_response?: boolean;
}

interface InboxStateFile {
  msg_id: string;
  received_at: string;
  read_at: string | null;
  replied_at: string | null;
  archived_at: string | null;
}

// ---------------------------------------------------------------------------
// Health derivation — mirrors the LMD stall thresholds (src/lmd/types.ts)
// without importing the LMD so the server stays self-contained & fast.
// ---------------------------------------------------------------------------

type FleetStatus = 'idle' | 'working' | 'stalled' | 'dead';

const DEGRADED_MS = 60_000; // ≥ 60 s stale
const STALLED_MS = 150_000; // ≥ 150 s stale
const DEAD_MS = 300_000; // ≥ 300 s stale

function deriveStatus(hb: HeartbeatFile, now: number): FleetStatus {
  const age = now - new Date(hb.timestamp).getTime();
  if (!Number.isFinite(age)) {
    return 'dead';
  }
  if (age >= DEAD_MS) {
    return 'dead';
  }
  if (age >= STALLED_MS) {
    return 'stalled';
  }
  // Within the live window: 'active' heartbeat with a task → working.
  if (hb.status === 'active' && hb.current_task) {
    return 'working';
  }
  if (age >= DEGRADED_MS) {
    return 'stalled';
  }
  return 'idle';
}

// ---------------------------------------------------------------------------
// Tool: fleet.status
// ---------------------------------------------------------------------------

interface FleetStatusRow {
  agent: string;
  sessionId: string | null;
  host: string | null;
  lastHeartbeat: string;
  status: FleetStatus;
  currentTask?: string;
}

async function readPrimaryHeartbeats(ctx: ToolContext): Promise<HeartbeatFile[]> {
  const dir = path.join(commsDir(ctx), 'heartbeats');
  const files = await listJsonFiles(dir);
  // Primary heartbeats are `<agent>.json`; session sidecars are
  // `<agent>-<session>.json`. We cannot reliably split on '-' (agent ids may
  // contain dashes), so read every file and dedupe by agent_id keeping the
  // newest timestamp.
  const byAgent = new Map<string, HeartbeatFile>();
  for (const f of files) {
    const hb = await readJsonFile<HeartbeatFile>(path.join(dir, f));
    if (!hb || !hb.agent_id || !hb.timestamp) {
      continue;
    }
    const existing = byAgent.get(hb.agent_id);
    if (!existing || new Date(hb.timestamp).getTime() > new Date(existing.timestamp).getTime()) {
      byAgent.set(hb.agent_id, hb);
    }
  }
  return [...byAgent.values()];
}

const fleetStatusTool: ToolHandler = {
  definition: {
    name: 'fleet.status',
    description:
      'Live status of every agent in the fleet, derived from heartbeat files. ' +
      'Returns one row per agent with derived status (idle/working/stalled/dead).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['workspace', 'program'],
          description: 'workspace = this repo only (default). program = cross-repo (not yet wired).',
        },
      },
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const scope = (args.scope as string) ?? 'workspace';
    if (scope === 'program') {
      // RFC §9.5: program scope depends on the program registry (C.14).
      return { ok: false, reason: 'not_implemented', detail: 'program scope pending C.14' };
    }
    const hbs = await readPrimaryHeartbeats(ctx);
    const now = Date.now();
    const rows: FleetStatusRow[] = hbs
      .map(hb => ({
        agent: hb.agent_id,
        sessionId: hb.session_id ?? null,
        host: hb.current_llm ?? null,
        lastHeartbeat: hb.timestamp,
        status: deriveStatus(hb, now),
        ...(hb.current_task ? { currentTask: hb.current_task } : {}),
      }))
      .sort((a, b) => a.agent.localeCompare(b.agent));
    return { ok: true, data: rows };
  },
};

// ---------------------------------------------------------------------------
// Tool: fleet.cards
// ---------------------------------------------------------------------------

interface FleetCard {
  agent: string;
  sessionId: string | null;
  host: string | null;
  status: FleetStatus;
  lastHeartbeat: string;
  sprint: number | null;
  assignedTasks: string[];
  orchestratorStatus: string | null;
  /** Per-host MCP telemetry rollup, populated by the server (see server.ts). */
  mcpActivity?: {
    calls: number;
    p50_ms: number;
    okRate: number;
  };
}

const fleetCardsTool: ToolHandler = {
  definition: {
    name: 'fleet.cards',
    description:
      'Richer per-agent cards: capabilities, scope, sprint assignment, and ' +
      'orchestrator-tracked status. Combines heartbeat files with state.json.',
    inputSchema: { type: 'object', properties: {} },
  },
  async run(ctx): Promise<ToolResult> {
    const state = await readJsonFile<OrchestratorState>(statePath(ctx));
    const hbs = await readPrimaryHeartbeats(ctx);
    const now = Date.now();
    const hbByAgent = new Map(hbs.map(h => [h.agent_id, h]));

    // Union of agents seen in heartbeats and in state.json.
    const agentIds = new Set<string>(hbs.map(h => h.agent_id));
    for (const id of Object.keys(state?.agents ?? {})) {
      agentIds.add(id);
    }

    const cards: FleetCard[] = [...agentIds]
      .map(agent => {
        const hb = hbByAgent.get(agent);
        const orch = state?.agents?.[agent];
        return {
          agent,
          sessionId: hb?.session_id ?? null,
          host: hb?.current_llm ?? null,
          status: hb ? deriveStatus(hb, now) : 'dead',
          lastHeartbeat: hb?.timestamp ?? (orch?.last_heartbeat ?? ''),
          sprint: hb?.sprint ?? orch?.sprint ?? null,
          assignedTasks: orch?.tasks ?? [],
          orchestratorStatus: orch?.status ?? null,
        };
      })
      .sort((a, b) => a.agent.localeCompare(b.agent));

    return { ok: true, data: cards };
  },
};

// ---------------------------------------------------------------------------
// Tool: inbox.read
// ---------------------------------------------------------------------------

interface InboxReadRow {
  id: string;
  from: string;
  to: string;
  type: string;
  timestamp: string;
  sprint?: number;
  task_id?: string;
  requires_response: boolean;
  read: boolean;
  replied: boolean;
  archived: boolean;
}

/** Resolve which inbox directory to read for a given agent id. */
function inboxDir(ctx: ToolContext, agent: string): string {
  return path.join(commsDir(ctx), 'inboxes', agent);
}

async function readInboxMessages(
  dir: string,
  opts: { unread?: boolean; awaitingMe?: boolean }
): Promise<InboxReadRow[]> {
  const files = await listJsonFiles(dir);
  const rows: InboxReadRow[] = [];
  for (const f of files) {
    const msg = await readJsonFile<InboxMessageFile>(path.join(dir, f));
    if (!msg || !msg.id) {
      continue;
    }
    const msgId = f.replace(/\.json$/, '');
    const st = await readJsonFile<InboxStateFile>(path.join(dir, '_state', `${msgId}.json`));
    const read = Boolean(st?.read_at);
    const replied = Boolean(st?.replied_at);
    const archived = Boolean(st?.archived_at);
    const requiresResponse = msg.requires_response === true;

    if (opts.unread && read) {
      continue;
    }
    if (opts.awaitingMe && (!requiresResponse || replied || archived)) {
      continue;
    }
    rows.push({
      id: msg.id,
      from: msg.from,
      to: msg.to,
      type: msg.type,
      timestamp: msg.timestamp,
      ...(msg.sprint !== undefined ? { sprint: msg.sprint } : {}),
      ...(msg.task_id !== undefined ? { task_id: msg.task_id } : {}),
      requires_response: requiresResponse,
      read,
      replied,
      archived,
    });
  }
  return rows.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

const inboxReadTool: ToolHandler = {
  definition: {
    name: 'inbox.read',
    description:
      'List cross-agent messages in an inbox. Defaults to the caller session ' +
      "agent's inbox; pass `agent` to read another inbox or `shared` for the broadcast bus.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: "Inbox to read. Omit for the caller's inbox. Use 'shared' for broadcasts.",
        },
        unread: { type: 'boolean', description: 'Only return unread messages.' },
        awaiting_me: {
          type: 'boolean',
          description: 'Only return messages that require a response and have not been replied to.',
        },
      },
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    // Identity: explicit `agent`, else the caller's session-derived agent.
    // stdio has no auth — RFC §4 — so we fall back to 'shared' when the host
    // exposed no session and the caller named no agent.
    const agent =
      (typeof args.agent === 'string' && args.agent.trim()) ||
      ctx.sessionId ||
      'shared';
    const dir = inboxDir(ctx, agent);
    try {
      await fsPromises.access(dir);
    } catch {
      return { ok: false, reason: 'not_found', detail: `no inbox for "${agent}"` };
    }
    const rows = await readInboxMessages(dir, {
      unread: args.unread === true,
      awaitingMe: args.awaiting_me === true,
    });
    return { ok: true, data: { agent, count: rows.length, messages: rows } };
  },
};

// ---------------------------------------------------------------------------
// Tool: todo.list
// ---------------------------------------------------------------------------

const todoListTool: ToolHandler = {
  definition: {
    name: 'todo.list',
    description:
      'TODO / AI: items discovered by the AutoClaw spider, with priority and age. ' +
      'Depends on the spider TODO index — currently a stub until that lands.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['open', 'all'], description: 'open (default) or all.' },
        classify: { type: 'boolean', description: 'Run priority classification on results.' },
      },
    },
  },
  async run(ctx): Promise<ToolResult> {
    // The spider's TODO index is not part of BP1's read surface. If a future
    // sprint writes a `.autoclaw/spider/todos.json`, this tool can read it.
    const todoIndex = path.join(ctx.autoclawDir, 'spider', 'todos.json');
    const data = await readJsonFile<unknown>(todoIndex);
    if (data === null) {
      return {
        ok: false,
        reason: 'not_implemented',
        detail: 'spider TODO index not yet produced; depends on the TODO spider task',
      };
    }
    return { ok: true, data };
  },
};

// ---------------------------------------------------------------------------
// Tool: recall.query
// ---------------------------------------------------------------------------

interface RecallHit {
  fact: string;
  source: string;
  valid_from: string;
  recorded_at: string;
  score: number;
}

const recallQueryTool: ToolHandler = {
  definition: {
    name: 'recall.query',
    description:
      'Query the AutoClaw memory store for facts relevant to a text query. ' +
      'Reads consolidated facts from the dream memory; archive-tier search ' +
      'depends on the KG daemon and is not wired in BP1.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query.' },
        topK: { type: 'number', description: 'Max results (default 8).' },
        tier: {
          type: 'string',
          enum: ['core', 'recall', 'archive'],
          description: 'Memory tier. archive depends on the KG daemon.',
        },
        asOf: { type: 'string', description: 'ISO8601 — bi-temporal as-of query (not wired in BP1).' },
      },
      required: ['query'],
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return { ok: false, reason: 'invalid_params', detail: 'query is required' };
    }
    const tier = (args.tier as string) ?? 'recall';
    if (tier === 'archive') {
      // RFC §9.3: archive tier / bi-temporal recall depends on KG daemon (C.4).
      return {
        ok: false,
        reason: 'not_implemented',
        detail: 'archive-tier recall depends on the KG daemon (C.4)',
      };
    }

    // BP1 read surface: the consolidated dream memory file. We do a simple
    // case-insensitive token-overlap scan — no embeddings (zero LLM/network).
    // TODO(BP2+): replace with a real recall index once the KG bridge lands.
    const memoryPath = path.join(ctx.autoclawDir, 'dream', 'MEMORY.md');
    let raw: string;
    try {
      raw = await fsPromises.readFile(memoryPath, 'utf8');
    } catch {
      return {
        ok: false,
        reason: 'not_implemented',
        detail: 'no consolidated memory yet; run /dream to produce .autoclaw/dream/MEMORY.md',
      };
    }

    const topK = typeof args.topK === 'number' && args.topK > 0 ? Math.floor(args.topK) : 8;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const lines = raw.split('\n').filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));

    const scored: RecallHit[] = lines
      .map(line => {
        const lc = line.toLowerCase();
        const overlap = terms.filter(t => lc.includes(t)).length;
        return { line, score: terms.length ? overlap / terms.length : 0 };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(s => ({
        fact: s.line.trim().replace(/^[-*]\s*/, ''),
        source: 'dream/MEMORY.md',
        valid_from: '',
        recorded_at: '',
        score: Number(s.score.toFixed(3)),
      }));

    return { ok: true, data: scored };
  },
};

// ---------------------------------------------------------------------------
// Tool: doctor.run
// ---------------------------------------------------------------------------

interface DoctorReport {
  ok: boolean;
  workspaceRoot: string;
  scope: string;
  checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
}

const doctorRunTool: ToolHandler = {
  definition: {
    name: 'doctor.run',
    description:
      'Structured health check of the AutoClaw workspace state — verifies the ' +
      '.autoclaw directory, orchestrator state, comms bus, and heartbeats are present and parseable.',
    inputSchema: { type: 'object', properties: {} },
  },
  async run(ctx): Promise<ToolResult> {
    const checks: DoctorReport['checks'] = [];

    // .autoclaw dir
    try {
      await fsPromises.access(ctx.autoclawDir);
      checks.push({ name: 'autoclaw-dir', status: 'pass', detail: ctx.autoclawDir });
    } catch {
      checks.push({
        name: 'autoclaw-dir',
        status: 'fail',
        detail: `missing: ${ctx.autoclawDir}`,
      });
    }

    // orchestrator state.json — RFC §7.3: must be reachable.
    const state = await readJsonFile<OrchestratorState>(statePath(ctx));
    if (state === null) {
      checks.push({
        name: 'orchestrator-state',
        status: 'warn',
        detail: 'state.json missing or unparseable',
      });
    } else {
      checks.push({
        name: 'orchestrator-state',
        status: 'pass',
        detail: `project=${state.project ?? '?'} sprint=${state.current_sprint ?? '?'} ` +
          `tasks=${state.tasks_complete ?? 0}/${state.tasks_total ?? 0}`,
      });
    }

    // comms bus
    const inboxesDir = path.join(commsDir(ctx), 'inboxes');
    try {
      await fsPromises.access(inboxesDir);
      checks.push({ name: 'comms-bus', status: 'pass', detail: inboxesDir });
    } catch {
      checks.push({ name: 'comms-bus', status: 'warn', detail: 'no inboxes directory' });
    }

    // heartbeats
    const hbs = await readPrimaryHeartbeats(ctx);
    checks.push({
      name: 'heartbeats',
      status: hbs.length > 0 ? 'pass' : 'warn',
      detail: `${hbs.length} agent heartbeat file(s)`,
    });

    const allOk = checks.every(c => c.status === 'pass');
    const report: DoctorReport = {
      ok: allOk,
      workspaceRoot: ctx.workspaceRoot,
      scope: ctx.scope,
      checks,
    };
    return { ok: true, data: report };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** All read-only tools shipped in BP1, keyed by tool name. */
export const READ_ONLY_TOOLS: ToolHandler[] = [
  recallQueryTool,
  fleetStatusTool,
  fleetCardsTool,
  inboxReadTool,
  todoListTool,
  doctorRunTool,
];

/** Build a name → handler map for O(1) `tools/call` dispatch. */
export function buildToolMap(handlers: ToolHandler[] = READ_ONLY_TOOLS): Map<string, ToolHandler> {
  const map = new Map<string, ToolHandler>();
  for (const h of handlers) {
    map.set(h.definition.name, h);
  }
  return map;
}

/** Tool definitions for the `tools/list` response. */
export function listToolDefinitions(handlers: ToolHandler[] = READ_ONLY_TOOLS): McpToolDefinition[] {
  return handlers.map(h => h.definition);
}
