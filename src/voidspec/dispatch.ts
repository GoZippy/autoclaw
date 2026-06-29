/**
 * dispatch.ts — VoidSpec agent-dispatch surface + VS Code sync command (G2).
 *
 * Three responsibilities:
 *
 *   1. {@link dispatchVoidSpecTasks} — if a `runner-voidspec` dispatch API is
 *      reachable, hand the mirrored tasks to it; otherwise fall back to
 *      converting VoidSpec tasks into native AutoClaw tasks (the mirrored
 *      `VS-<id>` tasks produced by sync.ts).
 *
 *   2. {@link watchVoidSpecDir} — a filesystem watcher on `.voidspec/` that
 *      auto-re-syncs whenever `tasks.yaml` changes. Uses `chokidar` when
 *      available (same pattern as src/daemon/watcher.ts) and falls back to a
 *      polling `fs.watchFile` loop.
 *
 *   3. {@link syncVoidSpecCommand} — the function the VS Code command
 *      `AutoClaw: Sync VoidSpec Tasks` invokes. It is exported here but is
 *      *not* wired into `src/extension.ts` — a separate session owns that file.
 *      See the TODO(extension) note at the bottom of this file.
 *
 * Pure file-I/O + optional child-process dispatch. *** NO LLM CALLS here. ***
 *
 * G2 — Sprint-3 / WA-4 (VoidSpec dispatch + VS Code command).
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  syncVoidSpec,
  SyncOptions,
  ExecutionStateSnapshot,
} from './sync';
import { AutoClawMirroredTask, SyncResult } from './types';
import {
  selectScaffoldVariant,
  type ScaffoldSelectionDecision,
} from '../workflows/scaffolds/select';
import type {
  PromptHarnessContract,
  ScaffoldScore,
  ScaffoldVariant,
} from '../workflows/scaffolds/types';

// ---------------------------------------------------------------------------
// Conventional locations
// ---------------------------------------------------------------------------

/** Default directory VoidSpec keeps its files in, relative to a workspace. */
export const VOIDSPEC_DIR = '.voidspec';
/** Default task-list filename inside {@link VOIDSPEC_DIR}. */
export const VOIDSPEC_TASKS_FILE = 'tasks.yaml';

/** Resolve the absolute path to a workspace's VoidSpec `tasks.yaml`. */
export function resolveTasksYamlPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, VOIDSPEC_DIR, VOIDSPEC_TASKS_FILE);
}

/** True when a workspace has a VoidSpec `tasks.yaml` file. */
export function hasVoidSpec(workspaceRoot: string): boolean {
  return fs.existsSync(resolveTasksYamlPath(workspaceRoot));
}

// ---------------------------------------------------------------------------
// runner-voidspec dispatch API seam
// ---------------------------------------------------------------------------

/**
 * Minimal interface for a `runner-voidspec` dispatch API. The real runner (if
 * one ships in a future sprint) implements this; for now AutoClaw probes for
 * it and falls back to native-task conversion when it is absent.
 */
export interface VoidSpecRunner {
  /** Stable runner id — always `"runner-voidspec"`. */
  readonly id: string;
  /** Returns true when the runner is installed and reachable. */
  isAvailable(): Promise<boolean> | boolean;
  /**
   * Dispatch a batch of mirrored tasks to the VoidSpec runner.
   * Returns a short status string per task (e.g. "queued").
   */
  dispatch(tasks: AutoClawMirroredTask[]): Promise<Record<string, string>>;
}

/**
 * The outcome of a dispatch pass.
 *  - `mode: 'runner'`  — handed off to `runner-voidspec`.
 *  - `mode: 'native'`  — no runner; tasks converted to AutoClaw tasks.
 */
export interface DispatchResult {
  mode: 'runner' | 'native';
  /** The mirrored tasks (always populated). */
  tasks: AutoClawMirroredTask[];
  /** Per-task dispatch status — only populated in `runner` mode. */
  dispatched?: Record<string, string>;
  /** Selector decisions keyed by mirrored task id, when scaffold selection ran. */
  scaffoldDecisions?: Record<string, ScaffoldSelectionDecision>;
}

