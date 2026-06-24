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
export {
  getEmbedding,
  embedStrict,
  getNoneEmbedding,
  detectOllama,
  detectRouter,
  listOllamaModels,
  resolveRouterHost,
  _resetPipelineCache,
} from './embeddings';
export {
  ConcreteProvider,
  ConcreteEmbeddingConfig,
  EmbeddingPin,
  ResolveResult,
  ResolveOptions,
  DEFAULT_EMBED_MODEL,
  resolveEmbeddingConfig,
  setEmbeddingProvider,
  clearEmbeddingPin,
  readEmbeddingPin,
  pickOllamaEmbedModel,
} from './embeddingResolve';
export {
  TRANSFORMERS_DIR_ENV,
  TRANSFORMERS_CACHE_ENV,
  InstallEmbeddingsOptions,
  InstallEmbeddingsResult,
  installEmbeddingsProvider,
  isEmbeddingsInstalled,
  resolveInstalledTransformersEntry,
  buildEmbeddingsInstallArgs,
} from './installEmbeddings';
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

// context-pack: orchestrator "context pack" producer (Channel A delivery)
export {
  ContextPackScope,
  ContextPackDeps,
  ContextPackOptions,
  ContextPackResult,
  ContextPackSummary,
  KgFact,
  buildContextPack,
  renderContextPackMarkdown,
} from './contextPack';

// host-context: per-host ambient project digest (Channel C delivery)
export {
  HostContextTarget,
  WriteHostContextResult,
  WriteHostContextOptions,
  resolveHostContextTargets,
  formatForHost,
  writeHostContextFiles,
} from './hostContext';

// refresh-service: standalone tick-based digest refresh (Channel C)
export {
  RefreshServiceOptions,
  RefreshServiceHandle,
  DEFAULT_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  startIntelligenceRefreshService,
} from './refreshService';

// kg-record: populate the Knowledge Graph from coordination outcomes + live events
export {
  RecordCoordinationDeps,
  RecordCoordinationResult,
  OrchestrationEvent,
  recordCoordinationToKg,
  recordOrchestrationEventsToKg,
} from './kgRecord';

// watch-service: always-on incremental code re-index (Intelligence watch)
export {
  IndexWatchOptions,
  IndexWatchHandle,
  DEFAULT_WATCH_DEBOUNCE_MS,
  MIN_WATCH_DEBOUNCE_MS,
  makeShouldIndex,
  startIndexWatchService,
} from './watchService';

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

// workflow-mining: tool-sequence patterns mined from session transcripts
export {
  SessionWorkflow,
  WorkflowPattern,
  WorkflowInsights,
  MineWorkflowsOptions,
  extractToolSteps,
  extractSessionWorkflow,
  mineWorkflows,
  workflowPatternLabel,
} from './workflows';

// effectiveness: tool × project matrix + snapshot persistence
export {
  EffectivenessCell,
  EffectivenessMatrix,
  ComputeEffectivenessOptions,
  computeEffectiveness,
} from './effectiveness';
export {
  EffectivenessFile,
  EFFECTIVENESS_FILE_NAME,
  effectivenessFilePath,
  getEffectiveness,
  recordEffectiveness,
} from './metrics/effectivenessStore';
