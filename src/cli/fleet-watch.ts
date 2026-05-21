/**
 * fleet-watch.ts — `autoclaw fleet watch` cron-style keep-alive loop
 * (Sprint 4 / WA-3 I3).
 *
 * Periodically checks LMD health and re-kicks any stalled agent through its
 * per-agent keep-alive strategy chain (`runner → cli → computer_use → toast`).
 *
 *   autoclaw fleet watch --interval 5m
 *
 * Responsibilities:
 *   1. Run a {@link HeartbeatReader} (zero-token, pure file I/O) so LMD health
 *      is current.
 *   2. On each scheduled tick, find every `stalled` agent and run its
 *      {@link StrategyChain}.
 *   3. Append a JSONL record of every chain run to
 *      `.autoclaw/runtime/keepalive.log`.
 *   4. Export {@link watchFleetCommand} for the "AutoClaw: Watch Fleet" VS Code
 *      command (toggle), and {@link fleetWatchStatusBarText} for the status bar.
 *
 * *** NO LLM CALLS. Pure file I/O + scheduling + child-process strategies. ***
 */

import * as fs from 'fs';
import * as path from 'path';
import { HeartbeatReader } from '../lmd/heartbeatReader';
import type { AgentHealth } from '../lmd/types';
import { StrategyChain, loadKeepaliveConfig } from '../keepalive/strategyChain';
import type { StrategyChainOptions } from '../keepalive/strategyChain';
import type { ChainResult } from '../keepalive/types';

/* -------------------------------------------------------------------------- */
/*  Interval parsing                                                          */
/* -------------------------------------------------------------------------- */

/** Default watch interval: 5 minutes. */
export const DEFAULT_WATCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Parse a human interval string (`"5m"`, `"30s"`, `"1h"`, or a bare number of
 * milliseconds) into milliseconds. Falls back to {@link DEFAULT_WATCH_INTERVAL_MS}
 * for empty / unparseable input. Clamped to a 10 s floor so the loop cannot
 * busy-spin.
 */
export function parseInterval(raw: string | undefined): number {
  if (!raw) { return DEFAULT_WATCH_INTERVAL_MS; }
  const m = /^(\d+)\s*(ms|s|m|h)?$/i.exec(raw.trim());
  if (!m) { return DEFAULT_WATCH_INTERVAL_MS; }
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const ms =
    unit === 'h' ? n * 3_600_000 :
    unit === 'm' ? n * 60_000 :
    unit === 's' ? n * 1000 :
    n;
  return Math.max(10_000, ms);
}

/* -------------------------------------------------------------------------- */
/*  keepalive.log record                                                      */
/* -------------------------------------------------------------------------- */

/** A `fleet watch` record appended to `.autoclaw/runtime/keepalive.log`. */
export interface FleetWatchLogEntry {
  at: string;
  /** `watch_tick` for a scheduled sweep, `chain_run` for one agent's chain. */
  event: 'watch_start' | 'watch_tick' | 'chain_run' | 'watch_stop';
  /** Present on `chain_run`. */
  agentId?: string;
  /** Present on `chain_run` — the chain outcome. */
  chain?: ChainResult;
  /** Free-form detail. */
  detail?: string;
}

