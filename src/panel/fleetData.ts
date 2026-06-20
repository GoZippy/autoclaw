/**
 * fleetData.ts — Read-only data layer for the AutoClaw Fleet dashboard.
 *
 * Walks the `.autoclaw/orchestrator/` tree (registry, heartbeats, inboxes,
 * inbox `_state/`, claims, sprint YAMLs, cost ledger) and produces the gathered
 * `FleetDashboardInputs` that the pure builders in
 * `src/views/fleetViewModelBuilders.ts` turn into a render model.
 *
 * Hard constraints:
 *   - READ-ONLY. This module never writes to the orchestrator tree.
 *   - No `vscode` import — pure Node `fs`/`path`, so it stays unit-testable.
 *   - No LLM / network calls.  Pure file I/O.
 *
 * Sprint 3 — C5 (WA-2, Fleet Panel).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentHealth } from '../lmd/types';
import {
  buildFleetDashboard,
  type RawHeartbeat,
  type RawAgentProfile,
  type RawMessage,
  type RawInboxState,
  type FleetDashboardInputs,
  type AgentCardInputs,
} from '../views/fleetViewModelBuilders';
import type { CostLedgerEntry, FleetDashboardModel } from '../views/fleetViewModel';
import type { DispatchResult } from '../runners/types';
import { readAllBeacons } from '../fleet/beacons';
import { parseFleetManifest } from '../fleet/architecture';
import { listInvites } from '../fleet/invites';
import { computePendingAgents, type PendingAgent } from '../fleet/pending';

const fsp = fs.promises;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Resolve the orchestrator comms directory under a workspace root. */
export function commsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
}

/** Resolve the orchestrator root directory under a workspace root. */
export function orchestratorDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator');
}

