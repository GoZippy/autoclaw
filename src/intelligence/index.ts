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
} from './vectorEngine';
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
