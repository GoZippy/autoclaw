/**
 * comms.ts — Cross-agent communication engine.
 *
 * Manages the filesystem-based mailbox protocol:
 *   - Message creation, delivery, and reading
 *   - Comms log (append-only JSONL)
 *   - Heartbeat protocol
 *   - Agent registry
 *   - Message retention/cleanup
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AgentType } from './fabric/agentTypes';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Heartbeat queue_depth at or above which a fresh agent is treated as overloaded. */
export const OVERLOAD_QUEUE_DEPTH = 10;
/** Heartbeat error_rate_1m at or above which a fresh agent is treated as overloaded. */
export const OVERLOAD_ERROR_RATE = 0.5;

/**
 * Identify which agent (if any) corresponds to the host VS Code variant.
 * Used by the heartbeat daemon to decide whose heartbeat may carry the host's
 * sessionId — peer agents own their own session_id and the host must NOT
 * stamp them. Pure (no vscode import) so tests can call it directly.
 */
export function detectAutoclawHostAgent(appName: string): string {
  if (/antigravity/i.test(appName)) { return 'antigravity'; }
  if (/kiro/i.test(appName))        { return 'kiro'; }
  if (/cursor/i.test(appName))      { return 'cursor'; }
  if (/windsurf/i.test(appName))    { return 'windsurf'; }
  // VS Code stock + Claude Code variants → claude-code is the canonical host agent.
  return 'claude-code';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Cross-agent message taxonomy. New Phase-3 entries (capability_query,
 * capability_offer, thought_record, subcontract_*) flow through the existing
 * sendMessage / readInbox plumbing without any extra handler — actual
 * routing logic for them lands in the capability-aware router (separate
 * worktree).
 *
 * Payload shape contracts (carried in `Message.payload` as a free-form
 * `Record<string, unknown>`):
 *
 *   - `capability_query`:
 *       {
 *         required_capabilities: string[];
 *         required_languages?: string[];
 *         min_context_window?: number;
 *         min_trust_level?: TrustLevel;
 *         deadline_iso?: string;
 *       }
 *
 *   - `capability_offer`:
 *       {
 *         for_query_id: string;
 *         agent_id: string;
 *         capabilities: string[];
 *         current_load: number;
 *         estimated_cost_usd?: number;
 *         available: boolean;
 *       }
 *
 *   - `thought_record`: free-form Thought envelope (KG schema, see
 *     packages/kg-daemon).
 *
 *   - `subcontract_request` / `subcontract_accept` / `subcontract_deliver`
 *     / `subcontract_ack`: parent → child fanout for Phase-3 work
 *     subcontracting; payload shape TBD with the router.
 */
export type MessageType =
  | 'review_request' | 'review_response'
  | 'consensus_vote' | 'consensus_result'
  | 'task_claim' | 'task_complete' | 'task_assignment'
  | 'finding_report' | 'question' | 'answer'
  | 'scope_conflict' | 'escalation' | 'handoff' | 'system'
  // Phase-3 capability discovery
  | 'capability_query' | 'capability_offer'
  // Phase-3 KG bridge
  | 'thought_record'
  // Phase-3 work subcontracting
  | 'subcontract_request' | 'subcontract_accept'
  | 'subcontract_deliver' | 'subcontract_ack'
  // LANE B — per-agent command & control doorbells (Command Center).
  //   evict_notice : the graceful-evict quiesce doorbell (drain-then-release)
  //   pause/resume : ask a cooperating agent to stop / resume claiming work
  //   reassign     : a claim was released back to the board for re-dispatch
  | 'evict_notice' | 'pause' | 'resume' | 'reassign';

export interface Message {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  timestamp: string;
  sprint?: number;
  task_id?: string;
  payload: Record<string, unknown>;
  requires_response: boolean;
  response_deadline?: string;
  /**
   * Absolute time after which this message is stale and may be garbage-collected.
   * Used for ephemeral dispatch placeholders (`task_claim-next-<agent>`) so the
   * shared inbox can't accumulate them unbounded.
   */
  expires_at?: string;
}

export interface Heartbeat {
  // --- v1 fields (unchanged) ---
  agent_id: string;
  timestamp: string;
  status: 'active' | 'idle';
  current_task: string | null;
  sprint: number | null;

  // --- v2 additions (all optional; see docs/specs/heartbeat-v2.md) ---
  /** Stable per-extension-activation session identifier. */
  session_id?: string;
  /** Remaining tokens in the agent's current LLM session/budget window. */
  token_budget_remaining?: number;
  /** Unread inbox + claimed-but-not-started task count. */
  queue_depth?: number;
  /** Identifier of the LLM the agent is currently using. */
  current_llm?: string;
  /** Most recent error surfaced by the adapter, redacted. */
  last_error?: {
    timestamp: string;
    code?: string;
    message: string;
  };
  /** Round-trip ms to the bridge / last peer. Local-only. */
  network_latency_ms?: number;
  /** Errors / total operations over the last 60 s. */
  error_rate_1m?: number;
  /** Optional schema marker; absence implies v1. */
  schema_version?: '1' | '2';

  // --- session-tracking additions (all optional; back-compat) ---
  /**
   * Intelligence source/adapter id this session belongs to (e.g. `claude-code`,
   * `kilocode`). Used by the panel's "Open chat" deep-link ladder to pick how to
   * reopen the conversation. Falls back to `agent_id` when absent.
   */
  adapterId?: string;
  /**
   * Opaque pointer to the session's transcript on disk (a file path or task
   * dir), as recorded by the source adapter's provenance. Lets the panel reveal
   * the raw transcript for tools without a resume-by-id deep link.
   */
  rawRef?: string;
}

export type AgentStatus =
  | 'active' | 'idle' | 'offline' | 'detected' | 'stalled' | 'overloaded';

export type CapabilityTag = string;
export type ToolTag = string;
export type TrustLevel = 'untrusted' | 'low' | 'medium' | 'high';

export interface CostBudget {
  daily_usd?: number;
  hourly_usd?: number;
  per_task_usd?: number;
}

export interface RegisteredAgent {
  // --- v1 fields (unchanged) ---
  id: string;
  name: string;
  extension_id: string | null;
  detected: boolean;
  inbox_path: string;
  hooks_supported: boolean;
  last_heartbeat: string | null;
  status: AgentStatus;

  // --- v2 additions (all optional; see docs/specs/registered-agent-v2.md) ---
  /** Path to this agent's cross-agent-protocol rules file relative to workspace root. */
  rules_path?: string;
  /** Stable opaque machine identifier. */
  machine_id?: string;
  /** Last-known machine IP. Local-only. */
  machine_ip?: string;
  /** Coarse capability tags drawn from the Agent Card. */
  capabilities?: CapabilityTag[];
  /** Models the agent can invoke. */
  llms_available?: string[];
  /** Maximum context window in tokens for the agent's primary LLM. */
  context_window?: number;
  /** Coarse tool taxonomy. */
  tools_supported?: ToolTag[];
  /** Trust tier; gates auto-merge and consensus rules. */
  trust_level?: TrustLevel;
  /** Soft budget caps. Local-only; never reported off-machine. */
  cost_budget?: CostBudget;
  /** Concurrency ceiling. */
  max_parallel_tasks?: number;
  /** AutoClaw skill IDs available. */
  skills_loaded?: string[];
  /** When true, the agent will not auto-execute tool calls. */
  human_in_loop_required?: boolean;
  /**
   * What KIND of worker this agent is (fabric taxonomy: coder/runner/auditor/
   * supervisor/assistant/governance). Drives how work is directed to it and how
   * its output is reviewed. Absent ⇒ treated as 'coder'.
   */
  agent_type?: AgentType;
  /** True when this agent may spawn + manage other agents (supervisor/governance). */
  can_orchestrate?: boolean;
  /** Pointer to the canonical Agent Card on disk. */
  agent_card_path?: string;
  /** SPIFFE ID, populated only when SPIRE is configured (Phase 4). */
  spiffe_id?: string;
  /** ISO timestamp the registry entry was last refreshed. */
  last_detected_at?: string;
}

export interface AgentRegistry {
  agents: RegisteredAgent[];
  ide: string;
  provisioned_at: string;
  /** Optional schema marker; absence implies v1. */
  schema_version?: '1' | '2';
}

export interface CommsLogEntry {
  timestamp: string;
  type: string;
  from: string;
  to?: string;
  message_id?: string;
  task_id?: string;
  sprint?: number;
  message: string;
}

export function generateMessageId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(4).toString('hex');
  return `msg-${ts}-${rand}`;
}

