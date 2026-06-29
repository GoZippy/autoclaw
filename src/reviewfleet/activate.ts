/**
 * reviewfleet/activate.ts — RF-4d: Review Fleet Activation Controller
 *
 * Manages the lifecycle of the Review Fleet watcher (start / stop / status).
 * The fleet stays DORMANT unless explicitly enabled AND funded.
 *
 * KEY INVARIANT: if config.enabled === false, start() fires runWatcher with
 * enabled=false. The watcher's own DORMANT gate returns { cycles:0, summaries:[] }
 * immediately — no scan, no dispatch, $0 spend.
 *
 * All heavy production dependencies are resolved lazily via await import() on
 * the first call to start(), so tests can inject fakes without ever loading
 * the real modules.
 *
 * Do NOT call real models, do NOT import vscode, do NOT register commands here.
 * The parent extension.ts wires the VS Code command registration.
 */

import type { ReviewerCapacity } from './roster';
import type { ReviewFleetWatcherDeps, StartWatcherOpts } from './watcher';

/* -------------------------------------------------------------------------- */
/*  Public config                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Configuration the VS Code command (or any caller) passes to
 * ReviewFleetController.start().
 */
export interface ReviewFleetActivateConfig {
  /** Master kill switch — must be true for the watcher to scan anything. */
  enabled: boolean;
  /** Spend ceiling in US cents. Both gates (enabled + budget) must pass. */
  budgetCents: number;
  /** Milliseconds between watcher cycles. Defaults to watcher's own default (15 s). */
  intervalMs?: number;
  /** Maximum number of cycles before the watcher stops itself. */
  maxCycles?: number;
  /** Agent identifier stamped on vote files. */
  agentId?: string;
  /** Session identifier stamped on vote files. */
  sessionId?: string;
}

/* -------------------------------------------------------------------------- */
/*  Injectable deps                                                            */
/* -------------------------------------------------------------------------- */

/**
 * All production IO is injectable so tests never load heavy modules.
 * Defaults are resolved lazily (await import) on the first start() call.
 */
export interface ReviewFleetActivateDeps {
  /**
   * Build the reviewer roster for the given workspace.
   * Default: buildReviewerRoster(defaultRosterDeps(workspaceRoot))
   */
  buildRoster: (workspaceRoot: string) => Promise<ReviewerCapacity[]>;

  /**
   * Build the watcher deps object that configures inbox scanning, dispatch,
   * and the inner ReviewFleetDeps.
   * Default: defaultReviewFleetWatcherDeps
   */
  buildWatcherDeps: (args: {
    workspaceRoot: string;
    roster: ReviewerCapacity[];
    enabled?: boolean;
    budgetCents?: number;
    sessionId?: string;
    agentId?: string;
    commsDir?: string;
  }) => ReviewFleetWatcherDeps;

  /**
   * Run the bounded watcher loop.
   * Default: startReviewFleetWatcher
   */
  runWatcher: (opts: StartWatcherOpts) => Promise<{ cycles: number; summaries: unknown[] }>;

  /** Optional log sink. Defaults to console.log. */
  log?: (msg: string) => void;
}

/* -------------------------------------------------------------------------- */
/*  Lazy default loader                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the production defaults exactly once.  Called only on first start(),
 * never at module load time, so tests that inject fakes never trigger the
 * real imports.
 */
async function loadProductionDefaults(): Promise<ReviewFleetActivateDeps> {
  const [rosterMod, inboxMod, watcherMod] = await Promise.all([
    import('./roster'),
    import('./inbox'),
    import('./watcher'),
  ]);

  return {
    buildRoster: (workspaceRoot: string) =>
      rosterMod.buildReviewerRoster(rosterMod.defaultRosterDeps(workspaceRoot)),

    buildWatcherDeps: (args) =>
      inboxMod.defaultReviewFleetWatcherDeps(args),

    runWatcher: watcherMod.startReviewFleetWatcher,
  };
}

/* -------------------------------------------------------------------------- */
/*  ReviewFleetController                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Lifecycle controller for the Review Fleet watcher.
 *
 * One instance per VS Code workspace.  The parent extension creates one,
 * registers commands that call start() / stop(), and holds the reference for
 * the session lifetime.
 *
 * Thread-safety note: VS Code extension host is single-threaded (Node.js
 * event loop), so no synchronisation primitives are needed.
 */
export class ReviewFleetController {
  private readonly _overrides: Partial<ReviewFleetActivateDeps>;
  private _deps: ReviewFleetActivateDeps | undefined;

