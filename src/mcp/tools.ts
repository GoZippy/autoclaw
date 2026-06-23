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
import { getKnowledgeGraph } from '../intelligence/kg/service';
import type { SearchStrategy } from '../intelligence/kg/types';
import { readAllBeacons } from '../fleet/beacons';
import { retrieveCode, buildContextPack } from '../intelligence';
import { gatherFleetData } from '../panel/fleetData';
import {
  buildFleetDigest,
  FLEET_STATUS_REL_PATH,
  type FleetDigest,
  type FleetDigestModel,
} from '../fleet/fleetDigest';

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
// Tool: presence.fleet (FF-1)
// ---------------------------------------------------------------------------

/**
 * Read the merged beacon fleet — every agent that has checked in via a beacon
 * (other IDEs, headless runners like Hermes/openclaw, MCP CLIs that called
 * `presence.beacon`). Reads both the machine-global `~/.autoclaw/beacons/` and
 * this workspace's `comms/beacons/` and dedupes per (agent_id, session_id),
 * freshest wins. Stale-beyond-TTL beacons are dropped unless `includeStale`.
 *
 * This is the read counterpart to the `presence.beacon` write tool: together
 * they let any MCP-speaking peer both check in and see who else is live —
 * closing the one A2A gap where MCP agents could message + claim but not be
 * visible in the fleet.
 */
