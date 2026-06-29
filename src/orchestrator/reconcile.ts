/**
 * reconcile.ts — Orchestrator-level reconciliation sweep.
 *
 * Every 5 minutes (configurable), diffs three sources of truth:
 *   1. tasks.md files  — manual/kiro task tracking
 *   2. state.json      — orchestrator message ledger + sprint statuses
 *   3. sprint-N.yaml   — canonical task assignments / sprint spec
 *
 * Detected drifts are written to:
 *   .autoclaw/orchestrator/reconcile-report.json
 *
 * Each drift also triggers a `system` message broadcast to the shared inbox
 * so all agents are aware. This module NEVER auto-fixes drift — it only
 * surfaces it.
 *
 * A6 — Sprint-1 / WA-2 (Watchdog & Reconciliation).
 *
 * NOTE: The existing src/reconcile.ts covers tasks.md ↔ sprint-N.yaml ↔
 * comms-log drift (the Kiro-spec variant). This module adds the orchestrator
 * state.json dimension and periodic scheduling, and writes reconcile-report.json
 * + shared-inbox notifications as specified by A6.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { runDoctorChecks, type DoctorFinding } from './doctor';
import { materializeOpsTasks } from './opsTasks';
import { generateMessageId, sendMessage, type Message, type MessageType } from '../comms';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Category of drift detected. */
export type DriftType =
  | 'task_in_yaml_not_in_state'     // sprint YAML has task not tracked in state.json
  | 'task_in_state_not_in_yaml'     // state.json tracks task not in any sprint YAML
  | 'task_status_mismatch'          // task status differs between state.json and sprint YAML
  | 'task_complete_in_comms_not_yaml' // comms-log shows task_complete but YAML still pending
  | 'task_complete_in_comms_not_state' // comms-log shows task_complete but state.json not updated
  | 'yaml_parse_error';             // a manifest/registry/sprint YAML file is syntactically invalid

export interface DriftRecord {
  type: DriftType;
  task_id: string;
  description: string;
  /** Source that appears to lag. */
  laggard: 'state_json' | 'sprint_yaml' | 'comms_log';
  /** Absolute path to the file that failed to parse (yaml_parse_error only). */
  file?: string;
}

export interface ReconcileReport {
  generated_at: string;
  sweep_duration_ms: number;
  drifts: DriftRecord[];
  /** Config vs reality findings from the doctor lane (when config is provided). */
  findings: DoctorFinding[];
}

export interface OrchestratorReconcileOptions {
  /** Absolute path to workspace root (contains .autoclaw/). */
  workspaceRoot: string;
  /** Sweep interval in milliseconds. Default 300 000 (5 min). 0 = disabled. */
  intervalMs?: number;
  /**
   * Called after each sweep completes (useful for testing / external hooks).
   */
  onSweepComplete?: (report: ReconcileReport) => void;
  /**
   * Config values for doctor checks. When provided, doctor findings are
   * appended to the reconcile report's `findings` array.
   */
  doctorConfig?: {
    baseBranch?: string;
    gitEnabled?: boolean;
  };
}

// ---------------------------------------------------------------------------
// State.json minimal type
// ---------------------------------------------------------------------------

interface StateJsonTask {
  id: string;
  status: string;
}

interface StateJson {
  tasks?: StateJsonTask[];
  sprint_statuses?: Record<string, string>;
  // message ledger entries are not parsed for task drift
}

// ---------------------------------------------------------------------------
// Sprint YAML minimal parse helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort extract of all task ids from a sprint YAML string.
 * Returns a map of task_id → status (string).
 */
function parseSprintYamlTasks(content: string): Map<string, string> {
  const tasks = new Map<string, string>();

  // Top-level sprint status (used as default when task has no own status field).
  const sprintStatusM = content.match(/^status:\s*([\w-]+)/m);
  const sprintStatus = sprintStatusM ? sprintStatusM[1] : 'pending';

  // Match task blocks: `- id: <X>` followed by optional `status: <Y>`.
  // The regex captures the block between one `- id:` and the next or EOF.
  const taskRe = /(^|\n)\s*-\s*id:\s*([\w.-]+)([\s\S]*?)(?=\n\s*-\s*id:|\n\s*-\s*agent:|\n\s*assignments:|$)/g;
  let m: RegExpExecArray | null;
  while ((m = taskRe.exec(content)) !== null) {
    const taskId = m[2].trim();
    const block = m[3];
    const statusM = block.match(/\bstatus:\s*([\w-]+)/);
    const status = statusM ? statusM[1].trim() : sprintStatus;
    tasks.set(taskId, status);
  }
  return tasks;
}

