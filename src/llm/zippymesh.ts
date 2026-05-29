/**
 * ZippyMesh LLM Router (ZMLR) adapter.
 *
 * Primary routing path per [docs/rfc/llm-provider-abstraction.md §3.4](../../docs/rfc/llm-provider-abstraction.md).
 *
 * Threads `x-intent` (canonical, smartRouter.js:269) and `x-zippy-intent`
 * (legacy, chat.js:131) on every chat call so ZMLR's playbook selection
 * works whether the user is running an older or newer ZMLR build. Also
 * supports `x-session-parallel` / `x-session-id` for /mateam fan-out.
 *
 * `recommendModel()` calls ZMLR's MCP `recommend_model` handler over the
 * `/mcp` HTTP route. On any failure (404 for older ZMLR builds without
 * the route, 502 when the handler self-reports failure, transport
 * timeout, connection refused) it returns null — the registry treats
 * null as "skip step 2 of getPreferred algorithm and fall through to
 * the oracle". See docs/specs/llm-provider-s2-zmlr-mcp-route/spec.md
 * for the ZMLR-side route contract and
 * docs/specs/llm-provider-s2-autoclaw-side/spec.md for this caller.
 *
 * @see ZMLR\src\sse\handlers\chat.js (line 131)
 * @see ZMLR\src\lib\routing\smartRouter.js (line 269)
 */

import type { ChatHints, ChatOptions } from './types';
import { OpenAiCompatibleProvider, type OpenAiCompatibleOptions } from './openai-compatible';

const DEFAULT_HOST = 'http://127.0.0.1:20128';

export interface ZippyMeshOptions {
  /** Override the host (e.g. for tests or remote ZMLR). */
  host?: string;
  /** Override the bearer token (defaults to `process.env.ZIPPYMESH_TOKEN`). */
  token?: string;
  /** Test hook — replace the global `fetch` for in-memory responders. */
  fetchImpl?: typeof fetch;
}

export interface RecommendModelConstraints {
  maxLatencyMs?: number;
  maxCostPerMTokens?: number;
  minContextWindow?: number;
  preferFree?: boolean;
  preferLocal?: boolean;
}

export interface RecommendModelResult {
  /** Resolved upstream model ZMLR picked. */
  model: string;
  /** Ordered fallback chain ZMLR would try if this model fails. */
  fallbackChain: string[];
}

export class ZippyMeshProvider extends OpenAiCompatibleProvider {
  constructor(opts: ZippyMeshOptions = {}) {
    const host = opts.host ?? process.env.ZIPPYMESH_HOST ?? DEFAULT_HOST;
    const config: OpenAiCompatibleOptions = {
      id: 'zippymesh',
      baseUrl: `${host}/v1`,
      auth: {
        kind: 'bearer',
        token: opts.token,
        tokenEnv: opts.token ? undefined : 'ZIPPYMESH_TOKEN',
      },
      defaultModel: 'auto',
      capabilities: {
        streaming: true,
        toolUse: true,
        jsonMode: true,
        embeddings: true,
        locality: 'lan',
        reportsCost: true,
        contextWindow: 200_000,
        modelFamilies: ['llama', 'qwen', 'claude', 'gpt', 'gemini', 'groq-llama'],
      },
      extraHeaders: { 'X-Client': 'autoclaw' },
      augmentHeaders: zippyMeshAugmentHeaders,
      fetchImpl: opts.fetchImpl,
    };
    super(config);
  }

  /**
   * Ask ZMLR's `recommend_model` MCP handler for a routing decision.
   *
   * POSTs `{ tool: 'recommend_model', input: { intent, constraints } }` to
   * `${host}/mcp` and parses the handler's response. Any failure mode
   * (404 — older ZMLR without the route, 502 — handler self-reported
   * failure, transport error, timeout) collapses to `null`, which the
   * registry treats as a signal to fall through to the oracle ladder.
   *
   * @see docs/specs/llm-provider-s2-zmlr-mcp-route/spec.md
   * @see docs/specs/llm-provider-s2-autoclaw-side/spec.md
   */
  async recommendModel(
    intent: string,
    constraints?: RecommendModelConstraints,
  ): Promise<RecommendModelResult | null> {
    const mcpUrl = this.deriveMcpUrl();
    try {
      const res = await this.fetchImpl(mcpUrl, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'recommend_model',
          input: {
            intent,
            constraints: constraints && mapConstraintsToHandlerShape(constraints),
          },
        }),
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) {
        // 404 (route not deployed yet) and 502 (handler self-reported
        // failure) both land here. Same observable: null. The registry
        // falls through to the oracle ladder.
        return null;
      }
      const json = (await res.json()) as RecommendModelHandlerResponse;
      if (!json.success) return null;
      return parseHandlerResponse(json);
    } catch {
      // Timeout / transport / parse error — return null. The oracle
      // ladder catches us.
      return null;
    }
  }

  /**
   * Derive the `/mcp` URL from the adapter's configured baseUrl.
   * baseUrl is e.g. `http://127.0.0.1:20128/v1`; we strip `/v1` and
   * append `/mcp`. Visible for testing.
   */
  protected deriveMcpUrl(): string {
    return this.baseUrl.replace(/\/v1\/?$/, '') + '/mcp';
  }
}

