/**
 * reconcile.ts — Drift detection between tasks.md / sprint YAML / comms-log.
 *
 * Pure function with no `vscode` import so it can be unit-tested in isolation
 * (mirrors the manifest-probe.ts pattern). Reads three sources and reports
 * mismatches; never auto-fixes.
 *
 * Per docs/COORDINATION_IMPROVEMENTS.md §2.3.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const fsPromises = fs.promises;

export type ReconcileSource = 'tasks_md' | 'sprint_yaml' | 'comms_log';

export interface ReconcileMismatch {
  source: ReconcileSource;
  task_id: string;
  expected: string;
  actual: string;
  hint: string;
}

export interface ReconcileReport {
  timestamp: string;
  mismatches: ReconcileMismatch[];
}

interface TaskStatus {
  done: boolean;
  raw: string;
}

/** Internal: read all .kiro/specs/<name>/tasks.md files and return per-task-id status. */
async function readTasksMdStatuses(workspaceRoot: string): Promise<Map<string, TaskStatus>> {
  const out = new Map<string, TaskStatus>();
  const specsDir = path.join(workspaceRoot, '.kiro', 'specs');
  let specDirs: string[];
  try {
    specDirs = await fsPromises.readdir(specsDir);
  } catch { return out; }

  for (const spec of specDirs) {
    const tasksPath = path.join(specsDir, spec, 'tasks.md');
    let content: string;
    try {
      content = await fsPromises.readFile(tasksPath, 'utf8');
    } catch { continue; }
    // Match "- [ ] <task-id>" or "- [x] <task-id>"; the task_id is the first
    // non-whitespace token after the checkbox. Tolerant of trailing markdown.
    const lineRe = /^\s*-\s*\[(\s|x|X)\]\s*([\w.-]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(content)) !== null) {
      const done = m[1].toLowerCase() === 'x';
      const taskId = m[2];
      out.set(taskId, { done, raw: done ? 'done' : 'pending' });
    }
  }
  return out;
}

/** Internal: read all sprint-N.yaml files and return per-task-id status. */
async function readSprintYamlStatuses(workspaceRoot: string): Promise<Map<string, TaskStatus>> {
  const out = new Map<string, TaskStatus>();
  const sprintsDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'sprints');
  let files: string[];
  try {
    files = (await fsPromises.readdir(sprintsDir)).filter(f => /^sprint-\d+\.yaml$/.test(f));
  } catch { return out; }

  for (const f of files) {
    let content: string;
    try {
      content = await fsPromises.readFile(path.join(sprintsDir, f), 'utf8');
    } catch { continue; }
    try {
      yaml.load(content, { filename: f });
    } catch { continue; }
    const sprintStatusMatch = content.match(/^status:\s*([\w-]+)\s*$/m);
    const sprintStatus = sprintStatusMatch ? sprintStatusMatch[1] : 'pending';
    // Walk task blocks: `id: <X>` then optionally a nearby `status:`.
    const taskRe = /(^|\n)\s*-\s*id:\s*([\w.-]+)([\s\S]*?)(?=(\n\s*-\s*id:|\n\s*assignments:|\n\s*status:\s*[\w-]+\s*$|$))/g;
    let m: RegExpExecArray | null;
    while ((m = taskRe.exec(content)) !== null) {
      const taskId = m[2];
      const block = m[3];
      const inner = block.match(/status:\s*([\w-]+)/);
      const taskStatus = inner ? inner[1] : sprintStatus;
      const done = taskStatus === 'merged' || taskStatus === 'done' || taskStatus === 'approved';
      out.set(taskId, { done, raw: taskStatus });
    }
  }
  return out;
}

/** Internal: read last 1000 lines of comms-log.jsonl and pull task_complete entries. */
async function readCommsLogCompletions(workspaceRoot: string): Promise<Set<string>> {
  const completed = new Set<string>();
  const logPath = path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'comms-log.jsonl');
  let content: string;
  try {
    content = await fsPromises.readFile(logPath, 'utf8');
  } catch { return completed; }

  const lines = content.trim().split('\n');
  const tail = lines.slice(-1000);
  for (const line of tail) {
    try {
      const entry = JSON.parse(line.replace(/^﻿/, '')) as { type?: string; task_id?: string };
      if (entry.type === 'task_complete' && typeof entry.task_id === 'string' && entry.task_id.length > 0) {
        completed.add(entry.task_id);
      }
    } catch { /* skip malformed */ }
  }
  return completed;
}

/**
 * Cross-reference tasks.md / sprint-N.yaml / comms-log.jsonl and return any
 * drift. Empty workspace returns an empty mismatches list. Never throws.
 */
export async function runReconcile(workspaceRoot: string): Promise<ReconcileReport> {
  const timestamp = new Date().toISOString();
  const mismatches: ReconcileMismatch[] = [];
  if (!workspaceRoot) { return { timestamp, mismatches }; }

  const tasksMd = await readTasksMdStatuses(workspaceRoot);
  const sprintYaml = await readSprintYamlStatuses(workspaceRoot);
  const commsCompleted = await readCommsLogCompletions(workspaceRoot);

  // Collect the union of task IDs we know about.
  const allTaskIds = new Set<string>([
    ...tasksMd.keys(),
    ...sprintYaml.keys(),
    ...commsCompleted,
  ]);

  for (const taskId of allTaskIds) {
    const md = tasksMd.get(taskId);
    const yaml = sprintYaml.get(taskId);
    const completedInLog = commsCompleted.has(taskId);

    // Rule 1: tasks.md says done, sprint yaml says not done → mismatch.
    if (md && md.done && yaml && !yaml.done) {
      mismatches.push({
        source: 'sprint_yaml',
        task_id: taskId,
        expected: 'done (per tasks.md)',
        actual: yaml.raw,
        hint: 'Sprint YAML lags behind tasks.md; refresh sprint status.',
      });
      continue;
    }

    // Rule 2: tasks.md says not done, sprint yaml says done → mismatch.
    if (md && !md.done && yaml && yaml.done) {
      mismatches.push({
        source: 'tasks_md',
        task_id: taskId,
        expected: 'done (per sprint yaml)',
        actual: 'pending',
        hint: 'tasks.md lags behind sprint YAML; tick the checkbox.',
      });
      continue;
    }

    // Rule 3: comms-log task_complete present but sprint yaml says pending.
    if (completedInLog && yaml && !yaml.done) {
      mismatches.push({
        source: 'sprint_yaml',
        task_id: taskId,
        expected: 'done (per comms-log task_complete)',
        actual: yaml.raw,
        hint: 'Sprint YAML did not absorb the task_complete broadcast.',
      });
      continue;
    }

    // Rule 4: comms-log task_complete present but tasks.md still unticked.
    if (completedInLog && md && !md.done) {
      mismatches.push({
        source: 'tasks_md',
        task_id: taskId,
        expected: 'done (per comms-log task_complete)',
        actual: 'pending',
        hint: 'tasks.md did not absorb the task_complete broadcast.',
      });
      continue;
    }
  }

  return { timestamp, mismatches };
}
