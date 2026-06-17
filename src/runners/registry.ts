/**
 * Runner registry and trust-preset translation.
 *
 * - {@link RunnerRegistry} — registers per-vendor runners, drives detection,
 *   and selects a preferred runner using the RFC §5.5 preference order.
 * - {@link TRUST_PRESET_TABLE} / {@link translateTrust} — the RFC §3
 *   trust-preset → per-runner-flag translation table.
 *
 * @see docs/rfc/runner-bridge-contract.md §3, §5.5
 */

import type {
  PreferenceCriterion,
  PreferenceOptions,
  RegisteredRunner,
  Runner,
  TrustPreset,
} from './types';

/* -------------------------------------------------------------------------- */
/*  §3 Trust preset translation                                               */
/* -------------------------------------------------------------------------- */

/**
 * Host-specific flags a trust preset translates to for one runner.
 *
 * `flags` is the literal argument list (Claude Code uses an SDK option
 * rather than CLI flags, so its values read as `key: value` strings).
 * `downgradedFrom` is set when the runner cannot honor the requested
 * preset and falls back to a stricter one (RFC §3).
 */
export interface TrustTranslation {
  /** CLI flags (or SDK option descriptors) to apply for this preset. */
  flags: string[];
  /** Set when the host cannot honor the requested preset and a stricter one is used. */
  downgradedFrom?: TrustPreset;
  /** Human-readable note on the translation, e.g. why a downgrade happened. */
  note?: string;
}

/**
 * RFC §3 per-runner trust translation table.
 *
 * Indexed `[runnerId][preset]`. Runners not present here are unknown to
 * the table; {@link translateTrust} falls back to a conservative default.
 */
export const TRUST_PRESET_TABLE: Readonly<
  Record<string, Readonly<Record<TrustPreset, TrustTranslation>>>
> = {
  'claude-code': {
    off: { flags: ['permissionMode: default'] },
    auto: {
      flags: ['permissionMode: acceptEdits'],
      note: 'acceptEdits auto-approves read tools; mutations still prompt.',
    },
    turbo: { flags: ['permissionMode: bypassPermissions'] },
  },
  cursor: {
    off: { flags: [] }, // default approval prompts
    auto: { flags: ['--auto-approve=read,grep'] },
    turbo: {
      flags: ['--auto-approve=all'],
      note: 'Deny list is applied inverted against --auto-approve=all.',
    },
  },
  kiro: {
    off: { flags: [] }, // no flag
    auto: { flags: ['--trust-tools=read,grep'] },
    turbo: { flags: ['--trust-all-tools'] },
  },
  'gemini-cli': {
    off: { flags: [] }, // default
    auto: { flags: ['--yolo=read,grep'] },
    turbo: { flags: ['--yolo'] },
  },
};

/** Stricter-to-looser ordering of trust presets, used for downgrades. */
const TRUST_RANK: Readonly<Record<TrustPreset, number>> = {
  off: 0,
  auto: 1,
  turbo: 2,
};

/**
 * Translate a {@link TrustPreset} into host-specific flags for `runnerId`.
 *
 * A runner that can't honor a preset downgrades to the closest *stricter*
 * option and records the downgrade on {@link TrustTranslation.downgradedFrom}
 * (RFC §3). Unknown runners fall back to the safest preset (`off`) with an
 * explanatory note.
 *
 * @param runnerId - the runner's stable id (e.g. `"claude-code"`).
 * @param preset   - the requested trust preset.
 * @returns the host-specific translation, possibly downgraded.
 */
export function translateTrust(runnerId: string, preset: TrustPreset): TrustTranslation {
  const perRunner = TRUST_PRESET_TABLE[runnerId];
  if (perRunner === undefined) {
    return {
      flags: [],
      downgradedFrom: preset === 'off' ? undefined : preset,
      note: `Unknown runner "${runnerId}"; defaulting to strictest trust (off).`,
    };
  }

  const direct = perRunner[preset];
  if (direct !== undefined) {
    return { ...direct, flags: [...direct.flags] };
  }

  // Downgrade to the closest stricter preset the runner does support.
  let candidate: TrustPreset | null = null;
  for (const p of Object.keys(perRunner) as TrustPreset[]) {
    if (TRUST_RANK[p] < TRUST_RANK[preset] && (candidate === null || TRUST_RANK[p] > TRUST_RANK[candidate])) {
      candidate = p;
    }
  }
  if (candidate !== null) {
    const fallback = perRunner[candidate];
    return {
      flags: [...fallback.flags],
      downgradedFrom: preset,
      note: `Runner "${runnerId}" cannot honor "${preset}"; downgraded to "${candidate}".`,
    };
  }
  return {
    flags: [],
    downgradedFrom: preset,
    note: `Runner "${runnerId}" has no trust translation for "${preset}".`,
  };
}

/* -------------------------------------------------------------------------- */
/*  §5.5 Runner registry                                                      */
/* -------------------------------------------------------------------------- */

/** Default §5.5 tiebreaker order when none is configured. */
const DEFAULT_PREFERENCE_ORDER: readonly PreferenceCriterion[] = [
  'explicit',
  'workspace',
  'reputation',
  'cost',
  'latency',
];

/**
 * Holds the set of per-vendor runners, drives their detection, and selects
 * a preferred runner for a request.
 *
 * Lifecycle:
 * 1. {@link register} each runner adapter at startup.
 * 2. {@link detect} once at startup (and again on `autoclaw doctor`).
 * 3. {@link getPreferred} per dispatch to choose a runner.
 */
export class RunnerRegistry {
  private readonly entries = new Map<string, RegisteredRunner>();

