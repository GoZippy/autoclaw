/**
 * Public surface of the AutoClaw runner contract.
 *
 * Per-vendor runner adapters and the orchestrator import from here rather
 * than reaching into individual modules.
 *
 * @see docs/rfc/runner-bridge-contract.md
 */

export type {
  ArtifactRef,
  Capabilities,
  DetectionResult,
  DetectionResultFound,
  DetectionResultNotFound,
  DispatchOptions,
  DispatchResult,
  ErrorClass,
  HealthReport,
  PreferenceCriterion,
  PreferenceOptions,
  RegisteredRunner,
  Runner,
  ScopeDeclaration,
  SessionSummary,
  TrustPreset,
} from './types';

export { RunnerRegistry, TRUST_PRESET_TABLE, translateTrust } from './registry';
export type { TrustTranslation } from './registry';

export {
  ClaudeCodeRunner,
  CliHeadlessTransport,
  trustToPermissionMode,
} from './claude-code';
export type {
  ClaudeHeadlessTransport,
  ClaudePermissionMode,
  ClaudeRunArgs,
  ClaudeRunOutcome,
  ClaudeStreamEvent,
} from './claude-code';
