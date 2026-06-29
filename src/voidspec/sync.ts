/**
 * sync.ts — VoidSpec `tasks.yaml` ↔ AutoClaw sprint-YAML bidirectional sync (G1).
 *
 * Responsibilities:
 *   1. Parse a VoidSpec `tasks.yaml` document via js-yaml (G1 BL-20 upgrade).
 *   2. Map each VoidSpec task → an AutoClaw mirrored task in the shared
 *      `VS-<id>` namespace.
 *   3. Bidirectional sync against an AutoClaw "execution state" snapshot:
 *        • VoidSpec → AutoClaw : new / renamed tasks, dependency edits, spec
 *          body changes are pulled in.
 *        • AutoClaw → VoidSpec : execution status (complete / in_progress /
 *          blocked) is written back into `tasks.yaml`.
 *   4. Conflict resolution:
 *        • VoidSpec spec wins — title, description, dependsOn (the "what").
 *        • AutoClaw execution state wins — status (the "how far along").
 *
 * Pure file-I/O + string processing. *** NO LLM CALLS. NO NETWORK CALLS. ***
 *
 * G1 — Sprint-3 / WA-4 (VoidSpec Sync).
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import {
  VoidSpecDocument,
  VoidSpecTask,
  AutoClawMirroredTask,
  AutoClawTaskStatus,
  VoidSpecScaffoldConstraints,
  VoidSpecSuccessMetadata,
  SyncResult,
  SyncTaskOutcome,
  toSharedId,
  toVoidSpecId,
  voidSpecToAutoClawStatus,
  autoClawToVoidSpecStatus,
  normaliseVoidSpecStatus,
} from './types';
import type { ModelLocality, WorkflowIntent } from '../workflows/types';
import type { ScaffoldRouterProfile } from '../workflows/scaffolds/types';

// ---------------------------------------------------------------------------
// VoidSpec tasks.yaml parser (uses js-yaml for full YAML support — BL-20)
// ---------------------------------------------------------------------------

/**
 * Parse a VoidSpec `tasks.yaml` document.
 *
 * Expected shape:
 *
 *   project: my-spec
 *   version: "1.0"
 *   tasks:
 *     - id: T-001
 *       title: "Build the parser"
 *       status: in_progress
 *       description: |
 *         Long form spec text
 *         with multiple lines
 *       owner: claude-code
 *       depends_on: [T-000]
 *       tags: [core, parser]
 *
 * Unknown scalar fields on a task are preserved in `task.extra` so a
 * write-back round-trip does not drop data.
 *
 * Parse errors return an empty document rather than throwing, matching the
 * original best-effort behaviour.
 */
export function parseVoidSpecYaml(content: string): VoidSpecDocument {
  // Strip a leading BOM if present.
  const text = content.replace(/^﻿/, '');

  const EMPTY: VoidSpecDocument = { project: undefined, version: undefined, tasks: [] };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = yaml.load(text);
  } catch {
    return EMPTY;
  }

  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    return EMPTY;
  }

  const project = coerceString(parsed['project']);
  const version = coerceString(parsed['version']);

  const tasks: VoidSpecTask[] = [];
  const rawTasks = parsed['tasks'];
  if (Array.isArray(rawTasks)) {
    for (const raw of rawTasks) {
      if (raw === null || raw === undefined || typeof raw !== 'object') { continue; }
      const task = buildTask(raw as Record<string, unknown>);
      if (task) { tasks.push(task); }
    }
  }

  return { project, version, tasks };
}

