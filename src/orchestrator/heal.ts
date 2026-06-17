/**
 * heal.ts — the orchestrator HEAL phase (SH-1 wiring).
 *
 * Gathers failure signals from the on-disk state the loop already produces
 * (board.json, the claims dir, reconcile-report.json), runs the pure
 * {@link resolveRecovery} ladder, then — in the default ACT-THEN-REPORT mode —
 * performs the bounded, reversible recovery and emits a `finding_report` for
 * every action. RAILS (enforced by resolveRecovery + here): never act on
 * `master`, always write a finding, bounded retries → escalate.
 *
 * The only mutation HEAL performs itself is the one the protocol explicitly
 * sanctions: deleting a stale+expired claim file so the task re-opens as
 * claimable (AGENT_SESSION_PROTOCOL §4.5). Everything else is surfaced as a
 * finding for the dispatch path / a human to act on — HEAL never kills a
 * process, deletes user data, or merges anything.
 *
 * fs-only (no vscode), `now` injectable — unit-testable against a tmp dir.
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §3.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  resolveRecovery,
  summarizeRecovery,
  type RecoverySignals,
  type RecoveryAction,
  type StaleClaimSignal,
  type DriftFindingSignal,
} from './supervisor';

const fsp = fs.promises;

const COMMS_REL = path.join('.autoclaw', 'orchestrator', 'comms');

function commsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, COMMS_REL);
}
function orchDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator');
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gather signals
// ---------------------------------------------------------------------------

interface BoardDoc {
  in_flight?: Array<{ task_id?: string; claimed_by?: string; owner_healthy?: boolean }>;
}
interface ReconcileDoc {
  drifts?: Array<{ type?: string; task_id?: string; description?: string }>;
}

/**
 * Build {@link RecoverySignals} from the loop's on-disk artifacts.
 *  - staleClaims  ← board.json in_flight where owner_healthy === false, with
 *                   `expired` resolved from the claim file's `expires_at`.
 *  - driftFindings← reconcile-report.json drifts.
 * Other signal lanes (dead dispatch, failed-twice, lease violations, corrupt
 * comms, unreachable) are left empty here — they are surfaced by their own
 * subsystems and can be fed in as those land.
 */
export async function gatherRecoverySignals(
  workspaceRoot: string,
  opts: { now?: number } = {},
): Promise<RecoverySignals> {
  const now = opts.now ?? Date.now();
  const orch = orchDir(workspaceRoot);

  const board = await readJson<BoardDoc>(path.join(orch, 'board.json'));
  const staleClaims: StaleClaimSignal[] = [];
  for (const item of board?.in_flight ?? []) {
    if (item.owner_healthy !== false || !item.task_id) { continue; }
    // Resolve `expired` from the claim file's TTL. A missing claim file means
    // there is nothing to steal — skip it.
    const claim = await readJson<{ expires_at?: string }>(
      path.join(commsDir(workspaceRoot), 'claims', `${item.task_id}.json`),
    );
    if (!claim) { continue; }
    const expired = !!claim.expires_at && Date.parse(claim.expires_at) < now;
    staleClaims.push({
      task_id: item.task_id,
      owner: item.claimed_by ?? 'unknown',
      owner_healthy: false,
      expired,
    });
  }

  const reconcile = await readJson<ReconcileDoc>(path.join(orch, 'reconcile-report.json'));
  const driftFindings: DriftFindingSignal[] = (reconcile?.drifts ?? [])
    .filter(d => d && d.task_id)
    .map(d => ({
      type: d.type ?? 'drift',
      task_id: d.task_id as string,
      description: d.description ?? '',
    }));

  return { staleClaims, driftFindings };
}

// ---------------------------------------------------------------------------
// Emit a finding_report (the "report" half of act-then-report)
// ---------------------------------------------------------------------------

function fileTs(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** Write a finding_report message into the shared inbox. Best-effort. */
async function emitFinding(
  workspaceRoot: string,
  action: RecoveryAction,
  now: number,
): Promise<void> {
  const sharedInbox = path.join(commsDir(workspaceRoot), 'inboxes', 'shared');
  const ts = new Date(now);
  const frag = crypto.randomBytes(3).toString('hex');
  const msg = {
    id: `msg-${crypto.randomUUID()}`,
    from: 'supervisor',
    to: 'shared',
    type: 'finding_report',
    timestamp: ts.toISOString(),
    requires_response: false,
    payload: {
      recovery_kind: action.kind,
      reason: action.reason,
      finding: action.finding,
    },
  };
  await fsp.mkdir(sharedInbox, { recursive: true });
  await fsp.writeFile(
    path.join(sharedInbox, `${fileTs(ts)}-finding_report-supervisor-${frag}.json`),
    JSON.stringify(msg, null, 2) + '\n',
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Run the HEAL phase
// ---------------------------------------------------------------------------

export interface HealResult {
  /** The recovery actions the supervisor resolved this cycle. */
  actions: RecoveryAction[];
  /** Task ids whose stale claim was actually deleted (steal_claim, act mode). */
  stolen: string[];
  /** How many finding_report messages were emitted. */
  findingsEmitted: number;
  /** One-line summary for the journal. */
  summary: string;
}

/**
 * Run one HEAL cycle: gather → resolve → (act) → report.
 *
 * In `act` mode (default) a `steal_claim` deletes the stale claim file so the
 * task re-opens; every action — in either mode — emits a finding_report. In
 * `propose` mode nothing is mutated (actions arrive wrapped as proposals); only
 * findings are written.
 */
export async function runHealPhase(
  workspaceRoot: string,
  opts: { mode?: 'act' | 'propose'; now?: number; maxRetries?: number } = {},
): Promise<HealResult> {
  const now = opts.now ?? Date.now();
  const mode = opts.mode ?? 'act';
  const signals = await gatherRecoverySignals(workspaceRoot, { now });
  const actions = resolveRecovery(signals, { mode, ...(opts.maxRetries ? { maxRetries: opts.maxRetries } : {}) });

  const stolen: string[] = [];
  let findingsEmitted = 0;

  for (const action of actions) {
    // RAIL: report every action (act-then-report).
    try { await emitFinding(workspaceRoot, action, now); findingsEmitted++; } catch { /* best-effort */ }

    // The one sanctioned mutation: delete a stale+expired claim so it re-opens.
    if (mode === 'act' && action.kind === 'steal_claim') {
      const claimFile = path.join(commsDir(workspaceRoot), 'claims', `${action.task_id}.json`);
      try {
        await fsp.unlink(claimFile);
        stolen.push(action.task_id);
      } catch { /* already gone — nothing to steal */ }
    }
  }

  return { actions, stolen, findingsEmitted, summary: summarizeRecovery(actions) };
}
