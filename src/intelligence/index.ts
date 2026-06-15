/**
 * index.ts — barrel export for the AutoClaw Intelligence Layer module.
 *
 * Foundation (Phase 0) is intentionally behavior-neutral: this barrel re-exports
 * the type contracts, config loader, path resolver, and file lock, but NOTHING
 * here is wired into the extension activation path. Importing this module
 * performs no I/O and no network access. Later specs (core-loop and beyond) add
 * the `learn`, `vectorEngine`, `ragCode`, and `sources/` registry slots that the
 * declared types already shape.
 */

export * from './types';
export {
  DEFAULT_CONFIG,
  LogFn,
  defaultConfig,
  loadConfig,
  getActiveEmbeddingSignature,
} from './config';
export {
  IntelligencePaths,
  intelligencePaths,
  ensureDir,
  isInsideContract,
  toForwardSlash,
} from './paths';
export { ReleaseFn, acquireLock, lockDirFor } from './fileLock';
export { resolveProjectKey } from './project';
export { redactSecrets } from './redact';
export { getEmbedding, getNoneEmbedding, _resetPipelineCache } from './embeddings';
export {
  VectorRecord,
  VectorSearchOptions,
  VectorSearchResult,
  StoreEmbeddingsOptions,
  ListIdsOptions,
  InitVectorDBOptions,
  VectorDB,
  initVectorDB,
  InitVectorDB,
  getBackendInitializer,
  initVectorBackend,
} from './vector';
export {
  SourceRegistry,
  CollectOptions,
  DiscoveredSource,
  DEFAULT_SOURCE_ENABLED,
  resolveEnabledSources,
  dedupSessions,
  createDefaultRegistry,
  defaultRegistry,
} from './sources/registry';
export { createAutoclawNativeAdapter } from './sources/autoclawNative';
export { createCursorAdapter, resolveCursorBaseDir } from './sources/cursor';
export { createGenericAdapter } from './sources/generic';
export {
  CodeChunk,
  GitRunner,
  IndexCodebaseOptions,
  IndexResult,
  RetrieveCodeOptions,
  CodeSearchResult,
  chunkCode,
  indexCodebase,
  retrieveCode,
} from './ragCode';
export { StyleAggregates, generateAgentStyle } from './agentStyle';
export {
  LearnOptions,
  LearnSummary,
  learnFromSessions,
} from './learn';

// ---------------------------------------------------------------------------
// Wave A (Phase 2-4) — universal ingestion, signal+rag, metrics, backend flex
// ---------------------------------------------------------------------------

// backend-flexibility: postgres backend + dimension guard + namespaces + ollama
export { initPostgresDB, InitPostgresDBOptions } from './vector';
export {
  SignatureCheck,
  checkSignature,
  signatureTag,
  requireForceOnMismatch,
  SignatureMismatchError,
  ReindexFn,
  DropNamespaceFn,
  MigrateOptions,
  MigrationResult,
  defaultNamespaceFor,
  migrateToNewSignature,
} from './vector/dimensionGuard';
export {
  SearchScope,
  projectNamespace,
  globalNamespace,
  isGlobalNamespace,
  resolveSearchScope,
} from './namespaces';
export { detectOllama } from './embeddings';

// universal-ingestion: discovery + watermarks + consent + new adapters + /sources
export {
  DiscoveredTool,
  DiscoverToolsOptions,
  RunnerDetector,
  discoverInstalledTools,
  runnerDataLocations,
  RUNNER_TO_ADAPTER,
} from './sources/discovery';
export {
  Watermark,
  WatermarkStore,
  getWatermark,
  setWatermark,
  watermarkStorePath,
  watermarkKey,
} from './sources/watermark';
export {
  NATIVE_SOURCE_ID,
  ConsentCandidate,
  ConsentDecision,
  isEnabled,
  defaultEnabledFor,
  ensureFirstRunConsent,
  recordConsent,
} from './sources/consent';
export { createClaudeCodeAdapter } from './sources/claudeCode';
export { createClaudeDesktopAdapter } from './sources/claudeDesktop';
export { createKiroAdapter } from './sources/kiro';
export { createGeminiAdapter } from './sources/gemini';
export {
  SourceRow,
  SourcesContext,
  ListSourcesOptions,
  listSources,
  setSourceEnabled,
  pendingConsentSources,
  renderSourcesReport,
  intelligenceSourcesReport,
  defaultAdapterEnv,
} from './sourcesCommand';

// signal-and-rag: git signals + ranking + RAG prompt + scaffold
export {
  GitSignalsOptions,
  CommitInfo,
  enrichSessionsWithGitSignals,
  resolveHomeDir,
} from './gitSignals';
export {
  SignalType,
  DerivedOutcome,
  SignalProvenance,
  deriveOutcome,
  weightForSignal,
  weightForRetrieval,
  provenanceForSession,
} from './ranking';
export {
  LearningHit,
  RAGPromptDeps,
  RAGPromptOptions,
  RAGPromptResult,
  ScaffoldOptions,
  generateRAGPrompt,
  buildScaffold,
} from './ragPrompt';

// metrics-dashboard: metrics store + cost-ledger bridge
export {
  LearningRunStats,
  RealTokenUsage,
  TrendPoint,
  TokenTotals,
  MetricsSummary,
  MetricsTrends,
  MetricsFile,
  DashboardData,
  MAX_RUNS,
  recordLearningRun,
  getMetrics,
  getDashboardData,
  metricsFilePath,
  computeSummary,
  computeTrends,
  buildMetricsFile,
} from './metrics/store';
export {
  LedgerLike,
  AggregateOptions,
  LedgerAggregate,
  aggregateRealTokens,
} from './metrics/ledgerBridge';