const presenceFleetTool: ToolHandler = {
  definition: {
    name: 'presence.fleet',
    description:
      'List the live beacon fleet — agents from other tools/IDEs/runners that ' +
      'have checked in via a beacon. Merges machine-global + workspace beacons, ' +
      'deduped freshest-wins, stale ones dropped by default.',
    inputSchema: {
      type: 'object',
      properties: {
        includeStale: {
          type: 'boolean',
          description: 'Include beacons older than the freshness window (default false).',
        },
      },
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const includeStale = args.includeStale === true;
    try {
      const rows = await readAllBeacons({
        commsDir: path.join(ctx.autoclawDir, 'orchestrator', 'comms'),
        includeStale,
      });
      rows.sort((a, b) => a.agent_id.localeCompare(b.agent_id));
      return { ok: true, data: rows };
    } catch (err) {
      return {
        ok: false,
        reason: 'internal_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: fleet.digest (FLEET-DIGEST)
// ---------------------------------------------------------------------------

/**
 * Read the canonical FLEET-DIGEST (`fleet-status.json`) — one small, stable
 * artifact a joining/looping agent reads each SYNC instead of re-walking the
 * registry, every inbox, the claims dir, and `board.json`. The extension host
 * writes this on its refresh cadence; if it has not yet (no panel open / never
 * refreshed), we build the SAME digest on demand from `gatherFleetData` + the
 * board snapshot so an MCP-only peer is never blocked. WRITE-FREE: the
 * on-demand path computes in-memory and never persists.
 */
const fleetDigestTool: ToolHandler = {
  definition: {
    name: 'fleet.digest',
    description:
      'Read the FLEET-DIGEST (fleet-status.json): a single small, canonical ' +
      'snapshot of the fleet (agents, claims rollup, board lanes, awaiting-you) ' +
      'so an agent can SYNC without re-walking the whole comms tree. Falls back ' +
      'to building it on demand (read-only) when the file is absent.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  async run(ctx): Promise<ToolResult> {
    try {
      const statusPath = path.join(ctx.autoclawDir, 'orchestrator', 'comms', 'fleet-status.json');
      const onDisk = await readJsonFile<FleetDigest>(statusPath);
      if (onDisk && onDisk.schema_version) {
        return { ok: true, data: onDisk };
      }
      // Absent / unparseable → build the same digest on demand (read-only).
      const selfAgentId = ctx.sessionId ? ctx.host : (ctx.host || 'mcp');
      const model = await gatherFleetData({
        workspaceRoot: ctx.workspaceRoot,
        selfAgentId,
      });
      const board = await readJsonFile<unknown>(
        path.join(ctx.autoclawDir, 'orchestrator', 'board.json'),
      );
      const digestModel: FleetDigestModel = board
        ? { ...model, board: board as FleetDigestModel['board'] }
        : model;
      const digest = buildFleetDigest(digestModel, new Date().toISOString());
      return { ok: true, data: digest };
    } catch (err) {
      return {
        ok: false,
        reason: 'internal_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
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
// Tool: fabric.route
// ---------------------------------------------------------------------------
// Surfaces the capability-aware router (src/fabric/router.ts) over MCP so any
// host can ask "which agent should take this task?" without running the loop.
// Read-only: it reads registry.json + live capability_offer messages and
// returns a scored decision. The router itself is pure (no IO).

interface RegistryAgentEntry {
  id: string;
  agent_type?: string;
  capabilities?: string[];
  languages_supported?: string[];
  trust_level?: string;
  max_parallel_tasks?: number;
}

const fabricRouteTool: ToolHandler = {
  definition: {
    name: 'fabric.route',
    description:
      'Capability-aware routing decision: given a task\'s required capabilities, ' +
      'language, criticality, and phase, score every registered agent and return ' +
      'the best match (or a round-robin fallback). Reads registry.json + live ' +
      'capability_offer messages. Read-only — does not assign the task.',
    inputSchema: {
      type: 'object',
      properties: {
        required_capabilities: { type: 'array', items: { type: 'string' }, description: 'Capabilities the task needs.' },
        language: { type: 'string', description: 'Primary language of the work.' },
        criticality: { type: 'number', enum: [1, 2, 3], description: '1=CRITICAL (gates low-trust), 2=MAJOR, 3=ROUTINE.' },
        phase: { type: 'string', enum: ['plan', 'execute', 'review', 'grade'], description: 'Phase hint.' },
        task_id: { type: 'string', description: 'Optional task id for the report.' },
      },
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    // Lazy import keeps the server cold-start cheap; router is pure + light.
    const router = require('../fabric/router') as typeof import('../fabric/router');

    const reg = await readJsonFile<{ agents?: RegistryAgentEntry[] }>(
      path.join(commsDir(ctx), 'registry.json'),
    );
    if (!reg || !Array.isArray(reg.agents) || reg.agents.length === 0) {
      return { ok: false, reason: 'not_found', detail: 'no registry.json or no registered agents' };
    }

    // Base fleet from the registry.
    const baseAgents = reg.agents.map(a => ({
      id: a.id,
      agent_type: a.agent_type as never,
      capabilities: a.capabilities,
      languages_supported: a.languages_supported,
      trust_level: a.trust_level as never,
      max_parallel_tasks: a.max_parallel_tasks,
    }));

    // Overlay live capability_offer messages from the shared inbox (load/cost/availability).
    const sharedDir = path.join(commsDir(ctx), 'inboxes', 'shared');
    const offerFiles = (await listJsonFiles(sharedDir)).filter(f => f.includes('capability_offer'));
    const offers: Array<Record<string, unknown>> = [];
    for (const f of offerFiles) {
      const msg = await readJsonFile<InboxMessageFile>(path.join(sharedDir, f));
      const p = msg?.payload;
      if (p && typeof p === 'object') { offers.push(p as Record<string, unknown>); }
    }
    const liveAgents = router.agentsFromOffers(offers as never);
    const liveById = new Map(liveAgents.map(a => [a.id, a]));
    const fleet = baseAgents.map(a => ({ ...a, ...(liveById.get(a.id) ?? {}) }));

    const result = router.routeTask(fleet as never, {
      id: typeof args.task_id === 'string' ? args.task_id : 'adhoc',
      required_capabilities: Array.isArray(args.required_capabilities) ? args.required_capabilities as string[] : [],
      language: typeof args.language === 'string' ? args.language : undefined,
      criticality: (args.criticality as 1 | 2 | 3) ?? undefined,
      phase: args.phase as never,
    });
    return { ok: true, data: result };
  },
};

// ---------------------------------------------------------------------------
// Tool: kg.search
// ---------------------------------------------------------------------------
// KGC-4: surfaces the in-process Knowledge Graph's similarity recall over MCP
// so any agent can pull back shared thoughts. Resolves the per-process KG
// handle via getKnowledgeGraph; reads only (the underlying searchSimilar makes
// no mutation). When the KG is degraded (no SQLite driver) the search still
// succeeds with an empty result and a `degraded: true` flag so callers can tell
// recall is off rather than genuinely empty.

const KG_STRATEGIES: readonly SearchStrategy[] = ['multi', 'vec', 'fts'];

const kgSearchTool: ToolHandler = {
  definition: {
    name: 'kg.search',
    description:
      'Recall shared agent thoughts from the in-process Knowledge Graph by ' +
      'similarity to a text query (vector + full-text, optionally graph-aware). ' +
      'Read-only. Filter by project, agent, recency (since), or a bi-temporal ' +
      'as-of instant (at). Returns matching thoughts ranked by relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Free-text query to recall thoughts for.' },
        k: { type: 'number', description: 'Max results (default per KG store).' },
        project: { type: 'string', description: 'Restrict to thoughts in this project.' },
        agent: { type: 'string', description: 'Restrict to thoughts from this agent.' },
        since: { type: 'string', description: 'ISO8601 — only thoughts recorded at/after this instant.' },
        at: { type: 'string', description: 'ISO8601 — bi-temporal as-of: only thoughts valid at this instant.' },
        strategy: {
          type: 'string',
          enum: ['multi', 'vec', 'fts'],
          description: 'Recall strategy: multi (default), vec, or fts.',
        },
      },
      required: ['q'],
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const q = typeof args.q === 'string' ? args.q.trim() : '';
    if (!q) {
      return { ok: false, reason: 'invalid_params', detail: 'q is required' };
    }
    const strategyRaw = typeof args.strategy === 'string' ? args.strategy : undefined;
    if (strategyRaw !== undefined && !KG_STRATEGIES.includes(strategyRaw as SearchStrategy)) {
      return { ok: false, reason: 'invalid_params', detail: 'strategy must be multi | vec | fts' };
    }

    try {
      const handle = getKnowledgeGraph({ workspaceRoot: ctx.workspaceRoot });
      const thoughts = await handle.kg.searchSimilar(q, {
        ...(typeof args.k === 'number' && args.k > 0 ? { k: Math.floor(args.k) } : {}),
        ...(typeof args.project === 'string' && args.project ? { project: args.project } : {}),
        ...(typeof args.agent === 'string' && args.agent ? { agent: args.agent } : {}),
        ...(typeof args.since === 'string' && args.since ? { since: args.since } : {}),
        ...(typeof args.at === 'string' && args.at ? { at: args.at } : {}),
        ...(strategyRaw ? { strategy: strategyRaw as SearchStrategy } : {}),
      });
      return { ok: true, data: { thoughts, degraded: handle.degraded } };
    } catch (err) {
      return {
        ok: false,
        reason: 'internal_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: kg.traverse
// ---------------------------------------------------------------------------
// KGC-4: walk relations out from a seed thought in the Knowledge Graph. Pairs
// with kg.search (find a seed, then expand its neighbourhood). Read-only; same
// degraded contract as kg.search.

const kgTraverseTool: ToolHandler = {
  definition: {
    name: 'kg.traverse',
    description:
      'Traverse relations outward from a seed thought in the Knowledge Graph, ' +
      'returning the thoughts reachable along the given edge kinds within depth. ' +
      'Read-only — pair with kg.search to expand a recalled thought.',
    inputSchema: {
      type: 'object',
      properties: {
        seed: { type: 'string', description: 'Seed thought id to traverse from.' },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge kinds to follow (e.g. mentions, supersedes). Empty = all kinds.',
        },
        depth: { type: 'number', description: 'Max traversal depth (default per KG store).' },
      },
      required: ['seed'],
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const seed = typeof args.seed === 'string' ? args.seed.trim() : '';
    if (!seed) {
      return { ok: false, reason: 'invalid_params', detail: 'seed is required' };
    }
    const kinds = Array.isArray(args.kinds)
      ? args.kinds.filter((k): k is string => typeof k === 'string')
      : [];
    const depth = typeof args.depth === 'number' && args.depth > 0 ? Math.floor(args.depth) : undefined;

    try {
      const handle = getKnowledgeGraph({ workspaceRoot: ctx.workspaceRoot });
      const thoughts = await handle.kg.traverseFrom(seed, kinds, depth);
      return { ok: true, data: { thoughts, degraded: handle.degraded } };
    } catch (err) {
      return {
        ok: false,
        reason: 'internal_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** All read-only tools shipped in BP1, keyed by tool name. */
/**
 * `intelligence.retrieve` — RAG over this project's indexed codebase. Lets ANY
 * MCP host (Claude, Cursor, …) query the local Intelligence index. Read-only;
 * degrades to an empty result (never throws) when the vector backend is
 * unavailable in the server's runtime.
 */
const intelligenceRetrieveTool: ToolHandler = {
  definition: {
    name: 'intelligence.retrieve',
    description:
      "Semantic code retrieval over this project's AutoClaw Intelligence index. " +
      'Returns the most relevant indexed code chunks for a natural-language query. ' +
      'Empty when the codebase has not been indexed or the vector backend is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language description of the code you want.' },
        limit: { type: 'number', description: 'Max chunks to return (default backend limit; capped at 50).' },
      },
      required: ['query'],
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query === '') {
      return { ok: false, reason: 'invalid_params', detail: 'query is required' };
    }
    const limit =
      typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 50) : undefined;
    try {
      const results = await retrieveCode(query, { workspaceRoot: ctx.workspaceRoot });
      const capped = limit ? results.slice(0, limit) : results;
      return {
        ok: true,
        data: capped.map((r) => ({
          file: r.file,
          score: Number(r.score.toFixed(4)),
          content: r.content,
        })),
      };
    } catch (err) {
      return { ok: false, reason: 'internal_error', detail: (err as Error).message };
    }
  },
};

/**
 * `intelligence.contextPack` — build a grounded "context pack" for a task on
 * demand (Channel B delivery). Returns the assembled markdown plus a compact
 * summary, combining RAG-retrieved code, the team's proven patterns/learnings,
 * the learned style guide, recent memory, and durable knowledge-graph facts.
 *
 * Read-only: it computes and returns the pack but writes nothing to disk (the
 * orchestrator / CLI / command own writing `sprint-<N>-<agent>.context.md`).
 * Degrade-safe — with no embeddings backend it still returns a learnings/style/
 * memory pack; never throws.
 */
const intelligenceContextPackTool: ToolHandler = {
  definition: {
    name: 'intelligence.contextPack',
    description:
      'Build a grounded context pack for a task: RAG-retrieved code from this ' +
      'project, proven patterns/learnings, the learned style guide, recent ' +
      'memory, and durable knowledge-graph facts. Returns ready-to-read markdown ' +
      'plus a compact summary. Read-only (writes nothing); degrades to a ' +
      'learnings/style/memory pack when the vector backend is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the agent will work on (drives retrieval + header).' },
        agent: { type: 'string', description: 'Agent id this pack is for (optional).' },
        sprint: { type: 'number', description: 'Sprint number (optional).' },
        role: { type: 'string', description: 'Work-lane / role label (optional).' },
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Task ids covered (optional).' },
        max_code_chunks: { type: 'number', description: 'Max code chunks (default 5, capped at 20).' },
        max_learnings: { type: 'number', description: 'Max learnings (default 4, capped at 20).' },
        max_kg_facts: { type: 'number', description: 'Max KG facts (default 6, capped at 20).' },
      },
      required: ['task'],
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (task === '') {
      return { ok: false, reason: 'invalid_params', detail: 'task is required' };
    }
    const cap = (v: unknown): number | undefined =>
      typeof v === 'number' && v > 0 ? Math.min(Math.floor(v), 20) : undefined;
    const taskIds = Array.isArray(args.task_ids)
      ? args.task_ids.filter((x): x is string => typeof x === 'string')
      : undefined;
    try {
      const pack = await buildContextPack(
        {
          task,
          agentId: typeof args.agent === 'string' ? args.agent : undefined,
          sprint: typeof args.sprint === 'number' ? args.sprint : undefined,
          role: typeof args.role === 'string' ? args.role : undefined,
          taskIds: taskIds && taskIds.length > 0 ? taskIds : undefined,
        },
        {
          workspaceRoot: ctx.workspaceRoot,
          maxCodeChunks: cap(args.max_code_chunks),
          maxLearnings: cap(args.max_learnings),
          maxKgFacts: cap(args.max_kg_facts),
        },
      );
      return {
        ok: true,
        data: {
          markdown: pack.markdown,
          summary: pack.summary,
          used_code: pack.usedCode,
          code_hits: pack.codeHits,
          learning_hits: pack.learningHits,
          kg_hits: pack.kgHits,
          degraded: pack.degraded,
          notes: pack.notes,
        },
      };
    } catch (err) {
      return { ok: false, reason: 'internal_error', detail: (err as Error).message };
    }
  },
};

export const READ_ONLY_TOOLS: ToolHandler[] = [
  recallQueryTool,
  fleetStatusTool,
  fleetCardsTool,
  presenceFleetTool,
  fleetDigestTool,
  inboxReadTool,
  todoListTool,
  doctorRunTool,
  fabricRouteTool,
  kgSearchTool,
  kgTraverseTool,
  intelligenceRetrieveTool,
  intelligenceContextPackTool,
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