  /**
   * Register a runner adapter. Re-registering the same id replaces the
   * previous entry and clears its detection state.
   *
   * @param runner - the runner instance to register.
   */
  register(runner: Runner): void {
    this.entries.set(runner.id, {
      runner,
      enabled: false,
      detection: null,
    });
  }

  /**
   * Run {@link Runner.detect} for every registered runner. Runners that are
   * not found stay registered but `enabled: false`, retaining their
   * {@link import('./types').DetectionResultNotFound} so `doctor` can surface
   * the remediation hint.
   *
   * Detection failures (a thrown error from a misbehaving adapter) are
   * treated as `not_installed` rather than propagating.
   *
   * @returns the registered runners with refreshed detection state.
   */
  async detect(): Promise<RegisteredRunner[]> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        try {
          const result = await entry.runner.detect();
          entry.detection = result;
          entry.enabled = result.found;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          entry.detection = {
            found: false,
            reason: 'not_installed',
            hint: `detect() threw for "${entry.runner.id}": ${message}`,
          };
          entry.enabled = false;
        }
      }),
    );
    return [...this.entries.values()];
  }

  /** Every registered runner, regardless of detection state. */
  list(): RegisteredRunner[] {
    return [...this.entries.values()];
  }

  /** Runners that detection found usable on this machine. */
  listActive(): RegisteredRunner[] {
    return [...this.entries.values()].filter((e) => e.enabled);
  }

  /** Runners that detection found unusable, with their remediation hint. */
  listDisabled(): RegisteredRunner[] {
    return [...this.entries.values()].filter((e) => !e.enabled);
  }

  /** Look up a single registered runner by id, or `undefined`. */
  get(runnerId: string): RegisteredRunner | undefined {
    return this.entries.get(runnerId);
  }

  /**
   * Select the preferred active runner for a request, applying the RFC §5.5
   * preference order:
   *
   * 1. The runner the user explicitly invoked.
   * 2. The runner matching the workspace's primary chat host.
   * 3. The cheapest by cost ledger (rolled-up tokens/$).
   * 4. The fastest by recent p50 dispatch latency.
   *
   * Only `enabled` runners are considered. The tiebreaker order is
   * configurable via {@link PreferenceOptions.preferenceOrder}.
   *
   * @param opts - preference inputs; all fields optional.
   * @returns the chosen runner, or `null` if no runner is active.
   */
  getPreferred(opts: PreferenceOptions = {}): Runner | null {
    const active = this.listActive().map((e) => e.runner);
    if (active.length === 0) {
      return null;
    }
    if (active.length === 1) {
      return active[0];
    }

    const order = opts.preferenceOrder ?? DEFAULT_PREFERENCE_ORDER;

    for (const criterion of order) {
      const winner = this.applyCriterion(criterion, active, opts);
      if (winner !== null) {
        return winner;
      }
    }

    // No criterion was decisive — fall back to the first active runner
    // (registration order) for a stable, deterministic result.
    return active[0];
  }

  /**
   * Apply one §5.5 criterion to the candidate set.
   *
   * @returns the winning runner, or `null` if the criterion does not
   *          uniquely decide (no signal, or a tie).
   */
  private applyCriterion(
    criterion: PreferenceCriterion,
    candidates: Runner[],
    opts: PreferenceOptions,
  ): Runner | null {
    switch (criterion) {
      case 'explicit': {
        if (opts.explicitRunnerId === undefined) {
          return null;
        }
        return candidates.find((r) => r.id === opts.explicitRunnerId) ?? null;
      }
      case 'workspace': {
        if (opts.workspacePrimaryHostId === undefined) {
          return null;
        }
        return candidates.find((r) => r.id === opts.workspacePrimaryHostId) ?? null;
      }
      case 'cost':
        return RunnerRegistry.lowestScored(candidates, opts.costByRunnerId);
      case 'latency':
        return RunnerRegistry.lowestScored(candidates, opts.p50LatencyMsByRunnerId);
      case 'reputation':
        // HR-3: prefer the strictly-highest reputation. No-op (null) when no
        // reputation map is supplied, so the default order is unaffected for
        // callers that don't opt in.
        return RunnerRegistry.highestScored(candidates, opts.reputationByRunnerId);
      default:
        return null;
    }
  }

  /**
   * Pick the candidate with the strictly-highest score. Returns `null` when
   * there is no score map, fewer than two scored candidates, or a tie on the
   * highest score (so the next criterion gets a chance to decide). The
   * higher-is-better mirror of {@link lowestScored}.
   */
  private static highestScored(
    candidates: Runner[],
    scores: Record<string, number> | undefined,
  ): Runner | null {
    if (scores === undefined) {
      return null;
    }
    const scored = candidates
      .map((r) => ({ runner: r, score: scores[r.id] }))
      .filter((s): s is { runner: Runner; score: number } => typeof s.score === 'number');
    if (scored.length < 2) {
      return null;
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored[0].score === scored[1].score) {
      return null; // tie — defer to the next criterion
    }
    return scored[0].runner;
  }

  /**
   * Pick the candidate with the strictly-lowest score. Returns `null` when
   * there is no score map, fewer than two scored candidates, or a tie on
   * the lowest score (so the next criterion gets a chance to decide).
   */
  private static lowestScored(
    candidates: Runner[],
    scores: Record<string, number> | undefined,
  ): Runner | null {
    if (scores === undefined) {
      return null;
    }
    const scored = candidates
      .map((r) => ({ runner: r, score: scores[r.id] }))
      .filter((s): s is { runner: Runner; score: number } => typeof s.score === 'number');
    if (scored.length < 2) {
      return null;
    }
    scored.sort((a, b) => a.score - b.score);
    if (scored[0].score === scored[1].score) {
      return null; // tie — defer to the next criterion
    }
    return scored[0].runner;
  }
}