/** Coerce any YAML scalar to a trimmed string, or undefined. */
function coerceString(v: unknown): string | undefined {
  if (v === null || v === undefined) { return undefined; }
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

/** Coerce a YAML value that may be a sequence or a scalar into a string array. */
function coerceStringList(v: unknown): string[] {
  if (v === null || v === undefined) { return []; }
  if (Array.isArray(v)) {
    return v
      .map((item) => coerceString(item))
      .filter((s): s is string => s !== undefined);
  }
  // Bare scalar (e.g. `depends_on: T-000` without brackets).
  const s = coerceString(v);
  return s ? [s] : [];
}

/** Build a VoidSpecTask from a raw parsed YAML object. */
function buildTask(raw: Record<string, unknown>): VoidSpecTask | null {
  const id = coerceString(raw['id']);
  if (!id) { return null; } // a task with no stable id is unusable

  const title = coerceString(raw['title']) ?? coerceString(raw['name']) ?? id;
  const status = normaliseVoidSpecStatus(coerceString(raw['status']));

  const descRaw = raw['description'] ?? raw['desc'];
  const description = coerceString(descRaw);

  const dependsOn = coerceStringList(raw['depends_on'] ?? raw['dependsOn'] ?? raw['deps']);
  const tags = coerceStringList(raw['tags']);
  const owner = coerceString(raw['owner'] ?? raw['assignee']);
  const intent = coerceIntent(raw['intent']);
  const success = coerceSuccess(raw['success'] ?? raw['success_criteria'] ?? raw['successCriteria'], raw['success_gates'] ?? raw['successGates']);
  const constraints = coerceConstraints(raw['constraints']);
  const preferredScaffold = coerceString(raw['preferred_scaffold'] ?? raw['preferredScaffold']);

  // Preserve unmodelled scalar fields for loss-free write-back.
  const known = new Set([
    'id', 'title', 'name', 'status', 'description', 'desc',
    'depends_on', 'dependsOn', 'deps', 'tags', 'owner', 'assignee',
    'intent', 'success', 'success_criteria', 'successCriteria',
    'success_gates', 'successGates', 'constraints',
    'preferred_scaffold', 'preferredScaffold',
  ]);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k)) {
      const s = coerceString(v);
      if (s !== undefined) { extra[k] = s; }
    }
  }

  return {
    id,
    title,
    status,
    description,
    dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    owner,
    tags: tags.length > 0 ? tags : undefined,
    intent,
    success,
    constraints,
    preferredScaffold,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

const WORKFLOW_INTENTS: readonly WorkflowIntent[] = [
  'plan', 'code', 'debug', 'test', 'review', 'security', 'docs', 'release',
  'refactor', 'research', 'summarize', 'coordination', 'benchmark', 'vision',
  'tool-use', 'long-context', 'creative', 'cheap-grade',
];

const ROUTING_PROFILES: readonly ScaffoldRouterProfile[] = [
  'cheap', 'balanced', 'quality', 'local-only', 'air-gapped', 'release-critical',
];

const LOCALITIES: readonly ModelLocality[] = ['local', 'lan', 'cloud'];

function coerceIntent(v: unknown): WorkflowIntent | undefined {
  const s = coerceString(v);
  return WORKFLOW_INTENTS.includes(s as WorkflowIntent) ? s as WorkflowIntent : undefined;
}

function coerceRoutingProfile(v: unknown): ScaffoldRouterProfile | undefined {
  const s = coerceString(v);
  return ROUTING_PROFILES.includes(s as ScaffoldRouterProfile) ? s as ScaffoldRouterProfile : undefined;
}

function coerceLocalities(v: unknown): ModelLocality[] | undefined {
  const out = coerceStringList(v)
    .filter((item): item is ModelLocality => LOCALITIES.includes(item as ModelLocality));
  return out.length > 0 ? out : undefined;
}

function coerceNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) { return v; }
  const s = coerceString(v);
  if (!s) { return undefined; }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function coerceSuccess(rawSuccess: unknown, rawGates: unknown): VoidSpecSuccessMetadata | undefined {
  const gatesFromScalar = coerceStringList(rawGates);
  if (gatesFromScalar.length > 0) {
    return { gates: gatesFromScalar };
  }
  if (!rawSuccess || typeof rawSuccess !== 'object' || Array.isArray(rawSuccess)) {
    return undefined;
  }
  const obj = rawSuccess as Record<string, unknown>;
  const gates = coerceStringList(obj['gates'] ?? obj['gateIds'] ?? obj['gate_ids']);
  return gates.length > 0 ? { gates } : undefined;
}

function coerceConstraints(raw: unknown): VoidSpecScaffoldConstraints | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const constraints: VoidSpecScaffoldConstraints = {};
  const routingProfile = coerceRoutingProfile(obj['routing_profile'] ?? obj['routingProfile'] ?? obj['profile']);
  const allowedLocalities = coerceLocalities(obj['allowed_localities'] ?? obj['allowedLocalities']);
  const privacyLocality = coerceLocalities(obj['privacy_locality'] ?? obj['privacyLocality']);
  const maxCostCents = coerceNumber(obj['max_cost_cents'] ?? obj['maxCostCents']);
  const promptHarnessId = coerceString(obj['prompt_harness_id'] ?? obj['promptHarnessId']);
  if (routingProfile) { constraints.routingProfile = routingProfile; }
  if (allowedLocalities) { constraints.allowedLocalities = allowedLocalities; }
  if (privacyLocality) { constraints.privacyLocality = privacyLocality; }
  if (maxCostCents !== undefined) { constraints.maxCostCents = maxCostCents; }
  if (promptHarnessId) { constraints.promptHarnessId = promptHarnessId; }
  return Object.keys(constraints).length > 0 ? constraints : undefined;
}

// ---------------------------------------------------------------------------
// Mapping: VoidSpec task → AutoClaw mirrored task
// ---------------------------------------------------------------------------