/** Options for {@link dispatchVoidSpecTasks}. */
export interface DispatchOptions {
  /**
   * Optional `runner-voidspec` implementation. When omitted, dispatch always
   * uses native-task conversion. Injecting a stub is the test seam.
   */
  runner?: VoidSpecRunner | null;
  /** Optional scaffold selector inputs. When present, native conversion annotates eligible tasks. */
  scaffoldSelection?: VoidSpecDispatchScaffoldSelection;
  /** Logger seam. Defaults to `console`. */
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export interface VoidSpecDispatchScaffoldSelection {
  variants: ScaffoldVariant[];
  scores?: ScaffoldScore[];
  promptHarnesses?: PromptHarnessContract[];
  now?: string;
}

/**
 * Dispatch mirrored VoidSpec tasks.
 *
 * If a `runner-voidspec` is supplied and reports itself available, the tasks
 * are handed to it. Otherwise the tasks are returned as native AutoClaw tasks
 * (the caller — orchestrator — folds them into a sprint manifest).
 */
export async function dispatchVoidSpecTasks(
  tasks: AutoClawMirroredTask[],
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  const logger = opts.logger ?? console;
  const runner = opts.runner ?? null;
  const selected = applyScaffoldSelection(tasks, opts.scaffoldSelection);

  if (runner) {
    let available = false;
    try {
      available = await runner.isAvailable();
    } catch {
      available = false;
    }
    if (available) {
      logger.info(
        `voidspec: dispatching ${tasks.length} task(s) to ${runner.id}.`,
      );
      const dispatched = await runner.dispatch(selected.tasks);
      return { mode: 'runner', tasks: selected.tasks, dispatched, scaffoldDecisions: selected.decisions };
    }
  }

  // No dispatch API — VoidSpec tasks become native AutoClaw tasks. They are
  // already in `VS-<id>` shared-namespace form, so the orchestrator can fold
  // them straight into a sprint manifest.
  logger.info(
    `voidspec: no runner-voidspec available — ${tasks.length} task(s) ` +
      `converted to native AutoClaw tasks.`,
  );
  return { mode: 'native', tasks: selected.tasks, scaffoldDecisions: selected.decisions };
}

function applyScaffoldSelection(
  tasks: AutoClawMirroredTask[],
  selection: VoidSpecDispatchScaffoldSelection | undefined,
): { tasks: AutoClawMirroredTask[]; decisions?: Record<string, ScaffoldSelectionDecision> } {
  if (!selection) {
    return { tasks };
  }
  const decisions: Record<string, ScaffoldSelectionDecision> = {};
  const annotated = tasks.map((task) => {
    if (!task.intent && !task.preferredScaffold) {
      return task;
    }
    const variants = task.preferredScaffold
      ? selection.variants.filter((variant) => variant.id === task.preferredScaffold)
      : selection.variants;
    if (variants.length === 0 || !task.intent) {
      return task;
    }
    const decision = selectScaffoldVariant({
      intent: task.intent,
      profile: task.constraints?.routingProfile ?? 'balanced',
      variants,
      scores: selection.scores,
      promptHarnesses: selection.promptHarnesses,
      constraints: task.constraints,
      now: selection.now,
    });
    decisions[task.id] = decision;
    if (!decision.selected) {
      return task;
    }
    return {
      ...task,
      selectedScaffold: decision.selected.id,
      scaffoldSelectionReason: decision.reason,
    };
  });
  return Object.keys(decisions).length > 0
    ? { tasks: annotated, decisions }
    : { tasks: annotated };
}

// ---------------------------------------------------------------------------
// .voidspec/ directory watcher
// ---------------------------------------------------------------------------

/** Options for {@link watchVoidSpecDir}. */
export interface VoidSpecWatchOptions {
  /** Workspace root containing the `.voidspec/` directory. */
  workspaceRoot: string;
  /**
   * Called after each successful re-sync with the fresh result. Throwing here
   * is caught and logged — it never crashes the watcher.
   */
  onSync: (result: SyncResult, tasks: AutoClawMirroredTask[]) => void;
  /**
   * Supplies the AutoClaw execution-state snapshot used on each re-sync.
   * Re-evaluated every time so status write-back stays current.
   */
  executionState?: () => ExecutionStateSnapshot;
  /** Polling interval (ms) used by the `fs.watchFile` fallback. Default 2000. */
  pollIntervalMs?: number;
  /** Logger seam. Defaults to `console`. */
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

/** Handle returned by {@link watchVoidSpecDir}. */
export interface VoidSpecWatcher {
  /** Stop watching and release resources. */
  stop(): void;
  /** True when running in the polling fallback (chokidar unavailable). */
  readonly isFallback: boolean;
  /** EventEmitter — emits `synced` (SyncResult) and `error` (Error). */
  readonly events: EventEmitter;
}

/**
 * Watch a workspace's `.voidspec/` directory and auto-re-sync `tasks.yaml`
 * whenever it changes.
 *
 * Prefers `chokidar` for sub-second reactivity; on failure (or absence) it
 * falls back to `fs.watchFile` polling. Never throws after construction.
 */
export function watchVoidSpecDir(opts: VoidSpecWatchOptions): VoidSpecWatcher {
  const logger = opts.logger ?? console;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const tasksPath = resolveTasksYamlPath(opts.workspaceRoot);
  const voidSpecDir = path.join(opts.workspaceRoot, VOIDSPEC_DIR);
  const events = new EventEmitter();

  let stopped = false;
  let isFallback = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chokidarWatcher: any | null = null;
  let watchFileActive = false;
  // Debounce: collapse rapid successive change events into one re-sync.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const runSync = (): void => {
    if (stopped) { return; }
    if (!fs.existsSync(tasksPath)) {
      logger.warn(`voidspec: ${tasksPath} disappeared — skipping re-sync.`);
      return;
    }
    try {
      const exec = opts.executionState?.();
      const syncOpts: SyncOptions = exec ? { executionState: exec } : {};
      const { result, mirrored } = syncVoidSpec(tasksPath, syncOpts);
      events.emit('synced', result);
      try {
        opts.onSync(result, mirrored);
      } catch (cbErr) {
        logger.error(`voidspec: onSync callback threw: ${String(cbErr)}`);
      }
    } catch (err) {
      logger.error(`voidspec: re-sync failed: ${String(err)}`);
      events.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  };

  const scheduleSync = (): void => {
    if (debounceTimer !== null) { clearTimeout(debounceTimer); }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSync();
    }, 150);
  };

