/**
 * strategyChain.ts — Per-agent keep-alive strategy chain (Sprint 4 / WA-3 I1).
 *
 * Each agent declares a `keepalive_strategy` — an ordered list drawn from
 * `['runner', 'cli', 'computer_use', 'toast']`. {@link StrategyChain} runs the
 * strategies in order and stops at the first one that succeeds; if every
 * automated strategy fails it falls through to `toast`, which always succeeds
 * (it hands the agent to a human).
 *
 * Strategies implemented here:
 *   - `runner` — re-dispatch a wake prompt through the agent's registered
 *     runner. Headless, cheapest, preferred. Delegates to an injected
 *     {@link RunnerRekick} seam (the real RunnerRegistry lives in src/runners).
 *   - `cli`    — run a configured shell command (`keepalive_cli_command` on
 *     scope.json) to wake the agent.
 *   - `computer_use` — drive the IDE GUI with Playwright. See `computerUse.ts`.
 *   - `toast`  — OS notification + "Awaiting You" panel entry. See `notify.ts`.
 *
 * *** NO LLM CALLS. Strategies are pure orchestration. ***
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ChainResult,
  KeepaliveConfig,
  KeepaliveStrategy,
  KeepaliveStrategyName,
  StrategyContext,
  StrategyResult,
} from './types';
import { DEFAULT_KEEPALIVE_CHAIN } from './types';
import type { AgentHealth } from '../lmd/types';
import { computerUseStrategy } from './computerUse';
import type { ComputerUseStrategyOptions } from './computerUse';
import { notifyAwaitingYou } from './notify';
import type { NotifyBridge } from './notify';

/* -------------------------------------------------------------------------- */
/*  Injected seams                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Minimal runner re-kick seam for the `runner` strategy. The full
 * RunnerRegistry lives in `src/runners/`; the chain only needs to learn
 * whether a runner exists and to dispatch a wake prompt to it.
 */
export interface RunnerRekick {
  /** Runner id for `agentId`, or `null` when the agent has no headless runner. */
  findRunner(agentId: string): string | null;
  /** Dispatch the wake prompt; resolve a short detail string, may reject. */
  dispatchRekick(agentId: string, prompt: string): Promise<string>;
}

/** No-op runner seam — used when no runner registry is wired in. */
const noRunner: RunnerRekick = {
  findRunner: () => null,
  dispatchRekick: async () => 'no_runner',
};

/* -------------------------------------------------------------------------- */
/*  scope.json loading                                                        */
/* -------------------------------------------------------------------------- */

/** Shape of the keep-alive fields we read from `agents/<agent>/scope.json`. */
interface ScopeKeepaliveFields {
  keepalive_strategy?: KeepaliveStrategyName[];
  keepalive_cli_command?: string;
  playwright_script?: string;
  ide_label?: string;
}

/**
 * Load an agent's {@link KeepaliveConfig} from
 * `<workspaceRoot>/.autoclaw/orchestrator/agents/<agentId>/scope.json`.
 *
 * Missing file / unparseable JSON / missing fields all degrade gracefully to a
 * config that uses {@link DEFAULT_KEEPALIVE_CHAIN}.
 */
