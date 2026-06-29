/**
 * reviewfleet/watcher.ts — RF-4b: Review Fleet Watcher Loop
 *
 * Provides a bounded, dormant-by-default watcher that scans for pending
 * review_request messages and dispatches each one through processReviewRequest.
 *
 * DORMANT GATE: If `enabled` is false (the default), startReviewFleetWatcher
 * returns immediately without calling scanPendingRequests at all. No scan,
 * no dispatch, no model call can occur unless the caller explicitly passes
 * `enabled: true`.
 *
 * Per-request error isolation: a failure in processReviewRequest increments
 * the errors counter and skips markProcessed for that request, but the cycle
 * continues to the next request. A single bad message never aborts the cycle.
 *
 * No real IO here. All IO seams are injectable (scanPendingRequests,
 * markProcessed, deps). Tests stub everything offline.
 */

import { processReviewRequest } from './service';
import type { ReviewFleetDeps } from './service';
import type { ReviewContext } from './router';
import type { ScaffoldVariant } from '../workflows/scaffolds/types';

/* -------------------------------------------------------------------------- */
/*  Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Minimal descriptor for a pending review_request message read from an inbox.
 * Production code populates this by reading the inbox JSON files; tests inject
 * arrays directly.
 */
export interface PendingReviewRequest {
  /** Message id (used for idempotency in markProcessed). */
  id: string;
  /** The task this review covers. */
  taskId: string;
  /** Optional scaffold variant from the message payload. */
  scaffold?: ScaffoldVariant;
  /** Optional routing context from the message payload. */
  ctx?: ReviewContext;
}

/**
 * Injectable seams for ReviewFleetWatcher.
 * All heavy IO lives here so the watcher is fully unit-testable offline.
 */
export interface ReviewFleetWatcherDeps {
  /** Production deps from defaultReviewFleetDeps — carries roster + dispatch. */
  deps: ReviewFleetDeps;
  /**
   * Scan for pending review_request messages.
   * Production: reads .autoclaw/orchestrator/comms/inboxes/shared/ for
   * type='review_request' files that are not yet in processed/.
   * Tests: return a static array.
   */
  scanPendingRequests: () => Promise<PendingReviewRequest[]>;
  /**
   * Mark a message as processed (move to processed/ or write state file).
   * Called EXACTLY ONCE per successfully processed request.
   * Never called when processReviewRequest throws.
   */
  markProcessed: (id: string) => Promise<void>;
  /**
   * Fallback scaffold factory used when a pending request carries no scaffold.
   * When absent, the built-in SAFE_DEFAULT_SCAFFOLD is used instead.
   */
  defaultScaffold?: () => ScaffoldVariant;
  /** Timestamp factory. Defaults to new Date().toISOString(). */
  now?: () => string;
  /** Log sink. Defaults to console.log. */
  log?: (msg: string) => void;
}

/**
 * Per-cycle statistics returned by runReviewFleetCycle and accumulated in
 * startReviewFleetWatcher.
 */
export interface ReviewFleetCycleSummary {
  /** Number of pending requests found by scanPendingRequests. */
  scanned: number;
  /** Requests that completed without throwing AND were markProcessed. */
  processed: number;
  /** Subset of processed where processReviewRequest returned a vote. */
  voted: number;
  /** Subset of processed where processReviewRequest returned humanRequired=true. */
  humanRequired: number;
  /** Requests that threw an error; NOT marked processed (eligible for retry). */
  errors: number;
}

/* -------------------------------------------------------------------------- */
/*  Built-in safe-default scaffold                                            */
/* -------------------------------------------------------------------------- */

/**
 * Conservative scaffold used when neither the request nor the watcher provides
 * a defaultScaffold.  tier1-local + different-provider + gatesFirst ensures
 * the cheapest, safest path and prevents any silent approve.
 */
const SAFE_DEFAULT_SCAFFOLD: ScaffoldVariant = {
  schema: 'autoclaw.scaffold.v1' as const,
  id: 'watcher-default-scaffold',
  workflowId: 'watcher-default',
  taskIntent: 'code',
  routerProfile: 'balanced',
  toolLaneIds: [],
  createdAt: '1970-01-01T00:00:00.000Z',
  review: {
    tier: 'tier1-local',
    reviewerIndependence: 'different-provider',
    gatesFirst: true,
  },
};

/* -------------------------------------------------------------------------- */
/*  runReviewFleetCycle                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Run a single watcher cycle: scan, dispatch each request, tally results.
 *
 * Never throws — all per-request errors are caught and counted.
 * markProcessed is called exactly once per successfully handled request.
 */
