/**
 * refreshService.ts — standalone, tick-based refresh for per-host project
 * context digests (Channel C). Completes the "ambient/refreshed" promise for the
 * case where intel drifts WITHOUT an explicit command — e.g. the KDream
 * background agent updates MEMORY.md, or new commits change what code retrieval
 * surfaces. The command-triggered refresh (after `/learn` + `/index-code`) keeps
 * digests current when you act; this service keeps them current while you don't.
 *
 * It refreshes only digests that already exist (`onlyExisting`), so it never
 * creates files as a side effect — a host opts in by running the
 * `autoclaw.intelligence.hostContext` command once.
 *
 * Host-free (no `vscode` import). The timer and the refresh action are
 * injectable so the loop is fully testable without real timers or a backend.
 * Bounded by design: it's a single interval the caller `stop()`s on deactivation
 * — overlapping ticks are skipped, and every tick is best-effort (never throws).
 */

import { LogFn } from './config';
import { IntelligenceConfig } from './types';
import { WriteHostContextResult, writeHostContextFiles } from './hostContext';

/** Default refresh cadence (30 min) and the floor we clamp to (1 min). */
export const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60_000;
export const MIN_REFRESH_INTERVAL_MS = 60_000;

type TimerHandle = ReturnType<typeof setInterval>;

/** Options for {@link startIntelligenceRefreshService}. */
export interface RefreshServiceOptions {
  /** Directory that contains `.autoclaw`. */
  workspaceRoot: string;
  /** Tick cadence in ms. Clamped to >= {@link MIN_REFRESH_INTERVAL_MS}. */
  intervalMs?: number;
  /** Pre-resolved config (forwarded to the refresh). */
  config?: IntelligenceConfig;
  /** Optional log sink. */
  log?: LogFn;
  /** Run an immediate tick on start. Defaults to true. */
  tickOnStart?: boolean;
  /** Injectable refresh action (defaults to per-host `onlyExisting` refresh). */
  refresh?: () => Promise<WriteHostContextResult>;
  /** Injectable timer setter (tests). Defaults to `setInterval`. */
  setIntervalFn?: (cb: () => void, ms: number) => TimerHandle;
  /** Injectable timer clearer (tests). Defaults to `clearInterval`. */
  clearIntervalFn?: (handle: TimerHandle) => void;
}

/** A running refresh service. */
export interface RefreshServiceHandle {
  /** True until {@link stop} is called. */
  readonly running: boolean;
  /** Number of completed (non-skipped) ticks. */
  readonly ticks: number;
  /** ISO timestamp of the last completed tick, or null. */
  readonly lastTickAt: string | null;
  /** The effective (clamped) interval in ms. */
  readonly intervalMs: number;
  /** Run one refresh now. Returns null when stopped or a tick is already in flight. */
  tickNow(): Promise<WriteHostContextResult | null>;
  /** Stop the timer. Idempotent. */
  stop(): void;
}

function noop(): void {
  /* no-op log */
}

/**
 * Start the refresh service. Returns immediately with a handle; the first tick
 * runs asynchronously (unless `tickOnStart` is false). Never throws.
 */
export function startIntelligenceRefreshService(opts: RefreshServiceOptions): RefreshServiceHandle {
  const log = opts.log ?? noop;
  const intervalMs = Math.max(opts.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS, MIN_REFRESH_INTERVAL_MS);
  const setIntervalFn = opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h));
  const refresh =
    opts.refresh ??
    (() => writeHostContextFiles(opts.workspaceRoot, { onlyExisting: true, config: opts.config, log }));

  const state = { running: true, ticks: 0, lastTickAt: null as string | null, inFlight: false };

  async function tickNow(): Promise<WriteHostContextResult | null> {
    if (!state.running || state.inFlight) {
      return null; // stopped, or a previous tick hasn't finished — skip (no overlap)
    }
    state.inFlight = true;
    try {
      const res = await refresh();
      state.ticks += 1;
      state.lastTickAt = new Date().toISOString();
      if (res.written.length > 0) {
        log(`refresh-service: refreshed ${res.written.map((w) => w.id).join(', ')}`);
      }
      return res;
    } catch (err) {
      log(`refresh-service: tick failed — ${(err as Error).message}`);
      return null;
    } finally {
      state.inFlight = false;
    }
  }

  const timer = setIntervalFn(() => {
    void tickNow();
  }, intervalMs);

  function stop(): void {
    if (!state.running) {
      return;
    }
    state.running = false;
    try {
      clearIntervalFn(timer);
    } catch {
      /* ignore */
    }
    log('refresh-service: stopped');
  }

  if (opts.tickOnStart !== false) {
    void tickNow();
  }

  log(`refresh-service: started (every ${Math.round(intervalMs / 1000)}s)`);

  return {
    get running() {
      return state.running;
    },
    get ticks() {
      return state.ticks;
    },
    get lastTickAt() {
      return state.lastTickAt;
    },
    get intervalMs() {
      return intervalMs;
    },
    tickNow,
    stop,
  };
}