function messageFilename(msg: Message): string {
  const ts = msg.timestamp.replace(/[:.]/g, '-');
  return `${ts}-${msg.type}-${msg.from}-${msg.id.slice(-8)}.json`;
}

export async function sendMessage(commsDir: string, msg: Message): Promise<string> {
  if (!msg.id) { msg.id = generateMessageId(); }
  if (!msg.timestamp) { msg.timestamp = new Date().toISOString(); }
  const inboxDir = path.join(commsDir, 'inboxes', path.basename(msg.to));
  await fsPromises.mkdir(inboxDir, { recursive: true });
  const filename = messageFilename(msg);
  const filePath = path.join(inboxDir, filename);
  await fsPromises.writeFile(filePath, JSON.stringify(msg, null, 2), 'utf8');
  await appendCommsLog(commsDir, {
    timestamp: msg.timestamp, type: msg.type, from: msg.from, to: msg.to,
    message_id: msg.id, task_id: msg.task_id, sprint: msg.sprint,
    message: `${msg.from} → ${msg.to}: ${msg.type}${msg.task_id ? ` (${msg.task_id})` : ''}`,
  });
  return filePath;
}

export async function readInbox(commsDir: string, agentId: string): Promise<Message[]> {
  const inboxDir = path.join(commsDir, 'inboxes', agentId);
  try {
    const files = await fsPromises.readdir(inboxDir);
    const messages: Message[] = [];
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const content = await fsPromises.readFile(path.join(inboxDir, file), 'utf8');
        messages.push(JSON.parse(content.replace(/^﻿/, '')) as Message);
      } catch { /* skip malformed */ }
    }
    return messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  } catch { return []; }
}

