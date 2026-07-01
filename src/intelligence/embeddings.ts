/**
 * embeddings.ts — embedding dispatch for the AutoClaw Intelligence Layer.
 *
 * Dispatches `getEmbedding(text, config, log?)` on a CONCRETE `config.provider`.
 * The `auto` provider is NOT handled here — it is resolved to a concrete one by
 * `embeddingResolve.ts` before any embed runs, so the index loop always sees a
 * pinned `{provider, model, dimension}`.
 *
 * Providers:
 *   - `router`: OpenAI-compatible POST `{model,input}` to `${routerHost}/v1/embeddings`
 *     (Zippy Mesh / any OpenAI-compat embeddings server). Node built-ins only.
 *   - `ollama`: POST `{model,prompt}` to `${ollamaHost}/api/embeddings`.
 *   - `transformers`: lazy dynamic import of `@xenova/transformers` (preferring a
 *     user-installed copy under {@link TRANSFORMERS_DIR_ENV}), pipeline cached.
 *   - `none`: deterministic hashed bag-of-words vector (no ML dependency, offline).
 *
 * GEOMETRY SAFETY: a single index pass must use ONE provider/model — vectors from
 * different models share no geometry. So `getEmbedding` does NOT chain across real
 * providers; on failure it degrades to `none` for that call (and warns ONCE), and
 * provider SELECTION is the resolver's job, not a per-call cascade. `embedStrict`
 * exposes the throw-on-failure path the resolver probes with.
 *
 * No `vscode` import; no I/O at module level. The Ollama/router HTTP calls use
 * only Node `http`/`https` built-ins, lazily required, so importing this module
 * never touches the network.
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
// Module-scope state
// ---------------------------------------------------------------------------

// Transformers pipeline cache (lazy, re-created if the model changes).
let cachedPipeline: unknown | null = null;
let cachedModel: string | null = null;

// A REAL dynamic `import()`. Under `module: commonjs` (this project's tsconfig)
// TypeScript downlevels a literal `import()` into `Promise.resolve().then(() =>
// require(...))`, and `require()` can neither load an ESM `file://` URL nor a
// pure-ESM package — exactly the two things the transformers loader must do.
// Building the import through the Function constructor hides it from the
// transpiler so the native, spec-compliant dynamic import survives.
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
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
// Hosts + timeouts
// ---------------------------------------------------------------------------

/** Default Ollama base URL when `config.ollamaHost`/env is unset. */
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
/** Default Zippy Mesh router base URL when `config.routerHost`/env is unset. */
const DEFAULT_ROUTER_HOST = 'http://127.0.0.1:20128';

/** Generous for an embed call; short for liveness detection. */
const EMBED_TIMEOUT_MS = 30000;
const DETECT_TIMEOUT_MS = 1500;
const EMBED_RETRY_DELAYS_MS = [250, 1000];

/**
 * Wall-clock backstop for a single embed call — strictly LONGER than the socket
 * timeout so a legitimately slow response is never cut short, but bounded so a
 * hung socket (on Windows a server can accept a connection and then never write,
 * a state in which `req.setTimeout` is not guaranteed to fire) cannot freeze the
 * whole index loop forever. Wraps every network embed via {@link hardDeadline}.
 */
const EMBED_HARD_DEADLINE_MS = 35000;

/**
 * Absolute ceiling on characters sent to an embedding provider in ONE call.
 * Embedding models have a fixed token context (e.g. Ollama `nomic-embed-text` is
 * 2048 tokens); an input past it is a DETERMINISTIC failure ("input length
 * exceeds the context length"), never a transient one. A single long source line
 * (minified JS, a bundled asset, a data blob) can produce a chunk far larger than
 * `config.rag.codeChunkSize`, so we cap defensively before the first attempt and
 * shrink-on-overflow after. The full chunk text is still STORED by the caller;
 * only the text handed to the embedder is truncated.
 */
const EMBED_MAX_INPUT_CHARS = 8000;
/** Floor for adaptive shrink so the retry loop always terminates. */
const EMBED_MIN_INPUT_CHARS = 400;
/** Max halvings from cap→floor before giving up (8000→…→400 is ~5). */
const EMBED_MAX_SHRINKS = 12;

/**
 * Hard wall-clock deadline so Windows socket-level timeouts (which can fail
 * to fire when a server accepts but never writes) cannot stall a detect call.
 */
