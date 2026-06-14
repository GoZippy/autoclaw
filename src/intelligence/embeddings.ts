/**
 * embeddings.ts — embedding dispatch for the AutoClaw Intelligence Layer.
 *
 * Provides `getEmbedding(text, config, log?)` which dispatches on the configured
 * `EmbeddingProvider`:
 *   - `transformers`: lazy dynamic import of `@xenova/transformers`, pipeline
 *     cached in module scope. Normalizes mean-pooled output.
 *   - `none`: deterministic hashed bag-of-words vector (no ML dependency).
 *
 * Requirements:
 *   R2.1 — dispatch on config.embedding.provider
 *   R2.2 — transformers lazy-loaded + cached
 *   R2.3 — none deterministic, no ML dep
 *   R2.4 — fallback to none on error + warn
 *   R2.5 — no work at import time
 *
 * No `vscode` import; no I/O at module level.
 */

// @xenova/transformers is an optionalDependency, loaded dynamically at runtime.
declare module '@xenova/transformers' {
  export function pipeline(task: string, model: string): Promise<CallableFunction>;
}

import { EmbeddingConfig } from './types';
import { LogFn } from './config';

// ---------------------------------------------------------------------------
// Module-scope cache for the transformers pipeline (R2.2 — cached, lazy)
// ---------------------------------------------------------------------------

let cachedPipeline: unknown | null = null;
let cachedModel: string | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce an embedding vector for `text` using the provider specified in `config`.
 * Falls back to the `none` provider on any error (R2.4).
 */
export async function getEmbedding(
  text: string,
  config: EmbeddingConfig,
  log?: LogFn,
): Promise<number[]> {
  const warn: LogFn = log ?? (() => undefined);

  try {
    switch (config.provider) {
      case 'transformers':
        return await getTransformersEmbedding(text, config);
      case 'none':
        return getNoneEmbedding(text, config.dimension);
      case 'ollama':
        // Ollama provider is out of scope for this spec (Phase 4).
        // Fall through to `none` with a note.
        warn('embedding: ollama provider not yet implemented; falling back to none');
        return getNoneEmbedding(text, config.dimension);
      default:
        warn(`embedding: unknown provider "${config.provider}"; falling back to none`);
        return getNoneEmbedding(text, config.dimension);
    }
  } catch (err) {
    warn(`embedding: ${config.provider} failed (${(err as Error).message}); falling back to none`);
    return getNoneEmbedding(text, config.dimension);
  }
}

// ---------------------------------------------------------------------------
// Transformers provider (R2.2)
// ---------------------------------------------------------------------------

async function getTransformersEmbedding(
  text: string,
  config: EmbeddingConfig,
): Promise<number[]> {
  const pipeline = await getOrCreatePipeline(config.model);
  const output = await (pipeline as CallableFunction)(text, {
    pooling: 'mean',
    normalize: true,
  });
  // output.data is a Float32Array (or similar typed array) of the embedding
  const data: Float32Array = output.data;
  return Array.from(data).slice(0, config.dimension);
}

/**
 * Lazy-load `@xenova/transformers` and cache the feature-extraction pipeline.
 * Re-creates if the model changes (edge case during development).
 */
async function getOrCreatePipeline(model: string): Promise<unknown> {
  if (cachedPipeline && cachedModel === model) {
    return cachedPipeline;
  }

  // Dynamic import — never runs at module load (R2.5)
  const { pipeline } = await import('@xenova/transformers');
  cachedPipeline = await pipeline('feature-extraction', model);
  cachedModel = model;
  return cachedPipeline;
}

// ---------------------------------------------------------------------------
// None provider (R2.3) — deterministic hashed bag-of-words
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic embedding from `text` without any ML dependency.
 * Uses a simple hashing scheme over tokenized words to fill a vector of
 * `dimension` floats in the range [-1, 1]. Same text always produces the
 * same vector.
 */
export function getNoneEmbedding(text: string, dimension: number): number[] {
  const vector = new Float64Array(dimension); // zeroed

  // Tokenize: lowercase, split on non-word characters, remove empties
  const tokens = text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return Array.from(vector);
  }

  // Each token contributes to the vector via deterministic hashing.
  // We use multiple hash iterations per token to spread influence.
  for (const token of tokens) {
    const h = fnv1aHash(token);
    // Use the hash to pick an index and a sign
    const idx = Math.abs(h) % dimension;
    const sign = h % 2 === 0 ? 1 : -1;
    vector[idx] += sign;

    // Second hash for additional spread
    const h2 = fnv1aHash(token + '_2');
    const idx2 = Math.abs(h2) % dimension;
    const sign2 = h2 % 2 === 0 ? 1 : -1;
    vector[idx2] += sign2;
  }

  // Normalize to unit vector (L2 norm)
  let norm = 0;
  for (let i = 0; i < dimension; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < dimension; i++) {
      vector[i] /= norm;
    }
  }

  return Array.from(vector);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * FNV-1a hash (32-bit) — fast, simple, deterministic. Returns a signed 32-bit int.
 */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash | 0; // force 32-bit signed
}

// ---------------------------------------------------------------------------
// Testing helpers (exported for unit tests only)
// ---------------------------------------------------------------------------

/** Reset the cached pipeline — for testing teardown. */
export function _resetPipelineCache(): void {
  cachedPipeline = null;
  cachedModel = null;
}