export async function readSharedInbox(commsDir: string): Promise<Message[]> {
  return readInbox(commsDir, 'shared');
}

export async function appendCommsLog(commsDir: string, entry: CommsLogEntry): Promise<void> {
  const logPath = path.join(commsDir, 'comms-log.jsonl');
  await fsPromises.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
}

export async function readCommsLog(
  commsDir: string, options?: { since?: string; limit?: number }
): Promise<CommsLogEntry[]> {
  const logPath = path.join(commsDir, 'comms-log.jsonl');
  try {
    const content = await fsPromises.readFile(logPath, 'utf8');
    let entries = content.trim().split('\n').filter(l => l.length > 0)
      .map(line => { try { return JSON.parse(line) as CommsLogEntry; } catch { return null; } })
      .filter((e): e is CommsLogEntry => e !== null);
    if (options?.since) {
      const t = new Date(options.since).getTime();
      entries = entries.filter(e => new Date(e.timestamp).getTime() >= t);
    }
    if (options?.limit) { entries = entries.slice(-options.limit); }
    return entries;
  } catch { return []; }
}

export async function writeHeartbeat(commsDir: string, hb: Heartbeat): Promise<void> {
  const dir = path.join(commsDir, 'heartbeats');
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(
    path.join(dir, `${path.basename(hb.agent_id)}.json`),
    JSON.stringify(hb, null, 2),
    'utf8'
  );
}

export async function readHeartbeat(commsDir: string, agentId: string): Promise<Heartbeat | null> {
  try {
    const content = await fsPromises.readFile(
      path.join(commsDir, 'heartbeats', `${path.basename(agentId)}.json`), 'utf8'
    );
    return JSON.parse(content.replace(/^﻿/, '')) as Heartbeat;
  } catch { return null; }
}

