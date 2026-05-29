/**
 * OpenAI-compatible base provider.
 *
 * Most local servers (Ollama via /v1, LM Studio, vLLM, llama.cpp's
 * server, ZippyMesh) speak the OpenAI REST surface. This module
 * implements that surface once; subclasses specialise endpoint, auth,
 * and per-request headers.
 *
 * @see docs/rfc/llm-provider-abstraction.md §3.1
 * @see docs/specs/llm-provider-s1/spec.md (OpenAI-compatible base section)
 */

import type {
  ChatHints,
  ChatOptions,
  ChatResult,
  DetectionResult,
  HealthReport,
  LlmProvider,
  ModelId,
  ModelInfo,
  ProviderCapabilities,
  ProviderId,
} from './types';
import { normalizeMessages } from './types';

/** Auth configuration for an OpenAI-compatible endpoint. */
export type OpenAiAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; tokenEnv?: string; token?: string }
  | { kind: 'header'; headerName: string; tokenEnv?: string; token?: string };

export interface OpenAiCompatibleOptions {
  id: ProviderId;
  /** Base URL **including** the `/v1` prefix (e.g. `http://127.0.0.1:1234/v1`). */
  baseUrl: string;
  auth?: OpenAiAuth;
  defaultModel?: ModelId;
  capabilities: ProviderCapabilities;
  /** Optional override for the models-list path; default `/models`. */
  modelsPath?: string;
  /** Optional override for the chat-completions path; default `/chat/completions`. */
  chatPath?: string;
  /** Static extra headers attached to every request. */
  extraHeaders?: Record<string, string>;
  /**
   * Hook subclasses use to inject per-request headers from `ChatHints`.
   * Returns headers to MERGE into the request (does not replace defaults).
   */
  augmentHeaders?: (opts: ChatOptions) => Record<string, string>;
  /** Override fetch impl (tests use this to install an in-memory responder). */
  fetchImpl?: typeof fetch;
}

