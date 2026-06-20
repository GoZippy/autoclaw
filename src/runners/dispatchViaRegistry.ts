/**
 * Reachable entry point for the runner dispatch contract.
 *
 * The {@link RunnerRegistry} (`getPreferred`/`get` + `Runner.dispatch`) was built
 * as a library but, until this seam, had no non-test runtime caller — the §5.5
 * preference order and the per-runner `dispatch()` were dead code. This module is
 * the thin, testable orchestration that turns that contract into reachable
 * behavior: pick a runner (explicit id, else the preference order), dispatch one
 * unit of work, and hand the result to an optional cost sink so a completed
 * dispatch can feed the per-agent cost ledger automatically.
 *
 * It deliberately holds no VS Code or filesystem coupling so it can be unit
 * tested against a mock registry + runner.
 *
 * @see docs/rfc/runner-bridge-contract.md
 */
import type {
  DispatchResult,
  PreferenceOptions,
  Runner,
  TrustPreset,
} from './types';
import type { RunnerRegistry } from './registry';

export interface DispatchViaRegistryOptions {
  /** Prompt / instruction handed to the selected runner. */
  prompt: string;
  /** Working directory the runner should operate in. */
  workingDir: string;
  /**
   * Explicit runner id. When set, that runner is used directly (must be
   * registered + enabled). When omitted, the registry's preference order picks.
   */
  runnerId?: string;
  /** Trust preset for the dispatch. Defaults to `'auto'`. */
  trust?: TrustPreset;
  /** Preference inputs (workspace primary, reputation, cost, latency …). */
  preference?: PreferenceOptions;
  /** Optional session id to resume rather than start fresh. */
  sessionId?: string;
  /**
   * Best-effort sink invoked with the resolved runner id + dispatch result after
   * a dispatch completes (ok or not). Used to record cost. A throw here is
   * swallowed — recording cost must never break a dispatch.
   */
  onResult?: (runnerId: string, result: DispatchResult) => void | Promise<void>;
}

export interface DispatchViaRegistryOutcome {
  result: DispatchResult;
  runnerId: string;
}

/**
 * Select a runner from the registry and dispatch one unit of work through the
 * runner contract. Returns `null` (no throw) when no runner can be selected —
 * e.g. an unknown/disabled explicit id, or no runner detected for the
 * preference order. Selection runs `registry.detect()` first so enablement /
 * detection state is fresh.
 */
export async function dispatchViaRegistry(
  registry: RunnerRegistry,
  opts: DispatchViaRegistryOptions,
): Promise<DispatchViaRegistryOutcome | null> {
  await registry.detect();

  let runner: Runner | null = null;
  if (opts.runnerId) {
    const entry = registry.get(opts.runnerId);
    runner = entry && entry.enabled ? entry.runner : null;
  } else {
    runner = registry.getPreferred(opts.preference ?? {});
  }
  if (!runner) {
    return null;
  }

  const result = await runner.dispatch({
    prompt: opts.prompt,
    trust: opts.trust ?? 'auto',
    workingDir: opts.workingDir,
    sessionId: opts.sessionId,
  });

  if (opts.onResult) {
    try {
      await opts.onResult(runner.id, result);
    } catch {
      /* best-effort — cost/telemetry sink must never break a dispatch */
    }
  }

  return { result, runnerId: runner.id };
}
