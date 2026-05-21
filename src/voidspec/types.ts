/**
 * types.ts — Shared types for the VoidSpec ↔ AutoClaw integration (G1/G2).
 *
 * VoidSpec is an external spec-driven task tracker. It stores its task list in
 * a `tasks.yaml` file (typically under a `.voidspec/` directory). AutoClaw
 * tracks execution work in sprint YAML files under
 * `.autoclaw/orchestrator/sprints/`.
 *
 * This module is pure type/interface declarations plus a couple of trivial
 * pure helpers — zero runtime cost, zero LLM calls, zero I/O.
 *
 * ── Stable-ID convention (COORDINATION §2.11) ──────────────────────────────
 *   Every VoidSpec task carries a stable `id` that never changes across edits.
 *   When such a task is mirrored into AutoClaw it is given the shared-namespace
 *   id `VS-<id>` so both systems can refer to the same unit of work without
 *   collision with native AutoClaw task ids (which use `<Letter><digit>` form).
 */

// ---------------------------------------------------------------------------
// VoidSpec task model
// ---------------------------------------------------------------------------

/**
 * The lifecycle status of a VoidSpec task. VoidSpec implementations vary in
 * exact vocabulary, so we normalise on a small closed set and treat anything
 * unrecognised as `'todo'`.
 */
export type VoidSpecStatus = 'todo' | 'in_progress' | 'blocked' | 'done';

/** A single task parsed from a VoidSpec `tasks.yaml` file. */
export interface VoidSpecTask {
  /** Stable identifier — never changes across edits (COORDINATION §2.11). */
  id: string;
  /** Human-readable one-line title. */
  title: string;
  /** Normalised lifecycle status. */
  status: VoidSpecStatus;
  /** Optional longer description / spec body. */
  description?: string;
  /** Ids of VoidSpec tasks this one depends on. */
  dependsOn?: string[];
  /** Optional owner / assignee hint. */
  owner?: string;
  /** Free-form tags. */
  tags?: string[];
  /**
   * Any fields present in the source YAML that we do not model explicitly.
   * Preserved so a write-back round-trip does not silently drop data.
   */
  extra?: Record<string, string>;
}

/** The parsed contents of a `tasks.yaml` document. */
export interface VoidSpecDocument {
  /** Optional VoidSpec project / spec name. */
  project?: string;
  /** Optional spec version string. */
  version?: string;
  /** All tasks, in document order. */
  tasks: VoidSpecTask[];
}

// ---------------------------------------------------------------------------
// AutoClaw-side mirror model
// ---------------------------------------------------------------------------

/**
 * The AutoClaw execution status of a task. This mirrors the status vocabulary
 * used in sprint YAML files (`pending`, `in_progress`, `complete`, …).
 */
export type AutoClawTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'complete';

/**
 * An AutoClaw task derived from a VoidSpec task. The `id` is the shared
 * namespace id (`VS-<voidSpecId>`); `sourceId` keeps the raw VoidSpec id.
 */
export interface AutoClawMirroredTask {
  /** Shared-namespace id — always `VS-<sourceId>`. */
  id: string;
  /** The raw VoidSpec task id (without the `VS-` prefix). */
  sourceId: string;
  /** Task title (mirrors VoidSpec `title`). */
  name: string;
  /** AutoClaw execution status. */
  status: AutoClawTaskStatus;
  /** Subtask lines — derived from the VoidSpec description, if any. */
  subtasks: string[];
  /** Mirrored dependency ids, also in shared-namespace form. */
  dependsOn: string[];
}

// ---------------------------------------------------------------------------
// Sync result model
// ---------------------------------------------------------------------------

/** The direction a particular task's state flowed during a sync pass. */
export type SyncDirection =
  | 'voidspec_to_autoclaw' // spec / structure change pulled in
  | 'autoclaw_to_voidspec' // execution status pushed back
  | 'unchanged'            // already consistent
  | 'conflict_resolved';   // both sides differed; conflict rule applied

/** Per-task record of what the sync did. */
export interface SyncTaskOutcome {
  /** Shared-namespace id. */
  id: string;
  /** Direction the data flowed. */
  direction: SyncDirection;
  /** Human-readable explanation, surfaced in the VS Code command output. */
  detail: string;
}

/** Aggregate result of one bidirectional sync pass. */
export interface SyncResult {
  /** Per-task outcomes. */
  tasks: SyncTaskOutcome[];
  /** Count of tasks newly mirrored into AutoClaw. */
  added: number;
  /** Count of tasks whose AutoClaw status was written back to VoidSpec. */
  writtenBack: number;
  /** Count of tasks where the conflict rule had to pick a winner. */
  conflicts: number;
  /** True when the VoidSpec `tasks.yaml` file was rewritten. */
  voidSpecFileChanged: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O)
// ---------------------------------------------------------------------------

/** The shared-namespace prefix applied to every mirrored VoidSpec task id. */
export const VS_ID_PREFIX = 'VS-';

/** Convert a raw VoidSpec id to its AutoClaw shared-namespace id. */
export function toSharedId(voidSpecId: string): string {
  return voidSpecId.startsWith(VS_ID_PREFIX)
    ? voidSpecId
    : VS_ID_PREFIX + voidSpecId;
}

/** Strip the shared-namespace prefix to recover the raw VoidSpec id. */
export function toVoidSpecId(sharedId: string): string {
  return sharedId.startsWith(VS_ID_PREFIX)
    ? sharedId.slice(VS_ID_PREFIX.length)
    : sharedId;
}

/** True when `id` belongs to the shared VoidSpec namespace. */
export function isSharedVoidSpecId(id: string): boolean {
  return id.startsWith(VS_ID_PREFIX);
}

/**
 * Map a VoidSpec status to the equivalent AutoClaw execution status.
 * `done` ↔ `complete`; everything else maps one-to-one.
 */
export function voidSpecToAutoClawStatus(s: VoidSpecStatus): AutoClawTaskStatus {
  switch (s) {
    case 'done':        return 'complete';
    case 'in_progress': return 'in_progress';
    case 'blocked':     return 'blocked';
    case 'todo':
    default:            return 'pending';
  }
}

/** Map an AutoClaw execution status back to a VoidSpec status. */
export function autoClawToVoidSpecStatus(s: AutoClawTaskStatus): VoidSpecStatus {
  switch (s) {
    case 'complete':    return 'done';
    case 'in_progress': return 'in_progress';
    case 'blocked':     return 'blocked';
    case 'pending':
    default:            return 'todo';
  }
}

/** Normalise an arbitrary status string from a YAML file into a known value. */
export function normaliseVoidSpecStatus(raw: string | undefined): VoidSpecStatus {
  const v = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (v) {
    case 'done':
    case 'complete':
    case 'completed':
    case 'finished':
      return 'done';
    case 'in_progress':
    case 'inprogress':
    case 'doing':
    case 'active':
    case 'wip':
      return 'in_progress';
    case 'blocked':
    case 'waiting':
    case 'on_hold':
      return 'blocked';
    case 'todo':
    case 'pending':
    case 'open':
    case 'new':
    case '':
    default:
      return 'todo';
  }
}