/**
 * Map a VoidSpec task into an AutoClaw mirrored task in the `VS-<id>` shared
 * namespace. The description is split into subtask lines on blank-line /
 * bullet boundaries so it surfaces meaningfully in sprint markdown.
 */
export function mapToAutoClawTask(vt: VoidSpecTask): AutoClawMirroredTask {
  const subtasks: string[] = [];
  if (vt.description) {
    for (const rawLine of vt.description.split(/\r?\n/)) {
      const line = rawLine.replace(/^\s*[-*]\s*/, '').trim();
      if (line.length > 0) { subtasks.push(line); }
    }
  }
  return {
    id: toSharedId(vt.id),
    sourceId: vt.id,
    name: vt.title,
    status: voidSpecToAutoClawStatus(vt.status),
    subtasks,
    dependsOn: (vt.dependsOn ?? []).map(toSharedId),
    intent: vt.intent,
    successGates: vt.success?.gates,
    constraints: vt.constraints,
    preferredScaffold: vt.preferredScaffold,
  };
}

/** Map a whole VoidSpec document into AutoClaw mirrored tasks. */
export function mapDocument(doc: VoidSpecDocument): AutoClawMirroredTask[] {
  return doc.tasks.map(mapToAutoClawTask);
}

// ---------------------------------------------------------------------------
// Bidirectional sync
// ---------------------------------------------------------------------------

/**
 * A snapshot of AutoClaw-side execution state, keyed by shared id (`VS-<id>`).
 * The sync caller builds this from sprint YAML / state.json. Only the status
 * is needed — AutoClaw owns "how far along", VoidSpec owns "what".
 */
export type ExecutionStateSnapshot = Map<string, AutoClawTaskStatus>;

/** Options for {@link syncVoidSpec}. */
export interface SyncOptions {
  /**
   * AutoClaw execution-state snapshot keyed by shared id. Tasks present here
   * have their status written back into VoidSpec when it differs.
   */
  executionState?: ExecutionStateSnapshot;
  /**
   * When false, the sync computes outcomes but never rewrites `tasks.yaml`
   * (dry-run). Defaults to true.
   */
  writeBack?: boolean;
}

/**
 * Run one bidirectional sync pass between a VoidSpec `tasks.yaml` file and an
 * AutoClaw execution-state snapshot.
 *
 * Conflict rule:
 *   • VoidSpec spec wins   — title/description/dependsOn always come from the
 *                            `tasks.yaml` document (AutoClaw never edits them).
 *   • AutoClaw exec wins   — when AutoClaw's status for a task differs from the
 *                            status recorded in `tasks.yaml`, AutoClaw's status
 *                            is written back into the file.
 *
 * @param tasksYamlPath  Absolute path to the VoidSpec `tasks.yaml` file.
 * @param opts           Sync options.
 * @returns              The mirrored AutoClaw tasks and a {@link SyncResult}.
 */
export function syncVoidSpec(
  tasksYamlPath: string,
  opts: SyncOptions = {},
): { mirrored: AutoClawMirroredTask[]; result: SyncResult } {
  const writeBack = opts.writeBack ?? true;
  const exec = opts.executionState ?? new Map<string, AutoClawTaskStatus>();

  const raw = fs.readFileSync(tasksYamlPath, 'utf8');
  const doc = parseVoidSpecYaml(raw);

  const outcomes: SyncTaskOutcome[] = [];
  let added = 0;
  let writtenBack = 0;
  let conflicts = 0;

  // Tasks whose VoidSpec status must be rewritten to match AutoClaw.
  const statusRewrites = new Map<string, AutoClawTaskStatus>();

  for (const vt of doc.tasks) {
    const sharedId = toSharedId(vt.id);
    const acStatus = exec.get(sharedId);

    if (acStatus === undefined) {
      // AutoClaw has never seen this task — it is new to the fleet. The spec
      // (VoidSpec) is the source of truth; we simply mirror it in.
      added++;
      outcomes.push({
        id: sharedId,
        direction: 'voidspec_to_autoclaw',
        detail: `New VoidSpec task mirrored into AutoClaw as "${sharedId}".`,
      });
      continue;
    }

    const vsStatusAsAc = voidSpecToAutoClawStatus(vt.status);
    if (vsStatusAsAc === acStatus) {
      outcomes.push({
        id: sharedId,
        direction: 'unchanged',
        detail: `Status already consistent (${acStatus}).`,
      });
      continue;
    }

    // The two systems disagree on status. AutoClaw execution state wins:
    // write AutoClaw's status back into VoidSpec.
    statusRewrites.set(vt.id, acStatus);
    writtenBack++;
    // A genuine conflict (both sides moved) vs. a plain forward update: if the
    // VoidSpec task is `done` but AutoClaw says otherwise — or vice-versa — we
    // count it as a resolved conflict for visibility.
    const bothMoved = vt.status === 'done' || acStatus === 'complete';
    if (bothMoved) { conflicts++; }
    outcomes.push({
      id: sharedId,
      direction: bothMoved ? 'conflict_resolved' : 'autoclaw_to_voidspec',
      detail:
        `AutoClaw status "${acStatus}" written back to VoidSpec ` +
        `(was "${vt.status}"). AutoClaw execution state wins.`,
    });
  }

  // Apply write-back to tasks.yaml if anything changed.
  let voidSpecFileChanged = false;
  if (writeBack && statusRewrites.size > 0) {
    const updated = applyStatusWriteBack(raw, statusRewrites);
    if (updated !== raw) {
      fs.writeFileSync(tasksYamlPath, updated, 'utf8');
      voidSpecFileChanged = true;
    }
  }

  return {
    mirrored: mapDocument(doc),
    result: {
      tasks: outcomes,
      added,
      writtenBack,
      conflicts,
      voidSpecFileChanged,
    },
  };
}