  // Ensure the directory exists so the watcher has something to attach to.
  try {
    fs.mkdirSync(voidSpecDir, { recursive: true });
  } catch { /* non-fatal */ }

  // ---- chokidar path -------------------------------------------------------
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chokidar = require('chokidar') as typeof import('chokidar');
    const watcher = chokidar.watch(voidSpecDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    watcher.on('add', (p: string) => {
      if (!stopped && p.endsWith(VOIDSPEC_TASKS_FILE)) { scheduleSync(); }
    });
    watcher.on('change', (p: string) => {
      if (!stopped && p.endsWith(VOIDSPEC_TASKS_FILE)) { scheduleSync(); }
    });
    watcher.on('error', (err: Error) => {
      logger.warn(`voidspec: chokidar error — ${String(err)}`);
      events.emit('error', err);
    });
    chokidarWatcher = watcher;
    logger.info(`voidspec: watching ${voidSpecDir} (chokidar).`);
  } catch (err) {
    // ---- polling fallback --------------------------------------------------
    isFallback = true;
    logger.warn(
      `voidspec: chokidar unavailable (${String(err)}) — polling ${tasksPath}.`,
    );
    try {
      fs.watchFile(tasksPath, { interval: pollIntervalMs }, (curr, prev) => {
        if (stopped) { return; }
        if (curr.mtimeMs !== prev.mtimeMs) { scheduleSync(); }
      });
      watchFileActive = true;
    } catch (wfErr) {
      logger.error(`voidspec: fs.watchFile failed — ${String(wfErr)}`);
    }
  }

