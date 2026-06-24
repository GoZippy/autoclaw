/**
 * wakeIdlePeers.ts — L3: wake idle peers with board-grounded inbox nudges.
 *
 * Two nudges, both written to a peer's PER-AGENT inbox (inboxes/<agentId>/) — the
 * universal wake a chat-only IDE agent already polls every cycle (keepalive step
 * "SYNC your inbox"):
 *   - work_available  : when the board has a CLAIMABLE task matched to an idle
 *     agent, tell that specific agent to claim that specific task (richer than the
 *     blind shared `next-<agent>` placeholder, which stays as the no-match fallback).
 *   - review_resolved : when a consensus verdict lands, tell the task's AUTHOR.
 *
 * Reuses the fabric router (capability/trust/load/cost scoring) for matching and
 * comms.sendMessage for delivery. Host-free (no vscode) and pure where it can be,
 * so the matcher + dedup + author-notify are unit-tested deterministically. The
 * loop wires these inside the L1 single-active gate, so a standby host nudges
 * nothing.
 */

import * as fs from 'fs';
import * as path from 'path';

import { routeTasks, type SchedulableAgent, type SchedulableTask } from '../fabric/router';
import type { AgentType } from '../fabric/routerTypes';
import type { TrustLevel } from '../comms';
import { sendMessage } from '../comms';
import type { BoardClaimableItem } from './board';

const fsp = fs.promises;

/** How long a wake nudge stays valid before GC may reap it (mirrors next-dispatch). */
export const WAKE_NUDGE_TTL_MS = 30 * 60 * 1000;
/** An idle agent is re-woken at most once per this window. */
export const WAKE_NUDGE_COOLDOWN_MS = 5 * 60 * 1000;

function commsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
}
async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse((await fsp.readFile(filePath, 'utf8')).replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Matching (pure)
// ---------------------------------------------------------------------------

/** The per-agent fields the matcher needs (sourced from registry.json + heartbeats). */
export interface IdleAgentProfile {
  agentId: string;
  agent_type?: AgentType;
  capabilities?: string[];
  trust_level?: TrustLevel;
  max_parallel_tasks?: number;
  current_load?: number;
}

/** One (idle agent → claimable task) assignment. */
export interface ClaimableMatch {
  agentId: string;
  task: BoardClaimableItem;
}

/**
 * Assign each idle agent the best claimable task (capacity-aware, at most one per
 * agent this round). PURE — same inputs give the same output, no fs/vscode/clock.
 *
 * The board's `claimable` list is already priority-sorted (buildBoard), and
 * routeTasks consumes tasks in order, so higher-priority tasks bind first; surplus
 * tasks simply go unmatched this round. A task no eligible agent can serve
 * (required_capabilities none can meet) is skipped (fallback) — left for the
 * capability_query path.
 */
export function matchClaimableToIdle(
  claimable: readonly BoardClaimableItem[],
  idle: readonly IdleAgentProfile[],
  opts: { requiredCapabilitiesByTask?: Record<string, string[]> } = {},
): ClaimableMatch[] {
  if (claimable.length === 0 || idle.length === 0) { return []; }

  const agents: SchedulableAgent[] = idle.map((a) => ({
    id: a.agentId,
    agent_type: a.agent_type,
    capabilities: a.capabilities,
    trust_level: a.trust_level,
    max_parallel_tasks: a.max_parallel_tasks ?? 1,
    current_load: a.current_load ?? 0,
  }));
  const tasks: SchedulableTask[] = claimable.map((c) => ({
    id: c.task_id,
    // The board is capability-blind today; thread the planner's caps via opts when
    // available, else routeTask treats the task as servable by any agent.
    required_capabilities: opts.requiredCapabilitiesByTask?.[c.task_id],
  }));

  const byId = new Map(claimable.map((c) => [c.task_id, c]));
  const used = new Set<string>();
  const out: ClaimableMatch[] = [];
  for (const r of routeTasks(agents, tasks)) {
    if (!r.chosen || r.fallback || used.has(r.chosen)) { continue; }
    const task = byId.get(r.task_id);
    if (!task) { continue; }
    used.add(r.chosen);
    out.push({ agentId: r.chosen, task });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reads (fs)
// ---------------------------------------------------------------------------

interface RegistryShape {
  agents?: Array<{
    id: string;
    agent_type?: AgentType;
    capabilities?: string[];
    trust_level?: TrustLevel;
    max_parallel_tasks?: number;
  }>;
}

/** Build idle profiles for the given agent ids from registry.json (best-effort). */
export async function readIdleAgentProfiles(
  workspaceRoot: string,
  idleAgentIds: readonly string[],
): Promise<IdleAgentProfile[]> {
  if (idleAgentIds.length === 0) { return []; }
  const reg = await readJson<RegistryShape>(path.join(commsDir(workspaceRoot), 'registry.json'));
  const byId = new Map<string, NonNullable<RegistryShape['agents']>[number]>();
  for (const a of reg?.agents ?? []) { if (a?.id) { byId.set(a.id, a); } }
  return idleAgentIds.map((id) => {
    const a = byId.get(id);
    return {
      agentId: id,
      agent_type: a?.agent_type,
      capabilities: Array.isArray(a?.capabilities) ? a!.capabilities : undefined,
      trust_level: a?.trust_level,
      max_parallel_tasks: typeof a?.max_parallel_tasks === 'number' ? a!.max_parallel_tasks : undefined,
    };
  });
}

/**
 * Agents that already received a `work_available` nudge within `withinMs` — scan
 * each per-agent inbox for a recent one. The dedup that stops re-nudging the same
 * idle agent every 30s tick.
 */
export async function readRecentlyWoken(
  workspaceRoot: string,
  withinMs: number = WAKE_NUDGE_COOLDOWN_MS,
  now: number = Date.now(),
): Promise<Set<string>> {
  const out = new Set<string>();
  const inboxesRoot = path.join(commsDir(workspaceRoot), 'inboxes');
  let agents: string[];
  try { agents = await fsp.readdir(inboxesRoot); } catch { return out; }
  const cutoff = now - withinMs;
  for (const agent of agents) {
    if (agent === 'shared' || agent.startsWith('_')) { continue; }
    const dir = path.join(inboxesRoot, agent);
    let files: string[];
    try { files = await fsp.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.includes('-work_available-')) { continue; }
      try {
        const st = await fsp.stat(path.join(dir, f));
        if (st.mtimeMs >= cutoff) { out.add(agent); break; }
      } catch { /* skip */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nudges (fs)
// ---------------------------------------------------------------------------

/**
 * Write a `work_available` nudge to each matched idle agent's inbox. Agents in
 * `recentlyWoken` are skipped so a still-idle agent is nudged at most once per
 * cooldown window. Best-effort per agent (one failure never aborts the rest).
 */
export async function wakeIdlePeers(opts: {
  workspaceRoot: string;
  claimable: readonly BoardClaimableItem[];
  idle: readonly IdleAgentProfile[];
  recentlyWoken?: ReadonlySet<string>;
  requiredCapabilitiesByTask?: Record<string, string[]>;
  now?: number;
}): Promise<{ nudged: ClaimableMatch[] }> {
  const now = opts.now ?? Date.now();
  const recent = opts.recentlyWoken ?? new Set<string>();
  const eligible = opts.idle.filter((a) => !recent.has(a.agentId));
  const matches = matchClaimableToIdle(opts.claimable, eligible, {
    requiredCapabilitiesByTask: opts.requiredCapabilitiesByTask,
  });
  const cd = commsDir(opts.workspaceRoot);
  const nudged: ClaimableMatch[] = [];
  for (const m of matches) {
    try {
      await sendMessage(cd, {
        id: '', from: 'orchestrator-loop', to: m.agentId, type: 'work_available',
        timestamp: '', task_id: m.task.task_id,
        payload: {
          task_id: m.task.task_id,
          title: m.task.title ?? null,
          priority: m.task.priority ?? null,
          files: m.task.files ?? [],
          board_grounded: true,
        },
        requires_response: false,
        expires_at: new Date(now + WAKE_NUDGE_TTL_MS).toISOString(),
      });
      nudged.push(m);
    } catch { /* best-effort per agent */ }
  }
  return { nudged };
}

/** The durable consensus/resolved/<task>.json record this module reads. */
interface ResolvedRecord {
  task_id?: string;
  author?: string;
  verdict?: string;
  approvals?: number;
  panel_size?: number;
  rule?: string;
}

/**
 * Notify each RESOLVED task's AUTHOR with a `review_resolved` inbox message —
 * RECONCILIATION-based, so it self-heals: scan consensus/resolved/*.json against
 * consensus/_notified/, and deliver to any author not yet notified. This decouples
 * "verdict computed" (which surfaces in the tally exactly once, ever) from "author
 * notified" — a transient delivery failure or a crash just retries on a later tick
 * instead of permanently losing the wake.
 *
 * Per-task isolation: one bad record never aborts the rest of the sweep. Delivery
 * is at-least-once (send first, THEN write the `_notified/<resolved-file>` ledger),
 * so a crash between send and ledger causes at most a benign duplicate next tick,
 * never a lost notify. The ledger filename is the resolved filename verbatim, so
 * distinct task ids can't collide. Skipped authors (empty / self / shared) are
 * still ledgered so they aren't rescanned every tick.
 */
export async function notifyReviewResolved(opts: {
  workspaceRoot: string;
  now?: number;
}): Promise<{ notified: string[] }> {
  const cd = commsDir(opts.workspaceRoot);
  const resolvedDir = path.join(cd, 'consensus', 'resolved');
  const notifiedDir = path.join(cd, 'consensus', '_notified');
  const notified: string[] = [];

  let files: string[];
  try { files = await fsp.readdir(resolvedDir); } catch { return { notified }; }

  for (const f of files) {
    if (!f.endsWith('.json')) { continue; }
    const ledger = path.join(notifiedDir, f); // 1:1 with the resolved file — no collision
    try {
      // Dedup: already notified?
      try { await fsp.access(ledger); continue; } catch { /* not yet notified */ }

      const rec = await readJson<ResolvedRecord>(path.join(resolvedDir, f));
      const author = rec?.author;
      try { await fsp.mkdir(notifiedDir, { recursive: true }); } catch { /* ignore */ }

      if (!author || author === 'orchestrator-loop' || author === 'shared') {
        // Nothing to deliver — ledger it so we don't rescan this record forever.
        await writeLedger(ledger, { resolved_file: f, author: author ?? '', skipped: true, now: opts.now });
        continue;
      }
      // Deliver FIRST (at-least-once), then record the ledger.
      await sendMessage(cd, {
        id: '', from: 'orchestrator-loop', to: author, type: 'review_resolved',
        timestamp: '', task_id: rec?.task_id ?? f.slice(0, -5),
        payload: {
          task_id: rec?.task_id ?? f.slice(0, -5),
          decision: rec?.verdict ?? null, verdict: rec?.verdict ?? null,
          approvals: rec?.approvals ?? null, panelSize: rec?.panel_size ?? null, rule: rec?.rule ?? null,
        },
        requires_response: false,
      });
      await writeLedger(ledger, { resolved_file: f, author, verdict: rec?.verdict, now: opts.now });
      notified.push(author);
    } catch {
      // One bad record (read/send/ledger fault) never aborts the rest; because we
      // only ledger AFTER a successful send, an undelivered notify is retried next tick.
      continue;
    }
  }
  return { notified };
}

/** Best-effort ledger write (marks a resolved task as notified). */
async function writeLedger(
  ledger: string,
  detail: { resolved_file: string; author: string; verdict?: string; skipped?: boolean; now?: number },
): Promise<void> {
  await fsp.writeFile(ledger, JSON.stringify({
    ...detail, notified_at: new Date(detail.now ?? Date.now()).toISOString(),
  }, null, 2), 'utf8');
}
