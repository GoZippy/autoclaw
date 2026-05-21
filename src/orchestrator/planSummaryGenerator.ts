/**
 * planSummaryGenerator.ts — Regenerate plan-summary.yaml from state.json + sprint YAMLs.
 *
 * Reads:
 *   - .autoclaw/orchestrator/state.json          (task/sprint runtime statuses)
 *   - .autoclaw/orchestrator/sprints/sprint-N.yaml (canonical sprint specs)
 *
 * Writes:
 *   - .autoclaw/orchestrator/sprints/plan-summary.yaml
 *
 * Idempotent: if the generated output is byte-for-byte identical to the
 * existing file, the write is skipped.
 *
 * A7 — Sprint-1 / WA-2 (Single source of truth generators).
 */

import * as fs from 'fs';
import * as path from 'path';

const fsPromises = fs.promises;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanSummarySprintRow {
  number: number;
  level: number;
  status: string;
  tasks: string[];
  task_count: number;
  agents: string[];
  estimated_days: number;
  depends_on: number[];
  description: string;
}

export interface PlanSummaryWorkstream {
  name: string;
  tasks: number;
  sprints: number[];
}

export interface PlanSummary {
  project: string;
  generated_at: string;
  source_manifest: string;
  totals: {
    tasks: number;
    sprints: number;
    agents: number;
    estimated_total_days: number;
    critical_path_sprints: number;
  };
  workstreams: Record<string, PlanSummaryWorkstream>;
  sprints: PlanSummarySprintRow[];
}

// ---------------------------------------------------------------------------
// Minimal YAML helpers (no external deps — plain-text serialisation)
// ---------------------------------------------------------------------------

/** Serialise a JS value to YAML-compatible text (subset, not full YAML). */
function toYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) { return 'null'; }
  if (typeof value === 'boolean') { return value ? 'true' : 'false'; }
  if (typeof value === 'number') { return String(value); }
  if (typeof value === 'string') {
    // Use flow-style double-quotes only when the string contains special chars.
    if (/[:#,\[\]{}&*?|<>=!%@`\n\\]/.test(value) || value.trim() !== value || value === '') {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) { return '[]'; }
    // Short arrays of scalars are inline.
    const allScalar = value.every(v => typeof v !== 'object' || v === null);
    if (allScalar) {
      const items = value.map(v => toYaml(v, 0)).join(', ');
      return `[${items}]`;
    }
    // Block style for complex arrays.
    return '\n' + value.map(v => `${pad}- ${toYaml(v, indent + 2).trimStart()}`).join('\n');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) { return '{}'; }
    return '\n' + keys.map(k => {
      const v = toYaml(obj[k], indent + 2);
      if (v.startsWith('\n')) {
        return `${pad}  ${k}:${v}`;
      }
      return `${pad}  ${k}: ${v}`;
    }).join('\n');
  }
  return String(value);
}