  // Lifecycle state
  private _running = false;
  private _stopped = false;
  private _loop: Promise<void> | undefined;
  private _currentConfig: ReviewFleetActivateConfig | undefined;

  constructor(deps?: Partial<ReviewFleetActivateDeps>) {
    this._overrides = deps ?? {};
  }

  /* ---------------------------------------------------------------------- */
  /*  start()                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Start the Review Fleet watcher for the given workspace.
   *
   * Returns immediately (fire-and-forget loop).  The watcher itself is
   * bounded by maxCycles and the shouldStop gate set by stop().
   *
   * With config.enabled === false: runWatcher receives enabled=false and
   * returns { cycles:0, summaries:[] } immediately — no scan, no model call,
   * $0 spend.  The controller still transitions to "running" so stop() works
   * symmetrically, but the loop resolves on the next tick.
   */
  async start(
    workspaceRoot: string,
    config: ReviewFleetActivateConfig,
  ): Promise<{ started: boolean; reason: string }> {
    if (this._running) {
      this._log('review fleet already running');
      return { started: false, reason: 'review fleet already running' };
    }

    // Resolve production defaults lazily on first start.
    if (!this._deps) {
      const defaults = await loadProductionDefaults();
      this._deps = {
        buildRoster: this._overrides.buildRoster ?? defaults.buildRoster,
        buildWatcherDeps: this._overrides.buildWatcherDeps ?? defaults.buildWatcherDeps,
        runWatcher: this._overrides.runWatcher ?? defaults.runWatcher,
        log: this._overrides.log ?? defaults.log,
      };
    }

    const deps = this._deps;

    // Build reviewer roster (failure is non-fatal — watcher marks humanRequired).
    let roster: ReviewerCapacity[];
    try {
      roster = await deps.buildRoster(workspaceRoot);
    } catch (err) {
      this._log(`buildRoster threw: ${String(err)} — continuing with empty roster`);
      roster = [];
    }

    if (roster.length === 0) {
      this._log('warning: reviewer roster is empty — all reviews will be humanRequired');
    }

    // Wire the watcher seams.
    const watcherDeps = deps.buildWatcherDeps({
      workspaceRoot,
      roster,
      enabled: config.enabled,
      budgetCents: config.budgetCents,
      sessionId: config.sessionId,
      agentId: config.agentId,
    });

    // Arm lifecycle flags.
    this._running = true;
    this._stopped = false;
    this._currentConfig = config;

    const log = this._log.bind(this);

    // Fire-and-forget: the watcher loop runs until shouldStop() or maxCycles.
    this._loop = deps
      .runWatcher({
        ...watcherDeps,
        enabled: config.enabled,
        maxCycles: config.maxCycles,
        intervalMs: config.intervalMs,
        shouldStop: () => this._stopped,
      })
      .then((r) => {
        this._running = false;
        log(`watcher finished after ${r.cycles} cycle(s)`);
      })
      .catch((e: unknown) => {
        this._running = false;
        log(`watcher error: ${String(e)}`);
      });

    const reason = config.enabled
      ? `watcher started (budget ${config.budgetCents}c, interval ${config.intervalMs ?? 'default'}ms)`
      : 'started DORMANT (enabled=false → no scan, no dispatch, $0)';

    this._log(reason);
    return { started: true, reason };
  }

  /* ---------------------------------------------------------------------- */
  /*  stop()                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Signal the watcher to stop at its next cycle boundary.
   *
   * Returns { stopped: true } if the watcher was running, { stopped: false }
   * if it was not.  In both cases the shouldStop gate is armed.
   */
  stop(): { stopped: boolean } {
    const wasRunning = this._running;
    this._stopped = true;
    if (wasRunning) {
      this._log('stop() called — watcher will halt at next cycle boundary');
    } else {
      this._log('stop() called but watcher is not running');
    }
    return { stopped: wasRunning };
  }

  /* ---------------------------------------------------------------------- */
  /*  isRunning() / status()                                                 */
  /* ---------------------------------------------------------------------- */

  /** True while the watcher loop promise is unresolved. */
  isRunning(): boolean {
    return this._running;
  }

  /**
   * Snapshot of controller state.  Returns the last config when running;
   * no config when idle.
   */
  status(): { running: boolean; config?: ReviewFleetActivateConfig } {
    if (this._running) {
      return { running: true, config: this._currentConfig };
    }
    return { running: false };
  }

  /* ---------------------------------------------------------------------- */
  /*  Private helpers                                                        */
  /* ---------------------------------------------------------------------- */

  private _log(msg: string): void {
    const sink = this._overrides.log ?? console.log;
    sink(`[ReviewFleetController] ${msg}`);
  }
}
