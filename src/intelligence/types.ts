/**
 * types.ts — AutoClaw Intelligence Layer type contracts.
 *
 * Declarations only. These interfaces define the boundaries that
 * `intelligence-core-loop` and later specs fill in, taken (in spirit) from the
 * planning docs:
 *   - docs/planning/02-architecture.md  (config + module shape)
 *   - docs/planning/09-session-source-adapters.md (UnifiedSession, SourceAdapter)
 *
 * NOTHING here performs I/O or imports `vscode`. Keeping the contracts in a
 * standalone module lets core-loop import them immediately and keeps the whole
 * `src/intelligence/` tree unit-testable outside the extension host (mirroring
 * the `src/kg.ts` convention).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Vector backend that stores embeddings + metadata. */
export type VectorBackend = 'sqlite-vec' | 'postgres';

/** Embedding provider. `none` is the always-available degraded fallback that
 *  requires no native modules (see the foundation packaging strategy). */
export type EmbeddingProvider = 'transformers' | 'ollama' | 'none';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  /** Model id, e.g. `Xenova/nomic-embed-text-v1.5`. */
  model: string;
  /** Vector dimension the active model emits, e.g. 768. */
  dimension: number;
  /** Base URL for a local Ollama server when `provider === 'ollama'`. */
  ollamaHost?: string;
}

export interface PostgresConfig {
  /** Standard libpq connection string. */
  connectionString: string;
}

export interface RagConfig {
  /** Target characters per code chunk before splitting. */
  codeChunkSize: number;
  /** Characters of overlap between adjacent chunks. */
  codeOverlap: number;
  /** Directory names skipped during code indexing (e.g. node_modules). */
  ignoredDirs: string[];
  /** File extensions eligible for indexing (with leading dot, e.g. `.ts`). */
  fileExtensions: string[];
  /** Only re-index files changed since the last index pass. */
  incremental: boolean;
}

export interface SearchConfig {
  /** Default number of results returned by a retrieve/search call. */
  defaultLimit: number;
  /** Minimum cosine similarity (0..1) for a result to be kept. */
  minSimilarity: number;
}

export interface TokenLoggingConfig {
  /** Capture token usage from the existing LLM cost ledger. */
  enabled: boolean;
  /** Roll captured usage up into the Intelligence metrics store. */
  aggregateIntoMetrics: boolean;
}

/** Per-source enablement keyed by Source Adapter id (see {@link SourceAdapter}). */
export interface SourceToggle {
  enabled: boolean;
}

/**
 * The single configuration surface, persisted at
 * `.autoclaw/vector/config.json`. Absent fields fall back to {@link
 * IntelligenceConfig} defaults; absent file ⇒ full defaults.
 */
export interface IntelligenceConfig {
  backend: VectorBackend;
  /** Path to the sqlite-vec database file (forward slashes). */
  sqlitePath: string;
  /** Present only when `backend === 'postgres'`. */
  postgres?: PostgresConfig;
  embedding: EmbeddingConfig;
  rag: RagConfig;
  search: SearchConfig;
  tokenLogging: TokenLoggingConfig;
  /** Source Adapter id → enablement. Tier-1 (AutoClaw-native) default on;
   *  third-party sources default off (consent), enforced by later specs. */
  sources: Record<string, SourceToggle>;
}

/** The embedding identity used by the Phase-4 dimension-mismatch guard. */
export interface EmbeddingSignature {
  model: string;
  dimension: number;
}

// ---------------------------------------------------------------------------
// Memory records (typed kinds adopted from the AI Workforce OS assessment)
// ---------------------------------------------------------------------------

export type MemoryKind =
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'policy'
  | 'reflection'
  | 'failure';

