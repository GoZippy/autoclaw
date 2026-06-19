/**
 * writeTools.ts — Gated write tools for the `autoclaw-mcp` server (BP3).
 *
 * BP1 shipped a read-only tool surface. BP3 adds the six write tools from
 * RFC §3.2 — `note.add`, `inbox.send`, `inbox.archive`, `claim.task`,
 * `dream.run`, `consensus.vote` — each of which mutates workspace state.
 *
 * Authorization (RFC §3.2):
 *   1. The server must be **workspace-scoped** (`ctx.scope === 'workspace'`).
 *      A user-global install is read-only — there is no project to write to.
 *   2. `autoclaw.mcp.allowWrites` must be `true`. The MCP slice stays
 *      self-contained (no import of the orchestrator config layer), so the
 *      flag is read from `.autoclaw/mcp/config.json` — `{ "allowWrites": true }`
 *      — with an `AUTOCLAW_MCP_ALLOW_WRITES` env override for hosts that pass
 *      env through. Deny by default: absent/false/unparseable ⇒ no writes.
 *
 * Every successful write appends a row to the orchestrator state ledger
 * (`.autoclaw/orchestrator/state.json` → `message_ledger`, keyed by a
 * generated `msg.id`) so file-bus consumers and `doctor` see MCP-originated
 * mutations. The state.json read-modify-write is the one place this module
 * is not strictly append-only; it is serialised per-process and tolerant of
 * a missing/corrupt file (it recreates a minimal ledger).
 *
 * `claim.task` uses **create-exclusive** write semantics per
 * docs/AGENT_SESSION_PROTOCOL.md §4 — the filesystem `wx` flag is the mutex;
 * a losing racer gets `{ ok: false, reason: 'conflict' }`.
 *
 * Sprint 2 — BP3 (WA-3)
 *
 * Sprint 3 — BP3 polish (WA-3):
 *   - **Per-tool authorization** beyond the coarse `allowWrites` boolean.
 *     `authorizeWriteTool` (scoping.ts) lets an operator withhold an
 *     individual tool via `.autoclaw/mcp/config.json` → `tools.<name>.allow`
 *     while leaving writes broadly enabled. Each tool now calls
 *     {@link authorizeTool} before mutating anything.
 *   - **Write-tool audit trail** in `state.json` → `write_tool_audit`: every
 *     write attempt (allowed *or* denied) appends an immutable audit row so
 *     `doctor` and the fleet panel can see who invoked which write tool, when,
 *     and whether it was authorized — distinct from the `message_ledger`,
 *     which only indexes *successful* message-shaped writes.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { ToolContext, ToolHandler, ToolResult } from './types';
import {
  authorizeWriteTool,
  parseToolAuthPolicy,
  type ScopingDecision,
  type ToolAuthPolicy,
} from './scoping';
import { LlmRegistry } from '../llm';
import { writeBeacon, type Beacon } from '../fleet/beacons';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// PA-5: LLM registry factory (injectable for tests). Delegates routing to the
// existing src/llm registry — ZMLR-first, oracle fallback (Option C). No
// parallel router lives here.
// ---------------------------------------------------------------------------
let llmRegistryFactory: (workspaceRoot: string) => LlmRegistry =
  (workspaceRoot) => new LlmRegistry({ workspaceRoot });

/** Test seam: override how `llm.*` tools obtain their registry. */
export function _setLlmRegistryFactoryForTests(
  factory: ((workspaceRoot: string) => LlmRegistry) | null,
): void {
  llmRegistryFactory = factory ?? ((workspaceRoot) => new LlmRegistry({ workspaceRoot }));
}

// ---------------------------------------------------------------------------
// Authorization gate
// ---------------------------------------------------------------------------

/** Why a write was (not) permitted. `detail` is human-readable. */
export interface WriteGateDecision {
  allowed: boolean;
  detail: string;
}

/**
 * Decide whether write tools may run for this context.
 *
 * Order: scope first (a global install can never write), then the
 * `allowWrites` flag. Both must hold; deny by default.
 */
export function checkWriteGate(ctx: ToolContext, env: NodeJS.ProcessEnv): WriteGateDecision {
  if (ctx.scope !== 'workspace') {
    return {
      allowed: false,
      detail: 'write tools require a workspace-scoped MCP install (scope is global)',
    };
  }
  if (!readAllowWrites(ctx, env)) {
    return {
      allowed: false,
      detail:
        'writes are disabled; set "allowWrites": true in .autoclaw/mcp/config.json ' +
        '(or AUTOCLAW_MCP_ALLOW_WRITES=true) to enable',
    };
  }
  return { allowed: true, detail: 'writes enabled' };
}

/**
 * Resolve the `allowWrites` flag. The env override wins when set to a
 * truthy string; otherwise `.autoclaw/mcp/config.json` is consulted.
 * Any read/parse failure resolves to `false` (deny by default).
 */
