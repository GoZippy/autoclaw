/**
 * sync.ts — VoidSpec `tasks.yaml` ↔ AutoClaw sprint-YAML bidirectional sync (G1).
 *
 * Responsibilities:
 *   1. Parse a VoidSpec `tasks.yaml` document (best-effort YAML — no external
 *      library; same approach as src/orchestrator/sprintMarkdownGenerator.ts).
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
import {
  VoidSpecDocument,
  VoidSpecTask,
  AutoClawMirroredTask,
  AutoClawTaskStatus,
  SyncResult,
  SyncTaskOutcome,
  toSharedId,
  toVoidSpecId,
  voidSpecToAutoClawStatus,
  autoClawToVoidSpecStatus,
  normaliseVoidSpecStatus,
} from './types';

// ---------------------------------------------------------------------------
// VoidSpec tasks.yaml parser (best-effort, no external YAML dependency)
// ---------------------------------------------------------------------------

/**
 * Parse a VoidSpec `tasks.yaml` document.
 *
 * Expected shape (a permissive subset of YAML):
 *
 *   project: my-spec
 *   version: "1.0"
 *   tasks:
 *     - id: T-001
 *       title: "Build the parser"
 *       status: in_progress
 *       description: "Long form spec text"
 *       owner: claude-code
 *       depends_on: [T-000]
 *       tags: [core, parser]
 *
 * Unknown scalar fields on a task are preserved in `task.extra` so a
 * write-back round-trip does not drop data.
 */
export function parseVoidSpecYaml(content: string): VoidSpecDocument {
  // Strip a leading BOM if present.
  const text = content.replace(/^﻿/, '');

  const topScalar = (key: string): string | undefined => {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? unquote(m[1].trim()) : undefined;
  };

  const project = topScalar('project');
  const version = topScalar('version');

  const tasks: VoidSpecTask[] = [];

  // Isolate the `tasks:` block — everything indented under it until a
  // non-indented line (or EOF).
  const tasksBlockM = text.match(/^tasks:\s*\n([\s\S]*?)(?=^\S|\s*$)/m);
  if (tasksBlockM) {
    // Prepend a newline so the first "- id:" entry splits cleanly.
    const block = '\n' + tasksBlockM[1];
    // Each task entry begins with `<indent>- ` at the list level.
    const entries = block.split(/\n\s*-\s+/g).slice(1);
    for (const entry of entries) {
      const task = parseTaskEntry(entry);
      if (task) { tasks.push(task); }
    }
  }

  return { project, version, tasks };
}

/** Parse one task list-entry (text after the leading `- `). */
function parseTaskEntry(entry: string): VoidSpecTask | null {
  // Collect every `key: value` line in the entry.
  const fields = new Map<string, string>();
  for (const line of entry.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) {
      const key = m[1].trim();
      // First occurrence wins; nested keys with the same name are rare.
      if (!fields.has(key)) { fields.set(key, m[2].trim()); }
    }
  }

  const id = unquote(fields.get('id') ?? '');
  if (!id) { return null; } // a task with no stable id is unusable

  const title = unquote(fields.get('title') ?? fields.get('name') ?? id);
  const status = normaliseVoidSpecStatus(fields.get('status'));

  const descRaw = fields.get('description') ?? fields.get('desc');
  const description = descRaw ? unquote(descRaw) : undefined;

  const dependsOn = parseInlineList(
    fields.get('depends_on') ?? fields.get('dependsOn') ?? fields.get('deps'),
  );
  const tags = parseInlineList(fields.get('tags'));
  const ownerRaw = fields.get('owner') ?? fields.get('assignee');
  const owner = ownerRaw ? unquote(ownerRaw) : undefined;

  // Preserve unmodelled scalar fields for loss-free write-back.
  const known = new Set([
    'id', 'title', 'name', 'status', 'description', 'desc',
    'depends_on', 'dependsOn', 'deps', 'tags', 'owner', 'assignee',
  ]);
  const extra: Record<string, string> = {};
  for (const [k, v] of fields) {
    if (!known.has(k) && v !== '') { extra[k] = v; }
  }

  return {
    id,
    title,
    status,
    description,
    dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    owner,
    tags: tags.length > 0 ? tags : undefined,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

/** Parse an inline `[a, b, c]` list, or a bare scalar, into a string array. */
function parseInlineList(raw: string | undefined): string[] {
  if (!raw) { return []; }
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '[]') { return []; }
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  return inner
    .split(',')
    .map((s) => unquote(s.trim()))
    .filter((s) => s.length > 0);
}

/** Strip a single layer of matching single/double quotes. */
function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  return s;
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
