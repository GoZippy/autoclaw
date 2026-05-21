/**
 * types.ts — Shared types for the Lightweight Monitoring Daemon (LMD).
 *
 * The LMD is a pure file-I/O process monitor. It MUST NOT make any LLM or
 * network calls. Every symbol in this file is a plain TypeScript type/interface
 * — zero runtime cost.
 */

// ---------------------------------------------------------------------------
// Health state
// ---------------------------------------------------------------------------

/**
 * The four health states an agent can be in.
 *
 * Transition rules (based on consecutive missed 30 s heartbeats):
 *   alive     → degraded : 2  missed (≥ 60 s stale)
 *   degraded  → stalled  : 5  missed (≥ 150 s stale)
 *   stalled   → dead     : 10 missed (≥ 300 s stale)
 *   any       → alive    : heartbeat file updated (mtime newer than last check)
 */
export type HealthState = 'alive' | 'degraded' | 'stalled' | 'dead';

// ---------------------------------------------------------------------------
// Agent health record
// ---------------------------------------------------------------------------

/** Per-agent health snapshot maintained by HealthStateMachine. */
export interface AgentHealth {
  /** Canonical agent identifier (matches heartbeat filename without .json). */
  agentId: string;
  /** Optional session id from the heartbeat file. */
  sessionId?: string;
  /** Current health state. */
  state: HealthState;
  /** ISO timestamp from the most recent heartbeat file that was read. */
  lastHeartbeatAt: string;
  /** Number of consecutive 30 s polls where no new heartbeat was found. */
  missedHeartbeats: number;
  /** Optional queue depth reported in the heartbeat file. */
  queueDepth?: number;
  /** Last error message if a file-read or parse error occurred. */
  lastError?: string;
  /**
   * Set to true when a re-kick prompt has been dispatched for this agent.
   * Cleared when the agent returns to alive.
   */
  rekickSent?: boolean;
  /**
   * Tick count at which rekick was sent. Used to escalate to dead if the agent
   * remains stalled for 5 more ticks after a re-kick.
   */
  rekickSentAtTick?: number;
}

// ---------------------------------------------------------------------------
// State-change event
// ---------------------------------------------------------------------------

/** Payload emitted on the `stateChange` event of HealthStateMachine. */
export interface StateChangeEvent {
  agentId: string;
  from: HealthState;
  to: HealthState;
  /** ISO timestamp of the transition. */
  at: string;
}

// ---------------------------------------------------------------------------
// keepalive.log JSONL record
// ---------------------------------------------------------------------------

export type KeepaliveAction = 'rekick' | 'dead' | 'recovered';

export interface KeepaliveLogEntry {
  at: string;
  agentId: string;
  action: KeepaliveAction;
  /** Present when action = 'rekick'. */
  runner?: string;
  /** Present when action = 'rekick'. */
  result?: string;
  /** Present when action = 'dead'. */
  reason?: string;
}
