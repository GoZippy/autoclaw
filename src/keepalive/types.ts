/**
 * types.ts — Shared types for the Computer-Use Keep-Alive Loop (Sprint 4 / WA-3).
 *
 * The keep-alive subsystem re-kicks stalled agents through a priority fallback
 * chain of strategies. It consumes LMD health (`src/lmd/`) and never makes an
 * LLM call itself — strategies are pure orchestration: child processes, OS
 * notifications, and (optionally) a Playwright browser driver.
 *
 * Every symbol in this file is a plain TypeScript type/interface — zero runtime
 * cost.
 */

import type { AgentHealth } from '../lmd/types';

/* -------------------------------------------------------------------------- */
/*  Strategy identifiers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The four keep-alive strategies, in their canonical preference order.
 *
 * - `runner`       — re-dispatch a wake prompt via the agent's registered
 *                    runner (headless; cheapest, preferred).
 * - `cli`          — run a configured shell command to wake the agent.
 * - `computer_use` — drive the IDE GUI with Playwright (focus window, click
 *                    chat box, submit). Last automated resort; gated on
 *                    "agent stalled AND human idle".
 * - `toast`        — give up automation: fire an OS notification and add an
 *                    "Awaiting You" entry so a human takes over.
 */
export type KeepaliveStrategyName = 'runner' | 'cli' | 'computer_use' | 'toast';

/** The default chain when an agent declares no `keepalive_strategy`. */
export const DEFAULT_KEEPALIVE_CHAIN: ReadonlyArray<KeepaliveStrategyName> = [
  'runner',
  'cli',
  'computer_use',
  'toast',
];

/* -------------------------------------------------------------------------- */
/*  Per-agent keep-alive configuration                                        */
/* -------------------------------------------------------------------------- */

/**
 * Per-agent keep-alive configuration. In production this is read from the
 * agent's `agents/<agent>/scope.json` (the `keepalive_strategy`,
 * `keepalive_cli_command`, and `playwright_script` fields).
 */
export interface KeepaliveConfig {
  /** The agent this config belongs to. */
  agentId: string;
  /**
   * Ordered list of strategies to try. The {@link StrategyChain} tries each in
   * order until one succeeds or all fail. Defaults to
   * {@link DEFAULT_KEEPALIVE_CHAIN}.
   */
  strategy?: KeepaliveStrategyName[];
  /**
   * Shell command for the `cli` strategy. Required for `cli` to do anything;
   * if absent, the `cli` strategy reports a skip.
   */
  cliCommand?: string;
  /**
   * Per-IDE Playwright script id for the `computer_use` strategy, e.g.
   * `"kilocode-chat-submit"`. Resolved against `src/keepalive/scripts/`.
   * Mirrors the `playwright_script` field on `scope.json`.
   */
  playwrightScript?: string;
  /** Optional human-readable label for the IDE/host, used in toasts + logs. */
  ideLabel?: string;
}

/* -------------------------------------------------------------------------- */
/*  Strategy result                                                           */
/* -------------------------------------------------------------------------- */

/** Outcome status of a single strategy attempt. */
export type StrategyOutcome = 'success' | 'failed' | 'skipped';

/** Result of attempting one keep-alive strategy. */
export interface StrategyResult {
  /** Which strategy produced this result. */
  strategy: KeepaliveStrategyName;
  /** Outcome — `skipped` means the strategy was not applicable / not configured. */
  outcome: StrategyOutcome;
  /** Short human-readable detail for the log. */
  detail: string;
  /** ISO timestamp of the attempt. */
  at: string;
}

/** Aggregate result of running a full {@link StrategyChain}. */
export interface ChainResult {
  /** The agent the chain ran for. */
  agentId: string;
  /** True when one strategy in the chain succeeded. */
  ok: boolean;
  /** The strategy that succeeded, or `null` when every strategy failed/skipped. */
  succeededWith: KeepaliveStrategyName | null;
  /** Every attempt in order, including skips and failures. */
  attempts: StrategyResult[];
  /** ISO timestamp the chain completed. */
  at: string;
}

/* -------------------------------------------------------------------------- */
/*  Strategy interface                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Context passed to a strategy when it is invoked. Carries the agent's health
 * snapshot and config plus injectable seams so strategies stay unit-testable.
 */
export interface StrategyContext {
  /** The agent being re-kicked. */
  agentId: string;
  /** The agent's keep-alive config. */
  config: KeepaliveConfig;
  /** Latest LMD health snapshot for the agent, when available. */
  health?: AgentHealth;
  /** Absolute workspace root — for resolving log/script paths. */
  workspaceRoot: string;
  /** The wake prompt to deliver to the agent. */
  prompt: string;
  /** Logger seam. Defaults to `console` in callers. */
  logger: { warn: (m: string) => void; error: (m: string) => void; log?: (m: string) => void };
}

/**
 * A single keep-alive strategy. Implementations live alongside this file
 * (`runnerStrategy`, `cliStrategy`, `computerUseStrategy`, `toastStrategy`).
 */
export interface KeepaliveStrategy {
  /** The strategy this implementation handles. */
  readonly name: KeepaliveStrategyName;
  /**
   * Attempt to wake the agent. MUST resolve (never reject) — failures are
   * reported via {@link StrategyResult.outcome}.
   */
  attempt(ctx: StrategyContext): Promise<StrategyResult>;
}
