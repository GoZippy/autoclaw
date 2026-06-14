/**
 * config.ts — load + validate the single Intelligence configuration surface
 * (`.autoclaw/vector/config.json`).
 *
 * Contract (R4):
 *  - Absent file ⇒ validated defaults, WITHOUT writing anything.
 *  - Present file ⇒ deep-merge over defaults, validate every field, replace any
 *    invalid/unknown-typed field with its default and surface a warning.
 *  - `loadConfig` NEVER throws on a bad config; it degrades to defaults.
 *
 * No `vscode` import and no `console` coupling — callers pass an optional
 * `log(msg)` to receive warnings (mirrors the `src/kg.ts` logger-injection
 * convention).
 */

import * as fs from 'fs';
import {
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingSignature,
  IntelligenceConfig,
  RagConfig,
  SearchConfig,
  SourceToggle,
  TokenLoggingConfig,
  VectorBackend,
} from './types';
import { intelligencePaths } from './paths';

export type LogFn = (msg: string) => void;

const VECTOR_BACKENDS: readonly VectorBackend[] = ['sqlite-vec', 'postgres'];
const EMBEDDING_PROVIDERS: readonly EmbeddingProvider[] = ['transformers', 'ollama', 'none'];

/**
 * Locked-decision defaults (see `.kiro/specs/README.md` D5/D7): sqlite-vec
 * backend, transformers provider with the 768-dim nomic model. Treated as
 * immutable — callers receive a deep clone via {@link loadConfig}.
 */
export const DEFAULT_CONFIG: IntelligenceConfig = {
  backend: 'sqlite-vec',
  sqlitePath: '.autoclaw/vector/db.sqlite',
  embedding: {
    provider: 'transformers',
    model: 'Xenova/nomic-embed-text-v1.5',
    dimension: 768,
  },
  rag: {
    codeChunkSize: 1000,
    codeOverlap: 200,
    ignoredDirs: [
      'node_modules',
      '.git',
      'dist',
      'out',
      'build',
      'coverage',
      '.autoclaw',
      '.vscode-test',
    ],
    fileExtensions: [
      '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
      '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.md',
    ],
    incremental: true,
  },
  search: {
    defaultLimit: 10,
    minSimilarity: 0.3,
  },
  tokenLogging: {
    enabled: true,
    aggregateIntoMetrics: true,
  },
  // Source enablement is populated by later specs (Tier-1 default-on, third
  // party opt-in per D13). Foundation ships an empty map.
  sources: {},
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Return validated defaults. Exported so callers (and tests) can get a fresh,
 * mutation-safe copy of the defaults without touching the module constant.
 */
export function defaultConfig(): IntelligenceConfig {
  return clone(DEFAULT_CONFIG);
}

/**
 * Load configuration for the workspace rooted at `workspaceRoot` (the directory
 * that contains `.autoclaw`). Never throws; invalid input degrades to defaults
 * with warnings routed through `log`.
 */
export function loadConfig(workspaceRoot: string, log?: LogFn): IntelligenceConfig {
  const warn: LogFn = log ?? (() => undefined);
  const cfg = defaultConfig();
  const { configPath } = intelligencePaths(workspaceRoot);

  let raw: string;
  try {
    if (!fs.existsSync(configPath)) {
      return cfg; // R4.2 — no file ⇒ defaults, no write
    }
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    warn(`intelligence config: could not read ${configPath}: ${(err as Error).message}; using defaults`);
    return cfg;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`intelligence config: invalid JSON in ${configPath}: ${(err as Error).message}; using defaults`);
    return cfg;
  }

  if (!isPlainObject(parsed)) {
    warn(`intelligence config: expected an object, got ${typeof parsed}; using defaults`);
    return cfg;
  }

  return mergeAndValidate(cfg, parsed, warn);
}

function mergeAndValidate(
  cfg: IntelligenceConfig,
  input: Record<string, unknown>,
  warn: LogFn,
): IntelligenceConfig {
  // backend
  if ('backend' in input) {
    if (VECTOR_BACKENDS.includes(input.backend as VectorBackend)) {
      cfg.backend = input.backend as VectorBackend;
    } else {
      warn(`intelligence config: invalid backend "${String(input.backend)}"; using "${cfg.backend}"`);
    }
  }

  // sqlitePath
  if ('sqlitePath' in input) {
    if (typeof input.sqlitePath === 'string' && input.sqlitePath.trim() !== '') {
      cfg.sqlitePath = input.sqlitePath;
    } else {
      warn(`intelligence config: invalid sqlitePath; using "${cfg.sqlitePath}"`);
    }
  }

  // postgres (optional)
  if ('postgres' in input && input.postgres !== undefined) {
    const pg = input.postgres;
    if (isPlainObject(pg) && typeof pg.connectionString === 'string' && pg.connectionString.trim() !== '') {
      cfg.postgres = { connectionString: pg.connectionString };
    } else {
      warn('intelligence config: invalid postgres block; ignoring');
    }
  }

  // embedding
  if ('embedding' in input) {
    cfg.embedding = mergeEmbedding(cfg.embedding, input.embedding, warn);
  }

  // rag
  if ('rag' in input) {
    cfg.rag = mergeRag(cfg.rag, input.rag, warn);
  }

  // search
  if ('search' in input) {
    cfg.search = mergeSearch(cfg.search, input.search, warn);
  }

  // tokenLogging
  if ('tokenLogging' in input) {
    cfg.tokenLogging = mergeTokenLogging(cfg.tokenLogging, input.tokenLogging, warn);
  }

  // sources
  if ('sources' in input) {
    cfg.sources = mergeSources(input.sources, warn);
  }

  return cfg;
}

