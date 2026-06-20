/**
 * modelCatalog.ts — model id → context-window lookup.
 *
 * The fleet panel's token/cost meters want a live "context fill" gauge, which
 * needs each model's maximum context window. No single map existed in the
 * codebase (values were scattered across provider capability blocks), so this
 * is the one place to look up a window by model id.
 *
 * Pure (no vscode / fs / native), so it unit-tests freely and can be imported
 * by both the host and the host-free webview renderers.
 *
 * Lookup is forgiving: an exact id wins; otherwise an explicit size marker in
 * the id (e.g. `claude-opus-4-8[1m]`) is honored; otherwise the id is
 * normalized (vendor prefix + date/quant suffix stripped) and matched by family
 * prefix; otherwise a conservative default is returned. Unknown is never an
 * error — callers get a usable number.
 */

/** Returned when a model id matches nothing — a safe, small floor. */
export const DEFAULT_CONTEXT_WINDOW = 8_000;

/**
 * Known maximum context windows, keyed by a normalized model id (see
 * {@link normalizeModelId}). Keep these conservative: when a vendor ships a
 * larger tier under a marker (e.g. `[1m]`), the marker path overrides this map,
 * so a too-small entry here is corrected by an explicit id, never the reverse.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic — Claude. Opus 4.8 ships a 1M tier (id `claude-opus-4-8[1m]`).
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-haiku-4': 200_000,
  'claude-fable-5': 200_000, // Claude-family default until a published figure lands.
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,

  // OpenAI — GPT / o-series.
  'gpt-4.1': 1_000_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  'o1': 200_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,

  // Google — Gemini.
  'gemini-1.5-pro': 2_000_000,
  'gemini-1.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-3-pro': 1_000_000,

  // Open-weight families (Ollama / ZippyMesh routing).
  'llama3.3': 128_000,
  'llama3.1': 128_000,
  'llama3': 8_192,
  'llama2': 4_096,
  'qwen3': 128_000,
  'qwen2.5': 128_000,
  'qwen2': 32_768,
  'mistral-large': 128_000,
  'mistral': 32_768,
  'mixtral': 32_768,
  'deepseek-v3': 64_000,
  'deepseek-coder': 128_000,
  'deepseek-r1': 64_000,
};

/** Family prefixes → window, tried after exact + marker lookups fail. */
const FAMILY_PREFIXES: Array<[string, number]> = Object.entries(MODEL_CONTEXT_WINDOWS)
  // Longest keys first so `claude-opus-4-8` wins over `claude-opus-4`.
  .sort((a, b) => b[0].length - a[0].length) as Array<[string, number]>;

/**
 * Normalize a raw model id to the catalog's key shape:
 * - lowercased
 * - vendor prefixes dropped (`anthropic/`, `us.anthropic.`, `openai:`, `models/…`)
 * - a trailing ollama quant/tag (`:70b`, `:latest`) dropped
 * - a trailing date stamp dropped (`-20250101`, `@2025-01-01`)
 * - a bracketed size marker (`[1m]`, `(200k)`) dropped (read separately)
 */
export function normalizeModelId(modelId: string): string {
  let id = String(modelId).trim().toLowerCase();
  // Drop a bracketed/parenthesized marker — handled by parseSizeMarker.
  id = id.replace(/[[(]\s*\d+\s*[km]\s*[\])]/g, '');
  // Vendor prefixes: keep only the segment after the last `/` or leading `vendor.`/`vendor:`.
  id = id.replace(/^[a-z0-9.-]+\//, '');         // `anthropic/`, `models/`
  id = id.replace(/^(?:us|eu|apac)\.anthropic\./, ''); // bedrock region prefix
  id = id.replace(/^[a-z]+:(?=[a-z])/, '');      // `openai:`, `claude-code:` style
  // Ollama tag/quant after a colon (`llama3.1:70b`, `qwen3:latest`).
  id = id.replace(/:[a-z0-9._-]+$/, '');
  // Trailing date stamp.
  id = id.replace(/[@-]\d{6,8}$/, '');
  id = id.replace(/@\d{4}-\d{2}-\d{2}$/, '');
  return id.trim();
}

/** Parse an explicit size marker like `[1m]` / `(200k)` → window in tokens. */
function parseSizeMarker(raw: string): number | undefined {
  const m = String(raw).toLowerCase().match(/[[(]\s*(\d+)\s*([km])\s*[\])]/);
  if (!m) { return undefined; }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) { return undefined; }
  return m[2] === 'm' ? n * 1_000_000 : n * 1_000;
}

/**
 * Best-effort maximum context window (in tokens) for a model id. Never throws;
 * returns {@link DEFAULT_CONTEXT_WINDOW} when nothing matches.
 */
export function contextWindowForModel(modelId?: string | null): number {
  if (!modelId) { return DEFAULT_CONTEXT_WINDOW; }
  // 1) An explicit marker in the raw id wins (e.g. `claude-opus-4-8[1m]`).
  const marked = parseSizeMarker(modelId);
  if (marked !== undefined) { return marked; }
  // 2) Exact normalized match.
  const norm = normalizeModelId(modelId);
  if (norm in MODEL_CONTEXT_WINDOWS) { return MODEL_CONTEXT_WINDOWS[norm]; }
  // 3) Family prefix match (longest key first).
  for (const [prefix, win] of FAMILY_PREFIXES) {
    if (norm.startsWith(prefix)) { return win; }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** True when the model is a known catalog entry (vs. a default fallback). */
export function isKnownModel(modelId?: string | null): boolean {
  if (!modelId) { return false; }
  if (parseSizeMarker(modelId) !== undefined) { return true; }
  const norm = normalizeModelId(modelId);
  if (norm in MODEL_CONTEXT_WINDOWS) { return true; }
  return FAMILY_PREFIXES.some(([prefix]) => norm.startsWith(prefix));
}
