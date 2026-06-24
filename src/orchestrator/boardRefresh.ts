/**
 * boardRefresh.ts — L2 real-time board refresh (producer side).
 *
 * The orchestrator loop re-derives board.json once per 30s tick. L2 adds a
 * file-watch fast path: when a board INPUT changes (a claim, heartbeat, consensus
 * stub/verdict, the shared inbox, or state.json), refresh the board within a
 * debounce window instead of waiting up to 30s. The 30s tick stays as the
 * BACKSTOP (catches missed FS events).
 *
 * Two anti-loop guarantees, both proven by the unit tests:
 *   1. {@link makeShouldRefreshBoard} is an ALLOW-LIST (default deny): only the
 *      board's INPUT paths trigger a refresh. The producer's own outputs —
 *      board.json/board.md, the atomic-publish `.tmp-*` siblings, loop-journal,
 *      loop-state, supervisor.lock, comms-log, dispatch sidecars — never do, so a
 *      board write can't retrigger the watcher.
 *   2. {@link refreshBoardNow} writes ONLY board.json/board.md (via writeBoard) —
 *      both excluded — so it produces nothing the allow-list reacts to.
 *
 * {@link refreshBoardNow} reuses the L1 single-active gate (acquire the supervisor
 * lease, write only when isActiveManager) so a standby host's watch event writes
 * NOTHING — real-time refresh stays single-active for free. It is deliberately
 * LIGHTER than a full tick: it does NOT dispatch, heal, tally, or ingest, so a
 * file change never spawns runners or bloats the loop journal.
 *
 * Host-free (no vscode): the timers and the refresh action are injectable, so the
 * debounce/coalescing + gating are tested deterministically. The thin vscode
 * FileSystemWatcher wiring lives in extension.ts.
 */

import { acquireSupervisorRole } from './supervisorLease';
import { writeBoard } from './boardWriter';

export const DEFAULT_BOARD_REFRESH_DEBOUNCE_MS = 300;
export const MIN_BOARD_REFRESH_DEBOUNCE_MS = 100;
/** Force a refresh at least this often under continuous churn (anti-starvation). */
export const DEFAULT_BOARD_REFRESH_MAX_WAIT_MS = 2_000;

type TimerHandle = ReturnType<typeof setTimeout>;

// ---------------------------------------------------------------------------
// Anti-loop change filter (allow-list, default deny)
// ---------------------------------------------------------------------------

/**
 * Build the predicate that decides whether a changed path means the board is
 * stale. ALLOW-LIST: returns true only for the inputs `writeBoard` derives the
 * board from. Everything else under `orchestrator/` — crucially the board files
 * themselves and the atomic-publish `.tmp-*` siblings — returns false, so the
 * producer's writes can never form a watch→write→watch loop.
 */
export function makeShouldRefreshBoard(): (filePath: string) => boolean {
  const ANCHOR = '/.autoclaw/orchestrator/';
  return (filePath: string): boolean => {
    if (typeof filePath !== 'string' || filePath === '') { return false; }
    const norm = filePath.replace(/\\/g, '/');
    // Atomic-publish temp siblings (board.json.tmp-<pid>-<seq>) appear as
    // transient create/delete events — never react to them.
    if (norm.includes('.tmp-')) { return false; }
    const at = norm.lastIndexOf(ANCHOR);
    if (at < 0) { return false; }
    // Path RELATIVE to .autoclaw/orchestrator/, matched by exact segments +
    // basename (NOT loose substring) so a future rename can't silently reopen a
    // watch loop. Default deny: only the inputs writeBoard derives the board from
    // pass. The producer's own outputs (board.json/board.md, loop-state.json,
    // loop-journal.jsonl, comms-log.jsonl, supervisor.lock.json, dispatch
    // sidecars under agents/_*) all fall through to `false`.
    const segs = norm.slice(at + ANCHOR.length).split('/');
    const base = segs[segs.length - 1];
    if (!base.endsWith('.json')) { return false; }
    // Root level: only state.json (board.json/board.md fall through).
    if (segs.length === 1) { return base === 'state.json'; }
    if (segs[0] !== 'comms') { return false; }
    switch (segs[1]) {
      case 'claims':     return true;
      case 'heartbeats': return true;
      case 'consensus':  return segs[2] === 'active' || segs[2] === 'resolved' || segs[2] === 'results';
      case 'inboxes':    return segs[2] === 'shared';
      case 'agents':
        // Per-agent claim files only, in a real agent dir — never the `_dispatch`
        // / `_reaped` sidecar dirs (mirrors boardWriter.readClaims skipping `_*`).
        return segs.length >= 4 && !segs[2].startsWith('_') && /^claim-.+\.json$/.test(base);
      default:           return false;
    }
  };
}

