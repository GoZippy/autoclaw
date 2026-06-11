/**
 * governance.ts — AF-5: org-level controls — an approval gate + an audit log.
 *
 * Two primitives:
 *  1. {@link gateDispatch} — decides whether an action by an agent of a given
 *     type needs human/governance approval before it takes effect. Human-in-loop
 *     types (assistant, governance) and any flow explicitly marked governance-
 *     controlled must be approved first.
 *  2. an append-only **audit log** every dispatch writes a row to, so an org can
 *     see who did what, when, and under which control. `vscode`-free; the file
 *     IO is small + append-only.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentType } from './agentTypes';
import { requiresHumanApproval } from './agentTypes';

const fsp = fs.promises;

export type ControlLevel = 'individual' | 'team' | 'security' | 'governance';

export interface GateDecision {
  allowed: boolean;
  /** When false, the action must be approved first. */
  needsApproval: boolean;
  reason: string;
}

/**
 * Decide whether an action may proceed without prior approval.
 *  - `governance` control level always needs approval (a governance actor signs off).
 *  - human-in-loop agent types (assistant, governance) need approval.
 *  - everything else proceeds (subject to the normal review gates downstream).
 */
export function gateDispatch(agentType: AgentType, controlLevel: ControlLevel = 'individual'): GateDecision {
  if (controlLevel === 'governance') {
    return { allowed: false, needsApproval: true, reason: 'governance control level requires sign-off before dispatch' };
  }
  if (requiresHumanApproval(agentType)) {
    return { allowed: false, needsApproval: true, reason: `agent type '${agentType}' is human-in-the-loop` };
  }
  return { allowed: true, needsApproval: false, reason: 'no approval gate at this control level' };
}

// ---------------------------------------------------------------------------
// Audit log (append-only JSONL under .autoclaw/orchestrator/audit/<date>.jsonl)
// ---------------------------------------------------------------------------

export interface AuditEntry {
  ts: string;
  actor: string;            // agent id
  agent_type: AgentType;
  action: string;           // e.g. 'dispatch', 'review', 'approve'
  task_id?: string;
  control_level?: ControlLevel;
  allowed: boolean;
  detail?: string;
}

function auditDir(autoclawDir: string): string {
  return path.join(autoclawDir, 'orchestrator', 'audit');
}

function auditFileFor(autoclawDir: string, date: Date): string {
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(auditDir(autoclawDir), `${day}.jsonl`);
}

/** Append one audit row. Best-effort timestamp defaults to now. */
export async function appendAuditLog(
  autoclawDir: string,
  entry: Omit<AuditEntry, 'ts'> & { ts?: string },
): Promise<void> {
  const now = entry.ts ? new Date(entry.ts) : new Date();
  const row: AuditEntry = { ...entry, ts: entry.ts ?? now.toISOString() };
  const file = auditFileFor(autoclawDir, now);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, JSON.stringify(row) + '\n', 'utf8');
}

/** Read all audit rows for a given day (default today). Tolerant of a missing file. */
export async function readAuditLog(autoclawDir: string, date: Date = new Date()): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(auditFileFor(autoclawDir, date), 'utf8');
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) { continue; }
    try { out.push(JSON.parse(t) as AuditEntry); } catch { /* skip malformed */ }
  }
  return out;
}
