/**
 * opsTasks.ts — convert reconcile drifts + doctor findings into claimable ops work.
 *
 * Reconcile detects drift; the doctor detects config/reality mismatches. Neither
 * auto-fixes. This module is the bridge: it turns each finding into a claimable
 * ops task (id prefix `ops:`) that an agent can pick up, fix, and close.
 *
 * Ops tasks live in `.autoclaw/orchestrator/ops-tasks.json` (not state.tasks[],
 * which is owned by the catalog ingest). The board writer merges them in so they
 * surface in the claimable lane alongside real work.
 *
 * Pure helpers + fs runner; no vscode.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DoctorFinding } from './doctor';
import type { DriftRecord } from './reconcile';

const fsp = fs.promises;

/** An ops task — a claimable item derived from a drift or finding. */
export interface OpsTask {
  id: string;
  title: string;
  description: string;
  /** Source that generated this ops task. */
  source: 'reconcile' | 'doctor';
  /** Original drift type or finding kind. */
  reason: string;
  /** Suggested fix hint. */
  hint: string;
  /** Absolute path to the offending file, when applicable. */
  file?: string;
  /** ISO-8601 timestamp the ops task was created. */
  created_at: string;
  priority: 'high' | 'medium' | 'low';
}

function opsTasksPath(orchestratorDir: string): string {
  return path.join(orchestratorDir, 'ops-tasks.json');
}

/**
 * Convert a reconcile drift to an ops task. Returns null for drift types that
 * don't map cleanly to a fixable ops item.
 */
export function driftToOpsTask(drift: DriftRecord, now: Date): OpsTask | null {
  const base: Omit<OpsTask, 'id' | 'title' | 'description' | 'reason' | 'hint' | 'priority'> = {
    source: 'reconcile',
    file: drift.file,
    created_at: now.toISOString(),
  };

  switch (drift.type) {
    case 'yaml_parse_error':
      return {
        ...base,
        id: `ops-yaml-${path.basename(drift.file ?? 'unknown')}`,
        title: `Fix invalid YAML: ${path.basename(drift.file ?? 'unknown')}`,
        description: drift.description,
        reason: drift.type,
        hint: 'Open the file, fix the YAML syntax error, and save.',
        priority: 'high',
      };
    case 'task_in_yaml_not_in_state':
      return {
        ...base,
        id: `ops-sync-${drift.task_id}`,
        title: `Sync task ${drift.task_id} into state.json`,
        description: drift.description,
        reason: drift.type,
        hint: 'Run catalog ingest or manually add the task to state.tasks.',
        priority: 'medium',
      };
    case 'task_status_mismatch':
      return {
        ...base,
        id: `ops-status-${drift.task_id}`,
        title: `Reconcile status for ${drift.task_id}`,
        description: drift.description,
        reason: drift.type,
        hint: `Update ${drift.laggard} to match the authoritative source.`,
        priority: 'medium',
      };
    default:
      return null;
  }
}

/** Convert a doctor finding to an ops task. */
export function findingToOpsTask(finding: DoctorFinding, now: Date): OpsTask {
  const base: Omit<OpsTask, 'id' | 'title' | 'description' | 'reason' | 'hint' | 'priority'> = {
    source: 'doctor',
    created_at: now.toISOString(),
  };

  switch (finding.kind) {
    case 'total_sprints_mismatch':
      return {
        ...base,
        id: 'ops-sprint-count',
        title: 'Fix total_sprints mismatch',
        description: finding.description,
        reason: finding.kind,
        hint: finding.hint,
        priority: 'medium',
      };
    case 'base_branch_missing':
      return {
        ...base,
        id: 'ops-base-branch',
        title: 'Create missing base branch',
        description: finding.description,
        reason: finding.kind,
        hint: finding.hint,
        priority: 'high',
      };
    case 'git_repo_absent':
      return {
        ...base,
        id: 'ops-git-init',
        title: 'Initialize git repo',
        description: finding.description,
        reason: finding.kind,
        hint: finding.hint,
        priority: 'low',
      };
    case 'git_repo_present_but_config_disabled':
      return {
        ...base,
        id: 'ops-git-config',
        title: 'Enable git coordination',
        description: finding.description,
        reason: finding.kind,
        hint: finding.hint,
        priority: 'medium',
      };
  }
}

/**
 * Materialize ops tasks from drifts + findings. Deduplicates by id (latest wins)
 * and writes to `ops-tasks.json`. Idempotent: re-running with the same inputs
 * produces the same file.
 */
export async function materializeOpsTasks(
  orchestratorDir: string,
  drifts: DriftRecord[],
  findings: DoctorFinding[],
  now: Date = new Date(),
): Promise<OpsTask[]> {
  const ops: OpsTask[] = [];

  for (const d of drifts) {
    const t = driftToOpsTask(d, now);
    if (t) { ops.push(t); }
  }
  for (const f of findings) {
    ops.push(findingToOpsTask(f, now));
  }

  // Dedupe by id (last wins).
  const byId = new Map<string, OpsTask>();
  for (const t of ops) { byId.set(t.id, t); }
  const deduped = Array.from(byId.values());

  const p = opsTasksPath(orchestratorDir);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(deduped, null, 2) + '\n', 'utf8');
  return deduped;
}

/** Read existing ops tasks. Returns [] when the file is absent or malformed. */
export async function readOpsTasks(orchestratorDir: string): Promise<OpsTask[]> {
  try {
    const raw = await fsp.readFile(opsTasksPath(orchestratorDir), 'utf8');
    const parsed = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
    if (!Array.isArray(parsed)) { return []; }
    return parsed.filter(isOpsTask);
  } catch {
    return [];
  }
}

function isOpsTask(v: unknown): v is OpsTask {
  if (typeof v !== 'object' || v === null) { return false; }
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.title === 'string';
}