function hardDeadline<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const tid = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('detect deadline'));
      }
    }, ms);
    if (typeof (tid as NodeJS.Timeout).unref === 'function') {
      (tid as NodeJS.Timeout).unref();
    }
    p.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(tid);
          resolve(v);
        }
      },
      (e) => {
        if (!done) {
          done = true;
          clearTimeout(tid);
          reject(e);
        }
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when the provider rejected the input for being longer than the model's
 * token context. This is DETERMINISTIC (the same input always fails), so it must
 * be handled by shrinking the input — never by a delay-retry (pointless) and
 * never by degrading to `none` (which would poison index geometry for a chunk
 * the provider could embed just fine at a smaller size). Depends on the response
 * body surviving into the error message — see {@link httpRequestJson}.
 */
function isContextLengthError(err: unknown): boolean {
  return /context length|context window|exceeds? the context|input (?:is )?too long|maximum context|too many tokens|reduce the (?:length|input)/i.test(
    errorMessage(err),
  );
}

function isTransientEmbeddingError(err: unknown): boolean {
  // A context-overflow 500 matches the HTTP 5xx rule below but is NOT transient —
  // classify it out first so it is shrunk, not blindly retried then degraded.
  if (isContextLengthError(err)) {
    return false;
  }
  const msg = errorMessage(err);
  return /HTTP 5\d\d|request timed out|ECONNRESET|EPIPE|socket hang up|fetch failed|detect deadline|embed deadline/i.test(msg);
}

/** Truncate `text` to at most `max` characters (head), leaving shorter text intact. */
function capInput(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Run one concrete embed with a wall-clock backstop. The `none` provider is pure
 * CPU (no socket) so it needs no deadline; every network provider is wrapped so a
 * hung connection cannot stall the caller indefinitely.
 */
function embedOnce(text: string, config: EmbeddingConfig): Promise<number[]> {
  if (config.provider === 'none') {
    return embedStrict(text, config);
  }
  return hardDeadline(EMBED_HARD_DEADLINE_MS, embedStrict(text, config)).catch((err) => {
    // Normalize the generic deadline message so the transient classifier and any
    // logs read as an embed timeout rather than the detector's wording.
    if (err instanceof Error && err.message === 'detect deadline') {
      throw new Error('embed deadline');
    }
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce an embedding vector for `text` using the (concrete) provider in
 * `config`. On any provider failure, degrades to `none` for THIS call and warns
 * at most once per distinct failure (R2.4). Never chains across real providers —
 * see the GEOMETRY SAFETY note in the file header.
 *
 * `onDegrade` (when supplied) is invoked on a real-provider→none degradation so a
 * caller embedding a whole corpus can detect that the pass mixed geometries and
 * surface a re-index prompt. It is NEVER called for the `none` provider (which
 * does not degrade) — only when a configured real provider failed.
 */
export async function getEmbedding(
  text: string,
  config: EmbeddingConfig,
  log?: LogFn,
  onDegrade?: () => void,
): Promise<number[]> {
  const warn: LogFn = log ?? (() => undefined);
  // Proactive cap: never hand a network provider more than it can embed in one
  // call. `none` has no context limit, so leave its (hashing) input untouched.
  let current = config.provider === 'none' ? text : capInput(text, EMBED_MAX_INPUT_CHARS);
  let lastError: unknown;
  let transientAttempts = 0;
  let shrinks = 0;
  for (;;) {
    try {
      return await embedOnce(current, config);
    } catch (err) {
      lastError = err;
      const msg = errorMessage(err);

      // (1) Deterministic "input too long" → shrink and retry IMMEDIATELY. A
      // delay-retry is pointless (same input, same failure) and degrading to
      // `none` would poison this chunk's geometry for a size the provider could
      // embed fine. Embedding a truncated head still yields a usable vector; the
      // caller stores the full chunk text regardless.
      if (
        config.provider !== 'none' &&
        isContextLengthError(err) &&
        current.length > EMBED_MIN_INPUT_CHARS &&
        shrinks < EMBED_MAX_SHRINKS
      ) {
        shrinks++;
        current = current.slice(0, Math.max(EMBED_MIN_INPUT_CHARS, Math.floor(current.length / 2)));
        warnOnce(
          warn,
          `provider-shrink:${config.provider}`,
          `embedding: an input exceeded the ${config.model} context window; embedding a ` +
            `truncated head of oversized chunks (full chunk text is still stored). (further ` +
            `identical notices this session are suppressed)`,
        );
        continue;
      }

      // (2) Genuinely transient failure (5xx that is not context-overflow,
      // timeout, reset, hung socket) → bounded delay-retry with the SAME input.
      if (
        config.provider !== 'none' &&
        transientAttempts < EMBED_RETRY_DELAYS_MS.length &&
        isTransientEmbeddingError(err)
      ) {
        warnOnce(
          warn,
          `provider-retry:${config.provider}:${msg.slice(0, 120)}`,
          `embedding: ${config.provider} provider had a transient failure (${msg}); retrying before ` +
            `degrading to basic 'none' embeddings. (further identical retry warnings this session ` +
            `are suppressed)`,
        );
        await sleep(EMBED_RETRY_DELAYS_MS[transientAttempts]);
        transientAttempts++;
        continue;
      }

      // (3) Not fixable here → fall through to the degrade-to-none path.
      break;
    }
  }
  const msg = errorMessage(lastError);
  if (config.provider !== 'none') {
    onDegrade?.();
  }
  warnOnce(
    warn,
    `provider-fail:${config.provider}:${msg.slice(0, 120)}`,
    `embedding: ${config.provider} provider unavailable (${msg}); using basic 'none' ` +
      `embeddings for now (lower retrieval quality). Run "AutoClaw: Intelligence — Set ` +
      `Embedding Provider" to pick Router/Ollama/offline, or fix the provider and re-index. ` +
      `(further identical warnings this session are suppressed)`,
  );
  return getNoneEmbedding(text, config.dimension);
}

/**
 * Embed `text` with the concrete provider in `config`, THROWING on any failure
 * (no `none` fallback). This is the path the resolver probes a candidate with
 * (success + the returned length tell it the provider works and its true
 * dimension). `getEmbedding` wraps this with the degrade-to-none safety net.
 */
export async function embedStrict(text: string, config: EmbeddingConfig): Promise<number[]> {
  switch (config.provider) {
    case 'router':
      return getRouterEmbedding(text, config);
    case 'ollama':
      return getOllamaEmbedding(text, config);
    case 'transformers':
      return getTransformersEmbedding(text, config);
    case 'none':
      return getNoneEmbedding(text, config.dimension);
    case 'auto':
      throw new Error(
        "embedding provider 'auto' must be resolved to a concrete provider before embedding",
      );
    default:
      throw new Error(`unknown embedding provider "${config.provider}"`);
  }
}

// ---------------------------------------------------------------------------
// Router provider — OpenAI-compatible POST /v1/embeddings (Zippy Mesh et al.)
// ---------------------------------------------------------------------------

/** Resolve the router base URL: config → ZIPPYMESH_HOST → default loopback. */
export function resolveRouterHost(routerHost?: string): string {
  return (
    normalizeHost(routerHost) ?? normalizeHost(process.env.ZIPPYMESH_HOST) ?? DEFAULT_ROUTER_HOST
  );
}

/**
 * Obtain an embedding from an OpenAI-compatible router (`POST /v1/embeddings`
 * with `{model, input}` → `{data:[{embedding}]}`). Honors a bearer token from
 * `ZIPPYMESH_TOKEN` and tags the request with `x-intent: embed` so the router
 * can route to an embedding-capable backend. Throws on any transport/HTTP/shape
 * error so the caller's degrade path engages.
 */
async function getRouterEmbedding(text: string, config: EmbeddingConfig): Promise<number[]> {
  const host = resolveRouterHost(config.routerHost);
  const body = await httpPostJson(
    `${host}/v1/embeddings`,
    { model: config.model, input: text },
    EMBED_TIMEOUT_MS,
    routerHeaders(),
  );
  const data = (body as { data?: unknown })?.data;
  const first = Array.isArray(data) && data.length > 0 ? (data[0] as { embedding?: unknown }) : undefined;
  const embedding = first?.embedding;
  if (!isUsableVector(embedding)) {
    throw new Error('router returned no usable embedding');
  }
  return embedding as number[];
}

/** Headers for a router request: bearer (if a token env is set) + embed intent. */
function routerHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'x-intent': 'embed' };
  const token = process.env.ZIPPYMESH_TOKEN;
  if (typeof token === 'string' && token.trim() !== '') {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

/**
 * Detect whether an OpenAI-compatible router is reachable (GET `/v1/models`,
 * falling back to `/api/health`). Host-free + dependency-free so commands can
 * surface a quick status. Resolves `false` on any failure.
 */
export async function detectRouter(routerHost?: string): Promise<boolean> {
  const host = resolveRouterHost(routerHost);
  for (const probe of [`${host}/v1/models`, `${host}/api/health`]) {
    try {
      await hardDeadline(DETECT_TIMEOUT_MS, httpGetJson(probe, DETECT_TIMEOUT_MS, routerHeaders()));
      return true;
    } catch {
      // try the next probe path
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ollama provider — native POST /api/embeddings
// ---------------------------------------------------------------------------

/**
 * POST `{ model, prompt }` to `${ollamaHost}/api/embeddings` and return the
 * embedding vector. Honors `config.ollamaHost`. Throws on any transport, HTTP,
 * or shape error so the caller's degrade path can engage.
 */
async function getOllamaEmbedding(text: string, config: EmbeddingConfig): Promise<number[]> {
  const host = normalizeHost(config.ollamaHost) ?? normalizeHost(process.env.OLLAMA_HOST) ?? DEFAULT_OLLAMA_HOST;
  const body = await httpPostJson(
    `${host}/api/embeddings`,
    { model: config.model, prompt: text },
    EMBED_TIMEOUT_MS,
  );
  const embedding = (body as { embedding?: unknown })?.embedding;
  if (!isUsableVector(embedding)) {
    throw new Error('ollama returned no usable embedding');
  }
  return embedding as number[];
}

/**
 * Detect whether an Ollama server is reachable at `ollamaHost` (defaults to
 * `http://localhost:11434`). Host-free + dependency-free. Resolves `false` on
 * any failure.
 */
export async function detectOllama(ollamaHost?: string): Promise<boolean> {
  const host = normalizeHost(ollamaHost) ?? normalizeHost(process.env.OLLAMA_HOST) ?? DEFAULT_OLLAMA_HOST;
  try {
    await hardDeadline(DETECT_TIMEOUT_MS, httpGetJson(`${host}/api/version`, DETECT_TIMEOUT_MS));
    return true;
  } catch {
    return false;
  }
}

/**
 * List the model names an Ollama server has pulled (GET `/api/tags`). Used by
 * the resolver to prefer an installed embedding model and to advise a `pull`
 * when none is present. Resolves `[]` on any failure.
 */
export async function listOllamaModels(ollamaHost?: string): Promise<string[]> {
  const host = normalizeHost(ollamaHost) ?? normalizeHost(process.env.OLLAMA_HOST) ?? DEFAULT_OLLAMA_HOST;
  try {
    const body = await httpGetJson(`${host}/api/tags`, DETECT_TIMEOUT_MS);
    const models = (body as { models?: Array<{ name?: unknown }> })?.models;
    if (!Array.isArray(models)) {
      return [];
    }
    return models
      .map((m) => (typeof m?.name === 'string' ? m.name : undefined))
      .filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Transformers provider — in-process @xenova/transformers (offline)
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
// None provider — deterministic hashed bag-of-words (offline, always works)
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic embedding from `text` without any ML dependency.
 * Uses a simple hashing scheme over tokenized words to fill a vector of
 * `dimension` floats. Same text always produces the same vector.
 */
export function getNoneEmbedding(text: string, dimension: number): number[] {
  const vector = new Float64Array(dimension); // zeroed

  const tokens = text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return Array.from(vector);
  }

  for (const token of tokens) {
    const h = fnv1aHash(token);
    const idx = Math.abs(h) % dimension;
    const sign = h % 2 === 0 ? 1 : -1;
    vector[idx] += sign;

    const h2 = fnv1aHash(token + '_2');
    const idx2 = Math.abs(h2) % dimension;
    const sign2 = h2 % 2 === 0 ? 1 : -1;
    vector[idx2] += sign2;
  }

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
// Shared helpers
// ---------------------------------------------------------------------------

/** True for a non-empty array of finite numbers. */
function isUsableVector(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** Strip a trailing slash and normalize a configured host, or return undefined. */
function normalizeHost(host?: string): string | undefined {
  if (typeof host !== 'string') {
    return undefined;
  }
  const trimmed = host.trim().replace(/\/+$/, '');
  return trimmed === '' ? undefined : trimmed;
}

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
// Minimal HTTP helpers (Node built-ins only, lazily required)
// ---------------------------------------------------------------------------

/** Issue a JSON POST and resolve the parsed response, rejecting on non-2xx. */
function httpPostJson(
  urlStr: string,
  payload: unknown,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<unknown> {
  return httpRequestJson(urlStr, 'POST', JSON.stringify(payload), timeoutMs, headers);
}

/** Issue a JSON GET and resolve the parsed response, rejecting on non-2xx. */
function httpGetJson(
  urlStr: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<unknown> {
  return httpRequestJson(urlStr, 'GET', undefined, timeoutMs, headers);
}

function httpRequestJson(
  urlStr: string,
  method: 'GET' | 'POST',
  payload: string | undefined,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch (err) {
      reject(new Error(`invalid host URL: ${(err as Error).message}`));
      return;
    }

    // Lazy require — keeps module import network-free.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lib = url.protocol === 'https:' ? require('https') : require('http');

    const headers: Record<string, string> = { Accept: 'application/json', ...(extraHeaders ?? {}) };
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
            // Keep a snippet of the body: providers report deterministic input
            // errors (e.g. Ollama's "the input length exceeds the context
            // length") only in the body, and the caller needs it to distinguish
            // a shrink-able overflow from a genuinely transient 5xx.
            const detail = data ? `: ${data.replace(/\s+/g, ' ').trim().slice(0, 300)}` : '';
            reject(new Error(`HTTP ${status}${detail}`));
            return;
          }
          try {
            resolve(data === '' ? {} : JSON.parse(data));
          } catch {
            reject(new Error('response was not valid JSON'));
          }
        });
      },
    );

    req.on('error', (err: Error) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timed out'));
    });
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
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