export async function readAllHeartbeats(commsDir: string): Promise<Heartbeat[]> {
  try {
    const dir = path.join(commsDir, 'heartbeats');
    const files = await fsPromises.readdir(dir);
    const hbs: Heartbeat[] = [];
    for (const f of files.filter(f => f.endsWith('.json'))) {
      try { hbs.push(JSON.parse((await fsPromises.readFile(path.join(dir, f), 'utf8')).replace(/^﻿/, ''))); } catch { /* skip */ }
    }
    return hbs;
  } catch { return []; }
}

export function agentStatusFromHeartbeat(hb: Heartbeat | null, now: number = Date.now()): AgentStatus {
  if (!hb) { return 'offline'; }
  const age = now - new Date(hb.timestamp).getTime();
  if (age < 2 * 60 * 1000) {
    // Stage B (v2): even a fresh heartbeat can be flagged 'overloaded' when
    // the agent is signaling distress via queue_depth or error_rate_1m.
    if (
      (typeof hb.queue_depth === 'number' && hb.queue_depth >= OVERLOAD_QUEUE_DEPTH) ||
      (typeof hb.error_rate_1m === 'number' && hb.error_rate_1m >= OVERLOAD_ERROR_RATE)
    ) {
      return 'overloaded';
    }
    return 'active';
  }
  if (age < 5 * 60 * 1000) { return 'idle'; }
  // Agent has an active sprint assignment but hasn't checked in for >5 min → stalled.
  if (hb.sprint !== null && age < 24 * 60 * 60 * 1000) { return 'stalled'; }
  return 'offline';
}

/** Redact a heartbeat last_error.message for safe local persistence:
 *  truncates to 500 chars, strips ANSI escapes, replaces $HOME and obvious tokens. */
export function redactErrorMessage(s: string): string {
  if (typeof s !== 'string') { return ''; }
  let out = s;
  // Strip ANSI escape sequences (CSI SGR).
  out = out.replace(/\x1b\[[0-9;]*m/g, '');
  // Replace user's home directory with $HOME.
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home && home.length > 0) {
    // Escape regex metacharacters in the home path.
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '$HOME');
  }
  // Redact obvious token-shaped strings.
  out = out.replace(/(acl_|sk-|ghp_)[A-Za-z0-9]+/g, '<redacted>');
  // Truncate to 500 chars.
  if (out.length > 500) { out = out.slice(0, 500); }
  return out;
}

/**
 * Read the claiming agent id for a task from `claims/<taskId>.json`.
 *
 * Used by the consensus gate to feed `evaluateConsensus(..., { author_agent_id })`
 * so an author's self-vote is excluded (verifier independence). Tolerates a
 * missing file, a leading BOM, or malformed JSON — all return `undefined`, in
 * which case consensus is unchanged (backward-compatible).
 *
 * The canonical claim field is `claimed_by` (written by the claim MCP tool);
 * `agent` is accepted as a legacy fallback (cf. boardWriter's claim reader).
 */
export async function readClaimAuthor(commsDir: string, taskId: string): Promise<string | undefined> {
  try {
    const raw = (await fsPromises.readFile(
      path.join(commsDir, 'claims', `${path.basename(taskId)}.json`), 'utf8'
    )).replace(/^﻿/, '');
    const claim = JSON.parse(raw) as { claimed_by?: string; agent?: string };
    return claim.claimed_by ?? claim.agent ?? undefined;
  } catch { return undefined; }
}

export async function readRegistry(commsDir: string): Promise<AgentRegistry | null> {
  try {
    return JSON.parse((await fsPromises.readFile(path.join(commsDir, 'registry.json'), 'utf8')).replace(/^﻿/, ''));
  } catch { return null; }
}

export async function writeRegistry(commsDir: string, reg: AgentRegistry): Promise<void> {
  await fsPromises.writeFile(path.join(commsDir, 'registry.json'), JSON.stringify(reg, null, 2), 'utf8');
}

