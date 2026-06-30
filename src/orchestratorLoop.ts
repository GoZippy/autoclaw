/**
 * orchestratorLoop.ts — Perpetual health-check → work-discovery → dispatch loop.
 *
 * This is the "always-on" heart of AutoClaw. It runs as a `setInterval`
 * ticker inside the extension host.
 *
 * Each tick:
 *  1. Read all heartbeat files → agent health grid
 *  2. Check inboxes for unread / requires_response messages
 *  3. Find idle/available agents → find next assignable task
 *  4. Dispatch work: write task_claim + work_package sidecar
 *  5. Write a loop-journal entry for external auditing
 *  6. Sleep until next tick
 *
 * Zero LLM calls in the hot path — all work is file-I/O against the
 * filesystem mailbox and heartbeat files.
 *
 * Agent dispatch (vendor-specific):
 *  - Kilo Code       → @kilocode/plugin (loaded dynamically via require)
 *  - Claude Code     → Claude Agent SDK headless subprocess
 *  - Kiro            → kiro-cli chat --no-interactive
 *  - Cursor          → cursor-agent CLI
 *  - Antigravity     → gemini CLI
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Heartbeat, Message } from './comms';
import { promotePendingTaskCompletes } from './orchestrator/peerReviewWatcher';
import { resolvePendingConsensus } from './orchestrator/consensusTally';
import { writeBoard } from './orchestrator/boardWriter';
import { ingestTaskCatalog } from './orchestrator/taskCatalogIngest';
import {
  wakeIdlePeers,
  notifyReviewResolved,
  readIdleAgentProfiles,
  readRecentlyWoken,
} from './orchestrator/wakeIdlePeers';
import type { BoardModel } from './orchestrator/board';
import { runHealPhase } from './orchestrator/heal';
import { reapDeadClaims } from './orchestrator/claimReaper';
import { acquireSupervisorRole, type AcquireResult, SUPERVISOR_TTL_MS, readClusterMap } from './orchestrator/supervisorLease';
import { type Membership, projectMonitors, projectStandbys, computeQuorumSize, isStrictlyNewer } from './orchestrator/clusterMap';
import { writeMonitorPresence, readMonitorRoster, pruneStaleMonitorPresence } from './orchestrator/monitorRoster';
import { ClusterMapGossipBus, RemoteClusterMapTracker } from './lmd/clusterMapGossip';
import { ingestWorkforceSignals } from './fleet/workforceIngest';
import { runRecallSweep } from './fleet/recallDispatch';
import { selectPreferredVendorByReputation } from './runners/reputationAssign';
// Fabric governance (AF-8 §3) — gate + audit the real dispatch path. Explicit
// subpath keeps the message-bus/bridge out of the loop module.
import { gateDispatch, appendAuditLog, type ControlLevel } from './fabric/governance';
import type { AgentType } from './fabric/agentTypes';
// Fleet HALT kill switch (HKS-3) — leaf module shared with hooks/triggerHooks.
import { isFleetHalted } from './hooks/fleetHalt';
import { enforceBudget } from './budget';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Path constants (computed once at module load; no circular deps)
// ---------------------------------------------------------------------------

export const COMMS_DIR_REL        = path.join('.autoclaw', 'orchestrator', 'comms');
export const HEARTBEATS_DIR_REL   = path.join(COMMS_DIR_REL, 'heartbeats');
export const SHARED_INBOX_REL     = path.join(COMMS_DIR_REL, 'inboxes', 'shared');
export const LOOP_JOURNAL_REL     = path.join(COMMS_DIR_REL, 'loop-journal.jsonl');
export const LOOP_STATE_REL       = path.join(COMMS_DIR_REL, 'loop-state.json');
export const LOOP_SIDE_CAR_DIR    = path.join(COMMS_DIR_REL, 'agents', '_dispatch');
export const DEFAULT_TICK_MS      = 30_000;
export const HEALTHY_MS           = 60_000;
export const STALLED_MS           = 5 * 60 * 1000;

/**
 * Per-process supervisor-candidate id (SH-2). Distinct across hosts so the
 * supervisor lease arbitrates which loop runs the HEAL phase; if the holder
 * goes stale, the next ticking host steals the lease and takes over.
 */
export const LOOP_INSTANCE_ID = `orchestrator-loop-${crypto.randomBytes(3).toString('hex')}`;

// ---------------------------------------------------------------------------
// KiloCode plugin cache (dynamic require — avoids hard dep)
// ---------------------------------------------------------------------------

let _kiloPlugin: any   = null;
let _kiloPluginLoadFailed = false;

// @ts-expect-error — @kilocode/plugin is an optional peer dep loaded at runtime.
declare module '@kilocode/plugin' { const Kang: any; export = Kang; }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VendorKind =
  | 'kilocode' | 'claude-code' | 'kiro' | 'cursor' | 'antigravity' | 'other';

export interface AgentHealthEntry {
  agentId: string;
  vendor: VendorKind;
  state: 'alive' | 'degraded' | 'stalled' | 'dead' | 'unknown';
  lastHeartbeatAt: string | null;
  missedTicks: number;
  hasUnreadMessages: boolean;
  unreadCount: number;
  currentSprint: number | null;
  currentTask: string | null;
}

export interface HealthCheckResult {
  entries: AgentHealthEntry[];
  stalledIds: string[];
  deadIds: string[];
  healthyCount: number;
  idleCount: number;
}

export interface LoopJournalEntry {
  at: string;
  tick: number;
  phase: 'health' | 'inbox' | 'work' | 'dispatch' | 'log' | 'sleep' | 'error';
  agentId?: string;
  action: string;
  detail?: Record<string, unknown>;
  ms?: number;
}

export interface LoopState {
  tick: number;
  startedAt: string;
  lastTickAt: string | null;
  totalAgentsSeen: number;
  totalTicks: number;
  totalErrors: number;
  totalDispatches: number;
  vendorStats: Record<string, { dispatched: number; errors: number }>;
}

export interface WorkPackage {
  type: 'work_package';
  taskId: string;
  taskName: string;
  description: string;
  filePaths: string[];
  successCriteria: string[];
  sprint: number;
  assignToVendor: VendorKind;
  priority: 'high' | 'medium' | 'low';
  timeBudgetMs: number;
  /**
   * Workspace-relative path to a generated intelligence context pack for this
   * task (Channel A). Set by {@link dispatchWork} when context-pack generation
   * is enabled; surfaced in the work-loop prompt so the agent reads it first.
   */
  contextPackPath?: string;
}

export interface DispatchContext {
  workspaceRoot: string;
  vendor: VendorKind;
  agentId: string;
  sprint: number;
  commitmentText: string;
  k8sWorkload?: boolean;
}

export interface DiscoveredWork {
  item: WorkPackage;
  why: string;
}

export interface TickResult {
  tick: number;
  durationMs: number;
  health: HealthCheckResult;
  workFound: DiscoveredWork[];
  dispatched: number;
  errors: number;
}