/**
 * Concrete OpenAI-compatible adapter.
 *
 * Subclasses (`OllamaProvider`, `ZippyMeshProvider`) provide only the
 * wiring that differs (endpoint, headers, optional model-list override).
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  readonly defaultModel?: ModelId;

  protected readonly baseUrl: string;
  protected readonly auth: OpenAiAuth;
  protected readonly modelsPath: string;
  protected readonly chatPath: string;
  protected readonly extraHeaders: Record<string, string>;
  protected readonly augmentHeaders?: (opts: ChatOptions) => Record<string, string>;
  protected readonly fetchImpl: typeof fetch;

  /** Last-known health snapshot fields, updated as side effects of chat/detect. */
  protected lastChatAt?: string;
  protected lastDetection?: DetectionResult;
  protected recentErrorCounts: Map<string, number> = new Map();

  constructor(opts: OpenAiCompatibleOptions) {
    this.id = opts.id;
    this.capabilities = opts.capabilities;
    this.defaultModel = opts.defaultModel;
    this.baseUrl = stripTrailingSlash(opts.baseUrl);
    this.auth = opts.auth ?? { kind: 'none' };
    this.modelsPath = opts.modelsPath ?? '/models';
    this.chatPath = opts.chatPath ?? '/chat/completions';
    this.extraHeaders = opts.extraHeaders ?? {};
    this.augmentHeaders = opts.augmentHeaders;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async detect(): Promise<DetectionResult> {
    try {
      const url = `${this.baseUrl}${this.modelsPath}`;
      const headers = this.buildHeaders();
      const auth = this.resolveAuth();
      if (auth.kind === 'bearer' && !auth.token && (this.auth as { tokenEnv?: string }).tokenEnv) {
        // Token env was named but empty; treat as no-auth — many local
        // servers don't require it. Still attempt the call so we can
        // distinguish a 401 from a connection refused.
      }
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 401 || res.status === 403) {
        const det: DetectionResult = {
          found: false,
          reason: 'no_auth',
          hint: `${this.id} at ${this.baseUrl} requires authentication (got ${res.status}).`,
        };
        this.lastDetection = det;
        return det;
      }
      if (!res.ok) {
        const det: DetectionResult = {
          found: false,
          reason: 'not_running',
          hint: `${this.id} at ${this.baseUrl} returned HTTP ${res.status}.`,
        };
        this.lastDetection = det;
        return det;
      }
      // Best-effort version detection — most OpenAI-compat servers don't
      // expose one on /models. Subclasses may override.
      const det: DetectionResult = {
        found: true,
        version: 'openai-compat',
        endpoint: this.baseUrl,
      };
      this.lastDetection = det;
      return det;
    } catch (err) {
      const det: DetectionResult = {
        found: false,
        reason: 'not_running',
        hint: `${this.id} at ${this.baseUrl} is unreachable: ${(err as Error).message}`,
      };
      this.lastDetection = det;
      return det;
    }
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const start = Date.now();
    const model = opts.model ?? this.defaultModel ?? 'auto';
    const messages = normalizeMessages(opts);
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };
    if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
    if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;
    if (opts.jsonMode) body.response_format = { type: 'json_object' };

    const headers = {
      ...this.buildHeaders(),
      'Content-Type': 'application/json',
      ...(this.augmentHeaders ? this.augmentHeaders(opts) : {}),
    };

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${this.chatPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      const durationMs = Date.now() - start;
      if (res.status === 429) {
        this.bumpError('rate_limit');
        return {
          ok: false,
          model,
          servedBy: this.id,
          durationMs,
          errorClass: 'internal',
          errorMessage: 'rate limited (429)',
          httpStatus: 429,
        };
      }
      if (res.status === 401 || res.status === 403) {
        this.bumpError('auth');
        return {
          ok: false,
          model,
          servedBy: this.id,
          durationMs,
          errorClass: 'auth',
          errorMessage: `auth failed (${res.status})`,
          httpStatus: res.status,
        };
      }
      if (!res.ok) {
        this.bumpError('internal');
        const text = await safeText(res);
        return {
          ok: false,
          model,
          servedBy: this.id,
          durationMs,
          errorClass: 'internal',
          errorMessage: `HTTP ${res.status}: ${text.slice(0, 200)}`,
          httpStatus: res.status,
        };
      }
      const json = (await res.json()) as OpenAiChatResponse;
      const choice = json.choices?.[0];
      const content = choice?.message?.content ?? '';
      const usage = json.usage;
      const result: ChatResult = {
        ok: true,
        response: content,
        model: json.model ?? model,
        servedBy: this.id,
        durationMs,
        tokens: usage
          ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }
          : undefined,
      };
      this.lastChatAt = new Date().toISOString();
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = (err as Error).message ?? String(err);
      const isAbort = (err as Error).name === 'AbortError' || message.includes('aborted');
      this.bumpError(isAbort ? 'timeout' : 'transport');
      return {
        ok: false,
        model,
        servedBy: this.id,
        durationMs,
        errorClass: isAbort ? 'timeout' : 'internal',
        errorMessage: isAbort ? 'request timed out' : `transport error: ${message}`,
      };
    }
  }

  async models(): Promise<ModelInfo[]> {
    try {
      const url = `${this.baseUrl}${this.modelsPath}`;
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as OpenAiModelsResponse;
      const items = json.data ?? [];
      return items.map((m) => ({
        id: m.id,
        contextWindow: m.context_window ?? undefined,
        family: m.owned_by ?? undefined,
        local: this.capabilities.locality === 'local',
      }));
    } catch {
      return [];
    }
  }

  async health(): Promise<HealthReport> {
    const det = this.lastDetection ?? (await this.detect());
    const reachable = det.found;
    const models = reachable ? await this.models() : [];
    const recentErrors: HealthReport['recentErrors'] = [];
    for (const [klass, count] of this.recentErrorCounts) {
      recentErrors.push({ class: klass as HealthReport['recentErrors'][0]['class'], count });
    }
    return {
      ok: reachable,
      reachable,
      authPresent: this.hasAuth(),
      version: reachable && det.found ? det.version : undefined,
      modelCount: models.length,
      lastChatAt: this.lastChatAt,
      recentErrors,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                           */
  /* ------------------------------------------------------------------ */

  protected buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...this.extraHeaders };
    const auth = this.resolveAuth();
    if (auth.kind === 'bearer' && auth.token) {
      h.Authorization = `Bearer ${auth.token}`;
    } else if (auth.kind === 'header' && auth.token) {
      h[auth.headerName] = auth.token;
    }
    return h;
  }

  protected resolveAuth(): OpenAiAuth & { token?: string } {
    if (this.auth.kind === 'none') return { kind: 'none' };
    if (this.auth.kind === 'bearer') {
      const token = this.auth.token ?? (this.auth.tokenEnv ? process.env[this.auth.tokenEnv] : undefined);
      return { kind: 'bearer', token, tokenEnv: this.auth.tokenEnv };
    }
    const token = this.auth.token ?? (this.auth.tokenEnv ? process.env[this.auth.tokenEnv] : undefined);
    return { kind: 'header', headerName: this.auth.headerName, token, tokenEnv: this.auth.tokenEnv };
  }

  protected hasAuth(): boolean {
    if (this.auth.kind === 'none') return true;
    const resolved = this.resolveAuth();
    if (resolved.kind === 'bearer' || resolved.kind === 'header') {
      return typeof resolved.token === 'string' && resolved.token.length > 0;
    }
    return false;
  }

  protected bumpError(klass: string): void {
    this.recentErrorCounts.set(klass, (this.recentErrorCounts.get(klass) ?? 0) + 1);
  }

  /** Build a `ChatHints`-aware header dict (subclasses may override). */
  protected augmentForRequest(_opts: ChatOptions, _hints?: ChatHints): Record<string, string> {
    return {};
  }
}

/* -------------------------------------------------------------------------- */
/*  HTTP response shapes (minimal — enough to parse what we use)              */
/* -------------------------------------------------------------------------- */

interface OpenAiChatResponse {
  model?: string;
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OpenAiModelsResponse {
  data?: { id: string; owned_by?: string; context_window?: number }[];
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
