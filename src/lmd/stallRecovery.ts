/**
 * stallRecovery.ts — Stall re-kick and dead-agent handling for the LMD.
 *
 * Listens to `stateChange` events from a `HealthStateMachine` (forwarded by
 * `HeartbeatReader` as `health_change`) and takes the following actions:
 *
 *   stalled → dispatch re-kick prompt via registered runner
 *   dead    → OS toast (vscode.window.showWarningMessage or stderr fallback)
 *             + exclude from consensus quorum
 *   alive   → restore to quorum + log recovery
 *
 * All actions are logged to `.autoclaw/runtime/keepalive.log` as JSONL.
 *
 * *** NO LLM CALLS. Pure event-handling + file append + optional child process. ***
 *
 * This module avoids a hard import of `vscode` so it remains unit-testable in
 * plain Node/Mocha. VS Code APIs are injected via the `VSCodeBridge` interface.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StateChangeEvent, KeepaliveLogEntry } from './types';
import type { HealthStateMachine } from './healthStateMachine';
import type { HeartbeatReader } from './heartbeatReader';

// ---------------------------------------------------------------------------
// Interfaces for injected dependencies
// ---------------------------------------------------------------------------

/**
 * Minimal VS Code surface used by StallRecovery.
 * In production, pass the real `vscode` module's window object.
 * In tests, inject a stub.
 */
export interface VSCodeBridge {
  showWarningMessage(message: string): void;
}

/**
 * Minimal runner interface used to dispatch re-kick prompts.
 * The full RunnerRegistry lives in `src/runners/` (a future sprint).
 * We accept a simple lookup function as a seam.
 */
export interface RunnerLookup {
  /**
   * Return a runner name/identifier for `agentId`, or `null` if unknown.
   * The runner name is used only for logging; actual dispatch is delegated to
   * `dispatchRekick`.
   */
  findRunner(agentId: string): string | null;
  /**
   * Dispatch the re-kick prompt for `agentId` via the runner.
   * Returns a short result string (e.g. "queued", "sent") for the log.
   * May throw; caller catches and logs the error.
   */
  dispatchRekick(agentId: string, prompt: string): Promise<string>;
}

/**
 * Stub consensus engine seam. The real ConsensusEngine will be updated in a
 * future sprint. For now we just call these no-op stubs.
 */
export interface ConsensusEngineBridge {
  excludeAgent(agentId: string): void;
  restoreAgent(agentId: string): void;
}

// ---------------------------------------------------------------------------
// Default stubs
// ---------------------------------------------------------------------------

/** Default runner lookup: logs and returns null (no registered runner). */
const defaultRunnerLookup: RunnerLookup = {
  findRunner(_agentId: string): string | null {
    return null;
  },
  async dispatchRekick(_agentId: string, _prompt: string): Promise<string> {
    return 'no_runner';
  },
};

/** Default consensus bridge: logs the call. */
const defaultConsensusBridge: ConsensusEngineBridge = {
  excludeAgent(agentId: string): void {
    console.warn(`[LMD] ConsensusEngine.excludeAgent stub called for "${agentId}" — wire to real engine in a future sprint.`);
  },
  restoreAgent(agentId: string): void {
    console.warn(`[LMD] ConsensusEngine.restoreAgent stub called for "${agentId}" — wire to real engine in a future sprint.`);
  },
};

// ---------------------------------------------------------------------------
// StallRecovery
// ---------------------------------------------------------------------------

export interface StallRecoveryOptions {
  workspaceRoot: string;
  reader: HeartbeatReader;
  stateMachine?: HealthStateMachine;
  vscodeBridge?: VSCodeBridge;
  runnerLookup?: RunnerLookup;
  consensusEngine?: ConsensusEngineBridge;
  /** Override keepalive log path. Defaults to `<workspaceRoot>/.autoclaw/runtime/keepalive.log`. */
  keepaliveLogPath?: string;
  /** Logger. Defaults to `console`. */
  logger?: { warn: (msg: string) => void; error: (msg: string) => void; log?: (msg: string) => void };
}

/**
 * Global tick counter incremented each time a `health_change` is processed.
 * Used to detect if an agent remains stalled after 5 more ticks post-rekick.
 *
 * Stored on the class so unit tests can inject it if needed.
 */
export class StallRecovery {
  private readonly workspaceRoot: string;
  private readonly reader: HeartbeatReader;
  private readonly stateMachine: HealthStateMachine;
  private readonly vscodeBridge: VSCodeBridge;
  private readonly runnerLookup: RunnerLookup;
  private readonly consensusEngine: ConsensusEngineBridge;
  private readonly keepaliveLogPath: string;
  private readonly logger: { warn: (msg: string) => void; error: (msg: string) => void; log?: (msg: string) => void };

  /** Per-agent tick counter since re-kick was sent. Used for escalation. */
  private readonly rekickTicks: Map<string, number> = new Map();

  private _started = false;
  private _unsub: (() => void) | null = null;

