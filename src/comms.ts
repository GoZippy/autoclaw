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

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageType =
  | 'review_request' | 'review_response'
  | 'consensus_vote' | 'consensus_result'
  | 'task_claim' | 'task_complete'
  | 'finding_report' | 'question' | 'answer'
  | 'scope_conflict' | 'escalation' | 'handoff' | 'system';

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
}

export interface Heartbeat {
  agent_id: string;
  timestamp: string;
  status: 'active' | 'idle';
  current_task: string | null;
  sprint: number | null;
}

export type AgentStatus = 'active' | 'idle' | 'offline' | 'detected';

export interface RegisteredAgent {
  id: string;
  name: string;
  extension_id: string | null;
  detected: boolean;
  inbox_path: string;
  hooks_supported: boolean;
  last_heartbeat: string | null;
  status: AgentStatus;
}

export interface AgentRegistry {
  agents: RegisteredAgent[];
  ide: string;
  provisioned_at: string;
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
  return `${ts}-${msg.type}-${msg.from}.json`;
}

export async function sendMessage(commsDir: string, msg: Message): Promise<string> {
  if (!msg.id) { msg.id = generateMessageId(); }
  if (!msg.timestamp) { msg.timestamp = new Date().toISOString(); }
  const inboxDir = path.join(commsDir, 'inboxes', msg.to);
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
        messages.push(JSON.parse(content) as Message);
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
  await fsPromises.writeFile(path.join(dir, `${hb.agent_id}.json`), JSON.stringify(hb, null, 2), 'utf8');
}

export async function readHeartbeat(commsDir: string, agentId: string): Promise<Heartbeat | null> {
  try {
    const content = await fsPromises.readFile(path.join(commsDir, 'heartbeats', `${agentId}.json`), 'utf8');
    return JSON.parse(content) as Heartbeat;
  } catch { return null; }
}

export async function readAllHeartbeats(commsDir: string): Promise<Heartbeat[]> {
  try {
    const dir = path.join(commsDir, 'heartbeats');
    const files = await fsPromises.readdir(dir);
    const hbs: Heartbeat[] = [];
    for (const f of files.filter(f => f.endsWith('.json'))) {
      try { hbs.push(JSON.parse(await fsPromises.readFile(path.join(dir, f), 'utf8'))); } catch { /* skip */ }
    }
    return hbs;
  } catch { return []; }
}

export function agentStatusFromHeartbeat(hb: Heartbeat | null, now: number = Date.now()): AgentStatus {
  if (!hb) { return 'offline'; }
  const age = now - new Date(hb.timestamp).getTime();
  if (age < 2 * 60 * 1000) { return 'active'; }
  if (age < 5 * 60 * 1000) { return 'idle'; }
  return 'offline';
}

export async function readRegistry(commsDir: string): Promise<AgentRegistry | null> {
  try {
    return JSON.parse(await fsPromises.readFile(path.join(commsDir, 'registry.json'), 'utf8'));
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
    const hb = await readHeartbeat(commsDir, agent.id);
    results.push({ ...agent, live_status: agentStatusFromHeartbeat(hb), heartbeat: hb });
  }
  return results;
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
