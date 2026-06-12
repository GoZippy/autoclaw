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
import { writeBoard } from './orchestrator/boardWriter';
// Fabric governance (AF-8 §3) — gate + audit the real dispatch path. Explicit
// subpath keeps the message-bus/bridge out of the loop module.
import { gateDispatch, appendAuditLog, type ControlLevel } from './fabric/governance';
import type { AgentType } from './fabric/agentTypes';

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
  controlLevel: ControlLevel = 'individual'
): Promise<string | null> {
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
    const match = reg.agents?.find(a => a.id === pkg.assignToVendor);
    if (match?.agent_type) { agentType = match.agent_type as AgentType; }
  } catch {
    /* no registry ⇒ default coder */
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
    prompt: buildWorkLoopPrompt(pkg),
  };

  const filename = `${pkg.taskId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
  await fsPromises.mkdir(sidecarDir, { recursive: true });
  const sidecarPath = path.join(sidecarDir, filename);
  await fsPromises.writeFile(sidecarPath, JSON.stringify(record, null, 2), 'utf8');

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
  state: LoopState
): Promise<TickResult> {
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

  const work = await discoverWork(workspaceRoot, health);

  if (work.length > 0) {
    for (const w of work.slice(0, 2)) {
      try {
        const sidecar = await dispatchWork(workspaceRoot, w.item);
        if (sidecar) { dispatched++; state.totalDispatches++; }
      } catch (e: any) { tickErrors++; state.totalErrors++; }
    }
  }

  // Auto-promote any new task_complete in shared/ into peer review_requests.
  if (workspaceRoot) {
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
      }
    } catch (e: any) {
      tickErrors++; state.totalErrors++;
      await writeLoopJournal(workspaceRoot, {
        at: new Date().toISOString(), tick: state.tick, phase: 'error',
        action: 'peer_review_promotion_failed', detail: { error: String(e) },
      });
    }

    // Refresh the agendaboard (board.md + board.json).
    try {
      await writeBoard({ workspaceRoot, generator: 'orchestrator-loop' });
    } catch (e: any) {
      tickErrors++; state.totalErrors++;
      await writeLoopJournal(workspaceRoot, {
        at: new Date().toISOString(), tick: state.tick, phase: 'error',
        action: 'board_write_failed', detail: { error: String(e) },
      });
    }
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
  let running = true;
  let timerId: NodeJS.Timeout | null = null;
  const state = freshLoopState();

  // Load persisted balance on start.
  if (workspaceRoot) { readPersistedLoopState(workspaceRoot).then(s => Object.assign(state, s)).catch(() => {}); }

  const kick = async (): Promise<TickResult | void> => {
    if (!running) return;
    try {
      const result = await runTick(workspaceRoot, state);
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