export function loadKeepaliveConfig(workspaceRoot: string, agentId: string): KeepaliveConfig {
  const file = path.join(
    workspaceRoot, '.autoclaw', 'orchestrator', 'agents', agentId, 'scope.json',
  );
  let parsed: ScopeKeepaliveFields = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ScopeKeepaliveFields;
  } catch {
    parsed = {};
  }
  const strategy = Array.isArray(parsed.keepalive_strategy) && parsed.keepalive_strategy.length > 0
    ? parsed.keepalive_strategy
    : undefined;
  return {
    agentId,
    strategy,
    cliCommand: typeof parsed.keepalive_cli_command === 'string' ? parsed.keepalive_cli_command : undefined,
    playwrightScript: typeof parsed.playwright_script === 'string' ? parsed.playwright_script : undefined,
    ideLabel: typeof parsed.ide_label === 'string' ? parsed.ide_label : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/*  runner strategy                                                           */
/* -------------------------------------------------------------------------- */

/** Build the `runner` strategy backed by an injected {@link RunnerRekick}. */
export function runnerStrategy(runner: RunnerRekick): KeepaliveStrategy {
  return {
    name: 'runner',
    async attempt(ctx: StrategyContext): Promise<StrategyResult> {
      const at = new Date().toISOString();
      const id = runner.findRunner(ctx.agentId);
      if (id === null) {
        return {
          strategy: 'runner', outcome: 'skipped',
          detail: 'no headless runner registered for this agent', at,
        };
      }
      try {
        const result = await runner.dispatchRekick(ctx.agentId, ctx.prompt);
        return {
          strategy: 'runner', outcome: 'success',
          detail: `re-kicked via runner "${id}": ${result}`, at,
        };
      } catch (err) {
        return {
          strategy: 'runner', outcome: 'failed',
          detail: `runner "${id}" dispatch failed: ${String(err)}`, at,
        };
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  cli strategy                                                              */
/* -------------------------------------------------------------------------- */

/** Options for {@link cliStrategy}. */
export interface CliStrategyOptions {
  /** Command-execution seam. Defaults to a real `execFile` via the shell. */
  exec?: (command: string, cwd: string) => Promise<{ ok: boolean; detail: string }>;
  /** Timeout for the wake command in ms. Defaults to 30 s. */
  timeoutMs?: number;
}

/** Default shell exec: runs `command` through the platform shell. */
function defaultExec(timeoutMs: number) {
  return (command: string, cwd: string): Promise<{ ok: boolean; detail: string }> =>
    new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd' : 'sh';
      const args = isWin ? ['/c', command] : ['-c', command];
      execFile(shell, args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, detail: `exit error: ${String(err)} ${stderr?.toString().trim() ?? ''}`.trim() });
          return;
        }
        resolve({ ok: true, detail: stdout?.toString().trim().slice(0, 200) || 'command exited 0' });
      });
    });
}

