/**
 * Ollama adapter.
 *
 * Fallback path when ZMLR is unreachable. Ollama exposes OpenAI-compat
 * at `/v1/*` (since 0.1.30+) — we use that for chat, but call the native
 * `/api/tags` for richer model metadata (parameter_size, family).
 *
 * @see docs/rfc/llm-provider-abstraction.md §3.2
 */

import type { ModelInfo } from './types';
import { OpenAiCompatibleProvider, type OpenAiCompatibleOptions } from './openai-compatible';

const DEFAULT_HOST = 'http://127.0.0.1:11434';

export interface OllamaOptions {
  /** Override the host (e.g. failsafe instance on a different port). */
  host?: string;
  /** Test hook. */
  fetchImpl?: typeof fetch;
  /** Override the adapter id (failsafe instance uses a different id). */
  id?: string;
}

export class OllamaProvider extends OpenAiCompatibleProvider {
  /** Bare host (no `/v1`) — used for native `/api/tags`. */
  private readonly bareHost: string;

  constructor(opts: OllamaOptions = {}) {
    const host = stripTrailingSlash(opts.host ?? process.env.OLLAMA_HOST ?? DEFAULT_HOST);
    const config: OpenAiCompatibleOptions = {
      id: opts.id ?? 'ollama',
      baseUrl: `${host}/v1`,
      auth: { kind: 'none' },
      capabilities: {
        streaming: true,
        toolUse: true, // varies per-model; cached after probeModelCapabilities
        jsonMode: true,
        embeddings: true,
        locality: 'local',
        reportsCost: false,
        contextWindow: 8192,
        modelFamilies: [],
        promptHarnesses: ['openai-tools'],
      },
      fetchImpl: opts.fetchImpl,
    };
    super(config);
    this.bareHost = host;
  }

  /**
   * Override `models()` to use Ollama's native `/api/tags` which exposes
   * richer metadata (`parameter_size`, `family`, `modified_at`) the
   * OpenAI-compat `/v1/models` omits.
   */
  override async models(): Promise<ModelInfo[]> {
    try {
      const res = await this.fetchImpl(`${this.bareHost}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as OllamaTagsResponse;
      const items = json.models ?? [];
      return items.map((m) => {
        const details = m.details ?? {};
        return {
          id: m.name,
          family: details.family ?? undefined,
          local: true,
          sizeB: parseParameterSize(details.parameter_size),
          capabilities: undefined, // populated lazily by probeModelCapabilities
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Override `detect()` to use `/api/version` for a real version string
   * (the OpenAI-compat `/v1/models` doesn't surface one).
   */
  override async detect() {
    try {
      const res = await this.fetchImpl(`${this.bareHost}/api/version`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        const det = {
          found: false as const,
          reason: 'not_running' as const,
          hint: `Ollama at ${this.bareHost} returned HTTP ${res.status}.`,
        };
        this.recordDetection(det);
        return det;
      }
      const json = (await res.json()) as { version?: string };
      const det = {
        found: true as const,
        version: json.version ?? 'unknown',
        endpoint: this.bareHost,
      };
      this.recordDetection(det);
      return det;
    } catch (err) {
      const det = {
        found: false as const,
        reason: 'not_running' as const,
        hint: `Ollama at ${this.bareHost} is unreachable: ${(err as Error).message}`,
      };
      this.recordDetection(det);
      return det;
    }
  }

  private recordDetection(det: { found: boolean }): void {
    // Cache parent's lastDetection by going through detect's normal path.
    // OpenAiCompatibleProvider tracks lastDetection in its detect();
    // mirror that here so health() sees the same data.
    (this as unknown as { lastDetection: typeof det }).lastDetection = det;
  }
}

interface OllamaTagsResponse {
  models?: {
    name: string;
    modified_at?: string;
    size?: number;
    details?: {
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
    };
  }[];
}

function parseParameterSize(s?: string): number | undefined {
  if (!s) return undefined;
  const m = s.match(/(\d+\.?\d*)\s*[bB]/);
  return m ? parseFloat(m[1]) : undefined;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
