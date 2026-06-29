/**
 * handoff.ts — Structured handoff note written by an agent on task completion.
 *
 * Problem: task_complete broadcasts are loose JSON. The agent that picks up
 * the next task has no machine-readable context about which files changed,
 * which are clean, what tests ran, or what risks exist. Four agents racing
 * on the same UI file is the predictable result.
 *
 * Solution: every task_complete MUST reference a handoff note sidecar at
 * comms/handoffs/<task-id>-<session-frag>.json. The note is the handover
 * brief — files changed, files NOT touched, integration seams, test results,
 * risks, and a suggested next agent or task.
 *
 * The orchestrator indexes these notes so a new claimant can read the brief
 * before editing a single file.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface HandoffTestResult {
  /** Test suite name or script (e.g. "npm run test:unit", "mocha src/test/comms"). */
  suite: string;
  passed: number;
  failed: number;
  skipped?: number;
  /** The exact command run (optional, for reproducibility). */
  command?: string;
}

/**
 * Structured handoff note produced by an agent when it completes a task.
 * Written as a sidecar to comms/handoffs/ and referenced from task_complete.
 */
export interface HandoffNote {
  task_id: string;
  agent_id: string;
  session_id: string;
  timestamp: string;

  /**
   * Workspace-relative paths of every file modified or created.
   * Must be exhaustive — the next claimant uses this to detect overlap.
   */
  files_changed: string[];

  /**
   * In-scope paths deliberately NOT touched.
   * Tells the next agent these are clean and safe to claim without checking
   * for conflicts with the just-completed work.
   */
  files_not_touched: string[];

  /**
   * Integration seams the next agent must be aware of.
   * E.g. "Added handoff_note field to task_complete payload in comms.ts — callers must include it."
   */
  integration_points: string[];

  /** All test runs attempted during the task. Report honest results. */
  tests_run: HandoffTestResult[];

  /**
   * Known risks, incomplete items, or caveats about the completed work.
   * Empty array = agent is confident the work is clean.
   */
  risks: string[];

  /**
   * The agent_id best suited to pick up the next task, if the completing
   * agent has a specific recommendation. Omit when any peer is fine.
   */
  next_agent_requested?: string;

  /** The task_id that should logically follow, if known from the sprint plan. */
  next_task_suggested?: string;

  /** One-paragraph human-readable summary of what was accomplished. */
  summary: string;

  /** Git branch the work was committed/pushed to. */
  branch?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HANDOFFS_REL = '.autoclaw/orchestrator/comms/handoffs';

export function handoffsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, HANDOFFS_REL);
}

/**
 * Sanitize a task ID so it is safe as a Windows/POSIX filename component.
 * Replaces any character that is not alphanumeric, dot, dash, or underscore
 * with an underscore. Path traversal sequences are collapsed to literals.
 */
export function sanitizeTaskId(taskId: string): string {
  // Replace illegal filename chars, then expand `..` to `__` so path-traversal
  // sequences can never survive into a filename (each dot replaced individually).
  return taskId
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.\./g, '__');
}

export function handoffFilename(taskId: string, sessionFrag: string): string {
  return `${sanitizeTaskId(taskId)}-${sessionFrag}.json`;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface WriteHandoffResult {
  /** Absolute path to the written sidecar file. */
  sidecarPath: string;
  /** Workspace-relative path, suitable for inclusion in task_complete payload. */
  handoffRef: string;
}

/**
 * Write a handoff note sidecar and return the reference path.
 * Call this during REPORT, before broadcasting task_complete, and include
 * `handoffRef` in the task_complete payload as `payload.handoff_note`.
 */
export async function writeHandoffNote(
  workspaceRoot: string,
  note: HandoffNote
): Promise<WriteHandoffResult> {
  const dir = handoffsDir(workspaceRoot);
  await fs.promises.mkdir(dir, { recursive: true });

  const sessionFrag = note.session_id.slice(0, 8);
  const filename = handoffFilename(note.task_id, sessionFrag);
  const sidecarPath = path.join(dir, filename);
  const handoffRef = path.join(HANDOFFS_REL, filename).replace(/\\/g, '/');

  await fs.promises.writeFile(sidecarPath, JSON.stringify(note, null, 2), 'utf8');
  return { sidecarPath, handoffRef };
}

/**
 * Read the most recent handoff note for a task, if any exists.
 * Returns null when no sidecar is found (task never had a handoff note).
 *
 * "Most recent" is determined by the `timestamp` field inside each sidecar —
 * NOT by lexicographic filename order, which would break if session IDs are
 * not monotonically increasing (they aren't guaranteed to be).
 */
export async function readHandoffNote(
  workspaceRoot: string,
  taskId: string
): Promise<HandoffNote | null> {
  const dir = handoffsDir(workspaceRoot);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return null;
  }

  // Use the sanitized form for prefix matching (consistent with writeHandoffNote).
  const prefix = `${sanitizeTaskId(taskId)}-`;
  const matches = entries.filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  if (matches.length === 0) { return null; }

  // Read all candidates and pick the one with the latest timestamp field.
  let latest: HandoffNote | null = null;
  let latestMs = -Infinity;
  for (const filename of matches) {
    try {
      const raw = await fs.promises.readFile(path.join(dir, filename), 'utf8');
      const note = JSON.parse(raw) as HandoffNote;
      const ms = note.timestamp ? Date.parse(note.timestamp) : NaN;
      if (Number.isFinite(ms) && ms > latestMs) {
        latestMs = ms;
        latest = note;
      }
    } catch { /* malformed — skip */ }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Template builder (for agent prompts / bootstrap scripts)
// ---------------------------------------------------------------------------

/**
 * Return a JSON template string that an agent can fill in and write.
 * Injected by handoff_factory.ts into the nested-loop prompt so agents
 * know the exact schema expected of them on task completion.
 */
export function handoffNoteTemplate(
  taskId: string,
  agentId: string,
  sessionId: string
): string {
  const template: HandoffNote = {
    task_id: taskId,
    agent_id: agentId,
    session_id: sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    files_changed: ['<workspace-relative path>'],
    files_not_touched: ['<in-scope path you deliberately left clean>'],
    integration_points: ['<seam the next agent must know about>'],
    tests_run: [
      { suite: 'npm run test:unit', passed: 0, failed: 0, command: 'npm run test:unit' },
    ],
    risks: ['<risk or known incomplete item, or omit this element>'],
    next_agent_requested: '<agent_id or omit>',
    next_task_suggested: '<task_id or omit>',
    summary: '<one paragraph summary of what was accomplished>',
    branch: '<git branch>',
  };
  return JSON.stringify(template, null, 2);
}