/** Serialise a PlanSummary to a YAML string matching the plan-summary.yaml schema. */
function serialisePlanSummary(summary: PlanSummary): string {
  const lines: string[] = [];

  lines.push(`project: ${toYaml(summary.project)}`);
  lines.push(`generated_at: ${toYaml(summary.generated_at)}`);
  lines.push(`source_manifest: ${toYaml(summary.source_manifest)}`);
  lines.push('');

  // Totals block.
  lines.push('totals:');
  lines.push(`  tasks: ${summary.totals.tasks}`);
  lines.push(`  sprints: ${summary.totals.sprints}`);
  lines.push(`  agents: ${summary.totals.agents}`);
  lines.push(`  estimated_total_days: ${summary.totals.estimated_total_days}`);
  lines.push(`  critical_path_sprints: ${summary.totals.critical_path_sprints}`);
  lines.push('');

  // Workstreams — inline objects on one line.
  lines.push('workstreams:');
  for (const [key, ws] of Object.entries(summary.workstreams)) {
    const sprintsInline = `[${ws.sprints.join(', ')}]`;
    lines.push(`  ${toYaml(key)}: {name: ${toYaml(ws.name)}, tasks: ${ws.tasks}, sprints: ${sprintsInline}}`);
  }
  lines.push('');

  // Sprint rows — block style.
  lines.push('sprints:');
  for (const sprint of summary.sprints) {
    lines.push(`  - number: ${sprint.number}`);
    lines.push(`    level: ${sprint.level}`);
    lines.push(`    status: ${sprint.status}`);
    lines.push(`    tasks: [${sprint.tasks.join(', ')}]`);
    lines.push(`    task_count: ${sprint.task_count}`);
    lines.push(`    agents: [${sprint.agents.map(a => toYaml(a)).join(', ')}]`);
    lines.push(`    estimated_days: ${sprint.estimated_days}`);
    lines.push(`    depends_on: [${sprint.depends_on.join(', ')}]`);
    lines.push(`    description: ${toYaml(sprint.description)}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sprint YAML parser (best-effort, no external YAML library)
// ---------------------------------------------------------------------------

function parseSprintYamlForSummary(content: string, sprintNumber: number): PlanSummarySprintRow {
  const getField = (key: string): string => {
    const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };

  const level = parseInt(getField('level') || '0', 10);
  const status = getField('status') || 'pending';
  const description = getField('description') || '';
  const estimatedDays = parseInt(getField('estimated_days') || '0', 10);

  // Parse depends_on_sprints: [1, 2] or []
  const dependsOnM = content.match(/^depends_on_sprints:\s*\[([^\]]*)\]/m);
  const dependsOn: number[] = dependsOnM
    ? dependsOnM[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : [];

  // Extract agent names from assignments.
  const agentMatches = [...content.matchAll(/^\s*-\s*agent:\s*([\w-]+)/gm)];
  const agents = [...new Set(agentMatches.map(m => m[1].trim()))];

  // Extract all task ids (- id: <X>).
  const taskMatches = [...content.matchAll(/^\s*-\s*id:\s*([\w.-]+)/gm)];
  const tasks = [...new Set(taskMatches.map(m => m[1].trim()))];

  return {
    number: sprintNumber,
    level,
    status,
    tasks,
    task_count: tasks.length,
    agents: agents.length > 0 ? agents : ['WA-1', 'WA-2', 'WA-3', 'WA-4'],
    estimated_days: estimatedDays,
    depends_on: dependsOn,
    description,
  };
}

// ---------------------------------------------------------------------------
// State.json integration
// ---------------------------------------------------------------------------

interface StateJson {
  tasks?: Array<{ id: string; status: string }>;
  sprint_statuses?: Record<string, string>;
}

async function loadStateJson(orchestratorDir: string): Promise<StateJson | null> {
  try {
    const raw = await fsPromises.readFile(path.join(orchestratorDir, 'state.json'), 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as StateJson;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PlanSummaryGeneratorOptions {
  /** Absolute path to the workspace root (contains .autoclaw/). */
  workspaceRoot: string;
  /** Project name. Default 'autoclaw-v3x-integration'. */
  projectName?: string;
  /** Source manifest path. Default '.autoclaw/orchestrator/manifests/v3x-integration.yaml'. */
  sourceManifest?: string;
}

export interface GenerateResult {
  /** True when the file was actually written (content changed). */
  written: boolean;
  /** The generated YAML string. */
  yaml: string;
  /** Path to the written file. */
  outputPath: string;
}

/**
 * Generate plan-summary.yaml from state.json + sprint YAML files.
 * Idempotent: skips the write when content is unchanged.
 */
export async function generatePlanSummary(opts: PlanSummaryGeneratorOptions): Promise<GenerateResult> {
  const {
    workspaceRoot,
    projectName = 'autoclaw-v3x-integration',
    sourceManifest = '.autoclaw/orchestrator/manifests/v3x-integration.yaml',
  } = opts;

  const orchestratorDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator');
  const sprintsDir = path.join(orchestratorDir, 'sprints');
  const outputPath = path.join(sprintsDir, 'plan-summary.yaml');

  // 1. Load state.json (optional — may not exist yet).
  const stateJson = await loadStateJson(orchestratorDir);

  // 2. Discover sprint YAML files.
  let sprintFiles: string[];
  try {
    sprintFiles = (await fsPromises.readdir(sprintsDir))
      .filter(f => /^sprint-\d+\.yaml$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)![0], 10);
        const nb = parseInt(b.match(/\d+/)![0], 10);
        return na - nb;
      });
  } catch {
    sprintFiles = [];
  }

  // 3. Parse each sprint YAML.
  const sprintRows: PlanSummarySprintRow[] = [];
  for (const f of sprintFiles) {
    const n = parseInt(f.match(/\d+/)![0], 10);
    try {
      const content = await fsPromises.readFile(path.join(sprintsDir, f), 'utf8');
      const row = parseSprintYamlForSummary(content, n);

      // Override status from state.json sprint_statuses if available.
      if (stateJson?.sprint_statuses) {
        const overrideStatus = stateJson.sprint_statuses[String(n)] ?? stateJson.sprint_statuses[`sprint-${n}`];
        if (overrideStatus) { row.status = overrideStatus; }
      }

      sprintRows.push(row);
    } catch { /* skip unreadable */ }
  }

  // 4. Compute workstreams by aggregating task prefixes across sprint rows.
  const workstreamMap = new Map<string, { tasks: Set<string>; sprints: Set<number>; name: string }>();
  const WORKSTREAM_NAMES: Record<string, string> = {
    A: 'Foundation (Orchestrator Correctness)',
    B: 'Runners + Bridge',
    'B+': 'MCP Server',
    C: 'Memory & UI',
    D: 'Cloud Relay',
    E: 'Lightweight Monitoring Daemon',
    F: 'Extended Runner Table',
    G: 'VoidSpec Integration',
    H: 'Single-Button UX',
    I: 'Computer-Use Keep-Alive Loop',
  };

  for (const row of sprintRows) {
    for (const taskId of row.tasks) {
      // Workstream prefix: one or two uppercase letters before the digit.
      const m = taskId.match(/^([A-Z][A-Z+]?)\d/);
      if (!m) { continue; }
      const prefix = m[1];
      if (!workstreamMap.has(prefix)) {
        workstreamMap.set(prefix, {
          tasks: new Set(),
          sprints: new Set(),
          name: WORKSTREAM_NAMES[prefix] ?? prefix,
        });
      }
      const ws = workstreamMap.get(prefix)!;
      ws.tasks.add(taskId);
      ws.sprints.add(row.number);
    }
  }

  const workstreams: Record<string, PlanSummaryWorkstream> = {};
  for (const [key, ws] of workstreamMap) {
    workstreams[key] = {
      name: ws.name,
      tasks: ws.tasks.size,
      sprints: [...ws.sprints].sort((a, b) => a - b),
    };
  }

  // 5. Compute totals.
  const allTaskIds = new Set(sprintRows.flatMap(r => r.tasks));
  const allAgents = new Set(sprintRows.flatMap(r => r.agents));
  const totalDays = sprintRows.reduce((sum, r) => sum + r.estimated_days, 0);
  const criticalPath = sprintRows.length; // simplification: all sprints on critical path

  const summary: PlanSummary = {
    project: projectName,
    generated_at: new Date().toISOString(),
    source_manifest: sourceManifest,
    totals: {
      tasks: allTaskIds.size,
      sprints: sprintRows.length,
      agents: allAgents.size,
      estimated_total_days: totalDays,
      critical_path_sprints: criticalPath,
    },
    workstreams,
    sprints: sprintRows,
  };

  // 6. Serialise.
  const yaml = serialisePlanSummary(summary);

  // 7. Idempotent write.
  let existing = '';
  try { existing = await fsPromises.readFile(outputPath, 'utf8'); } catch { /* no existing file */ }

  const stripGenAt = (s: string) => s.replace(/^generated_at:.*$/m, 'generated_at: <ignored>');
  if (existing !== '' && stripGenAt(existing) === stripGenAt(yaml)) {
    return { written: false, yaml: existing, outputPath };
  }

  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  await fsPromises.writeFile(outputPath, yaml, 'utf8');
  return { written: true, yaml, outputPath };
}