function mergeEmbedding(base: EmbeddingConfig, input: unknown, warn: LogFn): EmbeddingConfig {
  if (!isPlainObject(input)) {
    warn('intelligence config: invalid embedding block; using defaults');
    return base;
  }
  const out: EmbeddingConfig = { ...base };
  if ('provider' in input) {
    if (EMBEDDING_PROVIDERS.includes(input.provider as EmbeddingProvider)) {
      out.provider = input.provider as EmbeddingProvider;
    } else {
      warn(`intelligence config: invalid embedding.provider "${String(input.provider)}"; using "${base.provider}"`);
    }
  }
  if ('model' in input) {
    if (typeof input.model === 'string' && input.model.trim() !== '') {
      out.model = input.model;
    } else {
      warn(`intelligence config: invalid embedding.model; using "${base.model}"`);
    }
  }
  if ('dimension' in input) {
    if (isFiniteNumber(input.dimension) && input.dimension > 0 && Number.isInteger(input.dimension)) {
      out.dimension = input.dimension;
    } else {
      warn(`intelligence config: invalid embedding.dimension; using ${base.dimension}`);
    }
  }
  if ('ollamaHost' in input && input.ollamaHost !== undefined) {
    if (typeof input.ollamaHost === 'string' && input.ollamaHost.trim() !== '') {
      out.ollamaHost = input.ollamaHost;
    } else {
      warn('intelligence config: invalid embedding.ollamaHost; ignoring');
    }
  }
  return out;
}

function mergeRag(base: RagConfig, input: unknown, warn: LogFn): RagConfig {
  if (!isPlainObject(input)) {
    warn('intelligence config: invalid rag block; using defaults');
    return base;
  }
  const out: RagConfig = { ...base };
  if ('codeChunkSize' in input) {
    if (isFiniteNumber(input.codeChunkSize) && input.codeChunkSize > 0) {
      out.codeChunkSize = input.codeChunkSize;
    } else {
      warn(`intelligence config: invalid rag.codeChunkSize; using ${base.codeChunkSize}`);
    }
  }
  if ('codeOverlap' in input) {
    if (isFiniteNumber(input.codeOverlap) && input.codeOverlap >= 0) {
      out.codeOverlap = input.codeOverlap;
    } else {
      warn(`intelligence config: invalid rag.codeOverlap; using ${base.codeOverlap}`);
    }
  }
  if ('ignoredDirs' in input) {
    if (isStringArray(input.ignoredDirs)) {
      out.ignoredDirs = input.ignoredDirs;
    } else {
      warn('intelligence config: invalid rag.ignoredDirs; using defaults');
    }
  }
  if ('fileExtensions' in input) {
    if (isStringArray(input.fileExtensions)) {
      out.fileExtensions = input.fileExtensions;
    } else {
      warn('intelligence config: invalid rag.fileExtensions; using defaults');
    }
  }
  if ('incremental' in input) {
    if (typeof input.incremental === 'boolean') {
      out.incremental = input.incremental;
    } else {
      warn(`intelligence config: invalid rag.incremental; using ${base.incremental}`);
    }
  }
  return out;
}

function mergeSearch(base: SearchConfig, input: unknown, warn: LogFn): SearchConfig {
  if (!isPlainObject(input)) {
    warn('intelligence config: invalid search block; using defaults');
    return base;
  }
  const out: SearchConfig = { ...base };
  if ('defaultLimit' in input) {
    if (isFiniteNumber(input.defaultLimit) && input.defaultLimit > 0 && Number.isInteger(input.defaultLimit)) {
      out.defaultLimit = input.defaultLimit;
    } else {
      warn(`intelligence config: invalid search.defaultLimit; using ${base.defaultLimit}`);
    }
  }
  if ('minSimilarity' in input) {
    if (isFiniteNumber(input.minSimilarity) && input.minSimilarity >= 0 && input.minSimilarity <= 1) {
      out.minSimilarity = input.minSimilarity;
    } else {
      warn(`intelligence config: invalid search.minSimilarity (want 0..1); using ${base.minSimilarity}`);
    }
  }
  return out;
}

function mergeTokenLogging(base: TokenLoggingConfig, input: unknown, warn: LogFn): TokenLoggingConfig {
  if (!isPlainObject(input)) {
    warn('intelligence config: invalid tokenLogging block; using defaults');
    return base;
  }
  const out: TokenLoggingConfig = { ...base };
  if ('enabled' in input) {
    if (typeof input.enabled === 'boolean') {
      out.enabled = input.enabled;
    } else {
      warn(`intelligence config: invalid tokenLogging.enabled; using ${base.enabled}`);
    }
  }
  if ('aggregateIntoMetrics' in input) {
    if (typeof input.aggregateIntoMetrics === 'boolean') {
      out.aggregateIntoMetrics = input.aggregateIntoMetrics;
    } else {
      warn(`intelligence config: invalid tokenLogging.aggregateIntoMetrics; using ${base.aggregateIntoMetrics}`);
    }
  }
  return out;
}

function mergeSources(input: unknown, warn: LogFn): Record<string, SourceToggle> {
  if (!isPlainObject(input)) {
    warn('intelligence config: invalid sources block; using {}');
    return {};
  }
  const out: Record<string, SourceToggle> = {};
  for (const [id, val] of Object.entries(input)) {
    if (isPlainObject(val) && typeof val.enabled === 'boolean') {
      out[id] = { enabled: val.enabled };
    } else {
      warn(`intelligence config: invalid sources["${id}"]; skipping`);
    }
  }
  return out;
}

/**
 * The active embedding identity, used by the Phase-4 dimension-mismatch guard
 * to detect when the configured model changed under an existing index.
 */
export function getActiveEmbeddingSignature(cfg: IntelligenceConfig): EmbeddingSignature {
  return { model: cfg.embedding.model, dimension: cfg.embedding.dimension };
}
