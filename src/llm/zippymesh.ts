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
 * `recommendModel()` is the bridge to ZMLR's MCP `recommend_model`
 * handler. In S1 it returns null (ZMLR's MCP HTTP route doesn't exist
 * yet — see docs/specs/llm-provider-s2-zmlr-mcp-route/spec.md). The
 * registry treats null as "skip step 2 of getPreferred algorithm and
 * fall through to the oracle".
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
   * S1 stopgap: always returns null. S2 ships a PR to ZMLR exposing
   * `:20128/mcp` and this method calls it over HTTP.
   *
   * The registry treats null as "skip the ZMLR-recommend step and fall
   * through to the oracle's ladder".
   *
   * @see docs/specs/llm-provider-s2-zmlr-mcp-route/spec.md
   */
  async recommendModel(
    _intent: string,
    _constraints?: RecommendModelConstraints,
  ): Promise<RecommendModelResult | null> {
    return null;
  }
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
