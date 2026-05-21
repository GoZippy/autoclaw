/**
 * heartbeatReader.ts — Zero-token heartbeat file poller.
 *
 * Reads `.autoclaw/orchestrator/comms/heartbeats/<agent>.json` every 30 s
 * using a plain `setInterval`. For each file it:
 *   1. Parses the `timestamp` field (ISO string)
 *   2. Calls `stateMachine.tick(agentId, new Date(timestamp))`
 *   3. Emits `health_change` if the state changed
 *
 * *** NO LLM CALLS. NO NETWORK CALLS. Pure file I/O + JSON parse + Date compare. ***
 *
 * This module MUST NOT import `vscode`. It runs in plain Node.js and is fully
 * unit-testable without a VS Code host.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { HealthStateMachine } from './healthStateMachine';
import type { AgentHealth, StateChangeEvent } from './types';

// ---------------------------------------------------------------------------
// Heartbeat file shape
// ---------------------------------------------------------------------------

interface HeartbeatFile {
  agent_id?: string;
  timestamp: string;
  status?: string;
  current_task?: string;
  sprint?: string | null;
  session_id?: string;
  queue_depth?: number;
}

// ---------------------------------------------------------------------------
// HeartbeatReader
// ---------------------------------------------------------------------------

export interface HeartbeatReaderOptions {
  /**
   * Absolute path to the directory that contains `<agentId>.json` heartbeat
   * files.  Defaults to
   * `<workspaceRoot>/.autoclaw/orchestrator/comms/heartbeats/`.
   */
  heartbeatsDir?: string;
  /** Poll interval in milliseconds. Defaults to 30 000 (30 s). */
  intervalMs?: number;
  /**
   * Optional pre-built `HealthStateMachine`. If not provided, one is created
   * internally. Injecting it is useful for unit tests that need to inspect
   * state-change events independently.
   */
  stateMachine?: HealthStateMachine;
  /**
   * Optional logger. Defaults to `console`. Tests pass a silent stub.
   */
  logger?: { warn: (msg: string) => void; error: (msg: string) => void };
}

/**
 * Polls heartbeat files and drives the `HealthStateMachine`.
 *
 * Events:
 *   `health_change` — emitted with a `StateChangeEvent` payload whenever an
 *                     agent transitions to a new health state.
 */
export class HeartbeatReader extends EventEmitter {
  private readonly heartbeatsDir: string;
  private readonly intervalMs: number;
  readonly stateMachine: HealthStateMachine;
  private readonly logger: { warn: (msg: string) => void; error: (msg: string) => void };

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(workspaceRoot: string, opts: HeartbeatReaderOptions = {}) {
    super();
    this.heartbeatsDir = opts.heartbeatsDir
      ?? path.join(workspaceRoot, '.autoclaw', 'orchestrator', 'comms', 'heartbeats');
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.stateMachine = opts.stateMachine ?? new HealthStateMachine();
    this.logger = opts.logger ?? console;

    // Forward stateChange events from the state machine as health_change.
    this.stateMachine.on('stateChange', (evt: StateChangeEvent) => {
      this.emit('health_change', evt);
    });
  }

  /**
   * Start the 30 s polling loop. Safe to call multiple times (idempotent).
   */
  start(): void {
    if (this.running) { return; }
    this.running = true;
    // Poll immediately, then on interval.
    void this._poll();
    this.timer = setInterval(() => { void this._poll(); }, this.intervalMs);
  }

  /**
   * Stop the polling loop. Safe to call before start() or multiple times.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Returns a snapshot of all tracked agents' health for display in the Fleet
   * panel.
   */
  getHealthGrid(): AgentHealth[] {
    return this.stateMachine.getAll();
  }

  // ---------------------------------------------------------------------------
  // Internal polling logic
  // ---------------------------------------------------------------------------

  /**
   * Read all `*.json` files in the heartbeats directory and tick the state
   * machine for each agent.
   *
   * This is intentionally synchronous-style (readFileSync) inside an async
   * wrapper so the implementation stays simple and deterministic. The files are
   * small (< 1 KB each) and the directory is expected to have at most a handful
   * of entries, so blocking I/O is acceptable.
   */
  private _poll(): Promise<void> {
    // Make the method look async to allow `void this._poll()` without lint noise,
    // but the implementation is synchronous — no await, no network, no LLM.
    try {
      const entries = fs.readdirSync(this.heartbeatsDir);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) { continue; }
        const agentId = entry.slice(0, -5); // strip ".json"
        const filePath = path.join(this.heartbeatsDir, entry);
        this._tickAgent(agentId, filePath);
      }
    } catch (err) {
      // Directory might not exist yet — warn once and continue.
      this.logger.warn(
        `HeartbeatReader: cannot read heartbeats dir "${this.heartbeatsDir}": ${String(err)}`
      );
    }
    return Promise.resolve();
  }

  /**
   * Read a single heartbeat file and call `stateMachine.tick()`.
   * On parse error, ticks with `null` so the missed-beat counter increments.
   */
  private _tickAgent(agentId: string, filePath: string): void {
    let parsed: HeartbeatFile | null = null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      parsed = JSON.parse(raw) as HeartbeatFile;
    } catch (err) {
      this.logger.error(
        `HeartbeatReader: failed to read/parse "${filePath}": ${String(err)}`
      );
      this.stateMachine.tick(agentId, null, { lastError: String(err) });
      return;
    }

    const ts = parsed.timestamp;
    let mtime: Date | null = null;
    if (ts) {
      const d = new Date(ts);
      if (!isNaN(d.getTime())) {
        mtime = d;
      } else {
        this.logger.warn(
          `HeartbeatReader: invalid timestamp "${ts}" in "${filePath}"`
        );
      }
    }

    this.stateMachine.tick(agentId, mtime, {
      sessionId: parsed.session_id,
      queueDepth: parsed.queue_depth,
    });
  }
}