/** A single distilled learning destined for the vector/memory store. */
export interface LearnedMemory {
  namespace: string;
  kind: MemoryKind;
  content: string;
  /** 0..1 confidence the learning is correct. */
  confidence: number;
  /** 0..1 relative importance for ranking/retention. */
  importance: number;
  source?: string;
  project?: string;
  createdAt: string;
  expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Unified session schema (docs/planning/09)
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface SessionCodeBlock {
  lang: string;
  code: string;
}

export interface SessionMessage {
  role: MessageRole;
  ts?: number;
  text: string;
  codeBlocks?: SessionCodeBlock[];
}

/** Why a piece of code was judged "kept" (signal for kept-vs-discarded). */
export type KeptReason = 'user_approval' | 'git_commit' | 'applied_edit';

export interface KeptCode {
  code: string;
  reason: KeptReason;
  /** 0..1 confidence in the kept signal. */
  confidence: number;
}

export interface SessionTokenUsage {
  prompt: number;
  completion: number;
  model?: string;
}

export type SessionOutcome = 'shipped' | 'discarded' | 'unknown';

export interface SessionSignals {
  keptCode: KeptCode[];
  gitKept?: boolean;
  gitKeptCommit?: { hash: string; message: string };
  tokenUsage?: SessionTokenUsage;
  outcome?: SessionOutcome;
}

export interface SessionProvenance {
  adapterId: string;
  /** Opaque reference back to the raw source (file path, db key, …). */
  rawRef: string;
  extractedAt: number;
}

/**
 * The normalized shape every Source Adapter emits. The learning pipeline only
 * ever sees this, so adding a new tool never touches `learn.ts`.
 */
export interface UnifiedSession {
  /** Stable, source-scoped id. */
  id: string;
  /** Adapter id that produced this session. */
  source: string;
  /** Human tool name (e.g. "Claude Code"). */
  tool: string;
  /** Resolved workspace/repo this session belongs to. */
  project?: string;
  startedAt: number;
  endedAt?: number;
  title?: string;
  summary?: string;
  messages: SessionMessage[];
  signals: SessionSignals;
  provenance: SessionProvenance;
}

// ---------------------------------------------------------------------------
// Source Adapter contract (docs/planning/09)
// ---------------------------------------------------------------------------

/** Environment handed to a Source Adapter's discovery routine. */
export interface AdapterEnv {
  /** Absolute home directory (per-OS). */
  homeDir: string;
  /** Active workspace root, if any (forward slashes). */
  workspaceRoot?: string;
  /** Platform string (`process.platform`). */
  platform: NodeJS.Platform;
  /** Selected environment variables an adapter may need (e.g. APPDATA). */
  env: Record<string, string | undefined>;
}

/** Result of an adapter probing for its source on this machine. */
export interface SourcePresence {
  available: boolean;
  /** Concrete locations found (files/dirs), forward-slash paths. */
  locations: string[];
  /** Remediation/explanation hint when unavailable or partially available. */
  hint?: string;
}

/** Options controlling an incremental transcript extraction. */
export interface ExtractOptions {
  /** Only pull sessions newer than this epoch-ms watermark. */
  sinceTs?: number;
  /** Restrict to a single workspace/project. */
  workspace?: string;
  /** Cap on the number of sessions yielded. */
  limit?: number;
}

/** What an adapter can extract — drives ranking/dedup decisions later. */
export interface AdapterCapabilities {
  /** Full message bodies + code blocks, not just previews. */
  fullTranscripts: boolean;
  codeBlocks: boolean;
  timestamps: boolean;
  workspaceAttribution: boolean;
  /** Can extract only-since-last-run. */
  incremental: boolean;
}

/**
 * Every ingestion source implements this. Discovery prefers delegating to the
 * AutoClaw runner registry (`src/runners/`) where a runner exists; otherwise it
 * probes known per-OS locations. No implementations exist in foundation — this
 * is the slot core-loop / universal-ingestion fill.
 */
export interface SourceAdapter {
  id: string;
  displayName: string;
  tier: 1 | 2 | 3;
  discover(env: AdapterEnv): Promise<SourcePresence>;
  extract(opts: ExtractOptions): AsyncIterable<UnifiedSession>;
  capabilities: AdapterCapabilities;
}
