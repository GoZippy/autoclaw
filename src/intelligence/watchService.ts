/**
 * watchService.ts — always-on incremental code re-index as you work.
 *
 * Today the vector index is refreshed only by the `/index-code` command. This
 * service watches the workspace and, after a quiet debounce window, runs an
 * INCREMENTAL re-index so retrieval / context packs stay current without manual
 * runs. Re-index is cheap (git-diff watermark picks up only changed files).
 *
 * Critical: the path filter EXCLUDES `.autoclaw/` and the configured ignored
 * dirs, so the index's own writes (`.autoclaw/vector/db.sqlite`, …) can't
 * re-trigger the watcher — no feedback loop.
 *
 * Host-free (no `vscode`). The timer and the re-index action are injectable, so
 * the debounce/coalescing logic is tested deterministically with no real timers
 * or backend. Bounded by design: a single debounce timer the caller `stop()`s;
 * overlapping re-indexes are coalesced (one in flight at a time), and every run
 * is best-effort (never throws).
 */

import { LogFn } from './config';
import { IntelligenceConfig } from './types';

export const DEFAULT_WATCH_DEBOUNCE_MS = 5_000;
export const MIN_WATCH_DEBOUNCE_MS = 1_000;

type TimerHandle = ReturnType<typeof setTimeout>;

/** Build the change filter: only source files, never `.autoclaw/` or ignored dirs. */
export function makeShouldIndex(config: IntelligenceConfig): (filePath: string) => boolean {
  const exts = config.rag.fileExtensions.map((e) => e.toLowerCase());
  const ignored = new Set(config.rag.ignoredDirs);
  return (filePath: string): boolean => {
    if (typeof filePath !== 'string' || filePath === '') { return false; }
    const norm = filePath.replace(/\\/g, '/');
    const segments = norm.split('/');
    // Never react to AutoClaw's own data (prevents an index→write→watch loop).
    if (segments.includes('.autoclaw')) { return false; }
    if (segments.some((s) => ignored.has(s))) { return false; }
    const lower = norm.toLowerCase();
    return exts.some((ext) => lower.endsWith(ext));
  };
}

/** Options for {@link startIndexWatchService}. */
export interface IndexWatchOptions {
  workspaceRoot: string;
  /** Quiet window before a re-index fires. Clamped to >= {@link MIN_WATCH_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** Pre-resolved config (drives the path filter + forwarded to re-index). */
  config?: IntelligenceConfig;
  log?: LogFn;
  /** Injectable re-index action (defaults to incremental `indexCodebase`). */
  reindex?: () => Promise<unknown>;
  /** Injectable change filter (defaults to {@link makeShouldIndex}). */
  shouldIndex?: (filePath: string) => boolean;
  /** Injectable timer (tests). Default `setTimeout`. */
  setTimeoutFn?: (cb: () => void, ms: number) => TimerHandle;
  /** Injectable timer clearer (tests). Default `clearTimeout`. */
  clearTimeoutFn?: (h: TimerHandle) => void;
}

/** A running index-watch service. */
export interface IndexWatchHandle {
  readonly running: boolean;
  /** Number of completed re-index runs. */
  readonly runs: number;
  /** True when a change is debouncing toward a run. */
  readonly pending: boolean;
  /** Feed a changed path. Schedules a debounced re-index when it's a source file. */
  notifyChange(filePath: string): void;
  /** Run any pending re-index now (used by tests + manual flush). */
  flushNow(): Promise<void>;
  /** Stop the timer. Idempotent. */
  stop(): void;
}

function noop(): void {
  /* no-op log */
}

/**
 * Start the index-watch service. Returns immediately; call `notifyChange(path)`
 * for each workspace change (the vscode wrapper wires a FileSystemWatcher to it).
 * Never throws.
 */
export function startIndexWatchService(opts: IndexWatchOptions): IndexWatchHandle {
  const log = opts.log ?? noop;
  const debounceMs = Math.max(opts.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS, MIN_WATCH_DEBOUNCE_MS);
  const setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h));
  const shouldIndex =
    opts.shouldIndex ?? (opts.config ? makeShouldIndex(opts.config) : () => true);
  const reindex =
    opts.reindex ??
    (async () => {
      // Lazy import keeps this module's load free of the RAG/vector stack.
      const { indexCodebase } = await import('./ragCode');
      return indexCodebase({ workspaceRoot: opts.workspaceRoot, force: false, config: opts.config, log });
    });

  const state = { running: true, runs: 0, pending: false, inFlight: false };
  let timer: TimerHandle | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      try { clearTimeoutFn(timer); } catch { /* ignore */ }
      timer = null;
    }
  }

  async function run(): Promise<void> {
    if (!state.running || state.inFlight) {
      return; // stopped, or a run is already underway — coalesce
    }
    if (!state.pending) {
      return;
    }
    state.pending = false;
    state.inFlight = true;
    try {
      await reindex();
      state.runs += 1;
      log('watch: incremental re-index complete');
    } catch (err) {
      log(`watch: re-index failed — ${(err as Error).message}`);
    } finally {
      state.inFlight = false;
      // A change that arrived mid-run set pending again — schedule a follow-up.
      if (state.running && state.pending) {
        arm();
      }
    }
  }

  function arm(): void {
    clearTimer();
    timer = setTimeoutFn(() => {
      timer = null;
      void run();
    }, debounceMs);
  }

  function notifyChange(filePath: string): void {
    if (!state.running) { return; }
    if (!shouldIndex(filePath)) { return; }
    state.pending = true;
    if (!state.inFlight) { arm(); }
  }

  async function flushNow(): Promise<void> {
    clearTimer();
    await run();
  }

  function stop(): void {
    if (!state.running) { return; }
    state.running = false;
    clearTimer();
    log('watch: stopped');
  }

  log(`watch: started (debounce ${Math.round(debounceMs / 1000)}s)`);

  return {
    get running() { return state.running; },
    get runs() { return state.runs; },
    get pending() { return state.pending; },
    notifyChange,
    flushNow,
    stop,
  };
}
