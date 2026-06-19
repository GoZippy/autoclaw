/**
 * embeddingResolve.ts — resolve the `auto` embedding provider to a CONCRETE one
 * and PIN the choice, so the vector signature (`model@dimension`) stays stable
 * across runs and the dimension guard never sees it flapping.
 *
 * The ladder (first reachable wins; all overridable by an explicit
 * `embedding.provider` in config.json):
 *
 *   router (Zippy Mesh / OpenAI-compat)  →  ollama  →  transformers  →  none
 *
 * Resolution probes each rung with a REAL embed (for the network providers),
 * which simultaneously proves reachability AND measures the true vector
 * dimension — critical because router/ollama model dimensions vary and the
 * `signatureTag = model@dimension` guard needs a fixed dim. The chosen rung is
 * written to a sidecar (`.autoclaw/vector/embedding-resolved.json`) and reused on
 * subsequent runs; `none` is deliberately NOT pinned, so `auto` keeps looking for
 * a real provider the user may add later (a router start, an `ollama pull`).
 *
 * Geometry safety: switching the resolved provider changes the signature, which
 * the existing dimension guard turns into a clean reindex into a fresh namespace
 * — it never silently mixes vector spaces.
 *
 * Host-free: no `vscode` import. Network/fs only via `embeddings.ts` + `fs`.
 */

import * as fs from 'fs';
import * as path from 'path';

import { EmbeddingConfig, EmbeddingProvider, IntelligenceConfig } from './types';
import { LogFn } from './config';
import { intelligencePaths } from './paths';
import {
  embedStrict,
  detectRouter,
  detectOllama,
  listOllamaModels,
  resolveRouterHost,
} from './embeddings';
import { resolveInstalledTransformersEntry, TRANSFORMERS_DIR_ENV } from './installEmbeddings';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A tiny, fixed string embedded to probe a candidate provider + measure its dimension. */
const PROBE_TEXT = 'autoclaw embedding provider probe';

/** Default embedding model for the router/ollama rungs (768-dim, widely available). */
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

/** The in-process transformers model + its known dimension (no probe → no download). */
const TRANSFORMERS_MODEL = 'Xenova/nomic-embed-text-v1.5';
const TRANSFORMERS_DIM = 768;

/** Stable identity for the deterministic `none` provider. */
const NONE_MODEL = 'none-hashed-bow';

/** Sidecar file (under the vector dir) recording the pinned resolution. */
const PIN_FILENAME = 'embedding-resolved.json';