/* -------------------------------------------------------------------------- */
/*  recommend_model HTTP plumbing                                             */
/* -------------------------------------------------------------------------- */

/**
 * The shape ZMLR's recommend_model handler returns, per the ZMLR-side
 * spec. We accept the documented happy shape AND the looser legacy shape
 * (a plain `recommendations: string[]`) so the adapter keeps working
 * across ZMLR minor versions.
 */
interface RecommendModelHandlerResponse {
  success: boolean;
  /** Newer ZMLR — array of objects with model details. */
  recommendations?: Array<{ model?: string; id?: string } | string>;
  /** Ordered fallback chain ZMLR would try if the first recommendation fails. */
  fallbackChain?: string[];
  /** Older variant some ZMLR builds emit. */
  recommendation?: string | { model?: string; id?: string };
  /** Set when `success: false`. */
  error?: string;
}

function parseHandlerResponse(json: RecommendModelHandlerResponse): RecommendModelResult | null {
  const fallbackChain = Array.isArray(json.fallbackChain) ? json.fallbackChain : [];
  // Prefer the recommendations array (newer ZMLR), fall back to recommendation
  // (older variant), fall back to fallbackChain[0] if neither was provided.
  const top = pickTopRecommendation(json) ?? fallbackChain[0];
  if (!top) return null;
  return { model: top, fallbackChain };
}

function pickTopRecommendation(json: RecommendModelHandlerResponse): string | undefined {
  if (Array.isArray(json.recommendations) && json.recommendations.length > 0) {
    const first = json.recommendations[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') return first.model ?? first.id;
  }
  if (typeof json.recommendation === 'string') return json.recommendation;
  if (json.recommendation && typeof json.recommendation === 'object') {
    return json.recommendation.model ?? json.recommendation.id;
  }
  return undefined;
}

/**
 * Map the AutoClaw camelCase constraints to the snake_case shape ZMLR's
 * handler expects (per the input schema in zmlr-server.js).
 */
function mapConstraintsToHandlerShape(
  c: RecommendModelConstraints,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof c.maxLatencyMs === 'number') out.max_latency_ms = c.maxLatencyMs;
  if (typeof c.maxCostPerMTokens === 'number') out.max_cost_per_m_tokens = c.maxCostPerMTokens;
  if (typeof c.minContextWindow === 'number') out.min_context_window = c.minContextWindow;
  if (typeof c.preferFree === 'boolean') out.prefer_free = c.preferFree;
  if (typeof c.preferLocal === 'boolean') out.prefer_local = c.preferLocal;
  return out;
}

/**
 * Build the per-request headers for a ZMLR chat call.
 *
 * Sends BOTH `x-intent` and `x-zippy-intent` because the routing engine
 * reads different names in different code paths:
 *   - smartRouter.js:269 reads `x-intent`
 *   - chat.js:131 reads `x-zippy-intent`
 * Sending both means the request routes correctly regardless of which
 * code path handles it, with no client-side feature flag needed.
 */
export function zippyMeshAugmentHeaders(opts: ChatOptions): Record<string, string> {
  const h: Record<string, string> = {};
  const hints: ChatHints | undefined = opts.hints;
  if (hints?.intent) {
    h['x-intent'] = hints.intent;
    h['x-zippy-intent'] = hints.intent;
  }
  if (hints?.sessionParallel) {
    h['x-session-parallel'] = 'true';
    if (hints.sessionId) h['x-session-id'] = hints.sessionId;
  }
  return h;
}