// ---------------------------------------------------------------------------
// Low-level JSON readers (all swallow errors → null / [])
// ---------------------------------------------------------------------------

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    // Strip a possible UTF-8 BOM before parsing.
    return JSON.parse(raw.replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/** Read every `*.json` file in a directory, skipping malformed entries. */
async function readJsonDir<T>(dir: string): Promise<T[]> {
  const names = await listDir(dir);
  const out: T[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) { continue; }
    const parsed = await readJson<T>(path.join(dir, name));
    if (parsed !== null) { out.push(parsed); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry / agent profiles
// ---------------------------------------------------------------------------

interface RegistryFile {
  agents?: Array<{
    id: string;
    name?: string;
    role?: string;
    machine_id?: string;
    capabilities?: string[];
    parent_id?: string | null;
  }>;
}

/**
 * Read agent profiles from the comms registry.  Returns an empty list when no
 * registry exists yet.
 */
export async function readAgentProfiles(workspaceRoot: string): Promise<RawAgentProfile[]> {
  const reg = await readJson<RegistryFile>(
    path.join(commsDir(workspaceRoot), 'registry.json')
  );
  if (!reg?.agents) { return []; }
  return reg.agents.map(a => ({
    id: a.id,
    name: a.name,
    role: a.role,
    machine_id: a.machine_id,
    capabilities: a.capabilities,
    parent_id: a.parent_id ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

/**
 * Read the primary heartbeat for every agent (the `<agent>.json` files, not the
 * `<agent>-<session>.json` sidecars).  Returns a map keyed by agent id.
 */
export async function readHeartbeats(
  workspaceRoot: string
): Promise<Map<string, RawHeartbeat>> {
  const dir = path.join(commsDir(workspaceRoot), 'heartbeats');
  const names = await listDir(dir);
  const out = new Map<string, RawHeartbeat>();
  for (const name of names) {
    if (!name.endsWith('.json')) { continue; }
    const stem = name.slice(0, -5);
    // Skip session sidecars: `<agent>-<session>.json`. The primary file's stem
    // equals the agent id exactly, so we accept every file but let a later
    // primary overwrite — primary files are written last by writeSessionHeartbeat.
    const hb = await readJson<RawHeartbeat>(path.join(dir, name));
    if (!hb?.agent_id) { continue; }
    // Prefer the file whose stem matches agent_id exactly (the primary).
    const isPrimary = stem === hb.agent_id;
    if (isPrimary || !out.has(hb.agent_id)) {
      out.set(hb.agent_id, hb);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Messages (inboxes + outboxes + processed)
// ---------------------------------------------------------------------------

/** A message paired with the inbox directory it was found in. */
interface LocatedMessage {
  msg: RawMessage;
  /** Agent id of the inbox the message currently lives in ("shared" allowed). */
  inboxAgent: string;
}

/**
 * Read every message across all agent inboxes plus the `shared` inbox, including
 * their `processed/` subfolders.  Each message is tagged with the inbox it was
 * found in so the caller can group by recipient inbox.
 */
export async function readAllMessages(
  workspaceRoot: string
): Promise<LocatedMessage[]> {
  const inboxesRoot = path.join(commsDir(workspaceRoot), 'inboxes');
  const agentDirs = await listDir(inboxesRoot);
  const out: LocatedMessage[] = [];
  const seen = new Set<string>();

  for (const agent of agentDirs) {
    const agentInbox = path.join(inboxesRoot, agent);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(agentInbox);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) { continue; }

    // Top-level messages + processed/ subfolder.
    for (const sub of ['', 'processed']) {
      const dir = sub ? path.join(agentInbox, sub) : agentInbox;
      const names = await listDir(dir);
      for (const name of names) {
        if (!name.endsWith('.json')) { continue; }
        const msg = await readJson<RawMessage>(path.join(dir, name));
        if (!msg?.id) { continue; }
        // De-dupe across inbox/processed by message id.
        const key = `${msg.id}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        out.push({ msg, inboxAgent: agent });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inbox state (_state/<msg-id>.json)
// ---------------------------------------------------------------------------

/**
 * Read the per-message inbox state for one agent inbox.
 * Returns a map keyed by `msg_id`. Missing `_state/` ⇒ empty map (all unread).
 */
export async function readInboxStates(
  workspaceRoot: string,
  agentId: string
): Promise<Map<string, RawInboxState>> {
  const stateRoot = path.join(
    commsDir(workspaceRoot), 'inboxes', agentId, '_state'
  );
  const entries = await readJsonDir<RawInboxState>(stateRoot);
  const out = new Map<string, RawInboxState>();
  for (const e of entries) {
    if (e?.msg_id) { out.set(e.msg_id, e); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claims (claimed-but-incomplete tasks)
// ---------------------------------------------------------------------------

interface ClaimFile {
  task_ids?: string[];
  task_id?: string;
  claimed_by?: string;
  sprint?: number;
}

/**
 * Read the `claims/` directory and group claimed task ids by claiming agent.
 */
export async function readClaims(
  workspaceRoot: string
): Promise<Map<string, string[]>> {
  const dir = path.join(commsDir(workspaceRoot), 'claims');
  const claims = await readJsonDir<ClaimFile>(dir);
  const out = new Map<string, string[]>();
  for (const c of claims) {
    const agent = c.claimed_by;
    if (!agent) { continue; }
    const ids = c.task_ids ?? (c.task_id ? [c.task_id] : []);
    const list = out.get(agent) ?? [];
    for (const id of ids) {
      if (!list.includes(id)) { list.push(id); }
    }
    out.set(agent, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sprint assignments (sprint YAMLs — lightweight line scan, no YAML dep)
// ---------------------------------------------------------------------------

/**
 * Scan `sprints/*.yaml` for `agent:` / `role:` pairs and produce
 * "<sprintFile>:<role>" assignment strings keyed by agent id.
 *
 * This is a deliberately lightweight regex scan — the project has no YAML
 * parser dependency and the sprint files have a stable, simple shape. Agent
 * ids in sprint files use WA-N slot names; we also map the registry agents
 * through any `agent: <id>` lines that name a real agent.
 */
export async function readSprintAssignments(
  workspaceRoot: string
): Promise<Map<string, string[]>> {
  const dir = path.join(orchestratorDir(workspaceRoot), 'sprints');
  const names = await listDir(dir);
  const out = new Map<string, string[]>();

  for (const name of names) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) { continue; }
    let text: string;
    try {
      text = await fsp.readFile(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const sprintLabel = name.replace(/\.(yaml|yml)$/, '');
    // Walk "- agent: X" blocks, capturing the following "role:" line.
    const lines = text.split(/\r?\n/);
    let currentAgent: string | null = null;
    for (const line of lines) {
      const agentMatch = /^\s*-?\s*agent:\s*["']?([A-Za-z0-9_.\-]+)["']?\s*$/.exec(line);
      if (agentMatch) {
        currentAgent = agentMatch[1];
        continue;
      }
      const roleMatch = /^\s*role:\s*["']?(.+?)["']?\s*$/.exec(line);
      if (roleMatch && currentAgent) {
        const list = out.get(currentAgent) ?? [];
        const entry = `${sprintLabel}: ${roleMatch[1].trim()}`;
        if (!list.includes(entry)) { list.push(entry); }
        out.set(currentAgent, list);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

/**
 * Read the cost ledger.  Supports two on-disk shapes:
 *   - `cost-ledger.jsonl`  — newline-delimited JSON entries
 *   - `cost-ledger.json`   — a JSON array of entries
 * Both live directly under `.autoclaw/orchestrator/`. Missing file ⇒ [].
 */
export async function readCostLedger(
  workspaceRoot: string
): Promise<CostLedgerEntry[]> {
  const base = orchestratorDir(workspaceRoot);
  const out: CostLedgerEntry[] = [];

  // JSONL form.
  try {
    const raw = await fsp.readFile(path.join(base, 'cost-ledger.jsonl'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        const e = JSON.parse(trimmed) as Partial<CostLedgerEntry>;
        const norm = normalizeCostEntry(e);
        if (norm) { out.push(norm); }
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no jsonl */
  }

  // JSON-array form.
  const arr = await readJson<Array<Partial<CostLedgerEntry>>>(
    path.join(base, 'cost-ledger.json')
  );
  if (Array.isArray(arr)) {
    for (const e of arr) {
      const norm = normalizeCostEntry(e);
      if (norm) { out.push(norm); }
    }
  }

  return out;
}

/** Coerce a loosely-typed ledger record into a `CostLedgerEntry`. */
function normalizeCostEntry(
  e: Partial<CostLedgerEntry> & Record<string, unknown>
): CostLedgerEntry | null {
  const agentId =
    (typeof e.agentId === 'string' && e.agentId) ||
    (typeof e.agent_id === 'string' && (e.agent_id as string)) ||
    '';
  if (!agentId) { return null; }
  return {
    agentId,
    tokens: typeof e.tokens === 'number' ? e.tokens : 0,
    wallMs:
      typeof e.wallMs === 'number'
        ? e.wallMs
        : typeof e.wall_ms === 'number'
          ? (e.wall_ms as number)
          : 0,
    because:
      (typeof e.because === 'string' && e.because) ||
      (typeof e.rationale === 'string' && (e.rationale as string)) ||
      '',
    taskId:
      (typeof e.taskId === 'string' && e.taskId) ||
      (typeof e.task_id === 'string' && (e.task_id as string)) ||
      undefined,
    sprint: typeof e.sprint === 'number' ? e.sprint : undefined,
    timestamp:
      (typeof e.timestamp === 'string' && e.timestamp) ||
      new Date(0).toISOString(),
  };
}

/**
 * Append one entry to the orchestrator per-agent cost ledger
 * (`.autoclaw/orchestrator/cost-ledger.jsonl`). This is the integration seam any
 * in-process dispatcher that has both a token count and a workspace handle can
 * call to feed the panel's per-agent rollup ({@link readCostLedger} →
 * `buildCostLedger`). Best-effort: a write failure never throws, so persisting
 * cost can never break a dispatch.
 */
export async function appendCostLedgerEntry(
  workspaceRoot: string,
  entry: CostLedgerEntry,
): Promise<void> {
  try {
    const norm = normalizeCostEntry(entry as Partial<CostLedgerEntry> & Record<string, unknown>);
    if (!norm) { return; }
    const base = orchestratorDir(workspaceRoot);
    await fsp.mkdir(base, { recursive: true });
    await fsp.appendFile(path.join(base, 'cost-ledger.jsonl'), JSON.stringify(norm) + '\n', 'utf8');
  } catch {
    /* best-effort — never break a dispatch because cost couldn't be persisted */
  }
}

/**
 * Automatic cost writer: turn a completed runner {@link DispatchResult} into a
 * per-agent cost-ledger entry. This is the missing "in-process consumer" that
 * makes the panel's cost rollup fill itself — any dispatch seam that has a
 * workspace handle and a result can call this and the panel updates.
 *
 * Best-effort and non-recording by design when there's nothing to record:
 *   - a failed dispatch (`ok === false`) is skipped, and
 *   - a result with no host-reported `tokens` is skipped (we never fabricate a
 *     token count), and
 *   - any error is swallowed — recording cost must never break a dispatch.
 */
export async function recordDispatchCost(
  workspaceRoot: string,
  agentId: string,
  result: DispatchResult,
  meta?: { taskId?: string; sprint?: number },
): Promise<void> {
  try {
    if (!agentId || !result || result.ok === false || !result.tokens) { return; }
    const total = (result.tokens.input ?? 0) + (result.tokens.output ?? 0);
    if (total <= 0) { return; } // nothing to record — skip a zero-token no-op row
    await appendCostLedgerEntry(workspaceRoot, {
      agentId,
      tokens: total,
      wallMs: typeof result.durationMs === 'number' ? result.durationMs : 0,
      because: result.rationale ?? '',
      taskId: meta?.taskId,
      sprint: meta?.sprint,
      timestamp: result.finishedAt || new Date().toISOString(),
    });
  } catch {
    /* best-effort — cost capture must never break a dispatch */
  }
}

// ---------------------------------------------------------------------------
// Health snapshot
// ---------------------------------------------------------------------------

/**
 * Derive an `AgentHealth[]` snapshot from heartbeat files when a live LMD
 * `HealthStateMachine` is not available to the panel.
 *
 * The panel's preferred path is to be handed a live `getHealthGrid()` result
 * from the running LMD; this fallback keeps the dashboard populated when the
 * panel is opened before the LMD has ticked.
 */
export function deriveHealthFromHeartbeats(
  heartbeats: Map<string, RawHeartbeat>,
  now: number = Date.now()
): AgentHealth[] {
  const out: AgentHealth[] = [];
  for (const hb of heartbeats.values()) {
    const ageMs = now - new Date(hb.timestamp).getTime();
    const missed = Math.max(0, Math.floor(ageMs / 30_000));
    let state: AgentHealth['state'] = 'alive';
    if (missed >= 10) { state = 'dead'; }
    else if (missed >= 5) { state = 'stalled'; }
    else if (missed >= 2) { state = 'degraded'; }
    out.push({
      agentId: hb.agent_id,
      sessionId: hb.session_id,
      state,
      lastHeartbeatAt: hb.timestamp,
      missedHeartbeats: missed,
      queueDepth: hb.queue_depth,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pending tray (FF-3) — agents with a fresh beacon not yet in fleet.json
// ---------------------------------------------------------------------------

/**
 * Gather the pending tray: agents present via a fresh beacon (machine-global or
 * this workspace) that are not yet declared in fleet.json. Suggested role/type +
 * trust come from a matching consumed invite first, else the beacon's hints.
 * Best-effort: any read failure degrades to `[]` so the panel never throws.
 */
export async function readPendingAgents(
  workspaceRoot: string,
  now: number = Date.now(),
): Promise<PendingAgent[]> {
  try {
    const comms = commsDir(workspaceRoot);
    const fleetFile = path.join(orchestratorDir(workspaceRoot), 'fleet.json');
    const [beacons, manifest, invitesM, invitesW] = await Promise.all([
      readAllBeacons({ commsDir: comms, now }).catch(() => []),
      fsp.readFile(fleetFile, 'utf8').then(parseFleetManifest).catch(() => null),
      listInvites({}).catch(() => []),
      listInvites({ scope: 'workspace', commsDir: comms }).catch(() => []),
    ]);
    return computePendingAgents(beacons, manifest, [...invitesM, ...invitesW]);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Top-level gather
// ---------------------------------------------------------------------------

/** Options for {@link gatherFleetData}. */
export interface GatherOptions {
  /** Workspace root containing `.autoclaw/`. */
  workspaceRoot: string;
  /** The agent id this panel renders "for" (drives Awaiting You). */
  selfAgentId: string;
  /**
   * Live LMD health snapshot. When omitted, health is derived from heartbeat
   * file ages via {@link deriveHealthFromHeartbeats}.
   */
  health?: AgentHealth[];
  /** Injectable clock for deterministic tests. */
  now?: number;
}

/**
 * Read every input the Fleet dashboard needs and assemble a render-ready
 * {@link FleetDashboardModel}.  This is the single function the panel calls.
 */
export async function gatherFleetData(
  opts: GatherOptions
): Promise<FleetDashboardModel> {
  const now = opts.now ?? Date.now();
  const { workspaceRoot, selfAgentId } = opts;

  const [profiles, heartbeats, located, claims, sprintAssignments, cost, pending] =
    await Promise.all([
      readAgentProfiles(workspaceRoot),
      readHeartbeats(workspaceRoot),
      readAllMessages(workspaceRoot),
      readClaims(workspaceRoot),
      readSprintAssignments(workspaceRoot),
      readCostLedger(workspaceRoot),
      readPendingAgents(workspaceRoot, now),
    ]);

  const allMessages: RawMessage[] = located.map(l => l.msg);

  // Group messages by their addressed recipient (`to`), which is what the
  // Awaiting-You filter keys on.
  const messagesByRecipient = new Map<string, RawMessage[]>();
  for (const m of allMessages) {
    const list = messagesByRecipient.get(m.to) ?? [];
    list.push(m);
    messagesByRecipient.set(m.to, list);
  }

  // Inbox states: read for every known agent so per-agent presence works.
  const inboxStatesByAgent = new Map<string, Map<string, RawInboxState>>();
  await Promise.all(
    profiles.map(async p => {
      inboxStatesByAgent.set(p.id, await readInboxStates(workspaceRoot, p.id));
    })
  );
  const selfInboxStates =
    inboxStatesByAgent.get(selfAgentId) ??
    (await readInboxStates(workspaceRoot, selfAgentId));

  const health = opts.health ?? deriveHealthFromHeartbeats(heartbeats, now);
  const healthById = new Map(health.map(h => [h.agentId, h]));

  // Synthetic activity events for dead/stalled agents.
  const healthEvents = health
    .filter(h => h.state === 'dead')
    .map(h => ({
      agentId: h.agentId,
      kind: 'agent_died' as const,
      timestamp: h.lastHeartbeatAt,
      text: `${h.agentId} went dark (no heartbeat for ${h.missedHeartbeats} ticks)`,
    }));

  const cardInputs: AgentCardInputs = {
    profiles,
    heartbeats,
    health: healthById,
    messages: allMessages,
    sprintAssignments,
    claimedTasks: claims,
  };

  const inputs: FleetDashboardInputs = {
    selfAgentId,
    cardInputs,
    allMessages,
    selfInboxStates,
    inboxStatesByAgent,
    messagesByRecipient,
    health,
    cost,
    healthEvents,
    pending,
  };

  return buildFleetDashboard(inputs, now);
}