/** Build the `cli` strategy: runs the agent's configured wake command. */
export function cliStrategy(opts: CliStrategyOptions = {}): KeepaliveStrategy {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const exec = opts.exec ?? defaultExec(timeoutMs);
  return {
    name: 'cli',
    async attempt(ctx: StrategyContext): Promise<StrategyResult> {
      const at = new Date().toISOString();
      const command = ctx.config.cliCommand;
      if (!command || command.trim() === '') {
        return {
          strategy: 'cli', outcome: 'skipped',
          detail: 'no keepalive_cli_command configured on scope.json', at,
        };
      }
      try {
        const { ok, detail } = await exec(command, ctx.workspaceRoot);
        return {
          strategy: 'cli',
          outcome: ok ? 'success' : 'failed',
          detail: ok ? `wake command succeeded: ${detail}` : `wake command failed: ${detail}`,
          at,
        };
      } catch (err) {
        return { strategy: 'cli', outcome: 'failed', detail: `cli strategy threw: ${String(err)}`, at };
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  toast strategy                                                            */
/* -------------------------------------------------------------------------- */

/** Options for {@link toastStrategy}. */
export interface ToastStrategyOptions {
  /** Optional VS Code bridge for an in-editor warning. */
  bridge?: NotifyBridge;
  /** Override `process.platform` (tests). */
  platform?: NodeJS.Platform;
}

/**
 * Build the `toast` strategy: the terminal, non-automated fallback. Fires an
 * OS notification and records an "Awaiting You" entry so a human takes over.
 * Always reports `success` — handing off to a human IS the success condition.
 */
export function toastStrategy(opts: ToastStrategyOptions = {}): KeepaliveStrategy {
  return {
    name: 'toast',
    async attempt(ctx: StrategyContext): Promise<StrategyResult> {
      const at = new Date().toISOString();
      const reason = `Agent "${ctx.agentId}" is stalled and automated re-kick failed. ` +
        `Please check its inbox and resume it manually.`;
      try {
        notifyAwaitingYou({
          workspaceRoot: ctx.workspaceRoot,
          agentId: ctx.agentId,
          reason,
          ide: ctx.config.ideLabel,
          bridge: opts.bridge,
          platform: opts.platform,
          logger: ctx.logger,
        });
        return {
          strategy: 'toast', outcome: 'success',
          detail: 'OS notification fired + "Awaiting You" panel entry recorded', at,
        };
      } catch (err) {
        return { strategy: 'toast', outcome: 'failed', detail: `toast strategy threw: ${String(err)}`, at };
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  StrategyChain                                                             */
/* -------------------------------------------------------------------------- */

/** Options for constructing a {@link StrategyChain}. */
export interface StrategyChainOptions {
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** Runner re-kick seam for the `runner` strategy. Defaults to a no-op. */
  runner?: RunnerRekick;
  /** Options forwarded to the `cli` strategy. */
  cli?: CliStrategyOptions;
  /** Options forwarded to the `computer_use` strategy. */
  computerUse?: ComputerUseStrategyOptions;
  /** Options forwarded to the `toast` strategy. */
  toast?: ToastStrategyOptions;
  /**
   * Fully built strategy implementations, keyed by name. When supplied, these
   * override the ones the chain would build — primarily for tests.
   */
  strategies?: Partial<Record<KeepaliveStrategyName, KeepaliveStrategy>>;
  /** Logger seam. Defaults to `console`. */
  logger?: { warn: (m: string) => void; error: (m: string) => void; log?: (m: string) => void };
}

/**
 * Runs an agent's keep-alive strategy chain: tries each strategy in the agent's
 * declared order until one succeeds.
 *
 * A strategy that returns `skipped` (not applicable / not configured) does NOT
 * stop the chain — the chain moves on. Only `success` stops it. If every
 * strategy is exhausted with no success, {@link ChainResult.ok} is `false`.
 */
export class StrategyChain {
  private readonly workspaceRoot: string;
  private readonly logger: NonNullable<StrategyChainOptions['logger']>;
  private readonly impls: Record<KeepaliveStrategyName, KeepaliveStrategy>;

  constructor(opts: StrategyChainOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.logger = opts.logger ?? console;

    const built: Record<KeepaliveStrategyName, KeepaliveStrategy> = {
      runner: runnerStrategy(opts.runner ?? noRunner),
      cli: cliStrategy(opts.cli),
      computer_use: computerUseStrategy(opts.computerUse),
      toast: toastStrategy(opts.toast),
    };
    // Apply test/caller overrides.
    if (opts.strategies) {
      for (const name of Object.keys(opts.strategies) as KeepaliveStrategyName[]) {
        const override = opts.strategies[name];
        if (override) { built[name] = override; }
      }
    }
    this.impls = built;
  }

  /**
   * Run the chain for one agent.
   *
   * @param config - The agent's keep-alive config (chain order, cli command,
   *                 playwright script). Use {@link loadKeepaliveConfig} to read
   *                 it from `scope.json`.
   * @param health - The agent's latest LMD health snapshot, when available.
   *                 Forwarded to strategies (the `computer_use` gate needs it).
   * @param prompt - Optional wake prompt; a sensible default is used otherwise.
   */
  async run(
    config: KeepaliveConfig,
    health?: AgentHealth,
    prompt?: string,
  ): Promise<ChainResult> {
    const order: KeepaliveStrategyName[] =
      config.strategy && config.strategy.length > 0
        ? config.strategy
        : [...DEFAULT_KEEPALIVE_CHAIN];

    const wakePrompt = prompt ??
      `You appear to be stalled. Please check your inbox at ` +
      `.autoclaw/orchestrator/comms/inboxes/${config.agentId}/ and resume your task.`;

    const ctx: StrategyContext = {
      agentId: config.agentId,
      config,
      health,
      workspaceRoot: this.workspaceRoot,
      prompt: wakePrompt,
      logger: this.logger,
    };

    const attempts: StrategyResult[] = [];
    let succeededWith: KeepaliveStrategyName | null = null;

    for (const name of order) {
      const impl = this.impls[name];
      if (!impl) {
        attempts.push({
          strategy: name, outcome: 'skipped',
          detail: `unknown strategy "${name}" in keepalive_strategy`,
          at: new Date().toISOString(),
        });
        continue;
      }
      let result: StrategyResult;
      try {
        result = await impl.attempt(ctx);
      } catch (err) {
        // A well-behaved strategy never rejects; defend anyway.
        result = {
          strategy: name, outcome: 'failed',
          detail: `strategy threw: ${String(err)}`, at: new Date().toISOString(),
        };
      }
      attempts.push(result);
      if (result.outcome === 'success') {
        succeededWith = name;
        break;
      }
    }

    return {
      agentId: config.agentId,
      ok: succeededWith !== null,
      succeededWith,
      attempts,
      at: new Date().toISOString(),
    };
  }
}
