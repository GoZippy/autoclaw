/**
 * healthStateMachine.ts — Health state machine for the LMD.
 *
 * Tracks per-agent health states and fires `stateChange` events when an agent
 * transitions between states. Pure in-memory logic — no I/O, no LLM calls.
 *
 * Transition rules (consecutive missed 30 s heartbeats):
 *   alive    → degraded : 2 missed
 *   degraded → stalled  : 5 missed
 *   stalled  → dead     : 10 missed
 *   any      → alive    : heartbeat mtime newer than the last recorded beat
 *
 * This module MUST NOT import `vscode`. Unit tests run in plain Node/Mocha.
 */

import { EventEmitter } from 'events';
import type { HealthState, AgentHealth, StateChangeEvent } from './types';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const THRESHOLD_DEGRADED = 2;   // missed beats → degraded
const THRESHOLD_STALLED  = 5;   // missed beats → stalled
const THRESHOLD_DEAD     = 10;  // missed beats → dead

// ---------------------------------------------------------------------------
// HealthStateMachine
// ---------------------------------------------------------------------------

/**
 * Tracks health for a set of agents identified by string `agentId`.
 *
 * Consumers subscribe to the `stateChange` event:
 * ```ts
 * machine.on('stateChange', (evt: StateChangeEvent) => { ... });
 * ```
 */
export class HealthStateMachine extends EventEmitter {
  private readonly agents: Map<string, AgentHealth> = new Map();

  /**
   * Called on every 30 s heartbeat poll cycle.
   *
   * @param agentId     - The agent being ticked.
   * @param heartbeatMtime - The parsed `timestamp` from the heartbeat file, or
   *                       `null` if the file could not be read / parsed.
   * @param opts        - Optional extra fields from the heartbeat payload.
   * @returns The new `HealthState` if it changed, or `undefined` if unchanged.
   */
  tick(
    agentId: string,
    heartbeatMtime: Date | null,
    opts?: { sessionId?: string; queueDepth?: number; lastError?: string }
  ): HealthState | undefined {
    const now = new Date().toISOString();

    let record = this.agents.get(agentId);
    if (!record) {
      // First tick: bootstrap as alive, no state-change event.
      record = {
        agentId,
        state: 'alive',
        lastHeartbeatAt: heartbeatMtime ? heartbeatMtime.toISOString() : now,
        missedHeartbeats: 0,
        sessionId: opts?.sessionId,
        queueDepth: opts?.queueDepth,
        lastError: opts?.lastError,
      };
      this.agents.set(agentId, record);
      return undefined;
    }

    // Apply optional fields from the heartbeat payload.
    if (opts?.sessionId !== undefined) { record.sessionId = opts.sessionId; }
    if (opts?.queueDepth !== undefined) { record.queueDepth = opts.queueDepth; }
    if (opts?.lastError !== undefined) { record.lastError = opts.lastError; }

    const prev = record.state;

    if (heartbeatMtime !== null) {
      // Heartbeat arrived — check if it is newer than what we last saw.
      const lastAt = new Date(record.lastHeartbeatAt).getTime();
      if (heartbeatMtime.getTime() > lastAt) {
        // New beat — timestamp advanced, agent is alive.
        record.lastHeartbeatAt = heartbeatMtime.toISOString();
        record.missedHeartbeats = 0;
        record.lastError = opts?.lastError;
        record.rekickSent = false;
        record.rekickSentAtTick = undefined;
        record.state = 'alive';
      }
      // else: same timestamp as last time → treat as missed (no update from agent)
      else {
        record.missedHeartbeats++;
        record.state = this._computeState(record.missedHeartbeats);
      }
    } else {
      // Could not read / parse heartbeat file — count as a missed beat.
      record.missedHeartbeats++;
      record.state = this._computeState(record.missedHeartbeats);
    }

    if (record.state !== prev) {
      const evt: StateChangeEvent = { agentId, from: prev, to: record.state, at: now };
      this.emit('stateChange', evt);
      return record.state;
    }

    return undefined;
  }

  /** Compute state from missed-beat count. */
  private _computeState(missed: number): HealthState {
    if (missed >= THRESHOLD_DEAD)     { return 'dead'; }
    if (missed >= THRESHOLD_STALLED)  { return 'stalled'; }
    if (missed >= THRESHOLD_DEGRADED) { return 'degraded'; }
    return 'alive';
  }

  /** Get the current health record for a single agent. */
  getState(agentId: string): AgentHealth | undefined {
    return this.agents.get(agentId);
  }

  /** Get health records for all tracked agents. */
  getAll(): AgentHealth[] {
    return Array.from(this.agents.values());
  }

  /**
   * Mark that a re-kick has been sent for an agent.
   * Stores the current tick counter so we can escalate after 5 more ticks.
   *
   * @param agentId   - The agent that received the re-kick.
   * @param tickCount - The global tick counter at the time of sending.
   */
  markRekickSent(agentId: string, tickCount: number): void {
    const record = this.agents.get(agentId);
    if (record) {
      record.rekickSent = true;
      record.rekickSentAtTick = tickCount;
    }
  }
}
