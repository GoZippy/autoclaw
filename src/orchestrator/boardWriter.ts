/**
 * boardWriter.ts — Gather orchestrator state from disk, run {@link buildBoard},
 * and write `board.md` + `board.json` so humans (panel, editor) and new
 * agents (board.json on session join) see the same agendaboard.
 *
 * Side-effect:
 *   - `.autoclaw/orchestrator/board.json`  (machine-readable)
 *   - `.autoclaw/orchestrator/board.md`    (human-readable)
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  buildBoard,
  renderBoardMarkdown,
  type BoardClaim,
  type BoardConsensus,
  type BoardHeartbeat,
  type BoardModel,
  type BoardTask,
} from './board';

const fsp = fs.promises;

/* -------------------------------------------------------------------------- */
/*  Path helpers                                                              */
/* -------------------------------------------------------------------------- */

export function orchestratorDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'orchestrator');
}

function commsDir(workspaceRoot: string): string {
  return path.join(orchestratorDir(workspaceRoot), 'comms');
}

function statePath(workspaceRoot: string): string {
  return path.join(orchestratorDir(workspaceRoot), 'state.json');
}

function boardJsonPath(workspaceRoot: string): string {
  return path.join(orchestratorDir(workspaceRoot), 'board.json');
}

function boardMdPath(workspaceRoot: string): string {
  return path.join(orchestratorDir(workspaceRoot), 'board.md');
}

/* -------------------------------------------------------------------------- */
/*  Generic readers                                                           */
/* -------------------------------------------------------------------------- */

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as T;
  } catch { return null; }
}

async function listDir(dir: string): Promise<string[]> {
  try { return await fsp.readdir(dir); } catch { return []; }
}