export interface OrchestratorLoopOptions {
  workspaceRoot?: string;
  tickMs?: number;
  onTick?: (result: TickResult) => void;
  /**
   * Opt-in self-healing (Follow-up #3). When TRUE the loop runs the HEAL phase
   * each tick — bounded, reversible, act-then-report recovery on the fleet
   * (steal a stale+expired claim, emit a finding_report per action). When FALSE
   * (the default) the HEAL phase is skipped entirely: detection/reporting still
   * happens via the reconcile sweep + board write, but the orchestrator never
   * AUTO-ACTS on the fleet. OFF by default because this mutates shared state.
   * The boolean is sourced from `autoclaw.selfHealing.enabled` in extension.ts;
   * the orchestrator modules stay vscode-free.
   */
  selfHealingEnabled?: boolean;
  /**
   * Opt-in dead-session claim reaper (CL-3). When TRUE the active supervisor, each
   * tick, releases claims whose owning session is dead AND whose claim is expired
   * (archives the claim file to `claims/_reaped/`, emits a finding_report, frees
   * the task). RELEASE-ONLY — never touches live work, dispatches, or git — so it
   * is the safe subset of self-healing and is gated separately from
   * {@link selfHealingEnabled}. OFF by default. Sourced from
   * `autoclaw.selfHealing.reapDeadClaims` in extension.ts.
   */
  reapDeadClaims?: boolean;
  /**
   * L1 single-active manager. When TRUE (the default) only the active supervisor
   * host runs the fleet WRITE phases each tick (gc, dispatch, promote, consensus
   * tally, ingest, board write); standby hosts defer to it via the supervisor
   * lease. When FALSE every ticking host runs them independently (legacy). A solo
   * host always wins the lease, so the default preserves single-host behavior.
   * Sourced from `autoclaw.cluster.singleActive` in extension.ts.
   */
  singleActive?: boolean;
  /**
   * E1c: opt into LIVE election semantics — the supervisor acquire serializes on a
   * create-exclusive wx-lock and carries live epoch/term + deposed-holder fencing.
   * Default FALSE (a solo host is byte-identical to E1b). Sourced from
   * `autoclaw.cluster.fencing` in extension.ts.
   */
  fencing?: boolean;
  /**
   * E3b: opt into WAKE-ONLY cluster-map gossip — the host publishes its map for
   * peers and reads peer map-beats (advisory: it journals a peer-newer signal but
   * NEVER influences what is written; the wx-lock stays the sole authority). Builds
   * on `fencing` (gated as fencing && gossip). Default FALSE. Sourced from
   * `autoclaw.cluster.gossip` in extension.ts.
   */
  gossip?: boolean;
}

/** Per-tick options. Additive + defaulted so existing 2-arg callers are unchanged. */
export interface TickOptions {
  /**
   * Run the bounded, reversible, act-then-report HEAL phase this tick. Default
   * FALSE — when off the HEAL block is skipped and behavior is identical to a
   * loop that never opted in (no acts, no HEAL finding_reports). See
   * {@link OrchestratorLoopOptions.selfHealingEnabled}.
   */
  selfHealingEnabled?: boolean;
  /** Run the release-only dead-session claim reaper this tick (default FALSE). */
  reapDeadClaims?: boolean;
  /**
   * L1: gate the fleet WRITE phases behind the single active supervisor (default
   * TRUE). See {@link OrchestratorLoopOptions.singleActive}.
   */
  singleActive?: boolean;
  /** E1c: opt into wx-lock-serialized acquire + live epoch/term + fencing (default FALSE). */
  fencing?: boolean;
  /** E3b: opt into WAKE-ONLY cluster-map gossip (publish+read peer map-beats; advisory only). Default FALSE. */
  gossip?: boolean;
}

export interface OrchestratorLoopHandle {
  stop(): void;
  tickNow(): Promise<TickResult>;
  getState(): LoopState;
  isRunning(): boolean;
}

export interface AgentInfo {
  id: string;
  vendor: VendorKind;
  inbox: string;
  lastHeartbeatAt: string | null;
  state: AgentHealthEntry['state'];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function commsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, COMMS_DIR_REL);
}

function journalPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, LOOP_JOURNAL_REL);
}

function loopStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, LOOP_STATE_REL);
}