export async function getAgentStatuses(commsDir: string): Promise<Array<RegisteredAgent & { live_status: AgentStatus; heartbeat: Heartbeat | null }>> {
  const reg = await readRegistry(commsDir);
  if (!reg) { return []; }
  const results = [];
  for (const agent of reg.agents) {
    const hb = await readHeartbeat(commsDir, path.basename(agent.id));
    results.push({ ...agent, live_status: agentStatusFromHeartbeat(hb), heartbeat: hb });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Inbox state machine (COORDINATION_IMPROVEMENTS §2.1)
// ---------------------------------------------------------------------------

/** Per-message state, persisted at <commsDir>/inboxes/<agent>/_state/<message-id>.json */
export interface InboxMessageState {
  message_id: string;
  read_at: string | null;
  replied_at: string | null;
  archived_at: string | null;
}

function stateFilePath(commsDir: string, agentId: string, messageId: string): string {
  return path.join(
    commsDir, 'inboxes', path.basename(agentId), '_state',
    `${path.basename(messageId)}.json`
  );
}

async function readStateFile(filePath: string): Promise<InboxMessageState | null> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(content.replace(/^﻿/, '')) as InboxMessageState;
  } catch { return null; }
}

async function writeStateFile(filePath: string, state: InboxMessageState): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
}

export async function readMessageState(
  commsDir: string, agentId: string, messageId: string
): Promise<InboxMessageState | null> {
  return readStateFile(stateFilePath(commsDir, agentId, messageId));
}

export async function markMessageRead(
  commsDir: string, agentId: string, messageId: string
): Promise<void> {
  const fp = stateFilePath(commsDir, agentId, messageId);
  const existing = await readStateFile(fp);
  if (existing && existing.read_at) { return; }
  const now = new Date().toISOString();
  await writeStateFile(fp, {
    message_id: messageId,
    read_at: now,
    replied_at: existing?.replied_at ?? null,
    archived_at: existing?.archived_at ?? null,
  });
}

export async function markMessageReplied(
  commsDir: string, agentId: string, messageId: string
): Promise<void> {
  const fp = stateFilePath(commsDir, agentId, messageId);
  const existing = await readStateFile(fp);
  const now = new Date().toISOString();
  await writeStateFile(fp, {
    message_id: messageId,
    read_at: existing?.read_at ?? now,
    replied_at: now,
    archived_at: existing?.archived_at ?? null,
  });
}

export async function markMessageArchived(
  commsDir: string, agentId: string, messageId: string
): Promise<void> {
  const fp = stateFilePath(commsDir, agentId, messageId);
  const existing = await readStateFile(fp);
  const now = new Date().toISOString();
  await writeStateFile(fp, {
    message_id: messageId,
    read_at: existing?.read_at ?? null,
    replied_at: existing?.replied_at ?? null,
    archived_at: now,
  });
}

/** Returns counts joining inbox messages with their state files. Backwards compatible:
 *  if no state file exists for a given message it counts as unread, and as
 *  awaiting_response when the message itself has requires_response === true. */
export async function getInboxSummary(
  commsDir: string, agentId: string
): Promise<{ total: number; unread: number; awaiting_response: number; archived: number }> {
  const messages = await readInbox(commsDir, agentId);
  let unread = 0;
  let awaiting_response = 0;
  let archived = 0;
  for (const msg of messages) {
    const state = await readMessageState(commsDir, agentId, msg.id);
    if (!state || !state.read_at) { unread++; }
    if (state?.archived_at) { archived++; }
    if (msg.requires_response && (!state || !state.replied_at)) { awaiting_response++; }
  }
  return { total: messages.length, unread, awaiting_response, archived };
}

export async function cleanupOldMessages(commsDir: string, retentionDays: number = 7): Promise<number> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  try {
    const agents = await fsPromises.readdir(path.join(commsDir, 'inboxes'));
    for (const agent of agents) {
      const dir = path.join(commsDir, 'inboxes', agent);
      const stat = await fsPromises.stat(dir);
      if (!stat.isDirectory()) { continue; }
      for (const file of (await fsPromises.readdir(dir)).filter(f => f.endsWith('.json'))) {
        try {
          const s = await fsPromises.stat(path.join(dir, file));
          if (s.mtimeMs < cutoff) { await fsPromises.unlink(path.join(dir, file)); cleaned++; }
        } catch { /* skip */ }
      }
    }
  } catch { /* no inboxes */ }
  return cleaned;
}