/**
 * Strip a single layer of matching single/double quotes from a raw YAML scalar
 * string. Used only by the text-level write-back functions that operate on raw
 * YAML text rather than the parsed object tree.
 */
function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Rewrite the `status:` line of selected tasks inside a raw `tasks.yaml`
 * string, preserving all other formatting/whitespace.
 *
 * `rewrites` is keyed by raw VoidSpec id; values are AutoClaw statuses which
 * are converted back to VoidSpec vocabulary before being written.
 *
 * The algorithm walks the document line-by-line, tracking which task entry it
 * is currently inside (by watching for `id:` lines), and replaces the next
 * `status:` line within that entry. If a target task has no `status:` line,
 * one is inserted immediately after its `id:` line at the matching indent.
 */
export function applyStatusWriteBack(
  raw: string,
  rewrites: Map<string, AutoClawTaskStatus>,
): string {
  if (rewrites.size === 0) { return raw; }

  const lines = raw.split('\n');
  const out: string[] = [];

  let currentId: string | null = null;       // raw id of the task we are in
  let currentIndent = '';                     // indent of the current task's keys
  let statusWritten = false;                  // wrote status for current task?

  const flushMissingStatus = (): void => {
    // If we are leaving a target task that had no status line, the insertion
    // already happened right after its id line, so nothing to do here.
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idM = line.match(/^(\s*)(?:-\s*)?id:\s*(.+)$/);

    if (idM) {
      flushMissingStatus();
      const idVal = unquote(idM[2].trim());
      currentId = rewrites.has(idVal) ? idVal : null;
      currentIndent = idM[1].replace(/-\s*$/, '') + (idM[0].includes('- ') ? '  ' : '');
      // Normalise: the indent of sibling keys equals the column of "id:".
      const idCol = line.indexOf('id:');
      currentIndent = ' '.repeat(idCol);
      statusWritten = false;
      out.push(line);

      // Insert a status line immediately if the task has none. We look ahead
      // within this entry; if no status line exists before the next entry or
      // dedent, insert right here.
      if (currentId && !entryHasStatus(lines, i, idCol)) {
        const newStatus = autoClawToVoidSpecStatus(rewrites.get(currentId)!);
        out.push(`${currentIndent}status: ${newStatus}`);
        statusWritten = true;
      }
      continue;
    }

    const statusM = line.match(/^(\s*)status:\s*(.*)$/);
    if (statusM && currentId && !statusWritten) {
      const newStatus = autoClawToVoidSpecStatus(rewrites.get(currentId)!);
      out.push(`${statusM[1]}status: ${newStatus}`);
      statusWritten = true;
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

/**
 * Look ahead from the `id:` line at index `idIdx` and report whether the task
 * entry contains a `status:` line before the entry ends (next list item at the
 * same or shallower indent).
 */
function entryHasStatus(lines: string[], idIdx: number, idCol: number): boolean {
  for (let j = idIdx + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '') { continue; }
    const indent = line.length - line.trimStart().length;
    // A new list entry or a dedent ends the current task entry.
    if (indent < idCol || /^\s*-\s/.test(line)) { return false; }
    if (/^\s*status:\s*/.test(line)) { return true; }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Convenience: build an execution-state snapshot from a status map
// ---------------------------------------------------------------------------

/**
 * Build an {@link ExecutionStateSnapshot} from a plain record of
 * `<sharedId|rawId> → status`. Raw VoidSpec ids are normalised to shared ids.
 */
export function buildExecutionState(
  statuses: Record<string, AutoClawTaskStatus>,
): ExecutionStateSnapshot {
  const snap: ExecutionStateSnapshot = new Map();
  for (const [k, v] of Object.entries(statuses)) {
    snap.set(toSharedId(toVoidSpecId(k)), v);
  }
  return snap;
}