/** Returns true if a task status string represents a completion state. */
function isTerminalStatus(status: string): boolean {
  return ['merged', 'done', 'approved', 'complete', 'completed'].includes(status.toLowerCase());
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

/** Load state.json; returns null when the file does not exist. */
async function loadStateJson(orchestratorDir: string): Promise<StateJson | null> {
  const p = path.join(orchestratorDir, 'state.json');
  try {
    const raw = await fsPromises.readFile(p, 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as StateJson;
  } catch { return null; }
}

interface SprintYamlResult {
  tasks: Map<string, string>;
  parseErrors: Array<{ file: string; error: string }>;
}

/** Load all sprint-N.yaml files and union their task sets. Validates parseability. */
async function loadSprintYamlTasks(sprintsDir: string): Promise<SprintYamlResult> {
  const result: SprintYamlResult = { tasks: new Map(), parseErrors: [] };
  let files: string[];
  try {
    files = (await fsPromises.readdir(sprintsDir)).filter(f => /^sprint-\d+\.yaml$/.test(f));
  } catch { return result; }

  for (const f of files) {
    const filePath = path.join(sprintsDir, f);
    let content: string;
    try {
      content = await fsPromises.readFile(filePath, 'utf8');
    } catch { continue; }

    try {
      yaml.load(content, { filename: f });
    } catch (err) {
      result.parseErrors.push({ file: filePath, error: (err as Error).message });
      continue;
    }

    try {
      const tasks = parseSprintYamlTasks(content);
      for (const [id, status] of tasks) {
        if (!result.tasks.has(id) || isTerminalStatus(status)) {
          result.tasks.set(id, status);
        }
      }
    } catch { /* skip unreadable */ }
  }
  return result;
}

/** Extract task-complete task_ids from the last 1 000 comms-log lines. */
async function loadCommsLogCompletions(commsDir: string): Promise<Set<string>> {
  const completed = new Set<string>();
  const logPath = path.join(commsDir, 'comms-log.jsonl');
  try {
    const raw = await fsPromises.readFile(logPath, 'utf8');
    const lines = raw.trim().split('\n').slice(-1000);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line.replace(/^﻿/, '')) as { type?: string; task_id?: string };
        if (entry.type === 'task_complete' && typeof entry.task_id === 'string') {
          completed.add(entry.task_id);
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* no log yet */ }
  return completed;
}

// ---------------------------------------------------------------------------
// Core sweep
// ---------------------------------------------------------------------------

/**
 * Run one reconciliation sweep across state.json / sprint YAMLs / comms-log.
 * Returns the drift report. Never throws (errors are captured as drifts).
 */
export async function runOrchestratorReconcile(
  workspaceRoot: string,
  opts: { doctorConfig?: { baseBranch?: string; gitEnabled?: boolean } } = {},
): Promise<ReconcileReport> {
  const startMs = Date.now();
  const drifts: DriftRecord[] = [];
  const findings: DoctorFinding[] = [];

  if (!workspaceRoot) {
    return { generated_at: new Date().toISOString(), sweep_duration_ms: 0, drifts, findings };
  }

  const orchestratorDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator');
  const sprintsDir = path.join(orchestratorDir, 'sprints');
  const commsDir = path.join(orchestratorDir, 'comms');

  const [stateJson, sprintResult, commsCompleted] = await Promise.all([
    loadStateJson(orchestratorDir),
    loadSprintYamlTasks(sprintsDir),
    loadCommsLogCompletions(commsDir),
  ]);

  const yamlTasks = sprintResult.tasks;

  // Doctor lane: config vs reality checks.
  if (opts.doctorConfig) {
    findings.push(...runDoctorChecks(workspaceRoot, {
      configuredBaseBranch: opts.doctorConfig.baseBranch,
      gitEnabled: opts.doctorConfig.gitEnabled,
    }));
  }

  // Surface YAML parse errors as drifts.
  for (const pe of sprintResult.parseErrors) {
    drifts.push({
      type: 'yaml_parse_error',
      task_id: '',
      description: `Invalid YAML in ${path.basename(pe.file)}: ${pe.error}`,
      laggard: 'sprint_yaml',
      file: pe.file,
    });
  }

  // Build state.json task map.
  const stateTasks = new Map<string, string>();
  if (stateJson?.tasks) {
    for (const t of stateJson.tasks) {
      if (t.id) { stateTasks.set(t.id, t.status ?? 'unknown'); }
    }
  }

  // Union of all task IDs seen anywhere.
  const allIds = new Set<string>([
    ...stateTasks.keys(),
    ...yamlTasks.keys(),
    ...commsCompleted,
  ]);

  for (const taskId of allIds) {
    const inState = stateTasks.get(taskId);
    const inYaml = yamlTasks.get(taskId);
    const inComms = commsCompleted.has(taskId);

    // Rule 1: YAML has the task, state.json does not.
    if (inYaml !== undefined && inState === undefined) {
      drifts.push({
        type: 'task_in_yaml_not_in_state',
        task_id: taskId,
        description: `Task "${taskId}" is in sprint YAML (status: ${inYaml}) but absent from state.json.`,
        laggard: 'state_json',
      });
      continue;
    }

    // Rule 2: state.json has the task, no sprint YAML mentions it.
    if (inState !== undefined && inYaml === undefined) {
      drifts.push({
        type: 'task_in_state_not_in_yaml',
        task_id: taskId,
        description: `Task "${taskId}" is in state.json (status: ${inState}) but absent from all sprint YAMLs.`,
        laggard: 'sprint_yaml',
      });
      continue;
    }

    // Rule 3: Status mismatch between state.json and sprint YAML.
    if (inState !== undefined && inYaml !== undefined) {
      const stateDone = isTerminalStatus(inState);
      const yamlDone = isTerminalStatus(inYaml);
      if (stateDone !== yamlDone) {
        drifts.push({
          type: 'task_status_mismatch',
          task_id: taskId,
          description: `Task "${taskId}" status mismatch: state.json="${inState}", sprint YAML="${inYaml}".`,
          laggard: yamlDone ? 'state_json' : 'sprint_yaml',
        });
        continue;
      }
    }

    // Rule 4: comms-log reports task_complete but YAML still pending.
    if (inComms && inYaml !== undefined && !isTerminalStatus(inYaml)) {
      drifts.push({
        type: 'task_complete_in_comms_not_yaml',
        task_id: taskId,
        description: `comms-log has task_complete for "${taskId}" but sprint YAML shows "${inYaml}".`,
        laggard: 'sprint_yaml',
      });
      continue;
    }

    // Rule 5: comms-log reports task_complete but state.json still pending.
    if (inComms && inState !== undefined && !isTerminalStatus(inState)) {
      drifts.push({
        type: 'task_complete_in_comms_not_state',
        task_id: taskId,
        description: `comms-log has task_complete for "${taskId}" but state.json shows "${inState}".`,
        laggard: 'state_json',
      });
    }
  }

  const report: ReconcileReport = {
    generated_at: new Date().toISOString(),
    sweep_duration_ms: Date.now() - startMs,
    drifts,
    findings,
  };

  return report;
}

/**
 * Write the reconcile-report.json to disk.
 */
async function writeReconcileReport(orchestratorDir: string, report: ReconcileReport): Promise<void> {
  const reportPath = path.join(orchestratorDir, 'reconcile-report.json');
  await fsPromises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
}

/**
 * Broadcast each drift as a `system` message to the shared inbox.
 */
async function broadcastDrifts(commsDir: string, drifts: DriftRecord[]): Promise<void> {
  for (const drift of drifts) {
    const msg: Message = {
      id: generateMessageId(),
      from: 'system',
      to: 'shared',
      type: 'system' as MessageType,
      timestamp: new Date().toISOString(),
      task_id: drift.task_id,
      payload: {
        event: 'reconcile_drift',
        drift_type: drift.type,
        laggard: drift.laggard,
        description: drift.description,
      },
      requires_response: false,
    };
    await sendMessage(commsDir, msg).catch(() => { /* non-fatal */ });
  }
}

// ---------------------------------------------------------------------------
// Scheduled runner
// ---------------------------------------------------------------------------

export interface OrchestratorReconciler {
  /** Start the periodic sweep. Runs immediately then on interval. */
  start(): void;
  /** Stop the periodic sweep. */
  stop(): void;
  /** Force one sweep now (used for tests / on-demand triggers). */
  runNow(): Promise<ReconcileReport>;
}

/**
 * Create a reconciler that sweeps every `intervalMs` milliseconds.
 * Set intervalMs to 0 to disable automatic scheduling (manual `runNow()` only).
 */
export function createOrchestratorReconciler(opts: OrchestratorReconcileOptions): OrchestratorReconciler {
  const {
    workspaceRoot,
    intervalMs = 5 * 60 * 1000,
    onSweepComplete,
    doctorConfig,
  } = opts;

  const orchestratorDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator');
  const commsDir = path.join(orchestratorDir, 'comms');

  let _timer: ReturnType<typeof setInterval> | null = null;

  async function runNow(): Promise<ReconcileReport> {
    const report = await runOrchestratorReconcile(workspaceRoot, {
      doctorConfig: opts.doctorConfig,
    });

    // Persist report regardless of drift count.
    await writeReconcileReport(orchestratorDir, report).catch(() => { /* non-fatal */ });

    // Materialize ops tasks from drifts + findings so they become claimable.
    if (report.drifts.length > 0 || report.findings.length > 0) {
      await materializeOpsTasks(orchestratorDir, report.drifts, report.findings).catch(() => { /* non-fatal */ });
    }

    // Broadcast drifts to shared inbox.
    if (report.drifts.length > 0) {
      await broadcastDrifts(commsDir, report.drifts).catch(() => { /* non-fatal */ });
    }

    if (onSweepComplete) {
      try { onSweepComplete(report); } catch { /* non-fatal */ }
    }
    return report;
  }

  function start(): void {
    if (_timer !== null) { return; } // already running

    // Immediate first run.
    runNow().catch(() => { /* non-fatal */ });

    if (intervalMs > 0) {
      _timer = setInterval(() => {
        runNow().catch(() => { /* non-fatal */ });
      }, intervalMs);
    }
  }

  function stop(): void {
    if (_timer !== null) {
      clearInterval(_timer);
      _timer = null;
    }
  }

  return { start, stop, runNow };
}
