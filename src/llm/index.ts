/**
 * src/llm/ — LLM provider abstraction (Phase B, S1 — Option C).
 *
 * Public surface:
 *   - `LlmProvider` interface + supporting types.
 *   - `OpenAiCompatibleProvider` base + `ZippyMeshProvider`, `OllamaProvider`.
 *   - `Oracle` — client-side fallback ladder (TS port of an upstream model-oracle script).
 *   - `CostLedger` — ZICO-aligned append-only ledger.
 *   - `LlmRegistry` — provider registry + three-branch `getPreferred()`.
 *   - `installFailsafe()` — idempotent `qwen3:0.6b@:11435` installer.
 *
 * Phase B (this slice) replaces `src/personas/provider-stub.ts`.
 *
 * @see docs/rfc/llm-provider-abstraction.md
 * @see docs/specs/llm-provider-s1/spec.md
 */

export type {
  ProviderId,
  ModelId,
  EndpointId,
  OracleTask,
  Locality,
  ChatMessage,
  ChatHints,
  ChatOptions,
  ChatResult,
  ProviderCapabilities,
  DetectionResult,
  DetectionResultFound,
  DetectionResultNotFound,
  ModelInfo,
  HealthReport,
  LlmProvider,
  ParsedProviderRef,
} from './types';

export { parseProviderRef, normalizeMessages, mergeCapabilities } from './types';

export {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleOptions,
  type OpenAiAuth,
} from './openai-compatible';

export {
  ZippyMeshProvider,
  type ZippyMeshOptions,
  type RecommendModelConstraints,
  type RecommendModelResult,
} from './zippymesh';

export { OllamaProvider, type OllamaOptions } from './ollama';

export {
  Oracle,
  DEFAULT_ENDPOINTS,
  detectCapabilities,
  estimateSize,
  type OracleEndpoint,
  type OracleEndpointConfig,
  type OracleModel,
  type OracleDecision,
  type OracleOptions,
  type EndpointType,
  type RateLimitEntry,
  type DetectedCapabilities,
} from './oracle';

export { CostLedger, type LedgerRow, type LedgerOperation } from './costLedger';

export {
  LlmRegistry,
  type RegistryOptions,
  type GetPreferredOptions,
  type PreferredPick,
} from './registry';

export {
  installFailsafe,
  _resetFailsafeCacheForTests,
  type FailsafeInstallResult,
  type FailsafeInstallOptions,
} from './failsafe-install';
