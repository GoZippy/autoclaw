/**
 * recallDispatch.ts — deliver recall plans + the roster-gated sweep (HRW-3).
 *
 * HR-4 (recall.ts) PLANS who to call in; this module ACTS on the plan over the
 * filesystem lane: a `recall` writes a `task_assign` doorbell into the target
 * agent's inbox; a `hire`/`gap` surfaces a `finding_report` (a fresh spawn is
 * the runner layer's job). `runRecallSweep` ties it to a standing roster — it is
 * a no-op unless `.autoclaw/orchestrator/roster.json` exists, so it costs
 * nothing on a project that hasn't opted in.
 *
 * fs lane; `now` injectable; no vscode.
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §9.5.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { recallMessage, planRecallFromDisk, type RecallAction, type StandingRoster } from './recall';
import { parseFleetManifest } from './architecture';

const fsp = fs.promises;

/** Live presence is "fresh" within this window (mirrors the loop's HEALTHY band). */
const LIVE_TTL_MS = 5 * 60_000;

function commsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms');
}
function fileTs(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

async function writeMessage(dir: string, name: string, body: unknown): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, name), JSON.stringify(body, null, 2) + '\n', 'utf8');
}

export interface DispatchSummary {
  recalled: Array<{ agent_id: string; role: string }>;
  hires: Array<{ template_id: string; role: string }>;
  gaps: Array<{ role: string }>;
}

/**
 * Deliver a recall plan over the filesystem lane. Returns what was sent.
 *  - recall → a `task_assign` recall message into `inboxes/<agent_id>/`
 *  - hire   → a `finding_report` to `shared` (spawn-fresh is the runner layer's job)
 *  - gap    → a `finding_report` to `shared` (unfillable — needs attention)
 */
export async function dispatchRecallActions(
  workspaceRoot: string,
  actions: RecallAction[],
  opts: { from?: string; project?: string; now?: number } = {},
): Promise<DispatchSummary> {
  const now = new Date(opts.now ?? Date.now());
  const project = opts.project ?? path.basename(workspaceRoot);
  const from = opts.from ?? 'supervisor';
  const comms = commsDir(workspaceRoot);
  const shared = path.join(comms, 'inboxes', 'shared');
  const summary: DispatchSummary = { recalled: [], hires: [], gaps: [] };

  for (const action of actions) {
    const frag = crypto.randomBytes(3).toString('hex');
    if (action.kind === 'recall') {
      const msg = recallMessage(action.agent_id, action.role, {
        project, from, timestamp: now.toISOString(),
      });
      (msg as Record<string, unknown>).id = `msg-${crypto.randomUUID()}`;
      await writeMessage(
        path.join(comms, 'inboxes', action.agent_id),
        `${fileTs(now)}-task_assign-${from}-${frag}.json`,
        msg,
      );
      summary.recalled.push({ agent_id: action.agent_id, role: action.role });
    } else {
      const finding = {
        id: `msg-${crypto.randomUUID()}`, from, to: 'shared', type: 'finding_report',
        timestamp: now.toISOString(), requires_response: action.kind === 'gap',
        payload: action.kind === 'hire'
          ? { recall: 'hire', role: action.role, template_id: action.template_id,
              finding: `Roster vacancy for "${action.role}": hire fresh from template ${action.template_id} (runner spawn pending).` }
          : { recall: 'gap', role: action.role,
              finding: `Roster vacancy for "${action.role}" is UNFILLABLE — no available worker and no template. Needs attention.` },
      };
      await writeMessage(shared, `${fileTs(now)}-finding_report-${from}-${frag}.json`, finding);
      if (action.kind === 'hire') { summary.hires.push({ template_id: action.template_id, role: action.role }); }
      else { summary.gaps.push({ role: action.role }); }
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Live role census + roster-gated sweep
// ---------------------------------------------------------------------------

/**
 * Count live agents per role from primary heartbeats + the fleet.json role map.
 * "Live" = a heartbeat fresher than {@link LIVE_TTL_MS}. Agents with no declared
 * role count as `generalist`.
 */
export async function liveByRoleFromDisk(
  workspaceRoot: string,
  opts: { now?: number; ttlMs?: number } = {},
): Promise<Record<string, number>> {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? LIVE_TTL_MS;
  const comms = commsDir(workspaceRoot);

  const manifest = await fsp.readFile(path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'fleet.json'), 'utf8')
    .then(parseFleetManifest).catch(() => null);
  const roleOf = (id: string): string => manifest?.agents?.[id]?.role ?? 'generalist';

  const hbDir = path.join(comms, 'heartbeats');
  let files: string[];
  try { files = await fsp.readdir(hbDir); } catch { return {}; }

  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  for (const f of files) {
    if (!f.endsWith('.json')) { continue; }
    // Primary heartbeats only (skip session sidecars: >2 dash-separated segments).
    if (f.replace(/\.json$/, '').split('-').length > 2) { continue; }
    try {
      const hb = JSON.parse((await fsp.readFile(path.join(hbDir, f), 'utf8')).replace(/^﻿/, '')) as
        { agent_id?: string; timestamp?: string };
      if (!hb.agent_id || !hb.timestamp || seen.has(hb.agent_id)) { continue; }
      if (now - new Date(hb.timestamp).getTime() > ttl) { continue; }
      seen.add(hb.agent_id);
      const role = roleOf(hb.agent_id).toLowerCase();
      counts[role] = (counts[role] ?? 0) + 1;
    } catch { /* skip malformed */ }
  }
  return counts;
}

async function readRoster(workspaceRoot: string): Promise<StandingRoster | null> {
  try {
    const o = JSON.parse(
      (await fsp.readFile(path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'roster.json'), 'utf8')).replace(/^﻿/, ''),
    ) as StandingRoster;
    return o && o.want && typeof o.want === 'object' ? o : null;
  } catch {
    return null;
  }
}

export interface SweepResult { skipped: boolean; reason?: string; dispatched?: DispatchSummary }

/**
 * Roster-gated recall sweep: if `roster.json` exists, compute the live role
 * census, plan recall against the talent pool + templates, and dispatch it.
 * No roster ⇒ `{ skipped: true }` (zero cost). Safe to call every loop tick.
 */
export async function runRecallSweep(
  workspaceRoot: string,
  opts: { homeDir?: string; now?: number } = {},
): Promise<SweepResult> {
  const roster = await readRoster(workspaceRoot);
  if (!roster) { return { skipped: true, reason: 'no roster.json' }; }
  const live = await liveByRoleFromDisk(workspaceRoot, { now: opts.now });
  const plan = await planRecallFromDisk(roster, live, opts.homeDir);
  if (plan.length === 0) { return { skipped: true, reason: 'establishment staffed' }; }
  const dispatched = await dispatchRecallActions(workspaceRoot, plan, { now: opts.now, project: roster.project });
  return { skipped: false, dispatched };
}