  constructor(opts: StallRecoveryOptions) {
    this.workspaceRoot    = opts.workspaceRoot;
    this.reader           = opts.reader;
    this.stateMachine     = opts.stateMachine ?? opts.reader.stateMachine;
    this.vscodeBridge     = opts.vscodeBridge ?? { showWarningMessage: (m) => process.stderr.write(m + '\n') };
    this.runnerLookup     = opts.runnerLookup ?? defaultRunnerLookup;
    this.consensusEngine  = opts.consensusEngine ?? defaultConsensusBridge;
    this.keepaliveLogPath = opts.keepaliveLogPath
      ?? path.join(opts.workspaceRoot, '.autoclaw', 'runtime', 'keepalive.log');
    this.logger = opts.logger ?? console;
  }

  /** Start listening for health_change events. Idempotent. */
  start(): void {
    if (this._started) { return; }
    this._started = true;

    const handler = (evt: StateChangeEvent): void => { void this._onStateChange(evt); };
    this.reader.on('health_change', handler);
    this._unsub = () => { this.reader.off('health_change', handler); };
  }

  /** Stop listening. Idempotent. */
  stop(): void {
    if (!this._started) { return; }
    this._started = false;
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }

  // ---------------------------------------------------------------------------
  // Event handler
  // ---------------------------------------------------------------------------

  private async _onStateChange(evt: StateChangeEvent): Promise<void> {
    const { agentId, to } = evt;

    if (to === 'stalled') {
      await this._handleStalled(agentId, evt.at);
      return;
    }

    if (to === 'dead') {
      this._handleDead(agentId, evt.at);
      return;
    }

    if (to === 'alive' && (evt.from === 'degraded' || evt.from === 'stalled' || evt.from === 'dead')) {
      this._handleRecovered(agentId, evt.at);
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Stalled handler
  // ---------------------------------------------------------------------------

  private async _handleStalled(agentId: string, at: string): Promise<void> {
    const record = this.stateMachine.getState(agentId);

    // If we already sent a re-kick, increment escalation counter.
    if (record?.rekickSent) {
      const prevTicks = this.rekickTicks.get(agentId) ?? 0;
      const newTicks = prevTicks + 1;
      this.rekickTicks.set(agentId, newTicks);

      // After 5 more ticks still stalled → the state machine will naturally
      // transition to `dead` at 10 total missed beats. No manual escalation
      // needed; we just stop re-kicking.
      return;
    }

    // First stall: attempt re-kick.
    const runner = this.runnerLookup.findRunner(agentId);
    const prompt =
      `You have pending work in your inbox. Please check ` +
      `.autoclaw/orchestrator/comms/inboxes/${agentId}/ and resume.`;

    let result = 'no_runner';
    if (runner !== null) {
      try {
        result = await this.runnerLookup.dispatchRekick(agentId, prompt);
      } catch (err) {
        result = `error:${String(err)}`;
        this.logger.error(`[LMD] StallRecovery: re-kick failed for "${agentId}": ${String(err)}`);
      }
    } else {
      this.logger.warn(
        `[LMD] StallRecovery: no runner registered for "${agentId}" — logging stall only.`
      );
    }

    // Record on the AgentHealth that a re-kick was sent.
    this.rekickTicks.set(agentId, 0);
    // We don't have a tick counter here; use 0 as a placeholder — escalation
    // is driven by the natural state-machine transition to dead at 10 missed.
    this.stateMachine.markRekickSent(agentId, 0);

    this._appendLog({ at, agentId, action: 'rekick', runner: runner ?? 'none', result });
  }

  // ---------------------------------------------------------------------------
  // Dead handler
  // ---------------------------------------------------------------------------

  private _handleDead(agentId: string, at: string): void {
    // OS toast — use VS Code if available, otherwise stderr.
    const msg = `[AutoClaw LMD] Agent "${agentId}" is DEAD (10 missed heartbeats). Excluding from consensus quorum.`;
    try {
      this.vscodeBridge.showWarningMessage(msg);
    } catch {
      process.stderr.write(msg + '\n');
    }

    // Exclude from consensus quorum (stub or real).
    try {
      this.consensusEngine.excludeAgent(agentId);
    } catch (err) {
      this.logger.error(`[LMD] StallRecovery: consensusEngine.excludeAgent failed: ${String(err)}`);
    }

    this._appendLog({ at, agentId, action: 'dead', reason: '10_missed_heartbeats' });
  }

  // ---------------------------------------------------------------------------
  // Recovery handler
  // ---------------------------------------------------------------------------

  private _handleRecovered(agentId: string, at: string): void {
    this.rekickTicks.delete(agentId);

    try {
      this.consensusEngine.restoreAgent(agentId);
    } catch (err) {
      this.logger.error(`[LMD] StallRecovery: consensusEngine.restoreAgent failed: ${String(err)}`);
    }

    this._appendLog({ at, agentId, action: 'recovered' });
  }

  // ---------------------------------------------------------------------------
  // Log helper
  // ---------------------------------------------------------------------------

  private _appendLog(entry: KeepaliveLogEntry): void {
    const dir = path.dirname(this.keepaliveLogPath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this.keepaliveLogPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      this.logger.error(`[LMD] StallRecovery: failed to append to keepalive log: ${String(err)}`);
    }
  }
}