/** Append an entry to `<workspaceRoot>/.autoclaw/runtime/keepalive.log`. */
function appendKeepaliveLog(
  workspaceRoot: string,
  entry: FleetWatchLogEntry,
  logger: { error: (m: string) => void },
): void {
  const file = path.join(workspaceRoot, '.autoclaw', 'runtime', 'keepalive.log');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    logger.error(`fleet watch: failed to append keepalive.log: ${String(err)}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Status bar helper                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Text for the VS Code status-bar item that reflects the fleet-watch toggle.
 *
 * @param active     - Whether the watch loop is running.
 * @param stalledNow - Count of agents stalled at the last tick (optional).
 */
export function fleetWatchStatusBarText(active: boolean, stalledNow?: number): string {
  if (!active) { return '$(eye-closed) fleet watch off'; }
  const suffix = stalledNow && stalledNow > 0 ? ` — ${stalledNow} re-kicking` : '';
  return `$(eye) fleet watch active${suffix}`;
}

/* -------------------------------------------------------------------------- */
/*  FleetWatcher                                                              */
/* -------------------------------------------------------------------------- */

/** Options for {@link FleetWatcher}. */
export interface FleetWatchOptions {
  /** Workspace root. Defaults to `process.cwd()`. */
  workspaceRoot?: string;
  /** Watch interval in ms. Defaults to {@link DEFAULT_WATCH_INTERVAL_MS}. */
  intervalMs?: number;
  /** Logger seam. Defaults to `console`. */
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  /**
   * Pre-built {@link HeartbeatReader}. Defaults to a fresh one. Tests inject a
   * reader pre-seeded with a state machine so health is deterministic.
   */
  reader?: HeartbeatReader;
  /**
   * Pre-built {@link StrategyChain}. Defaults to one constructed from
   * {@link FleetWatchOptions.chain}. Tests inject a fake.
   */
  chain?: StrategyChain;
  /** Options forwarded to a default-constructed {@link StrategyChain}. */
  chainOptions?: Omit<StrategyChainOptions, 'workspaceRoot'>;
}

/** Outcome of a single {@link FleetWatcher.tick}. */
export interface FleetWatchTickResult {
  /** ISO timestamp of the tick. */
  at: string;
  /** Health snapshots seen this tick. */
  health: AgentHealth[];
  /** Agent ids found stalled and re-kicked. */
  stalled: string[];
  /** Chain results for each re-kicked agent. */
  chains: ChainResult[];
}

/**
 * The cron-style keep-alive loop. Drives a {@link HeartbeatReader} for LMD
 * health and, on each tick, re-kicks every stalled agent via its
 * {@link StrategyChain}.
 */
export class FleetWatcher {
  private readonly workspaceRoot: string;
  private readonly intervalMs: number;
  private readonly logger: NonNullable<FleetWatchOptions['logger']>;
  private readonly reader: HeartbeatReader;
  private readonly chain: StrategyChain;

  private timer: ReturnType<typeof setInterval> | null = null;
  private _active = false;
  private _lastStalledCount = 0;

  constructor(opts: FleetWatchOptions = {}) {
    this.workspaceRoot = opts.workspaceRoot ?? process.cwd();
    this.intervalMs = opts.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    this.logger = opts.logger ?? console;
    this.reader = opts.reader ?? new HeartbeatReader(this.workspaceRoot);
    this.chain = opts.chain ?? new StrategyChain({
      workspaceRoot: this.workspaceRoot,
      logger: this.logger,
      ...opts.chainOptions,
    });
  }

  /** True while the watch loop is running. */
  get isActive(): boolean { return this._active; }

  /** Count of agents found stalled at the most recent tick. */
  get lastStalledCount(): number { return this._lastStalledCount; }

  /** Status-bar text for the current state. */
  statusBarText(): string {
    return fleetWatchStatusBarText(this._active, this._lastStalledCount);
  }

  /**
   * Start the watch loop. Boots the {@link HeartbeatReader}, runs an immediate
   * tick, then schedules ticks on the interval. Idempotent.
   */
  start(): void {
    if (this._active) { return; }
    this._active = true;
    this.reader.start();
    appendKeepaliveLog(this.workspaceRoot,
      { at: new Date().toISOString(), event: 'watch_start', detail: `interval ${this.intervalMs}ms` },
      this.logger);
    this.logger.info(`fleet watch: active (interval ${Math.round(this.intervalMs / 1000)}s).`);
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  /** Stop the watch loop and the underlying reader. Idempotent. */
  stop(): void {
    if (!this._active) { return; }
    this._active = false;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.reader.stop();
    appendKeepaliveLog(this.workspaceRoot,
      { at: new Date().toISOString(), event: 'watch_stop' }, this.logger);
    this.logger.info('fleet watch: stopped.');
  }

  /**
   * Run a single watch sweep: read LMD health, re-kick every `stalled` agent.
   * Exposed (not just internal) so the VS Code command and tests can run a
   * sweep on demand.
   */
  async tick(): Promise<FleetWatchTickResult> {
    const at = new Date().toISOString();
    const health = this.reader.getHealthGrid();
    const stalledAgents = health.filter((h) => h.state === 'stalled');
    this._lastStalledCount = stalledAgents.length;

    appendKeepaliveLog(this.workspaceRoot,
      { at, event: 'watch_tick', detail: `${health.length} agent(s), ${stalledAgents.length} stalled` },
      this.logger);

    const chains: ChainResult[] = [];
    for (const agent of stalledAgents) {
      const config = loadKeepaliveConfig(this.workspaceRoot, agent.agentId);
      let result: ChainResult;
      try {
        result = await this.chain.run(config, agent);
      } catch (err) {
        // StrategyChain.run never rejects, but defend anyway.
        result = {
          agentId: agent.agentId, ok: false, succeededWith: null, attempts: [],
          at: new Date().toISOString(),
        };
        this.logger.error(`fleet watch: chain run threw for "${agent.agentId}": ${String(err)}`);
      }
      chains.push(result);
      appendKeepaliveLog(this.workspaceRoot,
        { at: new Date().toISOString(), event: 'chain_run', agentId: agent.agentId, chain: result },
        this.logger);
      this.logger.info(
        `fleet watch: "${agent.agentId}" stalled — chain ${result.ok ? `succeeded via "${result.succeededWith}"` : 'exhausted with no success'}.`,
      );
    }

    return { at, health, stalled: stalledAgents.map((a) => a.agentId), chains };
  }
}

/* -------------------------------------------------------------------------- */
/*  VS Code command (toggle)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Module-level singleton so the "AutoClaw: Watch Fleet" command toggles the
 * SAME watcher each invocation.
 */
let activeWatcher: FleetWatcher | null = null;

/** Result of a {@link watchFleetCommand} invocation. */
export interface WatchFleetCommandResult {
  /** Whether the watcher is active after this toggle. */
  active: boolean;
  /** Status-bar text to render. */
  statusBarText: string;
}

/**
 * Toggle handler for the "AutoClaw: Watch Fleet" VS Code command.
 *
 * First call starts a {@link FleetWatcher}; the next stops it. Exported here
 * but NOT wired into `src/extension.ts` — a separate session owns that file.
 *
 * TODO(extension): register `autoclaw.watchFleet` →
 * `() => watchFleetCommand({ workspaceRoot })` and bind the returned
 * `statusBarText` to a `vscode.StatusBarItem`.
 *
 * @param opts - `workspaceRoot` and (optionally) the interval / a VS Code
 *               notify bridge forwarded to the strategy chain.
 */
export function watchFleetCommand(opts: FleetWatchOptions = {}): WatchFleetCommandResult {
  if (activeWatcher && activeWatcher.isActive) {
    activeWatcher.stop();
    const text = activeWatcher.statusBarText();
    activeWatcher = null;
    return { active: false, statusBarText: text };
  }
  activeWatcher = new FleetWatcher(opts);
  activeWatcher.start();
  return { active: true, statusBarText: activeWatcher.statusBarText() };
}

/** The watcher the VS Code command currently owns, or `null`. Mostly for tests. */
export function currentWatcher(): FleetWatcher | null {
  return activeWatcher;
}

/* -------------------------------------------------------------------------- */
/*  CLI entry point                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `autoclaw fleet watch` CLI entry point.
 *
 * Flags:
 *   --interval <5m|30s|1h|ms>  watch interval (default 5m)
 *   --workspace <path>         workspace root (default cwd)
 *   --once                     run a single sweep and exit (CI / cron-driven)
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const workspaceRoot = arg('--workspace') ?? process.cwd();
  const intervalMs = parseInterval(arg('--interval'));
  const once = argv.includes('--once');

  const watcher = new FleetWatcher({ workspaceRoot, intervalMs });

  if (once) {
    // Single sweep — boot the reader, give it one poll, sweep, exit.
    const result = await watcher.tick();
    console.log(
      `fleet watch --once: ${result.health.length} agent(s), ` +
      `${result.stalled.length} stalled, ${result.chains.filter((c) => c.ok).length} re-kicked.`,
    );
    return;
  }

  watcher.start();
  console.log(`fleet watch: ${watcher.statusBarText().replace(/\$\([^)]+\)\s*/g, '')}`);

  // Keep the process alive; stop cleanly on SIGINT/SIGTERM.
  const shutdown = (): void => { watcher.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run as a CLI when invoked directly (not when imported).
if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error('fleet watch: fatal error:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
