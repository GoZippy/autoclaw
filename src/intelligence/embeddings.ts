/**
 * embeddings.ts — embedding dispatch for the AutoClaw Intelligence Layer.
 *
 * Provides `getEmbedding(text, config, log?)` which dispatches on the configured
 * `EmbeddingProvider`:
 *   - `transformers`: lazy dynamic import of `@xenova/transformers`, pipeline
 *     cached in module scope. Normalizes mean-pooled output.
 *   - `ollama`: HTTP POST to `${ollamaHost||'http://localhost:11434'}/api/embeddings`
 *     using Node built-ins only (no new deps); falls back ollama → transformers →
 *     none on failure, warning at each step (R2.1, R2.2 of backend-flexibility).
 *   - `none`: deterministic hashed bag-of-words vector (no ML dependency).
 *
 * Requirements:
 *   R2.1 — dispatch on config.embedding.provider
 *   R2.2 — transformers lazy-loaded + cached
 *   R2.3 — none deterministic, no ML dep
 *   R2.4 — fallback to none on error + warn
 *   R2.5 — no work at import time
 *   (backend-flexibility) R2.1/R2.2 — ollama provider honoring ollamaHost with a
 *   ollama → transformers → none fallback chain; R2.3 — first-run detection.
 *
 * No `vscode` import; no I/O at module level. The Ollama HTTP call uses only the
 * Node `http`/`https` built-ins, lazily required, so importing this module never
 * touches the network.
 */

// `@xenova/transformers` is an optionalDependency loaded dynamically at runtime
// (see `loadTransformersModule`); it has no static import, so its shape is typed
// locally via the `TransformersModule` interface below rather than an ambient
// `declare module`.

import { pathToFileURL } from 'url';

import { EmbeddingConfig } from './types';
import { LogFn } from './config';
import {
  resolveInstalledTransformersEntry,
  TRANSFORMERS_DIR_ENV,
  TRANSFORMERS_CACHE_ENV,
} from './installEmbeddings';

// ---------------------------------------------------------------------------
// Module-scope cache for the transformers pipeline (R2.2 — cached, lazy)
// ---------------------------------------------------------------------------

let cachedPipeline: unknown | null = null;
let cachedModel: string | null = null;

// A REAL dynamic `import()`. Under `module: commonjs` (this project's tsconfig)
// TypeScript downlevels a literal `import()` into `Promise.resolve().then(() =>
// require(...))`, and `require()` can neither load an ESM `file://` URL nor a
// pure-ESM package — exactly the two things the transformers loader must do.
// Building the import through the Function constructor hides it from the
// transpiler so the native, spec-compliant dynamic import survives.
const esmImport = new Function('specifier', 'return import(specifier);') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

// De-dupe noisy provider warnings: a failed index embeds every chunk, so a raw
// per-call warn floods the output with thousands of identical lines. Warn once
// per distinct message for the lifetime of the module (reset in tests).
const warnedKeys = new Set<string>();

/** Emit `msg` through `warn` at most once per distinct `key` (de-spam). */
function warnOnce(warn: LogFn, key: string, msg: string): void {
  if (warnedKeys.has(key)) {
    return;
  }
  warnedKeys.add(key);
  warn(msg);
}

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
        // Ollama → transformers → none fallback chain (R2.2). Performed inside
        // the case (not via the outer catch) so a failed Ollama call tries
        // transformers before settling on none, each step warning as it falls.
        return await getOllamaEmbeddingWithFallback(text, config, warn);
      default:
        warn(`embedding: unknown provider "${config.provider}"; falling back to none`);
        return getNoneEmbedding(text, config.dimension);
    }
  } catch (err) {
    const msg = (err as Error).message;
    warnOnce(
      warn,
      `provider-fail:${config.provider}:${msg.slice(0, 120)}`,
      `embedding: ${config.provider} provider unavailable (${msg}); using basic 'none' ` +
        `embeddings for now (lower retrieval quality). Run "AutoClaw: Intelligence — Install ` +
        `Embeddings Provider", switch to Ollama, or set embedding.provider to 'none' to silence ` +
        `this. (further identical warnings this session are suppressed)`,
    );
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

  // Dynamic import — never runs at module load (R2.5).
  const mod = await loadTransformersModule();
  configureTransformersCache(mod.env);
  cachedPipeline = await mod.pipeline('feature-extraction', model);
  cachedModel = model;
  return cachedPipeline;
}

/** The slice of the `@xenova/transformers` module surface this layer touches. */
interface TransformersModule {
  pipeline: (task: string, model: string) => Promise<CallableFunction>;
  /** Mutable global env (cacheDir, allowRemoteModels, …); absent on odd builds. */
  env?: Record<string, unknown>;
}

/**
 * Resolve `@xenova/transformers`, preferring a user-installed copy under
 * {@link TRANSFORMERS_DIR_ENV} (set by the install command) and falling back to
 * a bare specifier (which works in the dev tree where the package is a real
 * dependency). The installed copy is a pure-ESM package with no `exports` map,
 * so it must be imported by `file://` URL of its resolved entry — a bare
 * `import('@xenova/transformers')` cannot find it in the packaged extension.
 */
async function loadTransformersModule(): Promise<TransformersModule> {
  const dir = process.env[TRANSFORMERS_DIR_ENV];
  if (dir && dir.trim() !== '') {
    const entry = resolveInstalledTransformersEntry(dir);
    if (entry) {
      return (await esmImport(pathToFileURL(entry).href)) as unknown as TransformersModule;
    }
  }
  // Fallback: standard module resolution (dev tree / hoisted node_modules).
  return (await esmImport('@xenova/transformers')) as unknown as TransformersModule;
}

