/**
 * workforceIngest.ts — feed real fleet signals into earned résumés (HRW-1).
 *
 * The talent pool (HR-1) only means something if its résumés are built from
 * what actually happened. This module scans the shared comms inbox for the
 * clear, directly-attributable signals — `task_complete` (who finished work)
 * and `scope_violation` (who went off-lease) — and folds each into the right
 * worker's résumé via {@link recordOutcome}. It is idempotent: a per-workspace
 * watermark records processed message ids so re-running every loop tick never
 * double-counts.
 *
 * Consensus review outcomes (review_passed/failed) need reliable task→author
 * attribution and are deliberately left for a follow-up rather than guessed.
 *
 * Pure mapper (messageToOutcome) + fs scan/watermark; `now` injectable; no vscode.
 *
 * See docs/ideas/FLEET-FEDERATION-SELF-HEALING.md §9.4.
 */

import * as fs from 'fs';
import * as path from 'path';
import { recordOutcome, type Outcome } from './workforce';

const fsp = fs.promises;

/** A minimal view of a comms message this module reasons over. */
export interface IngestMessage {
  id?: string;
  from?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

/** The worker + outcome a message maps to, or null when it carries no signal. */
export interface MappedOutcome {
  agentId: string;
  outcome: Outcome;
}

/**
 * Pure: map a comms message to a résumé outcome, or null. `orchestrator-loop`,
 * `supervisor`, `autobuild`, and `shared` are infrastructure senders, never
 * workers — their messages are ignored for attribution.
 */
export function messageToOutcome(msg: IngestMessage, project?: string): MappedOutcome | null {
  const INFRA = new Set(['orchestrator-loop', 'supervisor', 'autobuild', 'shared', '']);
  const from = (msg.from ?? '').trim();
  if (msg.type === 'task_complete') {
    if (INFRA.has(from)) { return null; }
    return { agentId: from, outcome: { kind: 'task_complete', ...(project ? { project } : {}) } };
  }
  if (msg.type === 'scope_violation') {
    // The offending agent is named in the payload when present, else the sender.
    const offender = typeof msg.payload?.agent === 'string' ? (msg.payload.agent as string).trim() : from;
    if (INFRA.has(offender)) { return null; }
    return { agentId: offender, outcome: { kind: 'scope_violation' } };
  }
  return null;
}

interface IngestState { processed: Record<string, true>; last_run?: string }

function ingestStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'workforce-ingest.json');
}

async function readState(file: string): Promise<IngestState> {
  try {
    const o = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, '')) as IngestState;
    return o && typeof o.processed === 'object' ? o : { processed: {} };
  } catch {
    return { processed: {} };
  }
}

export interface IngestResult {
  ingested: number;
  byAgent: Record<string, number>;
  scanned: number;
}

/**
 * Scan the shared inbox for new task_complete / scope_violation messages and
 * fold each into the relevant worker's résumé. Idempotent via a per-workspace
 * watermark (message id, else filename). `homeDir` targets the worker store;
 * `project` defaults to the workspace folder name.
 */
export async function ingestWorkforceSignals(
  workspaceRoot: string,
  opts: { homeDir?: string; project?: string; now?: number } = {},
): Promise<IngestResult> {
  const project = opts.project ?? path.basename(workspaceRoot);
  const sharedDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'inboxes', 'shared');
  const stateFile = ingestStatePath(workspaceRoot);
  const state = await readState(stateFile);

  let files: string[];
  try { files = await fsp.readdir(sharedDir); } catch { return { ingested: 0, byAgent: {}, scanned: 0 }; }

  const byAgent: Record<string, number> = {};
  let ingested = 0;
  let scanned = 0;
  let dirty = false;

  for (const f of files) {
    if (!f.endsWith('.json')) { continue; }
    // Cheap pre-filter: only task_complete / scope_violation filenames carry signal.
    if (!f.includes('task_complete') && !f.includes('scope_violation')) { continue; }
    scanned++;
    let msg: IngestMessage;
    try {
      msg = JSON.parse((await fsp.readFile(path.join(sharedDir, f), 'utf8')).replace(/^﻿/, '')) as IngestMessage;
    } catch { continue; }

    const key = msg.id ?? f;
    if (state.processed[key]) { continue; }            // already folded — idempotent
    const mapped = messageToOutcome(msg, project);
    state.processed[key] = true; dirty = true;          // mark seen even if no outcome (don't re-read)
    if (!mapped) { continue; }

    await recordOutcome(mapped.agentId, mapped.outcome, { homeDir: opts.homeDir, now: opts.now });
    ingested++;
    byAgent[mapped.agentId] = (byAgent[mapped.agentId] ?? 0) + 1;
  }

  if (dirty) {
    // Cap the processed set so the watermark file can't grow without bound.
    const keys = Object.keys(state.processed);
    if (keys.length > 2000) {
      const trimmed: Record<string, true> = {};
      for (const k of keys.slice(-1500)) { trimmed[k] = true; }
      state.processed = trimmed;
    }
    state.last_run = new Date(opts.now ?? Date.now()).toISOString();
    try {
      await fsp.mkdir(path.dirname(stateFile), { recursive: true });
      await fsp.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch { /* best-effort watermark */ }
  }

  return { ingested, byAgent, scanned };
}