function readAllowWrites(ctx: ToolContext, env: NodeJS.ProcessEnv): boolean {
  const envRaw = (env.AUTOCLAW_MCP_ALLOW_WRITES ?? '').trim().toLowerCase();
  if (envRaw === 'true' || envRaw === '1' || envRaw === 'yes') {
    return true;
  }
  if (envRaw === 'false' || envRaw === '0' || envRaw === 'no') {
    return false;
  }
  try {
    const raw = fs.readFileSync(path.join(ctx.autoclawDir, 'mcp', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw.replace(/^﻿/, '')) as { allowWrites?: unknown };
    return cfg.allowWrites === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-tool authorization (BP3 polish — Sprint 3)
// ---------------------------------------------------------------------------

/**
 * Read the per-tool authorization policy from `.autoclaw/mcp/config.json`.
 * A missing or unparseable file yields an empty policy — every tool then
 * inherits the coarse `allowWrites` gate (deny-by-default still applies to
 * the coarse gate; an empty policy never *widens* access).
 */
function readToolAuthPolicy(ctx: ToolContext): ToolAuthPolicy {
  try {
    const raw = fs.readFileSync(path.join(ctx.autoclawDir, 'mcp', 'config.json'), 'utf8');
    return parseToolAuthPolicy(JSON.parse(raw.replace(/^﻿/, '')));
  } catch {
    return {};
  }
}

/**
 * Authorize one named write tool for this context — the per-invocation gate
 * each tool calls before mutating. Combines scope, the coarse `allowWrites`
 * flag, and the per-tool policy (see {@link authorizeWriteTool}).
 */
function authorizeTool(ctx: ToolContext, env: NodeJS.ProcessEnv, toolName: string): ScopingDecision {
  return authorizeWriteTool(ctx, readAllowWrites(ctx, env), toolName, readToolAuthPolicy(ctx));
}

/**
 * Wrap a write tool's `run` so it (a) authorizes per-tool first and (b)
 * appends a {@link writeToolAudit} row for every attempt — allowed or denied.
 *
 * A denied attempt returns `{ ok: false, reason: 'permission_denied' }` and
 * never reaches the tool body. The env used for the `allowWrites` override is
 * `process.env`; `server.ts` resolves the same value when it builds the gated
 * tool set, so the two stay consistent.
 */
function gated(toolName: string, body: ToolHandler['run']): ToolHandler['run'] {
  return async (ctx, args): Promise<ToolResult> => {
    const decision = authorizeTool(ctx, process.env, toolName);
    if (!decision.allowed) {
      await writeToolAudit(ctx, {
        tool: toolName,
        authorized: false,
        auth_code: decision.code,
        ...callerOf(ctx),
      });
      return { ok: false, reason: 'permission_denied', detail: decision.detail };
    }
    const result = await body(ctx, args);
    await writeToolAudit(ctx, {
      tool: toolName,
      authorized: true,
      auth_code: decision.code,
      result_ok: result.ok,
      ...callerOf(ctx),
    });
    return result;
  };
}

// ---------------------------------------------------------------------------
// Shared write helpers
// ---------------------------------------------------------------------------

/** Orchestrator paths — kept local so the MCP slice stays self-contained. */
function statePath(ctx: ToolContext): string {
  return path.join(ctx.autoclawDir, 'orchestrator', 'state.json');
}
function commsDir(ctx: ToolContext): string {
  return path.join(ctx.autoclawDir, 'orchestrator', 'comms');
}

/** A short, sortable, collision-resistant id fragment. */
function shortId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/** A `msg-<uuid>` id for ledger entries (AGENT_SESSION_PROTOCOL §3). */
function newMsgId(): string {
  return `msg-${crypto.randomUUID()}`;
}

/** ISO-8601-with-millis filename-safe timestamp (no `:` — Windows-safe). */
function fileTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Append one entry to `state.json` → `message_ledger`, keyed by `msgId`.
 *
 * Read-modify-write of a JSON document. Best-effort but reported: a failure
 * here does NOT roll back the primary write — the primary write (a note,
 * a message file, a claim) is already durable on disk; the ledger is the
 * orchestrator's index of it. We surface a ledger failure in the tool detail
 * rather than failing the whole call, mirroring the cost-ledger's
 * best-effort posture (RFC §8).
 *
 * Tolerates a missing or corrupt state.json by recreating a minimal shell.
 */
async function appendLedgerEntry(
  ctx: ToolContext,
  msgId: string,
  entry: Record<string, unknown>
): Promise<{ ok: boolean; detail: string }> {
  const file = statePath(ctx);
  let doc: Record<string, unknown> = {};
  try {
    const raw = await fsPromises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw.replace(/^﻿/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing/corrupt — recreate a minimal shell so the write still lands.
  }

  const ledgerRaw = doc.message_ledger;
  const ledger: Record<string, unknown> =
    ledgerRaw && typeof ledgerRaw === 'object' && !Array.isArray(ledgerRaw)
      ? (ledgerRaw as Record<string, unknown>)
      : {};

  ledger[msgId] = { ...entry, source: 'mcp', recorded_at: new Date().toISOString() };
  doc.message_ledger = ledger;
  doc.last_updated = new Date().toISOString();

  try {
    await fsPromises.mkdir(path.dirname(file), { recursive: true });
    await fsPromises.writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    return { ok: true, detail: '' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Caller identity for ledger attribution — host plus session when known. */
function callerOf(ctx: ToolContext): { from: string; session?: string } {
  return { from: ctx.host, ...(ctx.sessionId ? { session: ctx.sessionId } : {}) };
}

// ---------------------------------------------------------------------------
// Write-tool audit trail (BP3 polish — Sprint 3)
// ---------------------------------------------------------------------------

/** One immutable row in the `state.json` → `write_tool_audit` array. */
interface WriteToolAuditRow {
  /** Tool name, e.g. `inbox.send`. */
  tool: string;
  /** Whether the per-tool authorization gate allowed the call. */
  authorized: boolean;
  /** The scoping decision code (`ok` | `global_scope` | `writes_disabled` | `tool_denied`). */
  auth_code: string;
  /** For an authorized call, whether the tool body itself reported `ok`. */
  result_ok?: boolean;
  /** Calling host. */
  from: string;
  /** Calling session, when known. */
  session?: string;
  /** ISO timestamp the audit row was written. */
  audited_at: string;
}

/**
 * Append an audit row to `state.json` → `write_tool_audit`.
 *
 * Distinct from {@link appendLedgerEntry}: the `message_ledger` only indexes
 * *successful, message-shaped* writes (a note, a message file, a claim). The
 * `write_tool_audit` array records **every write-tool attempt**, including
 * ones the per-tool gate *denied* — so `doctor` and the panel can answer
 * "who tried to invoke which write tool, and was it permitted?".
 *
 * Best-effort and bounded: the array is capped at the most recent 500 rows so
 * a long-lived workspace's state.json does not grow without limit. A failure
 * here never affects the tool's own result.
 */
async function writeToolAudit(
  ctx: ToolContext,
  row: Omit<WriteToolAuditRow, 'audited_at'>,
): Promise<void> {
  const file = statePath(ctx);
  let doc: Record<string, unknown> = {};
  try {
    const raw = await fsPromises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw.replace(/^﻿/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing/corrupt — recreate a minimal shell so the audit still lands.
  }

  const existing = Array.isArray(doc.write_tool_audit)
    ? (doc.write_tool_audit as unknown[])
    : [];
  const auditRow: WriteToolAuditRow = { ...row, audited_at: new Date().toISOString() };
  const capped = [...existing, auditRow].slice(-500);
  doc.write_tool_audit = capped;
  doc.last_updated = new Date().toISOString();

  try {
    await fsPromises.mkdir(path.dirname(file), { recursive: true });
    await fsPromises.writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch {
    // Audit is best-effort — never fail the tool over it.
  }
}

// ---------------------------------------------------------------------------
// Tool: note.add
// ---------------------------------------------------------------------------

/**
 * Append a quick-capture note to `.autoclaw/dream/MEMORY.md` under a
 * `## Follow-ups` section. `/dream` later promotes it to a consolidated
 * fact (RFC §3.2). Append-only — never rewrites existing memory.
 */
const noteAddTool: ToolHandler = {
  definition: {
    name: 'note.add',
    description:
      'Append a quick-capture note to the dream memory Follow-ups section. ' +
      '/dream later promotes it to a consolidated fact. Requires write access.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note text.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags appended as #hashtags.',
        },
      },
      required: ['text'],
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) {
      return { ok: false, reason: 'invalid_params', detail: 'text is required' };
    }
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((t): t is string => typeof t === 'string')
      : [];

    const memoryPath = path.join(ctx.autoclawDir, 'dream', 'MEMORY.md');
    const now = new Date();
    const tagStr = tags.length ? ' ' + tags.map(t => `#${t.replace(/^#/, '')}`).join(' ') : '';
    const noteLine = `- ${text}${tagStr} _(via mcp ${now.toISOString()})_`;

    try {
      await fsPromises.mkdir(path.dirname(memoryPath), { recursive: true });
      let body = '';
      try {
        body = await fsPromises.readFile(memoryPath, 'utf8');
      } catch {
        body = '# Memory\n';
      }
      // Append under a `## Follow-ups` heading, creating it if absent.
      if (/^##\s+Follow-ups\s*$/m.test(body)) {
        body = body.replace(/(^##\s+Follow-ups\s*$)/m, `$1\n${noteLine}`);
      } else {
        body = body.replace(/\s*$/, '') + `\n\n## Follow-ups\n${noteLine}\n`;
      }
      await fsPromises.writeFile(memoryPath, body, 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: 'internal_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const msgId = newMsgId();
    const ledger = await appendLedgerEntry(ctx, msgId, {
      type: 'note_add',
      ...callerOf(ctx),
    });
    return {
      ok: true,
      data: { id: msgId, written: 'dream/MEMORY.md', ledger_ok: ledger.ok, ledger_detail: ledger.detail },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: inbox.send
// ---------------------------------------------------------------------------

/**
 * Write a cross-agent message into a recipient's inbox. Filename follows
 * AGENT_SESSION_PROTOCOL §3 (`<sortable-ts>-<type>-<agent>-<short-session>.json`).
 *
 * Idempotent: the caller may supply `client_id`; a second send with the same
 * `client_id` to the same recipient is detected via the ledger and returns
 * the original message id without writing a duplicate.
 */
const inboxSendTool: ToolHandler = {
  definition: {
    name: 'inbox.send',
    description:
      "Send a cross-agent message to a recipient's inbox (or 'shared' broadcast). " +
      'Idempotent when a client_id is supplied. Requires write access.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: "Recipient agent id, or 'shared'." },
        type: { type: 'string', description: 'Message type (question, finding_report, …).' },
        body: { type: 'object', description: 'Message payload object.' },
        requires_response: { type: 'boolean', description: 'Whether a reply is expected.' },
        client_id: {
          type: 'string',
          description: 'Caller-supplied dedupe key; a repeat send is a no-op.',
        },
      },
      required: ['to', 'type'],
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const to = typeof args.to === 'string' ? args.to.trim() : '';
    const type = typeof args.type === 'string' ? args.type.trim() : '';
    if (!to || !type) {
      return { ok: false, reason: 'invalid_params', detail: 'to and type are required' };
    }
    const body =
      args.body && typeof args.body === 'object' && !Array.isArray(args.body)
        ? (args.body as Record<string, unknown>)
        : {};
    const requiresResponse = args.requires_response === true;
    const clientId = typeof args.client_id === 'string' ? args.client_id.trim() : '';

    const inboxDir = path.join(commsDir(ctx), 'inboxes', to);

    // Idempotency: a prior ledger row with the same client_id ⇒ no-op.
    if (clientId) {
      const prior = await findLedgerByClientId(ctx, clientId);
      if (prior) {
        return { ok: true, data: { id: prior, deduped: true } };
      }
    }

    const now = new Date();
    const msgId = newMsgId();
    const caller = callerOf(ctx);
    const sessionFrag = (ctx.sessionId ?? shortId()).slice(0, 8);
    const fileName = `${fileTimestamp(now)}-${type}-${caller.from}-${sessionFrag}.json`;

    const message = {
      id: msgId,
      from: caller.from,
      ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
      to,
      type,
      timestamp: now.toISOString(),
      requires_response: requiresResponse,
      ...(clientId ? { client_id: clientId } : {}),
      payload: body,
    };

    try {
      await fsPromises.mkdir(inboxDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(inboxDir, fileName),
        JSON.stringify(message, null, 2) + '\n',
        'utf8'
      );
    } catch (err) {
      return {
        ok: false,
        reason: 'internal_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const ledger = await appendLedgerEntry(ctx, msgId, {
      type,
      to,
      ...(clientId ? { client_id: clientId } : {}),
      ...caller,
    });
    return {
      ok: true,
      data: { id: msgId, file: fileName, to, ledger_ok: ledger.ok, ledger_detail: ledger.detail },
    };
  },
};

/** Scan the state ledger for a row carrying `client_id`. Returns its key. */
async function findLedgerByClientId(ctx: ToolContext, clientId: string): Promise<string | null> {
  try {
    const raw = await fsPromises.readFile(statePath(ctx), 'utf8');
    const doc = JSON.parse(raw.replace(/^﻿/, '')) as {
      message_ledger?: Record<string, { client_id?: string }>;
    };
    for (const [key, row] of Object.entries(doc.message_ledger ?? {})) {
      if (row && row.client_id === clientId) {
        return key;
      }
    }
  } catch {
    // No ledger / unreadable — treat as "not seen before".
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool: inbox.archive
// ---------------------------------------------------------------------------

/**
 * Archive a handled message: move `inboxes/<agent>/<file>` to
 * `inboxes/<agent>/processed/` and stamp `archived_at` in the `_state/` sidecar
 * (AGENT_SESSION_PROTOCOL §3.2). The agent defaults to the caller's session
 * agent, overridable via `agent`.
 */
const inboxArchiveTool: ToolHandler = {
  definition: {
    name: 'inbox.archive',
    description:
      'Archive a handled inbox message — moves it to processed/ and stamps ' +
      'archived_at in the _state sidecar. Requires write access.',
    inputSchema: {
      type: 'object',
      properties: {
        msg_id: { type: 'string', description: 'Message id (the .json filename stem).' },
        agent: {
          type: 'string',
          description: "Inbox owning the message. Defaults to the caller's agent.",
        },
      },
      required: ['msg_id'],
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const msgId = typeof args.msg_id === 'string' ? args.msg_id.trim() : '';
    if (!msgId) {
      return { ok: false, reason: 'invalid_params', detail: 'msg_id is required' };
    }
    const agent =
      (typeof args.agent === 'string' && args.agent.trim()) || ctx.sessionId || ctx.host;
    const inboxDir = path.join(commsDir(ctx), 'inboxes', agent);
    const fileName = msgId.endsWith('.json') ? msgId : `${msgId}.json`;
    const stem = fileName.replace(/\.json$/, '');
    const src = path.join(inboxDir, fileName);
    const processedDir = path.join(inboxDir, 'processed');
    const dst = path.join(processedDir, fileName);

    try {
      await fsPromises.access(src);
    } catch {
      return { ok: false, reason: 'not_found', detail: `no message "${msgId}" in ${agent} inbox` };
    }

    const now = new Date().toISOString();
    try {
      await fsPromises.mkdir(processedDir, { recursive: true });
      await fsPromises.rename(src, dst);

      // Update the per-message state sidecar.
      const stateDir = path.join(inboxDir, '_state');
      await fsPromises.mkdir(stateDir, { recursive: true });
      const stateFile = path.join(stateDir, `${stem}.json`);
      let state: Record<string, unknown> = {
        msg_id: stem,
        received_at: now,
        read_at: now,
        replied_at: null,
        archived_at: null,
      };
      try {
        const prior = JSON.parse(
          (await fsPromises.readFile(stateFile, 'utf8')).replace(/^﻿/, '')
        );
        if (prior && typeof prior === 'object') {
          state = prior as Record<string, unknown>;
        }
      } catch {
        // no prior sidecar — use the default shell
      }
      state.archived_at = now;
      await fsPromises.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: 'internal_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const ledgerKey = newMsgId();
    const ledger = await appendLedgerEntry(ctx, ledgerKey, {
      type: 'inbox_archive',
      archived_msg: stem,
      agent,
      ...callerOf(ctx),
    });
    return {
      ok: true,
      data: { archived: stem, agent, ledger_ok: ledger.ok, ledger_detail: ledger.detail },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: claim.task
// ---------------------------------------------------------------------------

/**
 * Claim a task atomically via a **create-exclusive** write of
 * `comms/claims/<task-id>.json` (AGENT_SESSION_PROTOCOL §4). The `wx` flag
 * makes the filesystem the mutex: if the file already exists the write fails
 * with `EEXIST` and the caller gets `{ ok: false, reason: 'conflict' }` —
 * exactly the contention behaviour the protocol mandates.
 *
 * This tool does NOT steal expired claims; that requires checking the owner's
 * heartbeat and is the orchestrator's job (`src/orchestrator/claim.ts`).
 */
const claimTaskTool: ToolHandler = {
  definition: {
    name: 'claim.task',
    description:
      'Atomically claim a task via a create-exclusive claim file. Fails with ' +
      "reason 'conflict' if the task is already claimed. Requires write access.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task identifier to claim.' },
        sprint_id: { type: 'string', description: 'Optional sprint id for the claim record.' },
        ttl_hours: { type: 'number', description: 'Claim lifetime in hours (default 2).' },
      },
      required: ['task_id'],
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    if (!taskId) {
      return { ok: false, reason: 'invalid_params', detail: 'task_id is required' };
    }
    // Reject path separators — the task id becomes a filename.
    if (/[\\/]/.test(taskId)) {
      return { ok: false, reason: 'invalid_params', detail: 'task_id must not contain path separators' };
    }
    const ttlHours =
      typeof args.ttl_hours === 'number' && args.ttl_hours > 0 ? args.ttl_hours : 2;
    const sprintId = typeof args.sprint_id === 'string' ? args.sprint_id.trim() : '';

    const claimsDir = path.join(commsDir(ctx), 'claims');
    const claimFile = path.join(claimsDir, `${taskId}.json`);
    const now = new Date();
    const claimToken = crypto.randomUUID();
    const claim = {
      task_id: taskId,
      ...(sprintId ? { sprint_id: sprintId } : {}),
      claimed_by: ctx.host,
      ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
      claim_token: claimToken,
      claimed_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlHours * 3_600_000).toISOString(),
    };

    try {
      await fsPromises.mkdir(claimsDir, { recursive: true });
      // 'wx' = O_CREAT | O_EXCL — fails with EEXIST if the claim exists.
      await fsPromises.writeFile(claimFile, JSON.stringify(claim, null, 2) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Surface the current owner so the caller can decide what to do.
        let owner = 'unknown';
        try {
          const prior = JSON.parse(
            (await fsPromises.readFile(claimFile, 'utf8')).replace(/^﻿/, '')
          ) as { claimed_by?: string };
          owner = prior.claimed_by ?? 'unknown';
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          reason: 'conflict',
          detail: `task "${taskId}" is already claimed by ${owner}`,
        };
      }
      return {
        ok: false,
        reason: 'internal_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const ledgerKey = newMsgId();
    const ledger = await appendLedgerEntry(ctx, ledgerKey, {
      type: 'task_claim',
      task_id: taskId,
      claim_token: claimToken,
      ...callerOf(ctx),
    });
    return {
      ok: true,
      data: {
        task_id: taskId,
        claim_token: claimToken,
        expires_at: claim.expires_at,
        ledger_ok: ledger.ok,
        ledger_detail: ledger.detail,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: consensus.vote
// ---------------------------------------------------------------------------

/**
 * Cast a consensus vote, mirroring the file-bus protocol: write
 * `consensus/active/<task_id>-<agent>.json` (AGENT_SESSION_PROTOCOL §2).
 * One vote file per (task, agent); re-voting overwrites the agent's own
 * vote (a vote change is legitimate; it is not a create-exclusive resource).
 */
const consensusVoteTool: ToolHandler = {
  definition: {
    name: 'consensus.vote',
    description:
      'Cast a consensus vote on a task — writes consensus/active/<task>-<agent>.json. ' +
      'Requires write access.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task under review.' },
        vote: {
          type: 'string',
          enum: ['approve', 'reject', 'request_changes'],
          description: 'The vote.',
        },
        findings: {
          type: 'array',
          items: { type: 'object' },
          description: 'Optional structured findings backing the vote.',
        },
      },
      required: ['task_id', 'vote'],
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    const vote = typeof args.vote === 'string' ? args.vote.trim() : '';
    if (!taskId || /[\\/]/.test(taskId)) {
      return { ok: false, reason: 'invalid_params', detail: 'task_id is required and must be a bare id' };
    }
    if (vote !== 'approve' && vote !== 'reject' && vote !== 'request_changes') {
      return {
        ok: false,
        reason: 'invalid_params',
        detail: 'vote must be approve | reject | request_changes',
      };
    }
    const findings = Array.isArray(args.findings) ? args.findings : [];

    const activeDir = path.join(commsDir(ctx), 'consensus', 'active');
    // One file per (task, agent) — the agent id makes the filename unique.
    const safeAgent = ctx.host.replace(/[\\/]/g, '_');
    const voteFile = path.join(activeDir, `${taskId}-${safeAgent}.json`);
    const now = new Date();
    const msgId = newMsgId();
    const record = {
      id: msgId,
      task_id: taskId,
      agent: ctx.host,
      ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
      vote,
      findings,
      voted_at: now.toISOString(),
    };

    try {
      await fsPromises.mkdir(activeDir, { recursive: true });
      // Plain write — a vote may be revised; not a create-exclusive resource.
      await fsPromises.writeFile(voteFile, JSON.stringify(record, null, 2) + '\n', 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: 'internal_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const ledger = await appendLedgerEntry(ctx, msgId, {
      type: 'consensus_vote',
      task_id: taskId,
      vote,
      ...callerOf(ctx),
    });
    return {
      ok: true,
      data: { id: msgId, task_id: taskId, vote, ledger_ok: ledger.ok, ledger_detail: ledger.detail },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: dream.run
// ---------------------------------------------------------------------------

/**
 * Request a `/dream` consolidation cycle out-of-band (RFC §3.2). The MCP
 * server has no LLM and must cold-start fast, so it does NOT run the dream
 * pipeline itself — it drops a request marker at
 * `.autoclaw/dream/requests/<ts>.json` that the AutoClaw daemon / `/dream`
 * skill picks up. This keeps the tool synchronous-fast and side-effect-bounded.
 */
const dreamRunTool: ToolHandler = {
  definition: {
    name: 'dream.run',
    description:
      'Request an out-of-band /dream consolidation cycle. Drops a request ' +
      'marker the AutoClaw daemon consumes. Requires write access.',
    inputSchema: {
      type: 'object',
      properties: {
        now: {
          type: 'boolean',
          description: 'Request immediate consolidation rather than next idle window.',
        },
      },
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const immediate = args.now === true;
    const requestsDir = path.join(ctx.autoclawDir, 'dream', 'requests');
    const now = new Date();
    const msgId = newMsgId();
    const reqFile = path.join(requestsDir, `${fileTimestamp(now)}-${shortId()}.json`);
    const request = {
      id: msgId,
      requested_by: ctx.host,
      ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
      requested_at: now.toISOString(),
      immediate,
      status: 'pending',
    };

    try {
      await fsPromises.mkdir(requestsDir, { recursive: true });
      await fsPromises.writeFile(reqFile, JSON.stringify(request, null, 2) + '\n', 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: 'internal_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const ledger = await appendLedgerEntry(ctx, msgId, {
      type: 'dream_run',
      immediate,
      ...callerOf(ctx),
    });
    return {
      ok: true,
      data: {
        id: msgId,
        queued: true,
        immediate,
        note: 'dream consolidation requested; the AutoClaw daemon runs it out-of-band',
        ledger_ok: ledger.ok,
        ledger_detail: ledger.detail,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// PA-5 — MCP llm.* write-tools (gated + audited; delegate to src/llm registry)
// ---------------------------------------------------------------------------

/**
 * `llm.chat` — run one chat completion through the LLM registry. Routing is
 * ZMLR-first with an oracle fallback (Option C); this tool builds NO parallel
 * router. Gated like every write-tool and audited to the message ledger; the
 * registry additionally records the call in the ZICO cost ledger.
 */
const llmChatTool: ToolHandler = {
  definition: {
    name: 'llm.chat',
    description:
      'Run a chat completion via the AutoClaw LLM registry (ZMLR-first, oracle ' +
      'fallback). Requires write access. The model/provider is chosen by the ' +
      'registry unless `providerRef` is given.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'User prompt (sugar for a single user message).' },
        messages: { type: 'array', description: 'Full chat message array (role/content).', items: { type: 'object' } },
        providerRef: { type: 'string', description: 'Optional explicit "<provider>:<model>" override.' },
        temperature: { type: 'number' },
        maxTokens: { type: 'number' },
        jsonMode: { type: 'boolean' },
      },
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
    const messages = Array.isArray(args.messages) ? args.messages : undefined;
    if (!prompt && !messages) {
      return { ok: false, reason: 'invalid_params', detail: 'llm.chat requires prompt or messages' };
    }
    const msgId = newMsgId();
    try {
      const registry = llmRegistryFactory(ctx.workspaceRoot);
      const result = await registry.chat({
        prompt,
        messages: messages as never,
        temperature: typeof args.temperature === 'number' ? args.temperature : undefined,
        maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
        jsonMode: args.jsonMode === true,
        sessionId: ctx.sessionId,
        callerPersonaId: typeof args.callerPersonaId === 'string' ? args.callerPersonaId : undefined,
      }, typeof args.providerRef === 'string' ? args.providerRef : undefined);

      const ledger = await appendLedgerEntry(ctx, msgId, {
        type: 'llm_chat', servedBy: result.servedBy, model: result.model,
        ok: result.ok, tokens: result.tokens, ...callerOf(ctx),
      });
      if (!result.ok) {
        return { ok: false, reason: 'state_unreachable', detail: result.errorMessage ?? result.errorClass ?? 'chat failed' };
      }
      return {
        ok: true,
        data: {
          response: result.response, model: result.model, servedBy: result.servedBy,
          tokens: result.tokens, durationMs: result.durationMs, costCents: result.costCents,
          ledger_ok: ledger.ok,
        },
      };
    } catch (err) {
      return { ok: false, reason: 'internal_error', detail: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * `llm.models` — list the models each registered provider reports. Read-mostly
 * but gated as a write-tool because it probes external providers.
 */
const llmModelsTool: ToolHandler = {
  definition: {
    name: 'llm.models',
    description: 'List models available across the registry providers (ZMLR, Ollama). Requires write access.',
    inputSchema: { type: 'object', properties: {} },
  },
  async run(ctx): Promise<ToolResult> {
    try {
      const registry = llmRegistryFactory(ctx.workspaceRoot);
      const out: Record<string, unknown> = {};
      for (const p of registry.list()) {
        try { out[p.id] = await p.models(); } catch (e) { out[p.id] = { error: e instanceof Error ? e.message : String(e) }; }
      }
      return { ok: true, data: { providers: out } };
    } catch (err) {
      return { ok: false, reason: 'internal_error', detail: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * `llm.health` — health snapshot per provider (reachable / auth / model count).
 */
const llmHealthTool: ToolHandler = {
  definition: {
    name: 'llm.health',
    description: 'Report health for each registry provider (reachable, auth, model count). Requires write access.',
    inputSchema: { type: 'object', properties: {} },
  },
  async run(ctx): Promise<ToolResult> {
    try {
      const registry = llmRegistryFactory(ctx.workspaceRoot);
      const out: Record<string, unknown> = {};
      for (const p of registry.list()) {
        try { out[p.id] = await p.health(); } catch (e) { out[p.id] = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      }
      return { ok: true, data: { providers: out } };
    } catch (err) {
      return { ok: false, reason: 'internal_error', detail: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: presence.beacon (FF-1) — the MCP check-in
// ---------------------------------------------------------------------------

/**
 * Write a presence beacon so an MCP-speaking peer (Codex-CLI, Copilot, another
 * chat session, any tool that mounts this MCP server) becomes a visible fleet
 * row. This is the one A2A gap the federation work closes: before it, an MCP
 * agent could message + claim but could NOT check in, so it never appeared in
 * the fleet.
 *
 * The host stamps identity it knows (`host`, `session_id`) so a caller cannot
 * spoof those; everything else is the caller's self-description. `scope`
 * defaults to 'workspace' (the beacon ties to this project's comms tree); pass
 * 'machine' to announce into `~/.autoclaw/beacons/` for a cross-workspace view.
 * `timestamp` is always set server-side to now.
 *
 * Read it back with the `presence.fleet` read tool.
 */
const presenceBeaconTool: ToolHandler = {
  definition: {
    name: 'presence.beacon',
    description:
      'Check in to the fleet by writing a presence beacon — makes this agent a ' +
      'visible fleet row. The host stamps host + session_id. Requires write access.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Stable agent name. Defaults to the caller host.' },
        status: { type: 'string', enum: ['active', 'idle'], description: 'Liveness (default active).' },
        current_task: { type: 'string', description: 'What the agent is working on.' },
        current_llm: { type: 'string', description: 'Model currently in use.' },
        role: { type: 'string', description: 'Self-declared role hint (the user fleet.json still wins).' },
        agent_type: { type: 'string', description: 'Behavioral type hint (coder/runner/auditor/…).' },
        workspace: { type: 'string', description: 'Absolute workspace path. Defaults to the server root.' },
        transports: { type: 'array', items: { type: 'string' }, description: "Lanes this peer speaks: fs|mcp|http|relay." },
        card_url: { type: 'string', description: 'Optional A2A capability card URL.' },
        endpoint: { type: 'string', description: 'Optional HTTP endpoint for runner-style peers.' },
        scope: { type: 'string', enum: ['workspace', 'machine'], description: "Where to write (default workspace)." },
      },
    },
  },
  async run(ctx, args): Promise<ToolResult> {
    const scope = args.scope === 'machine' ? 'machine' : 'workspace';
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() ? v.trim() : undefined;

    const beacon: Beacon = {
      // Host stamps identity it owns — callers cannot spoof host/session.
      agent_id: str(args.agent_id) ?? ctx.host,
      ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
      timestamp: new Date().toISOString(),
      status: args.status === 'idle' ? 'idle' : 'active',
      host: ctx.host,
      origin: 'beacon',
      ...(str(args.current_task) ? { current_task: str(args.current_task) } : {}),
      ...(str(args.current_llm) ? { current_llm: str(args.current_llm) } : {}),
      ...(str(args.role) ? { role: str(args.role) } : {}),
      ...(str(args.agent_type) ? { agent_type: str(args.agent_type) } : {}),
      workspace: str(args.workspace) ?? ctx.workspaceRoot,
      ...(str(args.card_url) ? { card_url: str(args.card_url) } : {}),
      ...(str(args.endpoint) ? { endpoint: str(args.endpoint) } : {}),
      ...(Array.isArray(args.transports)
        ? { transports: args.transports.filter((t): t is string => typeof t === 'string') }
        : {}),
    };

    const msgId = newMsgId();
    try {
      const written = await writeBeacon(beacon, {
        scope,
        ...(scope === 'workspace' ? { commsDir: commsDir(ctx) } : {}),
      });
      const ledger = await appendLedgerEntry(ctx, msgId, {
        type: 'presence_beacon',
        agent_id: beacon.agent_id,
        scope,
        ...callerOf(ctx),
      });
      return {
        ok: true,
        data: {
          id: msgId,
          agent_id: beacon.agent_id,
          scope,
          file: written,
          ledger_ok: ledger.ok,
          ledger_detail: ledger.detail,
        },
      };
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

/**
 * Wrap a bare write-tool handler so every invocation passes the per-tool
 * authorization gate ({@link authorizeTool}) and appends a
 * {@link writeToolAudit} row. The `definition` is preserved unchanged.
 */
function withGate(handler: ToolHandler): ToolHandler {
  return {
    definition: handler.definition,
    run: gated(handler.definition.name, handler.run.bind(handler)),
  };
}

/**
 * All write tools shipped in BP3 (RFC §3.2), each wrapped with the BP3-polish
 * per-tool authorization gate + audit trail (Sprint 3). The coarse
 * workspace-scope + `allowWrites` gate is still applied at the tool-set level
 * by `server.ts` ({@link checkWriteGate}); `withGate` adds the *per-tool*
 * policy and the {@link writeToolAudit} row on top.
 */
export const WRITE_TOOLS: ToolHandler[] = [
  noteAddTool,
  inboxSendTool,
  inboxArchiveTool,
  claimTaskTool,
  dreamRunTool,
  consensusVoteTool,
  presenceBeaconTool,
  llmChatTool,
  llmModelsTool,
  llmHealthTool,
].map(withGate);

/** The un-gated write-tool handlers, exposed for unit tests of tool bodies. */
export const RAW_WRITE_TOOLS: ToolHandler[] = [
  noteAddTool,
  inboxSendTool,
  inboxArchiveTool,
  claimTaskTool,
  dreamRunTool,
  consensusVoteTool,
  presenceBeaconTool,
  llmChatTool,
  llmModelsTool,
  llmHealthTool,
];