  return {
    stop(): void {
      stopped = true;
      if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
      if (chokidarWatcher) {
        void chokidarWatcher.close();
        chokidarWatcher = null;
      }
      if (watchFileActive) {
        fs.unwatchFile(tasksPath);
        watchFileActive = false;
      }
    },
    get isFallback() { return isFallback; },
    get events() { return events; },
  };
}

// ---------------------------------------------------------------------------
// VS Code command — AutoClaw: Sync VoidSpec Tasks
// ---------------------------------------------------------------------------

/** Result surfaced by {@link syncVoidSpecCommand} to the VS Code UI. */
export interface SyncCommandResult {
  /** True when a VoidSpec `tasks.yaml` was found and synced. */
  ran: boolean;
  /** Human-readable summary suitable for an information message. */
  summary: string;
  /** The full sync result, when {@link ran} is true. */
  result?: SyncResult;
  /** The dispatch outcome, when {@link ran} is true. */
  dispatch?: DispatchResult;
}

/** Options for {@link syncVoidSpecCommand}. */
export interface SyncVoidSpecCommandOptions {
  /** Workspace root. */
  workspaceRoot: string;
  /** Optional execution-state snapshot for status write-back. */
  executionState?: ExecutionStateSnapshot;
  /** Optional `runner-voidspec` for dispatch. Omit for native conversion. */
  runner?: VoidSpecRunner | null;
  /** Logger seam. Defaults to `console`. */
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

/**
 * Implementation of the `AutoClaw: Sync VoidSpec Tasks` VS Code command.
 *
 * This is a *plain async function* with no `vscode` import so it stays
 * unit-testable. The extension host wraps it: registers the command, supplies
 * the workspace root, builds the execution-state snapshot from the
 * orchestrator, and shows {@link SyncCommandResult.summary} to the user.
 *
 * TODO(extension): a separate session owns `src/extension.ts`. To wire this
 * command, that session should add to `package.json#contributes.commands`:
 *
 *   { "command": "autoclaw.voidspec.sync",
 *     "title": "AutoClaw: Sync VoidSpec Tasks" }
 *
 * and in `activate()`:
 *
 *   context.subscriptions.push(
 *     vscode.commands.registerCommand('autoclaw.voidspec.sync', async () => {
 *       const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
 *       if (!root) { return; }
 *       const r = await syncVoidSpecCommand({ workspaceRoot: root });
 *       vscode.window.showInformationMessage(r.summary);
 *     }),
 *   );
 */
export async function syncVoidSpecCommand(
  opts: SyncVoidSpecCommandOptions,
): Promise<SyncCommandResult> {
  const logger = opts.logger ?? console;
  const tasksPath = resolveTasksYamlPath(opts.workspaceRoot);

  if (!fs.existsSync(tasksPath)) {
    return {
      ran: false,
      summary:
        `No VoidSpec tasks found — expected ` +
        `${path.join(VOIDSPEC_DIR, VOIDSPEC_TASKS_FILE)} in this workspace.`,
    };
  }

  const syncOpts: SyncOptions = opts.executionState
    ? { executionState: opts.executionState }
    : {};
  const { result, mirrored } = syncVoidSpec(tasksPath, syncOpts);

  const dispatch = await dispatchVoidSpecTasks(mirrored, {
    runner: opts.runner ?? null,
    logger,
  });

  const summary =
    `VoidSpec sync: ${mirrored.length} task(s) — ` +
    `${result.added} new, ${result.writtenBack} written back, ` +
    `${result.conflicts} conflict(s) resolved` +
    (result.voidSpecFileChanged ? ', tasks.yaml updated' : '') +
    `; dispatch mode "${dispatch.mode}".`;

  logger.info(summary);
  return { ran: true, summary, result, dispatch };
}
