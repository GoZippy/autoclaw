/**
 * index.ts — Public API surface for the LMD (Lightweight Monitoring Daemon).
 *
 * Re-exports everything consumers need. Internal implementation details are
 * kept in their respective files.
 *
 * Zero LLM tokens: this entire module is pure file I/O + process monitoring.
 */

// Types
export type {
  HealthState,
  AgentHealth,
  StateChangeEvent,
  KeepaliveAction,
  KeepaliveLogEntry,
} from './types';

// Health state machine
export { HealthStateMachine } from './healthStateMachine';

// Heartbeat file reader
export { HeartbeatReader } from './heartbeatReader';
export type { HeartbeatReaderOptions } from './heartbeatReader';

// Stall recovery & dead-agent handling
export { StallRecovery } from './stallRecovery';
export type {
  StallRecoveryOptions,
  VSCodeBridge,
  RunnerLookup,
  ConsensusEngineBridge,
} from './stallRecovery';