export async function runReviewFleetCycle(
  w: ReviewFleetWatcherDeps,
): Promise<ReviewFleetCycleSummary> {
  const log = w.log ?? ((msg: string) => console.log(`[ReviewFleetWatcher] ${msg}`));
  const summary: ReviewFleetCycleSummary = {
    scanned: 0,
    processed: 0,
    voted: 0,
    humanRequired: 0,
    errors: 0,
  };

  let pending: PendingReviewRequest[];
  try {
    pending = await w.scanPendingRequests();
  } catch (err) {
    // If the scan itself throws, log and return an empty summary.
    // This is a systemic failure (e.g. filesystem unavailable) — do not retry individual items.
    log(`scan failed: ${String(err)}`);
    summary.errors += 1;
    return summary;
  }

  summary.scanned = pending.length;

  for (const req of pending) {
    // Resolve scaffold: request > injected factory > built-in safe default
    const scaffold: ScaffoldVariant =
      req.scaffold ??
      w.defaultScaffold?.() ??
      SAFE_DEFAULT_SCAFFOLD;

    try {
      const result = await processReviewRequest(
        { scaffold, taskId: req.taskId, ctx: req.ctx },
        w.deps,
      );

      // Tally outcome
      summary.processed += 1;
      if (result.vote !== undefined) {
        summary.voted += 1;
      }
      if (result.humanRequired) {
        summary.humanRequired += 1;
      }

      // Mark processed exactly once, after a successful result
      await w.markProcessed(req.id);
    } catch (err) {
      // Isolate the error — this request will be retried next cycle
      summary.errors += 1;
      log(`error processing request ${req.id} (task ${req.taskId}): ${String(err)}`);
      // Do NOT call markProcessed — the message stays eligible for retry
    }
  }

  return summary;
}

/* -------------------------------------------------------------------------- */
/*  startReviewFleetWatcher                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Options for startReviewFleetWatcher, extending all watcher deps.
 */
export interface StartWatcherOpts extends ReviewFleetWatcherDeps {
  /**
   * DORMANT GATE — must be explicitly true to run.
   * DEFAULT FALSE: if omitted or false, the watcher returns immediately without
   * calling scanPendingRequests even once.
   */
  enabled?: boolean;
  /**
   * Maximum number of cycles to run before stopping.
   * DEFAULT 50.
   */
  maxCycles?: number;
  /**
   * Milliseconds to wait between cycles.
   * DEFAULT 15000 (15 seconds).
   */
  intervalMs?: number;
  /**
   * Checked at the START of each cycle (before running it).
   * If it returns true, the loop stops immediately without running that cycle.
   */
  shouldStop?: () => boolean;
  /**
   * Injectable sleep function. Defaults to real setTimeout-based sleep.
   * Inject an instant no-op in tests to avoid real delays.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Bounded watcher loop for the Review Fleet.
 *
 * PRIMARY INVARIANT:
 *   If opts.enabled is false (the default), returns { cycles: 0, summaries: [] }
 *   IMMEDIATELY without calling scanPendingRequests at all.
 *
 * When enabled:
 *   Runs up to maxCycles cycles. Each cycle:
 *     1. Check shouldStop() — if true, break before running the cycle.
 *     2. Run runReviewFleetCycle(opts).
 *     3. After each cycle (except the last), sleep intervalMs.
 *
 * Never throws. Returns accumulated cycle count and per-cycle summaries.
 */
export async function startReviewFleetWatcher(
  opts: StartWatcherOpts,
): Promise<{ cycles: number; summaries: ReviewFleetCycleSummary[] }> {
  const log = opts.log ?? ((msg: string) => console.log(`[ReviewFleetWatcher] ${msg}`));

  // ── DORMANT GATE ─────────────────────────────────────────────────────────────
  if (!opts.enabled) {
    log('review fleet watcher dormant (enabled=false)');
    return { cycles: 0, summaries: [] };
  }

  const maxCycles = opts.maxCycles ?? 50;
  const intervalMs = opts.intervalMs ?? 15_000;
  const realSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const sleep = opts.sleep ?? realSleep;

  const summaries: ReviewFleetCycleSummary[] = [];

  for (let i = 0; i < maxCycles; i++) {
    // Check shouldStop BEFORE running the cycle
    if (opts.shouldStop?.()) {
      log(`watcher stopping: shouldStop returned true (cycle ${i})`);
      break;
    }

    const summary = await runReviewFleetCycle(opts);
    summaries.push(summary);
    log(
      `cycle ${i + 1}/${maxCycles}: scanned=${summary.scanned} ` +
        `processed=${summary.processed} voted=${summary.voted} ` +
        `humanRequired=${summary.humanRequired} errors=${summary.errors}`,
    );

    // Sleep between cycles, but not after the last one
    const isLastCycle = i === maxCycles - 1;
    if (!isLastCycle) {
      await sleep(intervalMs);
    }
  }

  return { cycles: summaries.length, summaries };
}