// ---------------------------------------------------------------------------
// Gated board write (the watch action)
// ---------------------------------------------------------------------------

/** Result of a {@link refreshBoardNow} attempt. */
export interface RefreshBoardResult {
  /** True when this host wrote the board this call. */
  refreshed: boolean;
  /** True when the host stood by (another supervisor holds the lease). */
  standby: boolean;
}

/**
 * Refresh the board NOW, reusing the L1 single-active gate. Acquire the supervisor
 * lease (under the loop's own holder id so it renews the same lease, not a rival),
 * and only when this host is the active manager write the board. A standby writes
 * nothing. Lighter than a full tick: writeBoard only — no dispatch/heal/tally/
 * ingest, so a file change never spawns runners. Best-effort: never throws.
 *
 * `holderId` MUST be the loop's `LOOP_INSTANCE_ID` so the watch path and the 30s
 * tick share one lease (same holder ⇒ renew, never steal from each other).
 */
export async function refreshBoardNow(opts: {
  workspaceRoot: string;
  holderId: string;
  singleActive?: boolean;
  fencing?: boolean;
}): Promise<RefreshBoardResult> {
  const { workspaceRoot, holderId } = opts;
  if (!workspaceRoot) { return { refreshed: false, standby: false }; }
  const singleActive = opts.singleActive ?? true;
  const fencing = opts.fencing ?? false;

  let isActiveManager = !singleActive;
  if (!isActiveManager) {
    try {
      const sup = await acquireSupervisorRole(workspaceRoot, holderId, { fencing });
      isActiveManager = sup.isSupervisor;
    } catch {
      // Degrade to a safe standby on a lease read/write error: prefer skipping a
      // refresh over a possible double-write. The 30s tick backstop self-corrects.
      isActiveManager = false;
    }
  }
  if (!isActiveManager) { return { refreshed: false, standby: true }; }

  try {
    await writeBoard({ workspaceRoot, generator: 'board-watch' });
    return { refreshed: true, standby: false };
  } catch {
    return { refreshed: false, standby: false };
  }
}

// ---------------------------------------------------------------------------
// Debounce + coalesce engine
// ---------------------------------------------------------------------------

/** Options for {@link startBoardRefreshService}. */
export interface BoardRefreshOptions {
  /** The refresh action (the vscode wrapper passes a refreshBoardNow closure). */
  refresh: () => Promise<unknown>;
  /** Quiet window before a refresh fires. Clamped to >= {@link MIN_BOARD_REFRESH_DEBOUNCE_MS}. */
  debounceMs?: number;
  /**
   * Force a refresh at least this often even under continuous churn (prevents
   * trailing-debounce starvation). 0 or Infinity disables the cap.
   */
  maxWaitMs?: number;
  /** Injectable change filter (defaults to {@link makeShouldRefreshBoard}). */
  shouldRefresh?: (filePath: string) => boolean;
  /** Injectable timer (tests). Default `setTimeout`. */
  setTimeoutFn?: (cb: () => void, ms: number) => TimerHandle;
  /** Injectable timer clearer (tests). Default `clearTimeout`. */
  clearTimeoutFn?: (h: TimerHandle) => void;
  log?: (msg: string) => void;
}