/**
 * Point the transformers model cache at the configured dir (set by the install
 * command from {@link TRANSFORMERS_CACHE_ENV}) so multi-hundred-MB model weights
 * download to a project-local / user-chosen location instead of silently to a
 * home/C: cache. No-op when unset or when the env shape is unexpected.
 */
function configureTransformersCache(env: Record<string, unknown> | undefined): void {
  const cache = process.env[TRANSFORMERS_CACHE_ENV];
  if (env && cache && cache.trim() !== '') {
    env.cacheDir = cache;
    env.allowRemoteModels = true; // permit the first-run download from the model hub
  }
}

// ---------------------------------------------------------------------------
// Ollama provider (backend-flexibility R2.1/R2.2) — local HTTP embeddings
// ---------------------------------------------------------------------------

/** Default Ollama base URL when `config.ollamaHost` is unset. */
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

/** Network timeouts: generous for embeddings, short for liveness detection. */
const OLLAMA_EMBED_TIMEOUT_MS = 30000;
const OLLAMA_DETECT_TIMEOUT_MS = 1500;

/** Strip a trailing slash and normalize a configured host, or return undefined. */
function normalizeHost(host?: string): string | undefined {
  if (typeof host !== 'string') {
    return undefined;
  }
  const trimmed = host.trim().replace(/\/+$/, '');
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Obtain an embedding from Ollama, falling back to `transformers` and then
 * `none` (each transition warns). Never throws — the chain always resolves to a
 * usable vector.
 */
async function getOllamaEmbeddingWithFallback(
  text: string,
  config: EmbeddingConfig,
  warn: LogFn,
): Promise<number[]> {
  try {
    return await getOllamaEmbedding(text, config);
  } catch (err) {
    warnOnce(
      warn,
      `ollama-fail:${(err as Error).message.slice(0, 120)}`,
      `embedding: ollama failed (${(err as Error).message}); falling back to transformers`,
    );
    try {
      return await getTransformersEmbedding(text, config);
    } catch (err2) {
      warnOnce(
        warn,
        `ollama-transformers-fail:${(err2 as Error).message.slice(0, 120)}`,
        `embedding: transformers fallback failed (${(err2 as Error).message}); ` +
          `falling back to none`,
      );
      return getNoneEmbedding(text, config.dimension);
    }
  }
}

/**
 * POST `{ model, prompt }` to `${ollamaHost}/api/embeddings` and return the
 * embedding vector. Honors `config.ollamaHost` (R2.1). Throws on any transport,
 * HTTP, or shape error so the caller's fallback chain can engage.
 */
async function getOllamaEmbedding(text: string, config: EmbeddingConfig): Promise<number[]> {
  const host = normalizeHost(config.ollamaHost) ?? DEFAULT_OLLAMA_HOST;
  const body = await httpPostJson(
    `${host}/api/embeddings`,
    { model: config.model, prompt: text },
    OLLAMA_EMBED_TIMEOUT_MS,
  );
  const embedding = (body as { embedding?: unknown })?.embedding;
  if (
    !Array.isArray(embedding) ||
    embedding.length === 0 ||
    !embedding.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw new Error('ollama returned no usable embedding');
  }
  return embedding as number[];
}

/**
 * Detect whether an Ollama server is reachable at `ollamaHost` (defaults to
 * `http://localhost:11434`). Host-free + dependency-free, so the command layer
 * can call it to surface a one-time first-run suggestion (D7 / R2.3) without
 * coupling this module to the extension host. Resolves `false` on any failure.
 */
export async function detectOllama(ollamaHost?: string): Promise<boolean> {
  const host = normalizeHost(ollamaHost) ?? DEFAULT_OLLAMA_HOST;
  try {
    await httpGetJson(`${host}/api/version`, OLLAMA_DETECT_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Minimal HTTP helpers (Node built-ins only, lazily required — R2.5)
// ---------------------------------------------------------------------------

/** Issue a JSON POST and resolve the parsed response, rejecting on non-2xx. */
function httpPostJson(urlStr: string, payload: unknown, timeoutMs: number): Promise<unknown> {
  return httpRequestJson(urlStr, 'POST', JSON.stringify(payload), timeoutMs);
}

/** Issue a JSON GET and resolve the parsed response, rejecting on non-2xx. */
function httpGetJson(urlStr: string, timeoutMs: number): Promise<unknown> {
  return httpRequestJson(urlStr, 'GET', undefined, timeoutMs);
}

function httpRequestJson(
  urlStr: string,
  method: 'GET' | 'POST',
  payload: string | undefined,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch (err) {
      reject(new Error(`invalid ollama host URL: ${(err as Error).message}`));
      return;
    }

    // Lazy require — keeps module import network-free (R2.5).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lib = url.protocol === 'https:' ? require('https') : require('http');

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res: any) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`ollama HTTP ${status}`));
            return;
          }
          try {
            resolve(data === '' ? {} : JSON.parse(data));
          } catch {
            reject(new Error('ollama returned invalid JSON'));
          }
        });
      },
    );

    req.on('error', (err: Error) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('ollama request timed out'));
    });
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
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

/** Reset the cached pipeline + warn-once ledger — for testing teardown. */
export function _resetPipelineCache(): void {
  cachedPipeline = null;
  cachedModel = null;
  warnedKeys.clear();
}