/** Substrings that mark an Ollama model as embedding-capable (not a chat model). */
const EMBED_MODEL_HINTS = ['embed', 'nomic', 'mxbai', 'bge', 'gte', 'e5', 'minilm'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved provider — every value except the unresolved `auto`. */
export type ConcreteProvider = Exclude<EmbeddingProvider, 'auto'>;

/** An embedding config whose provider is already resolved to a concrete one. */
export type ConcreteEmbeddingConfig = EmbeddingConfig & { provider: ConcreteProvider };

/** The pinned resolution persisted to the sidecar. */
export interface EmbeddingPin {
  provider: ConcreteProvider;
  model: string;
  dimension: number;
  routerHost?: string;
  ollamaHost?: string;
  /** ISO timestamp of when the resolution was made. */
  resolvedAt: string;
  /** Human note (e.g. why a rung was skipped) for status/debug. */
  note?: string;
}

export interface ResolveResult {
  /** The input config with `embedding` replaced by the concrete resolution. */
  config: IntelligenceConfig;
  /** The concrete provider chosen (never `auto`). */
  provider: Exclude<EmbeddingProvider, 'auto'>;
  /** How the provider was decided. */
  source: 'explicit' | 'pinned' | 'probed';
  /** True only when a fresh probe ran THIS call (drives the one-time nudge). */
  freshlyResolved: boolean;
  /** Per-rung notes collected during probing (e.g. "ollama up but no embed model"). */
  notes: string[];
}

export interface ResolveOptions {
  /** Dir a user-installed `@xenova/transformers` lives under (env wins if set). */
  transformersDir?: string;
  log?: LogFn;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve `cfg.embedding.provider` to a concrete provider. If it is already
 * explicit (not `auto`), the config is returned unchanged. If `auto`, a pinned
 * resolution is reused when present; otherwise the ladder is probed, the choice
 * pinned (except `none`), and a fresh result returned.
 */
export async function resolveEmbeddingConfig(
  cfg: IntelligenceConfig,
  workspaceRoot: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const warn: LogFn = opts.log ?? (() => undefined);

  // Explicit provider — honor it verbatim (power-user override).
  if (cfg.embedding.provider !== 'auto') {
    return {
      config: cfg,
      provider: cfg.embedding.provider,
      source: 'explicit',
      freshlyResolved: false,
      notes: [],
    };
  }

  // Reuse a previously pinned REAL provider — but only if it is STILL reachable.
  // A pin that points at a now-dead router/ollama would otherwise make the whole
  // index degrade to `none` mid-pass while still stamping the dead provider's
  // signature, silently mixing geometries. Re-checking liveness (cheap: a live
  // host answers in ms, a dead one refuses in ms) lets us re-probe the ladder
  // and rebuild under a consistent signature instead.
  const pin = readEmbeddingPin(workspaceRoot);
  if (pin && (await pinStillReachable(pin, opts))) {
    return {
      config: withEmbedding(cfg, pinToEmbedding(pin)),
      provider: pin.provider,
      source: 'pinned',
      freshlyResolved: false,
      notes: pin.note ? [pin.note] : [],
    };
  }
  if (pin) {
    warn(`embedding: pinned provider "${pin.provider}" is no longer reachable; re-detecting`);
    clearEmbeddingPin(workspaceRoot);
  }

  // Probe the ladder fresh.
  const { embedding, notes } = await probeLadder(cfg, workspaceRoot, opts, warn);

  // Pin every real provider; never pin `none` so `auto` keeps looking for an
  // upgrade (a router start / `ollama pull`) on the next run.
  if (embedding.provider !== 'none') {
    writeEmbeddingPin(workspaceRoot, {
      provider: embedding.provider,
      model: embedding.model,
      dimension: embedding.dimension,
      routerHost: embedding.routerHost,
      ollamaHost: embedding.ollamaHost,
      resolvedAt: new Date().toISOString(),
      note: notes.join(' | ') || undefined,
    }, warn);
  }

  return {
    config: withEmbedding(cfg, embedding),
    provider: embedding.provider,
    source: 'probed',
    freshlyResolved: true,
    notes,
  };
}

/**
 * Persist an EXPLICIT provider choice into `config.json` (the user picked it via
 * a command). Clears any auto-pin so the explicit choice wins cleanly. Returns
 * the concrete embedding written. Never throws on a write failure — reports via
 * `log` and returns the embedding anyway.
 */
export function setEmbeddingProvider(
  workspaceRoot: string,
  embedding: EmbeddingConfig,
  log?: LogFn,
): EmbeddingConfig {
  const warn: LogFn = log ?? (() => undefined);
  const { configPath } = intelligencePaths(workspaceRoot);
  clearEmbeddingPin(workspaceRoot);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const existing = readJsonObject(configPath);
    existing.embedding = pruneUndefined({ ...embedding });
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    warn(`embedding provider set to "${embedding.provider}" (${embedding.model}, dim ${embedding.dimension})`);
  } catch (err) {
    warn(`could not write embedding provider to ${configPath}: ${(err as Error).message}`);
  }
  return embedding;
}

/** Delete the auto-resolution pin so the next `auto` run re-probes the ladder. */
export function clearEmbeddingPin(workspaceRoot: string): void {
  try {
    fs.rmSync(pinPath(workspaceRoot), { force: true });
  } catch {
    // best-effort
  }
}

/** Read the current pin (for status display), or undefined if none/invalid. */
export function readEmbeddingPin(workspaceRoot: string): EmbeddingPin | undefined {
  try {
    const raw = fs.readFileSync(pinPath(workspaceRoot), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const provider = parsed.provider;
    const model = parsed.model;
    const dimension = parsed.dimension;
    if (
      typeof provider === 'string' &&
      (['router', 'ollama', 'transformers', 'none'] as string[]).includes(provider) &&
      typeof model === 'string' &&
      model.trim() !== '' &&
      typeof dimension === 'number' &&
      Number.isInteger(dimension) &&
      dimension > 0
    ) {
      return {
        provider: provider as ConcreteProvider,
        model,
        dimension,
        routerHost: typeof parsed.routerHost === 'string' ? parsed.routerHost : undefined,
        ollamaHost: typeof parsed.ollamaHost === 'string' ? parsed.ollamaHost : undefined,
        resolvedAt: typeof parsed.resolvedAt === 'string' ? parsed.resolvedAt : '',
        note: typeof parsed.note === 'string' ? parsed.note : undefined,
      };
    }
  } catch {
    // missing/invalid → no pin
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Ladder probing
// ---------------------------------------------------------------------------

async function probeLadder(
  cfg: IntelligenceConfig,
  workspaceRoot: string,
  opts: ResolveOptions,
  warn: LogFn,
): Promise<{ embedding: ConcreteEmbeddingConfig; notes: string[] }> {
  const notes: string[] = [];
  const seedDim = cfg.embedding.dimension;

  // --- Rung 1: router -----------------------------------------------------
  const routerHost = resolveRouterHost(cfg.embedding.routerHost);
  if (await detectRouter(routerHost)) {
    const model = cfg.embedding.model && isRouterModel(cfg.embedding.model)
      ? cfg.embedding.model
      : DEFAULT_EMBED_MODEL;
    const dim = await probeDimension({ provider: 'router', model, dimension: seedDim, routerHost }, warn);
    if (dim) {
      warn(`embedding: auto-detected router at ${routerHost} (model ${model}, dim ${dim})`);
      const embedding: ConcreteEmbeddingConfig = { provider: 'router', model, dimension: dim, routerHost };
      return { embedding, notes };
    }
    notes.push(`router reachable at ${routerHost} but did not serve embeddings (model "${model}")`);
  }

  // --- Rung 2: ollama -----------------------------------------------------
  const ollamaHost = cfg.embedding.ollamaHost; // undefined ⇒ embeddings.ts default/env
  if (await detectOllama(ollamaHost)) {
    const model = pickOllamaEmbedModel(await listOllamaModels(ollamaHost));
    if (model) {
      const dim = await probeDimension({ provider: 'ollama', model, dimension: seedDim, ollamaHost }, warn);
      if (dim) {
        warn(`embedding: auto-detected Ollama (model ${model}, dim ${dim})`);
        const embedding: ConcreteEmbeddingConfig = pruneUndefined({
          provider: 'ollama',
          model,
          dimension: dim,
          ollamaHost,
        });
        return { embedding, notes };
      }
      notes.push(`Ollama running but embedding with "${model}" failed`);
    } else {
      notes.push(
        `Ollama is running but no embedding model is pulled — run \`ollama pull ${DEFAULT_EMBED_MODEL}\` then re-detect`,
      );
    }
  }

  // --- Rung 3: transformers (installed only; no probe → no model download) -
  const transformersDir = process.env[TRANSFORMERS_DIR_ENV] || opts.transformersDir;
  if (transformersDir && resolveInstalledTransformersEntry(transformersDir)) {
    warn(`embedding: using installed offline transformers (${TRANSFORMERS_MODEL}, dim ${TRANSFORMERS_DIM})`);
    const embedding: ConcreteEmbeddingConfig = {
      provider: 'transformers',
      model: TRANSFORMERS_MODEL,
      dimension: TRANSFORMERS_DIM,
    };
    return { embedding, notes };
  }

  // --- Rung 4: none (always available; not pinned) ------------------------
  notes.push(
    "no embedding provider detected — using basic 'none' (lower retrieval quality). Start Zippy " +
      `Mesh, run \`ollama pull ${DEFAULT_EMBED_MODEL}\`, or install the offline provider, then re-index`,
  );
  const embedding: ConcreteEmbeddingConfig = { provider: 'none', model: NONE_MODEL, dimension: seedDim };
  return { embedding, notes };
}

/**
 * Probe a candidate by embedding {@link PROBE_TEXT}; returns the measured vector
 * dimension on success or `undefined` on any failure (so the ladder falls
 * through). Never throws.
 */
async function probeDimension(embedding: EmbeddingConfig, warn: LogFn): Promise<number | undefined> {
  try {
    const vec = await embedStrict(PROBE_TEXT, embedding);
    return Array.isArray(vec) && vec.length > 0 ? vec.length : undefined;
  } catch (err) {
    warn(`embedding probe (${embedding.provider}) failed: ${(err as Error).message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pick the best embedding-capable model from an Ollama tag list, or undefined. */
export function pickOllamaEmbedModel(models: string[]): string | undefined {
  const lower = (m: string) => m.toLowerCase();
  // Strongest signal first: an exact nomic-embed-text (any tag), then any name
  // that looks like a dedicated embedding model.
  const nomic = models.find((m) => lower(m).startsWith(`${DEFAULT_EMBED_MODEL}`));
  if (nomic) {
    return nomic;
  }
  return models.find((m) => EMBED_MODEL_HINTS.some((h) => lower(m).includes(h)));
}

/** A router model name is one a router would understand (not a `Xenova/...` transformers id). */
function isRouterModel(model: string): boolean {
  return !model.startsWith('Xenova/');
}

/**
 * Is a pinned provider still usable? Cheap liveness probe per provider kind:
 * router/ollama via a GET detect (live host answers in ms; dead host refuses in
 * ms), transformers via the on-disk install check. `none` is never pinned.
 */
async function pinStillReachable(pin: EmbeddingPin, opts: ResolveOptions): Promise<boolean> {
  switch (pin.provider) {
    case 'router':
      return detectRouter(pin.routerHost);
    case 'ollama':
      return detectOllama(pin.ollamaHost);
    case 'transformers': {
      const dir = process.env[TRANSFORMERS_DIR_ENV] || opts.transformersDir;
      return !!dir && resolveInstalledTransformersEntry(dir) !== undefined;
    }
    default:
      return true;
  }
}

function pinToEmbedding(pin: EmbeddingPin): EmbeddingConfig {
  const embedding: ConcreteEmbeddingConfig = {
    provider: pin.provider,
    model: pin.model,
    dimension: pin.dimension,
    routerHost: pin.routerHost,
    ollamaHost: pin.ollamaHost,
  };
  return pruneUndefined(embedding);
}

function withEmbedding(cfg: IntelligenceConfig, embedding: EmbeddingConfig): IntelligenceConfig {
  return { ...cfg, embedding };
}

function pinPath(workspaceRoot: string): string {
  return path.join(intelligencePaths(workspaceRoot).vectorDir, PIN_FILENAME);
}

function writeEmbeddingPin(workspaceRoot: string, pin: EmbeddingPin, warn: LogFn): void {
  try {
    const file = pinPath(workspaceRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pruneUndefined({ ...pin }), null, 2) + '\n', 'utf8');
  } catch (err) {
    warn(`could not pin embedding resolution: ${(err as Error).message}`);
  }
}

function readJsonObject(file: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Drop `undefined`-valued keys so JSON output stays clean (type-preserving). */
function pruneUndefined<T extends object>(obj: T): T {
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (rec[k] === undefined) {
      delete rec[k];
    }
  }
  return obj;
}