/** A running board-refresh service. */
export interface BoardRefreshHandle {
  readonly running: boolean;
  /** Number of completed refresh runs. */
  readonly runs: number;
  /** True when a change is debouncing toward a refresh. */
  readonly pending: boolean;
  /** Feed a changed path. Schedules a debounced refresh when it's a board input. */
  notifyChange(filePath: string): void;
  /** Run any pending refresh now (tests + manual flush). */
  flushNow(): Promise<void>;
  /** Stop the timers. Idempotent. */
  stop(): void;
}

function noop(): void { /* no-op log */ }

/**
 * Start the board-refresh service. Returns immediately; call `notifyChange(path)`
 * for each comms change (the vscode wrapper wires a FileSystemWatcher to it).
 * One refresh in flight at a time (overlapping changes coalesce); a change mid-run
 * schedules exactly one follow-up; under continuous churn `maxWaitMs` forces a
 * refresh so it never starves. Never throws.
 */
export function startBoardRefreshService(opts: BoardRefreshOptions): BoardRefreshHandle {
  const log = opts.log ?? noop;
  const debounceMs = Math.max(opts.debounceMs ?? DEFAULT_BOARD_REFRESH_DEBOUNCE_MS, MIN_BOARD_REFRESH_DEBOUNCE_MS);
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_BOARD_REFRESH_MAX_WAIT_MS;
  const maxWaitEnabled = Number.isFinite(maxWaitMs) && maxWaitMs > 0;
  const setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h));
  const shouldRefresh = opts.shouldRefresh ?? makeShouldRefreshBoard();
  const refresh = opts.refresh;

  const state = { running: true, runs: 0, pending: false, inFlight: false };
  let timer: TimerHandle | null = null;
  let maxTimer: TimerHandle | null = null;

  function clearOne(h: TimerHandle | null): null {
    if (h !== null) { try { clearTimeoutFn(h); } catch { /* ignore */ } }
    return null;
  }

  async function run(): Promise<void> {
    timer = clearOne(timer);
    maxTimer = clearOne(maxTimer);
    if (!state.running || state.inFlight) { return; }
    if (!state.pending) { return; }
    state.pending = false;
    state.inFlight = true;
    try {
      await refresh();
      state.runs += 1;
    } catch (err) {
      log(`board-watch: refresh failed — ${(err as Error).message}`);
    } finally {
      state.inFlight = false;
      // A change arrived mid-run — schedule a follow-up.
      if (state.running && state.pending) { arm(); }
    }
  }

  function arm(): void {
    timer = clearOne(timer);
    timer = setTimeoutFn(() => { timer = null; void run(); }, debounceMs);
    // Arm the max-wait ceiling once per debounce burst so continuous churn that
    // keeps re-arming `timer` still fires within maxWaitMs.
    if (maxWaitEnabled && maxTimer === null) {
      maxTimer = setTimeoutFn(() => { maxTimer = null; void run(); }, maxWaitMs);
    }
  }

  function notifyChange(filePath: string): void {
    if (!state.running) { return; }
    if (!shouldRefresh(filePath)) { return; }
    state.pending = true;
    if (!state.inFlight) { arm(); }
  }

  async function flushNow(): Promise<void> {
    timer = clearOne(timer);
    maxTimer = clearOne(maxTimer);
    await run();
  }

  function stop(): void {
    if (!state.running) { return; }
    state.running = false;
    state.pending = false;
    timer = clearOne(timer);
    maxTimer = clearOne(maxTimer);
    log('board-watch: stopped');
  }

  log(`board-watch: started (debounce ${debounceMs}ms, maxWait ${maxWaitEnabled ? maxWaitMs + 'ms' : 'off'})`);

  return {
    get running() { return state.running; },
    get runs() { return state.runs; },
    get pending() { return state.pending; },
    notifyChange,
    flushNow,
    stop,
  };
}
