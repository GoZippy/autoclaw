/**
 * index.ts — Public API surface for the Computer-Use Keep-Alive subsystem
 * (Sprint 4 / WA-3).
 *
 * The keep-alive subsystem re-kicks stalled agents through a priority fallback
 * chain (`runner → cli → computer_use → toast`). It consumes LMD health and
 * never makes an LLM call.
 */

// Types
export type {
  KeepaliveStrategyName,
  KeepaliveConfig,
  KeepaliveStrategy,
  StrategyContext,
  StrategyResult,
  StrategyOutcome,
  ChainResult,
} from './types';
export { DEFAULT_KEEPALIVE_CHAIN } from './types';

// Strategy chain (I1)
export {
  StrategyChain,
  loadKeepaliveConfig,
  runnerStrategy,
  cliStrategy,
  toastStrategy,
} from './strategyChain';
export type {
  StrategyChainOptions,
  RunnerRekick,
  CliStrategyOptions,
  ToastStrategyOptions,
} from './strategyChain';

// Computer-use strategy (I2)
export { computerUseStrategy, createPlaywrightDriver } from './computerUse';
export type { BrowserDriver, ComputerUseStrategyOptions } from './computerUse';

// Idle detection (computer-use safety gate)
export { detectIdle, DEFAULT_IDLE_THRESHOLD_MS } from './idleDetector';
export type { IdleStatus } from './idleDetector';

// Notification helper (toast strategy)
export { notifyAwaitingYou, appendAwaitingYou } from './notify';
export type { NotifyBridge, AwaitingYouEntry } from './notify';

// Per-IDE computer-use scripts
export { resolveScript, listScriptIds } from './scripts';
export type { IdeComputerUseScript, ComputerUseStep } from './scripts/types';

// Computer-use audit log
export { logComputerUseAction, computerUseLogDir, screenshotPath } from './computerUseLog';
export type { ComputerUseAction } from './computerUseLog';