async function readJsonDir<T>(dir: string): Promise<T[]> {
  const out: T[] = [];
  for (const name of await listDir(dir)) {
    if (!name.endsWith('.json')) { continue; }
    const v = await readJson<T>(path.join(dir, name));
    if (v !== null) { out.push(v); }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Tasks                                                                     */
/* -------------------------------------------------------------------------- */

interface RawState {
  agents?: Record<string, {
    status?: string;
    sprint?: number | null;
    tasks?: string[];
  }>;
  tasks?: Array<{
    id: string;
    title?: string;
    sprint?: number;
    priority?: 'high' | 'medium' | 'low';
    status?: BoardTask['status'];
    depends_on?: string[];
    files?: string[];
  }>;
}

/**
 * Derive the BoardTask list from state.json plus discovered task ids in
 * claims / consensus. Authoritative metadata (title/deps/priority) comes from
 * an optional `state.tasks` array; falls back to inferred status from agent
 * task lists otherwise.
 */
async function readTasks(
  workspaceRoot: string,
  claimedTaskIds: Set<string>,
  consensusTaskIds: Set<string>,
): Promise<BoardTask[]> {
  const state = await readJson<RawState>(statePath(workspaceRoot));
  const out = new Map<string, BoardTask>();

  // 1. Pull explicit task list if present.
  if (Array.isArray(state?.tasks)) {
    for (const t of state!.tasks!) {
      if (typeof t?.id !== 'string') { continue; }
      out.set(t.id, {
        id: t.id,
        title: t.title,
        sprint: t.sprint,
        priority: t.priority,
        status: t.status,
        depends_on: t.depends_on ?? [],
        files: t.files ?? [],
      });
    }
  }

  // 2. Mention each task referenced in any agent's task list. Status inferred:
  //    consensus → in_review, claimed → in_progress, otherwise open.
  const agentMap = state?.agents ?? {};
  for (const a of Object.values(agentMap)) {
    if (!Array.isArray(a?.tasks)) { continue; }
    for (const taskId of a.tasks!) {
      if (typeof taskId !== 'string' || taskId.length === 0) { continue; }
      if (out.has(taskId)) { continue; }
      out.set(taskId, {
        id: taskId,
        depends_on: [],
        files: [],
      });
    }
  }

  // 3. Surface any task id that appears in claims or consensus but isn't in state.
  for (const id of claimedTaskIds) {
    if (!out.has(id)) { out.set(id, { id, depends_on: [], files: [] }); }
  }
  for (const id of consensusTaskIds) {
    if (!out.has(id)) { out.set(id, { id, depends_on: [], files: [] }); }
  }

  // 4. Infer status when not set.
  for (const t of out.values()) {
    if (t.status) { continue; }
    if (consensusTaskIds.has(t.id)) { t.status = 'in_review'; continue; }
    if (claimedTaskIds.has(t.id)) { t.status = 'in_progress'; continue; }
    t.status = 'open';
  }

  return Array.from(out.values());
}

/* -------------------------------------------------------------------------- */
/*  Claims                                                                    */
/* -------------------------------------------------------------------------- */

interface ClaimFileShape {
  task_id?: string;
  task_ids?: string[];
  claimed_by?: string;
  agent?: string;
  claimed_at?: string;
  ttl_ms?: number;
}

/** Read both claim conventions (comms/claims/<id>.json and comms/agents/<agent>/claim-*.json). */
async function readClaims(workspaceRoot: string): Promise<BoardClaim[]> {
  const out: BoardClaim[] = [];
  const seen = new Set<string>();

  // Format A: comms/claims/<task-id>.json
  const flatClaims = await readJsonDir<ClaimFileShape>(path.join(commsDir(workspaceRoot), 'claims'));
  for (const c of flatClaims) {
    const owner = c.claimed_by ?? c.agent;
    if (!owner) { continue; }
    const ids = c.task_ids ?? (c.task_id ? [c.task_id] : []);
    for (const id of ids) {
      const key = `${id}|${owner}`;
      if (seen.has(key)) { continue; }
      seen.add(key);
      out.push({
        task_id: id,
        claimed_by: owner,
        claimed_at: c.claimed_at ?? new Date(0).toISOString(),
        ttl_ms: c.ttl_ms,
      });
    }
  }

  // Format B: comms/agents/<agent>/claim-<task>-<ts>.json
  const agentsDir = path.join(commsDir(workspaceRoot), 'agents');
  for (const agentEntry of await listDir(agentsDir)) {
    if (agentEntry.startsWith('_')) { continue; }
    const agentDir = path.join(agentsDir, agentEntry);
    let stat: fs.Stats;
    try { stat = await fsp.stat(agentDir); } catch { continue; }
    if (!stat.isDirectory()) { continue; }
    for (const fn of await listDir(agentDir)) {
      if (!fn.startsWith('claim-') || !fn.endsWith('.json')) { continue; }
      const c = await readJson<ClaimFileShape>(path.join(agentDir, fn));
      if (!c) { continue; }
      const owner = c.claimed_by ?? c.agent ?? agentEntry;
      const ids = c.task_ids ?? (c.task_id ? [c.task_id] : []);
      for (const id of ids) {
        const key = `${id}|${owner}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        out.push({
          task_id: id,
          claimed_by: owner,
          claimed_at: c.claimed_at ?? new Date(stat.mtimeMs).toISOString(),
          ttl_ms: c.ttl_ms,
        });
      }
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Consensus + heartbeats                                                    */
/* -------------------------------------------------------------------------- */

async function readConsensus(workspaceRoot: string): Promise<BoardConsensus[]> {
  const raw = await readJsonDir<{
    task_id?: string;
    author?: string;
    opened_at?: string;
    reviewers?: string[];
    rule?: 'majority' | 'unanimous';
    votes?: Array<{ voter: string; vote: 'approve' | 'request_changes' | 'reject' }>;
  }>(path.join(commsDir(workspaceRoot), 'consensus', 'active'));
  const out: BoardConsensus[] = [];
  for (const c of raw) {
    if (typeof c.task_id !== 'string' || typeof c.author !== 'string') { continue; }
    out.push({
      task_id: c.task_id,
      author: c.author,
      opened_at: c.opened_at ?? new Date(0).toISOString(),
      reviewers: Array.isArray(c.reviewers) ? c.reviewers : [],
      votes: Array.isArray(c.votes) ? c.votes : [],
      rule: c.rule === 'unanimous' ? 'unanimous' : 'majority',
    });
  }
  return out;
}

async function readHeartbeats(workspaceRoot: string): Promise<BoardHeartbeat[]> {
  const dir = path.join(commsDir(workspaceRoot), 'heartbeats');
  const out: BoardHeartbeat[] = [];
  for (const name of await listDir(dir)) {
    if (!name.endsWith('.json')) { continue; }
    const hb = await readJson<{ agent_id?: string; timestamp?: string; status?: string }>(
      path.join(dir, name),
    );
    if (!hb?.agent_id || !hb.timestamp) { continue; }
    out.push({ agent_id: hb.agent_id, timestamp: hb.timestamp, status: hb.status });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Top-level                                                                 */
/* -------------------------------------------------------------------------- */

/** Options for {@link writeBoard}. */
export interface WriteBoardOptions {
  workspaceRoot: string;
  /** Identifier of the writer — surfaced in `board.json.generator`. */
  generator?: string;
  /** Clock for deterministic tests. */
  now?: number;
}

/** What {@link writeBoard} returns to its caller. */
export interface WriteBoardResult {
  board: BoardModel;
  jsonPath: string;
  mdPath: string;
}

/**
 * Gather inputs, build the board, and write both `board.json` and `board.md`.
 *
 * Safe to call from a polling loop — every call is a fresh snapshot.
 */
export async function writeBoard(opts: WriteBoardOptions): Promise<WriteBoardResult> {
  const { workspaceRoot } = opts;

  const [claims, consensus, heartbeats] = await Promise.all([
    readClaims(workspaceRoot),
    readConsensus(workspaceRoot),
    readHeartbeats(workspaceRoot),
  ]);

  const claimedTaskIds = new Set(claims.map(c => c.task_id));
  const consensusTaskIds = new Set(consensus.map(c => c.task_id));
  const tasks = await readTasks(workspaceRoot, claimedTaskIds, consensusTaskIds);

  const board = buildBoard({
    tasks,
    claims,
    consensus,
    heartbeats,
    generator: opts.generator,
    now: opts.now,
  });

  await fsp.mkdir(orchestratorDir(workspaceRoot), { recursive: true });
  const jsonPath = boardJsonPath(workspaceRoot);
  const mdPath = boardMdPath(workspaceRoot);
  await fsp.writeFile(jsonPath, JSON.stringify(board, null, 2), 'utf8');
  await fsp.writeFile(mdPath, renderBoardMarkdown(board), 'utf8');

  return { board, jsonPath, mdPath };
}