/** Best-effort journal append; never throws. */
export async function writeLoopJournal(
  workspaceRoot: string,
  entry: LoopJournalEntry
): Promise<void> {
  try {
    const fp = journalPath(workspaceRoot);
    await fsPromises.mkdir(path.dirname(fp), { recursive: true });
    await fsPromises.appendFile(fp, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* advisory only — never block the loop */ }
}

/** Read the loop journal (tail). */
export async function readLoopJournal(
  workspaceRoot: string,
  maxLines = 200
): Promise<LoopJournalEntry[]> {
  try {
    const raw = await fsPromises.readFile(journalPath(workspaceRoot), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const parsed: LoopJournalEntry[] = [];
    for (const line of lines.slice(-maxLines)) {
      try { parsed.push(JSON.parse(line) as LoopJournalEntry); } catch { /* skip corrupt */ }
    }
    return parsed;
  } catch { return []; }
}

export async function writeLoopState(workspaceRoot: string, state: LoopState): Promise<void> {
  const fp = loopStatePath(workspaceRoot);
  await fsPromises.mkdir(path.dirname(fp), { recursive: true });
  await fsPromises.writeFile(fp, JSON.stringify(state, null, 2), 'utf8');
}

export async function readPersistedLoopState(workspaceRoot: string): Promise<LoopState> {
  try {
    const raw = await fsPromises.readFile(loopStatePath(workspaceRoot), 'utf8');
    return JSON.parse(raw) as LoopState;
  } catch { return freshLoopState(); }
}

function inboxDir(workspaceRoot: string, agentId: string): string {
  return path.join(workspaceRoot, COMMS_DIR_REL, 'inboxes', agentId);
}

// ---------------------------------------------------------------------------
// Vendor helpers
// ---------------------------------------------------------------------------

export function vendorFromId(agentId: string): VendorKind {
  if (agentId === 'kilocode' || /kilocode/.test(agentId)) return 'kilocode';
  if (agentId === 'claude-code' || /claude/.test(agentId))  return 'claude-code';
  if (/kiro/.test(agentId))  return 'kiro';
  if (/cursor/.test(agentId)) return 'cursor';
  if (/antigravity|anti-/.test(agentId)) return 'antigravity';
  return 'other';
}

export function buildWorkLoopPrompt(pkg: WorkPackage): string {
  const lines: string[] = [];
  lines.push('<!-- AutoClaw Nested Loop — DO NOT STOP UNTIL CRITERIA VERIFIED -->');
  lines.push('');
  lines.push(`## Task ${pkg.taskId}: ${pkg.taskName}`);
  lines.push(`Priority: ${pkg.priority}`);
  lines.push('');
  lines.push('### Description');
  lines.push(pkg.description);
  lines.push('');
  if (pkg.filePaths.length > 0) {
    lines.push('### File Paths');
    for (const f of pkg.filePaths) lines.push(`- \`${f}\``);
    lines.push('');
  }
  lines.push('### Success Criteria');
  for (const i in pkg.successCriteria) lines.push(`${Number(i) + 1}. ${pkg.successCriteria[i]}`);
  lines.push('');
  lines.push('### Grounding — Context Pack');
  if (pkg.contextPackPath) {
    lines.push(
      `Read \`${pkg.contextPackPath}\` FIRST — a grounded pack the orchestrator ` +
        `assembled for this task: relevant code from this repo, the team's proven ` +
        `patterns, the learned style guide, recent memory, and durable facts.`,
    );
  } else {
    lines.push(
      'Before coding, pull your grounding pack: call the `intelligence.contextPack` ' +
        'MCP tool with this task, or run ' +
        '`node scripts/context-pack.js --task "<this task>"`. It returns relevant ' +
        'code, proven patterns, the style guide, memory, and durable facts.',
    );
  }
  lines.push('Treat it as retrieved hints, not authority — verify against the current code.');
  lines.push('');
  lines.push('### Nested Loop Lifecycle');
  lines.push('1. Make required changes.');
  lines.push('2. Verify each criterion explicitly.');
  lines.push('3. If any criterion fails → return to step 1.');
  lines.push('4. Write task_complete only when ALL criteria pass.');
  lines.push('');
  lines.push(`On completion write to .autoclaw/orchestrator/comms/inboxes/orchestrator-loop/:`);
  lines.push(`task_complete message with task_id="${pkg.taskId}".`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export async function healthCheck(
  workspaceRoot: string,
  now: Date = new Date()
): Promise<HealthCheckResult> {
  const nowMs = now.getTime();
  const hbDir = path.join(workspaceRoot, HEARTBEATS_DIR_REL);
  const entries: AgentHealthEntry[] = [];
  const stalledIds: string[] = [];
  const deadIds: string[] = [];
  let healthyCount = 0;
  let idleCount = 0;

  let filenames: string[] = [];
  try { filenames = await fsPromises.readdir(hbDir); } catch { return { entries: [], stalledIds: [], deadIds: [], healthyCount: 0, idleCount: 0 }; }

  for (const fn of filenames) {
    if (!fn.endsWith('.json')) continue;
    const base = fn.replace(/\.json$/, '');
    // Skip session heartbeat files: <agentId>-<uuidOrSession>.json
    // Heuristic: session files have 3+ dash-separated segments
    // (e.g., "agent-a-sess-abc" = 3 parts, "claude-code" = 2 parts, "kiro" = 1 part).
    if (base.split('-').length > 2) continue;
    const agentId = base;
    const hbPath = path.join(hbDir, fn);

    let hb: Heartbeat | null = null;
    try { const raw = await fsPromises.readFile(hbPath, 'utf8'); hb = JSON.parse(raw) as Heartbeat; } catch { /* skip */ }

    const ageMs = hb ? nowMs - new Date(hb.timestamp).getTime() : Infinity;
    const state: AgentHealthEntry['state'] =
      hb == null ? 'unknown'
      : ageMs > STALLED_MS * 3 ? 'dead'
      : ageMs > STALLED_MS ? 'stalled'
      : ageMs > HEALTHY_MS ? 'degraded'
      : 'alive';

    entries.push({
      agentId,
      vendor: vendorFromId(agentId),
      state,
      lastHeartbeatAt: hb?.timestamp ?? null,
      missedTicks: Math.max(0, Math.floor(ageMs / DEFAULT_TICK_MS)),
      hasUnreadMessages: false,
      unreadCount: 0,
      currentSprint: hb?.sprint ?? null,
      currentTask: hb?.current_task ?? null,
    });
  }

  for (const e of entries) {
    if (e.state === 'alive') healthyCount++;
    if (e.state === 'stalled') stalledIds.push(e.agentId);
    if (e.state === 'dead') deadIds.push(e.agentId);
  }

  return { entries, stalledIds, deadIds, healthyCount, idleCount };
}

// ---------------------------------------------------------------------------
// Inbox scanning
// ---------------------------------------------------------------------------

async function countUnread(workspaceRoot: string, agentId: string): Promise<number> {
  const dir = inboxDir(workspaceRoot, agentId);
  let files: string[] = [];
  try { files = await fsPromises.readdir(dir); } catch { return 0; }
  let count = 0;
  for (const fn of files) {
    if (!fn.endsWith('.json')) continue;
    const stateDir = path.join(dir, '_state');
    const stateFile = path.join(stateDir, fn.replace(/\.json$/, '') + '.json');
    try {
      const raw = await fsPromises.readFile(stateFile, 'utf8');
      const state = JSON.parse(raw);
      if (!state.archived_at) count++;
    } catch { count++; }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Work discovery
// ---------------------------------------------------------------------------

/**
 * Return the set of agent ids that already own at least one active (non-expired)
 * claim under `comms/claims/`. An agent with a live claim is NOT idle and must
 * not be re-dispatched a `next-<agent>` placeholder.
 */
export async function readClaimedAgentIds(workspaceRoot: string): Promise<Set<string>> {
  const claimsDir = path.join(workspaceRoot, COMMS_DIR_REL, 'claims');
  const out = new Set<string>();
  let entries: string[];
  try { entries = await fsPromises.readdir(claimsDir); } catch { return out; }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fsPromises.readFile(path.join(claimsDir, name), 'utf8');
      const claim = JSON.parse(raw) as { claimed_by?: string; expires_at?: string };
      if (typeof claim.claimed_by !== 'string') continue;
      if (claim.expires_at && Date.parse(claim.expires_at) < Date.now()) continue;
      out.add(claim.claimed_by);
    } catch { /* skip malformed claim */ }
  }
  return out;
}

/**
 * Return the set of agent ids that already received a `next-<agent>` dispatch
 * in the last `withinMs` window. The orchestrator-loop must not re-broadcast
 * the same placeholder every tick — once is enough until either the agent
 * claims real work or the cooldown elapses.
 */
export async function readRecentNextDispatches(
  workspaceRoot: string,
  withinMs: number = 5 * 60 * 1000
): Promise<Set<string>> {
  const sharedInbox = path.join(workspaceRoot, SHARED_INBOX_REL);
  const out = new Set<string>();
  const cutoff = Date.now() - withinMs;
  let names: string[];
  try { names = await fsPromises.readdir(sharedInbox); } catch { return out; }
  for (const name of names) {
    if (!name.includes('task_claim-next-')) continue;
    const m = name.match(/task_claim-next-(.+?)\.json$/);
    if (!m) continue;
    try {
      const stat = await fsPromises.stat(path.join(sharedInbox, name));
      if (stat.mtimeMs >= cutoff) { out.add(m[1]); }
    } catch { /* skip */ }
  }
  return out;
}

/**
 * How long a `task_claim-next-<agent>` placeholder lives before it is garbage.
 * Comfortably longer than the 5-min re-dispatch cooldown so a live agent always
 * has time to claim, but short enough that an idle fleet doesn't leave a litter
 * of stale placeholders (an idle fleet could otherwise pile up dozens in shared/).
 */
export const NEXT_DISPATCH_TTL_MS = 30 * 60 * 1000;

/**
 * Garbage-collect stale dispatch placeholders from the shared inbox (#1).
 *
 *  - **Expire:** delete any `task_claim-next-<agent>` whose `expires_at` is in the
 *    past (falling back to file mtime + TTL for legacy files without the field).
 *  - **Coalesce:** for each agent, keep only the newest live placeholder and
 *    delete the older duplicates — one pending nudge per idle agent is enough.
 *
 * Best-effort and self-contained: a malformed file is skipped, never fatal.
 * Returns the count removed so the loop can journal it.
 */
export async function gcStaleNextDispatches(
  workspaceRoot: string,
  now: number = Date.now(),
  ttlMs: number = NEXT_DISPATCH_TTL_MS,
): Promise<number> {
  const sharedInbox = path.join(workspaceRoot, SHARED_INBOX_REL);
  let names: string[];
  try { names = await fsPromises.readdir(sharedInbox); } catch { return 0; }

  // First pass: classify each next-dispatch file as expired or live, and for the
  // live ones record (agent → newest file) so we can coalesce duplicates.
  const live: Array<{ agent: string; name: string; mtimeMs: number }> = [];
  const toDelete: string[] = [];
  for (const name of names) {
    if (!name.includes('task_claim-next-')) continue;
    const m = name.match(/task_claim-next-(.+?)\.json$/);
    if (!m) continue;
    const full = path.join(sharedInbox, name);
    try {
      const raw = await fsPromises.readFile(full, 'utf8');
      const msg = JSON.parse(raw) as Message;
      const stat = await fsPromises.stat(full);
      const expiry = msg.expires_at ? Date.parse(msg.expires_at) : stat.mtimeMs + ttlMs;
      if (Number.isFinite(expiry) && expiry < now) { toDelete.push(name); }
      else { live.push({ agent: m[1], name, mtimeMs: stat.mtimeMs }); }
    } catch {
      // Unreadable/corrupt placeholder — reap it.
      toDelete.push(name);
    }
  }

  // Coalesce live duplicates: keep the newest per agent, delete the rest.
  const newestByAgent = new Map<string, { name: string; mtimeMs: number }>();
  for (const l of live) {
    const prev = newestByAgent.get(l.agent);
    if (!prev || l.mtimeMs > prev.mtimeMs) { newestByAgent.set(l.agent, l); }
  }
  for (const l of live) {
    const keep = newestByAgent.get(l.agent);
    if (keep && keep.name !== l.name) { toDelete.push(l.name); }
  }

  let removed = 0;
  for (const name of toDelete) {
    try { await fsPromises.unlink(path.join(sharedInbox, name)); removed++; } catch { /* already gone */ }
  }
  return removed;
}

export async function discoverWork(
  workspaceRoot: string,
  health: HealthCheckResult
): Promise<DiscoveredWork[]> {
  // Two-layer dedup: skip agents that ALREADY own an active claim, and skip
  // agents that received a `next-<agent>` placeholder in the last 5 minutes.
  // Both checks were missing before; the result was 15+ duplicate broadcasts
  // in 7 minutes — observed in production on 2026-05-29.
  const claimedAgents     = await readClaimedAgentIds(workspaceRoot);
  const recentlyNotified  = await readRecentNextDispatches(workspaceRoot);

  const work: DiscoveredWork[] = [];
  for (const agent of health.entries) {
    if (agent.state !== 'alive') continue;
    if (claimedAgents.has(agent.agentId)) continue;
    if (recentlyNotified.has(agent.agentId)) continue;
    work.push({
      item: {
        type: 'work_package',
        taskId: `next-${agent.agentId}`,
        taskName: `Next available work for ${agent.agentId}`,
        description: `Auto-dispatched by orchestrator-loop. Agent ${agent.agentId} is idle.`,
        filePaths: [],
        successCriteria: [
          'All existing tests pass',
          'task_complete written to shared inbox',
        ],
        sprint: agent.currentSprint ?? 1,
        assignToVendor: agent.vendor,
        priority: 'low',
        timeBudgetMs: 0,
      },
      why: `agent=${agent.agentId} idle, no claim, no recent next-dispatch`,
    });
  }
  return work;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function dispatchWork(
  workspaceRoot: string,
  pkg: WorkPackage,
  controlLevel: ControlLevel = 'individual',
  opts: { generateContextPack?: boolean; recordToKg?: boolean } = {}
): Promise<string | null> {
  // Fleet HALT kill switch (HKS-3, agent-trigger-hooks spec): when the
  // operator has engaged `.autoclaw/orchestrator/HALT`, NOTHING dispatches —
  // not the loop tick, not trigger hooks. Journaled so the pause is visible.
  if (isFleetHalted(workspaceRoot)) {
    await writeLoopJournal(workspaceRoot, {
      at: new Date().toISOString(), tick: 0, phase: 'dispatch',
      action: 'dispatch_halted', detail: { taskId: pkg.taskId, vendor: pkg.assignToVendor, reason: 'fleet HALT engaged' },
    });
    return null;
  }

  // Cost-as-instrument ceiling: when a spend/wall-clock budget is configured and
  // breached, enforceBudget engages the fleet HALT switch (so the pause persists
  // and is visible) and we refuse this dispatch. No-op when no budget.json exists.
  const budget = await enforceBudget(workspaceRoot);
  if (budget.enabled && !budget.within) {
    await writeLoopJournal(workspaceRoot, {
      at: new Date().toISOString(), tick: 0, phase: 'dispatch',
      action: 'dispatch_over_budget',
      detail: { taskId: pkg.taskId, vendor: pkg.assignToVendor, breaches: budget.breaches, spend_usd: budget.spend_usd },
    });
    return null;
  }

  const commsDirAbs = commsDir(workspaceRoot);
  const sidecarDir = path.join(workspaceRoot, LOOP_SIDE_CAR_DIR);
  const autoclawDir = path.join(workspaceRoot, '.autoclaw');

  // AF-8 §3: resolve the target agent's fabric type and gate the dispatch.
  // Absent agent_type ⇒ 'coder' ⇒ allowed, so existing fleets are unchanged;
  // only human-in-loop (assistant/governance) types or a governance control
  // level are held for approval.
  let agentType: AgentType = 'coder';
  try {
    const reg = JSON.parse(
      (await fsPromises.readFile(path.join(commsDirAbs, 'registry.json'), 'utf8')).replace(/^﻿/, '')
    ) as { agents?: Array<{ id: string; agent_type?: string }> };

    // BL-7b Part 2: reputation-aware DEFAULT assignment. A work package with no
    // explicit target ('other') is otherwise broadcast unaddressed for any agent
    // to self-claim. Instead, address the claim to the highest-reputation CAPABLE
    // registered agent — "capable" = one the dispatch gate would allow. Explicit,
    // named vendors are untouched. Degrade-safe: no candidates or a ledger-read
    // failure leaves the original 'other' broadcast and existing queue semantics.
    if (pkg.assignToVendor === 'other') {
      const candidates = (reg.agents ?? [])
        .filter(a => !!a.id && a.id !== 'other'
          && gateDispatch((a.agent_type ?? 'coder') as AgentType, controlLevel).allowed)
        .map(a => a.id);
      const picked = await selectPreferredVendorByReputation(workspaceRoot, candidates);
      if (picked) {
        pkg.assignToVendor = picked as VendorKind;
        await writeLoopJournal(workspaceRoot, {
          at: new Date().toISOString(), tick: 0, phase: 'dispatch',
          action: 'reputation_assigned',
          detail: { taskId: pkg.taskId, from: 'other', to: picked, candidates: candidates.length },
        });
      }
    }

    const match = reg.agents?.find(a => a.id === pkg.assignToVendor);
    if (match?.agent_type) { agentType = match.agent_type as AgentType; }
  } catch {
    /* no registry ⇒ default coder, original vendor preserved */
  }
  const gate = gateDispatch(agentType, controlLevel);
  if (!gate.allowed) {
    await appendAuditLog(autoclawDir, {
      actor: 'orchestrator-loop', agent_type: agentType, action: 'dispatch',
      task_id: pkg.taskId, control_level: controlLevel, allowed: false, detail: gate.reason,
    });
    await writeLoopJournal(workspaceRoot, {
      at: new Date().toISOString(), tick: 0, phase: 'dispatch',
      action: 'dispatch_gated', detail: { taskId: pkg.taskId, vendor: pkg.assignToVendor, reason: gate.reason },
    });
    return null;
  }

  // Auto-hook (Channel A): best-effort generate a context pack for this task and
  // reference it in the prompt. Degrade-safe and never blocks dispatch — any
  // failure (no backend, slow embed) is journaled and the prompt falls back to
  // pull-on-demand instructions.
  if (opts.generateContextPack) {
    try {
      const { buildContextPack } = await import('./intelligence');
      const task = `${pkg.taskName}: ${pkg.description}`.trim().replace(/:\s*$/, '');
      const pack = await buildContextPack(
        { task, sprint: pkg.sprint, agentId: pkg.assignToVendor, taskIds: [pkg.taskId] },
        { workspaceRoot },
      );
      const sprintsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'sprints');
      await fsPromises.mkdir(sprintsDir, { recursive: true });
      const packFile = path.join(sprintsDir, `${pkg.taskId}.context.md`);
      await fsPromises.writeFile(packFile, pack.markdown, 'utf8');
      pkg.contextPackPath = path.relative(workspaceRoot, packFile).split(path.sep).join('/');
      await writeLoopJournal(workspaceRoot, {
        at: new Date().toISOString(), tick: 0, phase: 'dispatch',
        action: 'context_pack_written',
        detail: { taskId: pkg.taskId, file: pkg.contextPackPath, degraded: pack.degraded, codeHits: pack.codeHits, kgHits: pack.kgHits },
      });
    } catch (err) {
      await writeLoopJournal(workspaceRoot, {
        at: new Date().toISOString(), tick: 0, phase: 'dispatch',
        action: 'context_pack_failed', detail: { taskId: pkg.taskId, error: String(err) },
      });
    }
  }

  const record = {
    at: new Date().toISOString(),
    type: 'work_package' as const,
    taskId: pkg.taskId,
    taskName: pkg.taskName,
    vendor: pkg.assignToVendor,
    sprint: pkg.sprint,
    filePaths: pkg.filePaths,
    successCriteria: pkg.successCriteria,
    priority: pkg.priority,
    timeBudgetMs: pkg.timeBudgetMs,
    contextPackPath: pkg.contextPackPath,
    prompt: buildWorkLoopPrompt(pkg),
  };

  const filename = `${pkg.taskId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
  await fsPromises.mkdir(sidecarDir, { recursive: true });
  const sidecarPath = path.join(sidecarDir, filename);
  await fsPromises.writeFile(sidecarPath, JSON.stringify(record, null, 2), 'utf8');

  // Real-time KG: remember this assignment as a durable fact (best-effort).
  if (opts.recordToKg) {
    try {
      const { recordOrchestrationEventsToKg } = await import('./intelligence');
      await recordOrchestrationEventsToKg(workspaceRoot, [{
        type: 'dispatch',
        eventId: filename.replace(/\.json$/, ''),
        agentId: pkg.assignToVendor,
        taskId: pkg.taskId,
        sprint: pkg.sprint,
        text: `Dispatched ${pkg.taskName || pkg.taskId} (${pkg.taskId}) to ${pkg.assignToVendor}` +
          (typeof pkg.sprint === 'number' ? ` for sprint ${pkg.sprint}` : '') + '.',
      }]);
    } catch { /* best-effort — never block dispatch */ }
  }

  const sharedInbox = path.join(workspaceRoot, SHARED_INBOX_REL);
  const claimMsg: Message = {
    id:          `msg-claim-${pkg.taskId}-${Date.now().toString(36)}`,
    from:        'orchestrator-loop',
    to:          'shared',
    type:        'task_claim',
    timestamp:   new Date().toISOString(),
    task_id:     pkg.taskId,
    payload:     { vendor: pkg.assignToVendor, priority: pkg.priority },
    requires_response: true,
    // Ephemeral placeholder: if nobody claims it within the TTL it is garbage —
    // gcStaleNextDispatches() reaps it so the shared inbox stays bounded (#1).
    expires_at:  new Date(Date.now() + NEXT_DISPATCH_TTL_MS).toISOString(),
  };
  await fsPromises.mkdir(sharedInbox, { recursive: true });
  const msgFile = path.join(sharedInbox, `${claimMsg.timestamp.replace(/[:.]/g,'-')}-task_claim-${pkg.taskId}.json`);
  await fsPromises.writeFile(msgFile, JSON.stringify(claimMsg, null, 2), 'utf8');

  // Append to comms-log.
  const logPath = path.join(workspaceRoot, LOOP_JOURNAL_REL.replace('loop-journal', 'comms-log'));
  await fsPromises.mkdir(path.dirname(logPath), { recursive: true });
  await fsPromises.appendFile(logPath, JSON.stringify(claimMsg) + '\n', 'utf8');

  await writeLoopJournal(workspaceRoot, {
    at: new Date().toISOString(), tick: 0, phase: 'dispatch',
    action: 'work_dispatched', detail: { taskId: pkg.taskId, vendor: pkg.assignToVendor },
  });

  // AF-8 §3: audit the allowed dispatch.
  await appendAuditLog(autoclawDir, {
    actor: 'orchestrator-loop', agent_type: agentType, action: 'dispatch',
    task_id: pkg.taskId, control_level: controlLevel, allowed: true,
  });

  return sidecarPath;
}

// ---------------------------------------------------------------------------
// Loop state helpers
// ---------------------------------------------------------------------------

function freshLoopState(): LoopState {
  return {
    tick: 0, startedAt: new Date().toISOString(), lastTickAt: null,
    totalAgentsSeen: 0, totalTicks: 0, totalErrors: 0, totalDispatches: 0,
    vendorStats: {},
  };
}

// ---------------------------------------------------------------------------
// Single tick
// ---------------------------------------------------------------------------

export async function runTick(
  workspaceRoot: string,
  state: LoopState,
  opts: TickOptions = {}
): Promise<TickResult> {
  const selfHealingEnabled = opts.selfHealingEnabled ?? false;
  const reapEnabled = opts.reapDeadClaims ?? false;
  const singleActive = opts.singleActive ?? true;
  const fencing = opts.fencing ?? false;
  const gossip = opts.gossip ?? false;
  const t0 = Date.now();
  state.tick++;
  state.totalTicks++;
  let tickErrors = 0;
  let dispatched = 0;

  await writeLoopJournal(workspaceRoot, { at: new Date().toISOString(), tick: state.tick, phase: 'health', action: 'tick_start' });

  let health: HealthCheckResult;
  try {
    health = await healthCheck(workspaceRoot);
    state.totalAgentsSeen = Math.max(state.totalAgentsSeen, health.entries.length);
  } catch (e: any) {
    tickErrors++; state.totalErrors++;
    health = { entries: [], stalledIds: [], deadIds: [], healthyCount: 0, idleCount: 0 };
    await writeLoopJournal(workspaceRoot, { at: new Date().toISOString(), tick: state.tick, phase: 'error', action: 'health_failed', detail: { error: String(e) } });
  }

  await writeLoopJournal(workspaceRoot, {
    at: new Date().toISOString(), tick: state.tick, phase: 'inbox', action: 'scan_complete',
    detail: { healthy: health.healthyCount, stalled: health.stalledIds.length, dead: health.deadIds.length },
  });

  // L1 (single-active manager): acquire the supervisor lease ONCE per tick. The
  // same lease arbitrates the fleet WRITE phases below (when `singleActive`, the
  // default) AND the HEAL phase (always a single healer). Acquiring is a lease
  // heartbeat — done outside the HALT guard so the lease keeps renewing while the
  // fleet is paused (otherwise a HALT would let a standby steal supervision; this
  // is a deliberate, benign deviation from the pre-L1 path, which let the lease go
  // stale during a HALT — nothing depends on that). On a read/write error we
  // degrade this host to a SAFE STANDBY for the tick: we prefer skipping the write
  // phases (board may stale one tick) over risking a double-write under an
  // uncertain lease. All skipped phases are idempotent re-derivations, so a solo
  // host self-corrects fully on the next tick (~30 s).
  // E2b-ii START LOOP (gated by `fencing`): write THIS loop instance's presence
  // (the JOIN/keepalive — every ticking host, so standbys are discoverable) and
  // DISCOVER the live monitor roster to project into the cluster map. The roster
  // keys on the loop-instance id (same keyspace as active_manager), the FS-canonical
  // fix for the agent-id/loop-instance keyspace gap. Single-FS only (no sockets).
  // Best-effort: a roster error must never block election. The projection is passed
  // INTO the acquire so it folds into the same wx-locked write (only the active
  // manager persists it — a standby's acquire writes nothing). Standbys are scored
  // by freshness alone (uniform need_score=1) until per-instance capability lands.
  let membership: Membership | undefined;
  if (workspaceRoot && fencing) {
    try {
      const nowIso = new Date(t0).toISOString();
      await writeMonitorPresence(workspaceRoot, { instance_id: LOOP_INSTANCE_ID, timestamp: nowIso });
      const roster = await readMonitorRoster(workspaceRoot, { now: t0, ttlMs: SUPERVISOR_TTL_MS });
      const monitors = projectMonitors(roster.map((r) => ({ instance_id: r.instance_id, age_ms: r.age_ms })), SUPERVISOR_TTL_MS);
      const standbys = projectStandbys(
        roster.map((r) => ({ instance_id: r.instance_id, agent_id: r.agent_id, need_score: 1, age_ms: r.age_ms, last_seen: r.timestamp })),
        LOOP_INSTANCE_ID, SUPERVISOR_TTL_MS,
      );
      membership = { monitors, standbys, quorum_size: computeQuorumSize(monitors.length) };
      await pruneStaleMonitorPresence(workspaceRoot, { now: t0, ttlMs: SUPERVISOR_TTL_MS });
    } catch {
      membership = undefined; // never break the tick on a roster error
    }
  }

  let sup: AcquireResult | null = null;
  if (workspaceRoot) {
    try {
      sup = await acquireSupervisorRole(workspaceRoot, LOOP_INSTANCE_ID, { fencing, membership });
    } catch (e: any) {
      tickErrors++; state.totalErrors++;
      await writeLoopJournal(workspaceRoot, {
        at: new Date().toISOString(), tick: state.tick, phase: 'error',
        action: 'supervisor_acquire_failed', detail: { error: String(e) },
      });
    }
  }
  // When `singleActive` is on, only the active supervisor performs fleet writes
  // (gc, dispatch, promote, tally, ingest, board). When off, every ticking host
  // does (legacy). A solo host always wins the lease, so single-host behavior is
  // unchanged. The board can briefly stale during a supervisor handoff — that is
  // the intended trade for a single coherent writer.
  const isActiveManager = !singleActive || (sup?.isSupervisor ?? false);

  // E3b WAKE-ONLY gossip (gated by `gossip`, which builds on `fencing`): the ACTIVE
  // manager publishes its current cluster map for peers, and every gossip host reads
  // peer map-beats into the cross-tick tracker. CRITICAL — gossip is ADVISORY: it is
  // NEVER merged into the acquire base, NEVER used for steal/renew, and the gossiped
  // heartbeat is NEVER trusted for liveness (the adversarial review proved an
  // epoch-dominant stale beat would otherwise resurrect a deposed active + drop the
  // disk fence[] = split-brain). The wx-locked cluster-map.json the acquire ABOVE
  // already wrote stays the SOLE authority. Gossip only journals a peer-newer signal
  // so a standby learns of a takeover promptly; a stale beat can at most cause a
  // wasted observation, never a write. Best-effort: gossip never breaks the tick.
  if (workspaceRoot && fencing && gossip) {
    try {
      const bus = new ClusterMapGossipBus(workspaceRoot, { selfOrigin: LOOP_INSTANCE_ID });
      const disk = await readClusterMap(workspaceRoot);
      if (isActiveManager && disk) {
        await bus.publish({ origin: LOOP_INSTANCE_ID, emittedAt: new Date(t0).toISOString(), map: disk });
      }
      // Use a PER-TICK tracker over the CURRENT fresh beats — not a monotonic
      // cross-tick one. A wake signal must reflect the live bus: a dead peer's
      // stale high-epoch beat must stop journalling once it ages out of readBeats,
      // not be remembered forever. (RemoteClusterMapTracker stays the seam for a
      // future stateful consumer / the T-track.)
      const tracker = new RemoteClusterMapTracker();
      tracker.mergeAll(await bus.readBeats(t0));
      const peer = tracker.best();
      if (peer && disk && isStrictlyNewer(peer, disk)
        && peer.active_manager && peer.active_manager.instance_id !== LOOP_INSTANCE_ID) {
        // A peer reports a strictly-newer map naming a DIFFERENT active — surface it
        // (observability / a future board-refresh wake). The host does NOT act on it
        // here: its next acquire reconciles from DISK, so a real takeover is honored
        // and a stale beat is ignored.
        await writeLoopJournal(workspaceRoot, {
          at: new Date().toISOString(), tick: state.tick, phase: 'log', action: 'gossip_peer_newer',
          detail: {
            peer_active: peer.active_manager.instance_id,
            peer_epoch: peer.epoch, peer_term: peer.term,
            disk_epoch: disk.epoch, disk_term: disk.term,
          },
        });
      }
      // GC long-dead orphan beats (a crashed window leaves a beat under a defunct
      // LOOP_INSTANCE_ID that per-origin overwrite never reclaims).
      await bus.pruneStale(t0);
    } catch {
      /* best-effort; gossip never breaks the tick */
    }
  }

  // Reap stale/duplicate dispatch placeholders before discovering new work, so
  // the shared inbox can't accumulate them unbounded.
  if (workspaceRoot && isActiveManager) {
    try {
      const reaped = await gcStaleNextDispatches(workspaceRoot);
      if (reaped > 0) {
        await writeLoopJournal(workspaceRoot, {
          at: new Date().toISOString(), tick: state.tick, phase: 'inbox',
          action: 'next_dispatch_gc', detail: { removed: reaped },
        });
      }
    } catch { /* GC is best-effort; never break the tick */ }
  }

  // Discovery + dispatch are fleet writes (next-dispatch placeholders + runner
  // dispatch) — only the active manager runs them, so two windows sharing a
  // project never double-dispatch the same task.
  const work = isActiveManager ? await discoverWork(workspaceRoot, health) : [];

  if (work.length > 0) {
    for (const w of work.slice(0, 2)) {
      try {
        const sidecar = await dispatchWork(workspaceRoot, w.item, 'individual', { generateContextPack: true, recordToKg: true });
        if (sidecar) { dispatched++; state.totalDispatches++; }
      } catch (e: any) { tickErrors++; state.totalErrors++; }
    }
  }

  // Auto-promote any new task_complete in shared/ into peer review_requests.
  // L1: the promote/tally/ingest/board WRITE phases run only on the active
  // manager (gated by `isActiveManager`); standby hosts skip them and defer to
  // the supervisor. HEAL stays gated on the lease independently (single healer).
  if (workspaceRoot && isActiveManager) {
    try {
      const promo = await promotePendingTaskCompletes({
        workspaceRoot,
        fromAgent: 'orchestrator-loop',
      });
      if (promo.promoted > 0) {
        await writeLoopJournal(workspaceRoot, {
          at: new Date().toISOString(), tick: state.tick, phase: 'dispatch',
          action: 'peer_reviews_promoted',
          detail: { promoted: promo.promoted, promotions: promo.promotions },
        });
        // Real-time KG: remember each completion as a durable fact (best-effort).
        try {
          const { recordOrchestrationEventsToKg } = await import('./intelligence');
          await recordOrchestrationEventsToKg(
            workspaceRoot,
            promo.promotions.map((p) => ({
              type: 'completion' as const,
              eventId: p.sourceMessageId,
              agentId: p.author,
              taskId: p.taskId,
              text: `${p.author} completed ${p.taskId ?? 'a task'} (now in peer review).`,
            })),
          );
        } catch { /* best-effort — never break the tick */ }
      }
    } catch (e: any) {
      tickErrors++; state.totalErrors++;
      await writeLoopJournal(workspaceRoot, {
        at: new Date().toISOString(), tick: state.tick, phase: 'error',
        action: 'peer_review_promotion_failed', detail: { error: String(e) },
      });
    }

    // L3: the freshly-written board (claimable lane) drives the work_available
    // wake pass after writeBoard below. review_resolved reconciles from
    // consensus/resolved/ directly, so it needs no tick-scoped capture.
    let boardThisTick: BoardModel | null = null;

    // Auto-tally any consensus/active/ vote sets that have reached a verdict:
    // write consensus/resolved/<task>.json and clear the active stub. Closes the
    // loop the watcher opens so no operator hand-writes it.
    try {
      // reviseMaxRounds:2 — on a dissent verdict (request_changes/reject) the
      // author gets one automatic "respond before we re-tally" round instead of
      // an immediate finalize; an approval or a second-round dissent finalizes.
      const tally = await resolvePendingConsensus({ workspaceRoot, resolvedBy: 'orchestrator-loop', reviseMaxRounds: 2 });
      if (tally.resolved.length > 0) {
        await writeLoopJournal(workspaceRoot, {
          at: new Date().toISOString(), tick: state.tick, phase: 'work',
          action: 'consensus_resolved', detail: { resolved: tally.resolved },
        });
      }
      if (tally.revised.length > 0) {
        await writeLoopJournal(workspaceRoot, {
          at: new Date().toISOString(), tick: state.tick, phase: 'work',
          action: 'consensus_revision_requested', detail: { revised: tally.revised },
        });
      }
    } catch (e: any) {
      tickErrors++; state.totalErrors++;
      await writeLoopJournal(workspaceRoot, {
        at: new Date().toISOString(), tick: state.tick, phase: 'error',
        action: 'consensus_tally_failed', detail: { error: String(e) },
      });
    }

    // HRW-1: fold task_complete / scope_violation into earned résumés (the
    // talent pool, HR-1). Idempotent via a per-workspace watermark; no-op when
    // there are no new signals. Distinct from the consensus/HEAL blocks above.
    try {
      const ing = await ingestWorkforceSignals(workspaceRoot);
      if (ing.ingested > 0) {
        await writeLoopJournal(workspaceRoot, {
          at: new Date().toISOString(), tick: state.tick, phase: 'work',
          action: 'workforce_ingest', detail: { ingested: ing.ingested, byAgent: ing.byAgent },
        });
      }
    } catch (e: any) {
      tickErrors++; state.totalErrors++;
      await writeLoopJournal(workspaceRoot, {
        at: new Date().toISOString(), tick: state.tick, phase: 'error',
        action: 'workforce_ingest_failed', detail: { error: String(e) },
      });
    }

    // Materialize the task catalog into state.tasks[] BEFORE the board write, so
    // the board surfaces claimable work instead of an empty lane (L0). Idempotent
    // + digest-gated, so a steady-state tick is a cheap no-op.
    try {
      const ing = await ingestTaskCatalog({ workspaceRoot });
      if (ing.changed) {
        await writeLoopJournal(workspaceRoot, {
          at: new Date().toISOString(), tick: state.tick, phase: 'log',
          action: 'task_catalog_ingested',
          detail: { count: ing.count, sprints: ing.sources.sprints, markdown: ing.sources.markdown },
        });
      }
    } catch (e: any) {
      tickErrors++; state.totalErrors++;
      await writeLoopJournal(workspaceRoot, {
        at: new Date().toISOString(), tick: state.tick, phase: 'error',
        action: 'task_catalog_ingest_failed', detail: { error: String(e) },
      });
    }

    // Refresh the agendaboard (board.md + board.json).
    try {
      boardThisTick = (await writeBoard({ workspaceRoot, generator: 'orchestrator-loop' })).board;
    } catch (e: any) {
      tickErrors++; state.totalErrors++;
      await writeLoopJournal(workspaceRoot, {
        at: new Date().toISOString(), tick: state.tick, phase: 'error',
        action: 'board_write_failed', detail: { error: String(e) },
      });
    }

    // L3: WAKE IDLE PEERS. The active supervisor (this whole block is
    // isActiveManager-gated, so a standby nudges nothing) writes board-grounded
    // wake nudges to per-agent inboxes — the universal wake a chat-only IDE agent
    // polls. (a) work_available: match each idle agent to a specific claimable
    // task; (b) review_resolved: tell each task author its verdict landed. Both
    // deduped (recent-nudge window + a _notified wx ledger). Best-effort.
    try {
      if (boardThisTick && boardThisTick.claimable.length > 0) {
        const claimed = await readClaimedAgentIds(workspaceRoot);
        const recentlyWoken = await readRecentlyWoken(workspaceRoot);
        const idleIds = health.entries
          .filter((e) => e.state === 'alive')
          .map((e) => e.agentId)
          .filter((id) => !claimed.has(id) && !recentlyWoken.has(id));
        const idle = await readIdleAgentProfiles(workspaceRoot, idleIds);
        const wake = await wakeIdlePeers({
          workspaceRoot, claimable: boardThisTick.claimable, idle, recentlyWoken,
        });
        if (wake.nudged.length > 0) {
          await writeLoopJournal(workspaceRoot, {
            at: new Date().toISOString(), tick: state.tick, phase: 'dispatch',
            action: 'work_available_nudged',
            detail: { nudged: wake.nudged.map((m) => ({ agent: m.agentId, task: m.task.task_id })) },
          });
        }
      }
      // review_resolved: reconcile consensus/resolved/ vs _notified/ and tell any
      // not-yet-notified author its verdict (self-healing; cheap no-op when none).
      const notify = await notifyReviewResolved({ workspaceRoot });
      if (notify.notified.length > 0) {
        await writeLoopJournal(workspaceRoot, {
          at: new Date().toISOString(), tick: state.tick, phase: 'work',
          action: 'review_resolved_notified', detail: { authors: notify.notified },
        });
      }
    } catch (e: any) {
      tickErrors++; state.totalErrors++;
      await writeLoopJournal(workspaceRoot, {
        at: new Date().toISOString(), tick: state.tick, phase: 'error',
        action: 'wake_idle_peers_failed', detail: { error: String(e) },
      });
    }

    // HEAL phase (SH-1/SH-2) — runs AFTER the board write so signals are fresh.
    // Only the active supervisor heals (the lease arbitrates between hosts; a
    // stale holder is taken over by the next ticking loop). Act-then-report:
    // bounded, reversible recovery + a finding_report per action; never master.
    // Skipped while the fleet is HALTed. Fully guarded — never breaks the tick.
    //
    // Follow-up #3 GATE: the act-then-report HEAL phase only runs when the
    // operator OPTS IN (`selfHealingEnabled`, default FALSE). When it is off the
    // `runHealPhase` call below is skipped entirely — ZERO fleet mutation and
    // ZERO HEAL finding_reports, identical to a loop that never opted in. The
    // supervisor lease + recall sweep are NOT gated by it, so non-HEAL
    // supervisor behavior is unchanged whether or not self-healing is enabled.
    try {
      if (!isFleetHalted(workspaceRoot)) {
        // Reuse the lease acquired once at the top of the tick (no re-acquire —
        // that would double the heartbeat write and open a TOCTOU window).
        if (sup?.isSupervisor) {
          if (selfHealingEnabled) {
            const heal = await runHealPhase(workspaceRoot, { mode: 'act' });
            if (heal.actions.length > 0 || sup?.stole) {
              await writeLoopJournal(workspaceRoot, {
                at: new Date().toISOString(), tick: state.tick, phase: 'work',
                action: 'heal', detail: {
                  summary: heal.summary, stolen: heal.stolen,
                  findings: heal.findingsEmitted, took_over: sup?.stole,
                },
              });
            }
          } else if (sup?.stole) {
            // Self-healing disabled: do NOT act/report. Still record the lease
            // takeover for audit (internal journal only — not a fleet finding).
            await writeLoopJournal(workspaceRoot, {
              at: new Date().toISOString(), tick: state.tick, phase: 'work',
              action: 'heal_disabled', detail: { took_over: sup?.stole },
            });
          }
          // CL-3: dead-session claim reaper — RELEASE-ONLY and gated SEPARATELY
          // from self-healing (it never acts on live work, dispatches, or git;
          // it only frees a task whose owning session is dead AND whose claim is
          // expired, archiving the claim file for audit). Safe with HEAL off.
          if (reapEnabled) {
            const reap = await reapDeadClaims(workspaceRoot, { apply: true });
            if (reap.reaped.length > 0) {
              await writeLoopJournal(workspaceRoot, {
                at: new Date().toISOString(), tick: state.tick, phase: 'work',
                action: 'reap_claims', detail: {
                  reaped: reap.reaped.length, scanned: reap.scanned,
                  tasks: reap.reaped.map(r => r.task_id),
                },
              });
            }
          }
          // HRW-3: supervisor-only roster-gated recall sweep (no-op without
          // .autoclaw/orchestrator/roster.json). Keeps the establishment staffed.
          const sweep = await runRecallSweep(workspaceRoot);
          if (!sweep.skipped && sweep.dispatched) {
            await writeLoopJournal(workspaceRoot, {
              at: new Date().toISOString(), tick: state.tick, phase: 'work',
              action: 'recall_sweep', detail: {
                recalled: sweep.dispatched.recalled, hires: sweep.dispatched.hires,
                gaps: sweep.dispatched.gaps,
              },
            });
          }
        } else {
          await writeLoopJournal(workspaceRoot, {
            at: new Date().toISOString(), tick: state.tick, phase: 'work',
            action: 'heal_standby', detail: { supervisor: sup?.holder ?? 'unknown' },
          });
        }
      }
    } catch (e: any) {
      tickErrors++; state.totalErrors++;
      await writeLoopJournal(workspaceRoot, {
        at: new Date().toISOString(), tick: state.tick, phase: 'error',
        action: 'heal_failed', detail: { error: String(e) },
      });
    }
  }

  // L1: record when this host stood by (single-active gated it off this tick) so
  // the deferral to the active supervisor is auditable.
  if (workspaceRoot && !isActiveManager) {
    await writeLoopJournal(workspaceRoot, {
      at: new Date().toISOString(), tick: state.tick, phase: 'log',
      action: 'manager_standby', detail: { supervisor: sup?.holder ?? null },
    });
  }

  state.lastTickAt = new Date().toISOString();
  const durationMs = Date.now() - t0;

  // Persist state to disk so external tools can audit loop progress.
  if (workspaceRoot) {
    try { await writeLoopState(workspaceRoot, state); } catch { /* best-effort */ }
  }

  await writeLoopJournal(workspaceRoot, {
    at: new Date().toISOString(), tick: state.tick, phase: 'log', action: 'tick_complete',
    detail: { durationMs, workFound: work.length, dispatched, errors: tickErrors },
  });

  return { tick: state.tick, durationMs, health, workFound: work, dispatched, errors: tickErrors };
}

// ---------------------------------------------------------------------------
// Loop lifecycle
// ---------------------------------------------------------------------------

export function startOrchestratorLoop(opts: OrchestratorLoopOptions = {}): OrchestratorLoopHandle {
  const workspaceRoot = opts.workspaceRoot ?? '';
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  // Follow-up #3: OFF by default — the loop only auto-heals when the operator
  // opts in (extension.ts reads `autoclaw.selfHealing.enabled` and passes it).
  const selfHealingEnabled = opts.selfHealingEnabled ?? false;
  // CL-3: OFF by default — release-only dead-session claim reaping when the
  // operator opts in (`autoclaw.selfHealing.reapDeadClaims`).
  const reapDeadClaimsEnabled = opts.reapDeadClaims ?? false;
  // L1: ON by default — only the active supervisor host runs the fleet WRITE
  // phases each tick (`autoclaw.cluster.singleActive`).
  const singleActive = opts.singleActive ?? true;
  // E1c: OFF by default — wx-lock-serialized acquire + live epoch/term + fencing
  // only when the operator opts in (`autoclaw.cluster.fencing`).
  const fencing = opts.fencing ?? false;
  // E3b: OFF by default — WAKE-ONLY cluster-map gossip (`autoclaw.cluster.gossip`).
  const gossip = opts.gossip ?? false;
  let running = true;
  let timerId: NodeJS.Timeout | null = null;
  const state = freshLoopState();

  // Load persisted balance on start.
  if (workspaceRoot) { readPersistedLoopState(workspaceRoot).then(s => Object.assign(state, s)).catch(() => {}); }

  const kick = async (): Promise<TickResult | void> => {
    if (!running) return;
    try {
      const result = await runTick(workspaceRoot, state, { selfHealingEnabled, reapDeadClaims: reapDeadClaimsEnabled, singleActive, fencing, gossip });
      if (workspaceRoot) await writeLoopState(workspaceRoot, state);
      opts.onTick?.(result);
    } catch (e) {
      state.totalErrors++;
      if (workspaceRoot) await writeLoopState(workspaceRoot, state);
      console.error('[orchestrator-loop] tick error:', e);
    }
  };

  timerId = setInterval(kick as () => void, tickMs);
  kick().catch(() => {});

  return {
    stop(): void { running = false; if (timerId) { clearInterval(timerId); timerId = null; } },
    tickNow(): Promise<TickResult> { return kick() as unknown as Promise<TickResult>; },
    getState(): LoopState { return state; },
    isRunning(): boolean { return running; },
  };
}

// ---------------------------------------------------------------------------
// Agent registry join
// ---------------------------------------------------------------------------

export async function getAgentRegistry(
  workspaceRoot: string,
  health: HealthCheckResult
): Promise<AgentInfo[]> {
  const registryPath = path.join(workspaceRoot, COMMS_DIR_REL, 'registry.json');
  let entries: Array<{ id: string; inbox_path?: string }> = [];
  try {
    const raw = await fsPromises.readFile(registryPath, 'utf8');
    const parsed = JSON.parse(raw);
    entries = ((parsed as any).agents ?? []).map((a: any) => ({ id: a.id, inbox_path: a.inbox_path }));
  } catch { /* no registry yet */ }

  return entries.map((entry: { id: string; inbox_path?: string }): AgentInfo => {
    const hb = health.entries.find((e: AgentHealthEntry) => e.agentId === entry.id);
    return {
      id: entry.id,
      vendor: vendorFromId(entry.id),
      inbox: entry.inbox_path ?? inboxDir(workspaceRoot, entry.id),
      lastHeartbeatAt: hb?.lastHeartbeatAt ?? null,
      state: hb?.state ?? 'unknown',
    };
  });
}
