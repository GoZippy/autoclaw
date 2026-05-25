/**
 * Client-side fallback Oracle — TypeScript port of an upstream
 * model-oracle script (Bun original).
 *
 * Discovers reachable LLM endpoints (ZMLR, Ollama, LM Studio, failsafe),
 * scores models per task class, tracks rate limits with persistent TTL
 * memory, and validates before handing a model to the caller. When
 * `LlmRegistry.getPreferred()` can't reach ZMLR's `recommend_model`, the
 * oracle picks.
 *
 * Diverges from the upstream original in two ways:
 *   1. ZMLR is included as a ladder rung (not just a routing decider) so
 *      a 429 on ZMLR's selected backend can fall through the same
 *      ladder while a different backend cools off.
 *   2. Rate-limit map persists to `.autoclaw/llm/oracle-state.json` so
 *      long autonomous AutoClaw loops don't re-fire paid 429s across
 *      process restarts.
 *
 * Does NOT port the Bun original's:
 *   - SQLite storage (uses a small JSON file)
 *   - HTTP daemon serve mode (AutoClaw uses oracle in-process)
 *   - Benchmark blending (`getBenchScore`) — deferred; S1 ships heuristic only.
 *   - Matrix display command (`cmdMatrix`)
 *
 * @see docs/rfc/llm-provider-abstraction.md §5a
 * @see docs/specs/llm-provider-s1/spec.md (Oracle section)
 * @see tmp/oracle-src/model-oracle.mjs (the Bun source we ported from)
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ChatHints, EndpointId, ModelId, OracleTask, ProviderId } from './types';

/* -------------------------------------------------------------------------- */
/*  Capability heuristics (ported verbatim from model-oracle.mjs)             */
/* -------------------------------------------------------------------------- */

const TOOLS_PATTERNS: RegExp[] = [
  /claude/i,
  /grok/i,
  /gemini/i,
  /deepseek-v[23]/i,
  /deepseek-v3/i,
  /llama-4/i,
  /llama3\.[23]/i,
  /qwen3\./i,
  /glm-4\.[5-9]/i,
  /llama3\.[1-9]/i,
  /llama-3\.[1-9]/i,
  /qwen[23]/i,
  /qwen2\.5/i,
  /mistral-nemo/i,
  /ministral/i,
  /mistral:7b/i,
  /mistral:latest/i,
  /phi3\.5/i,
  /phi4/i,
  /phi-4/i,
  /gemma3/i,
  /deepseek-coder-v2/i,
  /command-r/i,
  /opencoder/i,
  /devstral/i,
  /nemotron/i,
  /cogito/i,
  /olmo2/i,
  /solar/i,
  /lfm2/i,
  /corethink/i,
  /code-focus/i,
  /fast-code/i,
  /kimi/i,
  /glm-4\.7/i,
];

const THINKING_PATTERNS: RegExp[] = [
  /deepseek-r1/i,
  /\br1-/i,
  /-r1\b/i,
  /:r1\b/i,
  /\bqwq\b/i,
  /thinking/i,
  /reasoning/i,
  /openthinker/i,
  /exaone-deep/i,
  /cogito/i,
  /lfm2\.5.*think/i,
  /phi.*reason/i,
  /glm-4\.7.*flash/i,
  /r1-1776/i,
];

const VISION_PATTERNS: RegExp[] = [
  /llava/i,
  /vision/i,
  /-vl\b/i,
  /\bvl:/i,
  /\.vl\b/i,
  /llama3\.2-vision/i,
  /qwen.*vl/i,
  /gemma3:12b/i,
  /gemma3:27b/i,
  /granite.*vision/i,
  /moondream/i,
  /glm-ocr/i,
  /glm-4\.7/i,
];

const FREE_PATTERNS: RegExp[] = [/:free$/i, /corethink:free/i, /kilo.*free/i];

export interface DetectedCapabilities {
  supportsTools: boolean;
  supportsThinking: boolean;
  supportsVision: boolean;
  isFree: boolean;
  sizeB: number;
}

export function detectCapabilities(
  modelId: string,
  family = '',
  paramSize = '',
): DetectedCapabilities {
  const text = `${modelId} ${family} ${paramSize}`.toLowerCase();
  const sizeB = estimateSize(text, paramSize);
  return {
    supportsTools: TOOLS_PATTERNS.some((p) => p.test(text)),
    supportsThinking: THINKING_PATTERNS.some((p) => p.test(text)),
    supportsVision: VISION_PATTERNS.some((p) => p.test(text)),
    isFree: FREE_PATTERNS.some((p) => p.test(text)),
    sizeB,
  };
}

export function estimateSize(text: string, paramSize = ''): number {
  const fromField = paramSize && paramSize.match(/(\d+\.?\d*)\s*[bB]/);
  if (fromField) return parseFloat(fromField[1]);
  const m1 = text.match(/[:\-_](\d+\.?\d*)[bB]\b/);
  if (m1) return parseFloat(m1[1]);
  const m2 = text.match(/\b(\d+\.?\d*)[bB]\b/);
  if (m2) return parseFloat(m2[1]);
  if (/nano|tiny/i.test(text)) return 1;
  if (/mini|small/i.test(text)) return 3;
  if (/medium/i.test(text)) return 8;
  if (/large/i.test(text)) return 30;
  return 7;
}

/* -------------------------------------------------------------------------- */
/*  Endpoint registry                                                         */
/* -------------------------------------------------------------------------- */

export type EndpointType = 'zmlr' | 'ollama' | 'lmstudio';

export interface OracleEndpointConfig {
  id: EndpointId;
  type: EndpointType;
  baseUrl: string;
  /** Optional token for this endpoint. */
  apiKey?: string;
  /** Human-readable name for status output. */
  name: string;
  /** When true, the endpoint is the always-on bottom rung. */
  failsafe?: boolean;
}

/**
 * The default endpoint set probed by `Oracle.refresh()`. Mirrors the Bun
 * original's `ENDPOINTS` array, scoped to localhost-only by default
 * (remote ZMLR/Ollama deferred until the user opts in via config).
 */
export const DEFAULT_ENDPOINTS: OracleEndpointConfig[] = [
  {
    id: 'zmlr-local',
    type: 'zmlr',
    baseUrl: 'http://127.0.0.1:20128',
    name: 'ZMLR Local',
  },
  {
    id: 'ollama-local',
    type: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    name: 'Ollama Local',
  },
  {
    id: 'lmstudio-local',
    type: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234',
    name: 'LM Studio Local',
  },
  {
    id: 'ollama-failsafe',
    type: 'ollama',
    baseUrl: process.env.OLLAMA_FAILSAFE_URL ?? 'http://127.0.0.1:11435',
    name: 'Ollama Failsafe',
    failsafe: true,
  },
];

/* -------------------------------------------------------------------------- */
/*  Oracle types                                                              */
/* -------------------------------------------------------------------------- */

export interface OracleEndpoint {
  id: EndpointId;
  type: EndpointType;
  baseUrl: string;
  online: boolean;
  latencyMs?: number;
  version?: string;
  modelCount: number;
  failsafe: boolean;
  /** ISO timestamp of the last successful probe. */
  lastOnlineAt?: string;
}

export interface OracleModel {
  id: ModelId;
  endpointId: EndpointId;
  endpointType: EndpointType;
  capabilities: {
    tools: boolean;
    thinking: boolean;
    vision: boolean;
    free: boolean;
  };
  sizeB: number;
  local: boolean;
  /** ISO timestamp of last successful `validate()`. */
  lastValidatedAt?: string;
  lastValidatedOk?: boolean;
}

export interface OracleDecision {
  task: OracleTask;
  /** Selected model + endpoint, or null if nothing was available. */
  recommended: (OracleModel & { score: number }) | null;
  /** Up to five next-best candidates (excluding the recommended one). */
  alternatives: (OracleModel & { score: number })[];
  /** True when the recommendation came from a failsafe endpoint. */
  failsafe: boolean;
}

export interface RateLimitEntry {
  modelId: ModelId;
  endpointId: EndpointId;
  /** Epoch ms — entries past `resetsAt` are pruned on read. */
  resetsAt: number;
}

export interface OracleState {
  rateLimits: RateLimitEntry[];
  /** Schema version for forward-compat. */
  version: 1;
}

/* -------------------------------------------------------------------------- */
/*  Oracle implementation                                                     */
/* -------------------------------------------------------------------------- */

export interface OracleOptions {
  /** Workspace root — `.autoclaw/llm/oracle-state.json` is written here. */
  workspaceRoot: string;
  /** Override the endpoint set (e.g. for tests). */
  endpoints?: OracleEndpointConfig[];
  /** Test hook — replace global `fetch` with an in-memory responder. */
  fetchImpl?: typeof fetch;
  /** Skip the on-disk state read/write (in-memory only). Tests use this. */
  ephemeral?: boolean;
}

export class Oracle {
  private readonly workspaceRoot: string;
  private readonly endpointConfigs: OracleEndpointConfig[];
  private readonly fetchImpl: typeof fetch;
  private readonly ephemeral: boolean;

  /** Endpoint state map (id → OracleEndpoint). */
  private readonly endpoints: Map<EndpointId, OracleEndpoint> = new Map();
  /** Models per endpoint. */
  private readonly models: Map<EndpointId, OracleModel[]> = new Map();
  /** Rate-limit map keyed `${endpointId}:${modelId}`. */
  private readonly rateLimits: Map<string, RateLimitEntry> = new Map();

  constructor(opts: OracleOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.endpointConfigs = opts.endpoints ?? DEFAULT_ENDPOINTS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.ephemeral = opts.ephemeral ?? false;
    if (!this.ephemeral) {
      this.loadState();
    }
    // Seed endpoint entries as offline-until-refreshed.
    for (const cfg of this.endpointConfigs) {
      this.endpoints.set(cfg.id, {
        id: cfg.id,
        type: cfg.type,
        baseUrl: cfg.baseUrl,
        online: false,
        modelCount: 0,
        failsafe: cfg.failsafe ?? false,
      });
    }
  }

  /** Probe every endpoint and refresh the in-memory model catalogue. */
  async refresh(): Promise<OracleEndpoint[]> {
    const results: OracleEndpoint[] = [];
    for (const cfg of this.endpointConfigs) {
      let result: OracleEndpoint;
      try {
        if (cfg.type === 'zmlr') {
          result = await this.probeZmlr(cfg);
        } else if (cfg.type === 'ollama') {
          result = await this.probeOllama(cfg);
        } else {
          result = await this.probeLmStudio(cfg);
        }
      } catch (err) {
        result = {
          id: cfg.id,
          type: cfg.type,
          baseUrl: cfg.baseUrl,
          online: false,
          modelCount: 0,
          failsafe: cfg.failsafe ?? false,
        };
        // Errors during probe are non-fatal; just mark offline.
        void err;
      }
      this.endpoints.set(cfg.id, result);
      results.push(result);
    }
    return results;
  }

  /**
   * Pick the best model for a task. Re-queries fresh each call — no
   * cross-turn cache, matching the SKILL.md rule.
   *
   * Honors `hints.requireLocality` as a hard filter; honors the rate-limit
   * map (entries past `resetsAt` are pruned in `pruneExpired()`).
   */
  pick(task: OracleTask, hints?: ChatHints): OracleDecision {
    this.pruneExpired();
    const candidates: (OracleModel & { score: number })[] = [];
    for (const [endpointId, models] of this.models) {
      const ep = this.endpoints.get(endpointId);
      if (!ep || !ep.online) continue;
      for (const m of models) {
        if (hints?.requireLocality) {
          // Map endpoint type to locality.
          const locality = endpointTypeToLocality(m.endpointType);
          if (locality !== hints.requireLocality) continue;
        }
        if (this.isRateLimited(m.id, endpointId)) continue;
        const score = this.scoreModel(m, task);
        if (score < 0) continue;
        candidates.push({ ...m, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const recommended = candidates[0] ?? null;
    const alternatives = candidates.slice(1, 6);
    const failsafe = recommended ? !!this.endpoints.get(recommended.endpointId)?.failsafe : false;
    return { task, recommended, alternatives, failsafe };
  }

  /**
   * Probe a model end-to-end with a tiny completion. Returns ok=true
   * when the endpoint returns a parseable response.
   */
  async validate(
    modelId: ModelId,
    endpointId: EndpointId,
  ): Promise<{ ok: boolean; rateLimited: boolean; error?: string; latencyMs: number }> {
    const ep = this.endpoints.get(endpointId);
    const cfg = this.endpointConfigs.find((c) => c.id === endpointId);
    if (!ep || !cfg) {
      return { ok: false, rateLimited: false, error: 'unknown endpoint', latencyMs: 0 };
    }
    const start = Date.now();
    try {
      if (cfg.type === 'ollama') {
        const res = await this.fetchImpl(`${cfg.baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            prompt: 'Reply: OK',
            stream: false,
            options: { num_predict: 4 },
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const latencyMs = Date.now() - start;
        if (res.status === 429) {
          this.handle429(modelId, endpointId, res);
          return { ok: false, rateLimited: true, latencyMs };
        }
        if (!res.ok) return { ok: false, rateLimited: false, latencyMs, error: `HTTP ${res.status}` };
        const json = (await res.json()) as { response?: string };
        const ok = typeof json.response === 'string';
        this.markValidation(modelId, endpointId, ok);
        return { ok, rateLimited: false, latencyMs };
      }
      // OpenAI-compat (ZMLR, LM Studio)
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const res = await this.fetchImpl(`${cfg.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Reply: OK' }],
          max_tokens: 4,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - start;
      if (res.status === 429) {
        this.handle429(modelId, endpointId, res);
        return { ok: false, rateLimited: true, latencyMs };
      }
      if (!res.ok) return { ok: false, rateLimited: false, latencyMs, error: `HTTP ${res.status}` };
      const json = (await res.json()) as { choices?: unknown[] };
      const ok = Array.isArray(json.choices) && json.choices.length > 0;
      this.markValidation(modelId, endpointId, ok);
      return { ok, rateLimited: false, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - start;
      return { ok: false, rateLimited: false, latencyMs, error: (err as Error).message };
    }
  }

  /**
   * Record a 429 (or manual rate-limit) for a model+endpoint pair.
   * Persists to `oracle-state.json` unless `ephemeral` is true.
   */
  recordRateLimit(modelId: ModelId, endpointId: EndpointId, resetsAfterSec: number): void {
    const resetsAt = Date.now() + resetsAfterSec * 1000;
    const key = `${endpointId}:${modelId}`;
    this.rateLimits.set(key, { modelId, endpointId, resetsAt });
    if (!this.ephemeral) {
      this.saveState();
    }
  }

  /** True when the (model, endpoint) pair has an unexpired rate-limit entry. */
  isRateLimited(modelId: ModelId, endpointId: EndpointId): boolean {
    const key = `${endpointId}:${modelId}`;
    const entry = this.rateLimits.get(key);
    if (!entry) return false;
    if (entry.resetsAt <= Date.now()) {
      this.rateLimits.delete(key);
      return false;
    }
    return true;
  }

  /** Snapshot of endpoints + active rate limits. */
  status(): { endpoints: OracleEndpoint[]; rateLimited: RateLimitEntry[] } {
    this.pruneExpired();
    return {
      endpoints: [...this.endpoints.values()],
      rateLimited: [...this.rateLimits.values()],
    };
  }

  /** List of endpoints currently online. */
  onlineEndpoints(): OracleEndpoint[] {
    return [...this.endpoints.values()].filter((e) => e.online);
  }

  /**
   * Map this oracle's recommended endpoint to a stable provider id used
   * by the registry (`zippymesh` / `ollama`). LM Studio collapses to
   * `ollama`-like locally (caller decides whether to honor that).
   */
  static endpointToProviderId(endpointType: EndpointType): ProviderId {
    switch (endpointType) {
      case 'zmlr':
        return 'zippymesh';
      case 'ollama':
        return 'ollama';
      case 'lmstudio':
        return 'lmstudio';
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                         */
  /* ------------------------------------------------------------------ */

  private async probeZmlr(cfg: OracleEndpointConfig): Promise<OracleEndpoint> {
    const t0 = Date.now();
    const ver = await this.tryFetchJson(`${cfg.baseUrl}/api/health`, {}, 5_000);
    if (!ver.ok) return offlineEndpoint(cfg);
    const latencyMs = Date.now() - t0;
    const version = typeof ver.data?.version === 'string' ? ver.data.version : undefined;

    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const m = await this.tryFetchJson(`${cfg.baseUrl}/v1/models`, { headers }, 12_000);
    const items: { id: string }[] = Array.isArray(m.data?.data) ? m.data!.data : [];
    const models: OracleModel[] = items.map((item) => ({
      id: item.id,
      endpointId: cfg.id,
      endpointType: cfg.type,
      capabilities: capsBitsFromDetection(detectCapabilities(item.id)),
      sizeB: detectCapabilities(item.id).sizeB,
      local: false, // ZMLR proxies anywhere; treat as LAN
    }));
    this.models.set(cfg.id, models);
    return {
      id: cfg.id,
      type: cfg.type,
      baseUrl: cfg.baseUrl,
      online: true,
      latencyMs,
      version,
      modelCount: models.length,
      failsafe: cfg.failsafe ?? false,
      lastOnlineAt: new Date().toISOString(),
    };
  }

  private async probeOllama(cfg: OracleEndpointConfig): Promise<OracleEndpoint> {
    const t0 = Date.now();
    const ver = await this.tryFetchJson(`${cfg.baseUrl}/api/version`, {}, 5_000);
    if (!ver.ok) return offlineEndpoint(cfg);
    const latencyMs = Date.now() - t0;
    const version = typeof ver.data?.version === 'string' ? ver.data.version : undefined;

    const tags = await this.tryFetchJson(`${cfg.baseUrl}/api/tags`, {}, 12_000);
    const items: { name: string; details?: { family?: string; parameter_size?: string } }[] =
      Array.isArray(tags.data?.models) ? tags.data!.models : [];
    const models: OracleModel[] = items.map((item) => {
      const d = item.details ?? {};
      const caps = detectCapabilities(item.name, d.family ?? '', d.parameter_size ?? '');
      return {
        id: item.name,
        endpointId: cfg.id,
        endpointType: cfg.type,
        capabilities: capsBitsFromDetection(caps),
        sizeB: caps.sizeB,
        local: true,
      };
    });
    this.models.set(cfg.id, models);
    return {
      id: cfg.id,
      type: cfg.type,
      baseUrl: cfg.baseUrl,
      online: true,
      latencyMs,
      version,
      modelCount: models.length,
      failsafe: cfg.failsafe ?? false,
      lastOnlineAt: new Date().toISOString(),
    };
  }

  private async probeLmStudio(cfg: OracleEndpointConfig): Promise<OracleEndpoint> {
    const t0 = Date.now();
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const m = await this.tryFetchJson(`${cfg.baseUrl}/v1/models`, { headers }, 8_000);
    if (!m.ok) return offlineEndpoint(cfg);
    const latencyMs = Date.now() - t0;
    const items: { id: string }[] = Array.isArray(m.data?.data) ? m.data!.data : [];
    const models: OracleModel[] = items.map((item) => {
      const caps = detectCapabilities(item.id);
      return {
        id: item.id,
        endpointId: cfg.id,
        endpointType: cfg.type,
        capabilities: capsBitsFromDetection(caps),
        sizeB: caps.sizeB,
        local: true,
      };
    });
    this.models.set(cfg.id, models);
    return {
      id: cfg.id,
      type: cfg.type,
      baseUrl: cfg.baseUrl,
      online: true,
      latencyMs,
      modelCount: models.length,
      failsafe: cfg.failsafe ?? false,
      lastOnlineAt: new Date().toISOString(),
    };
  }

  private async tryFetchJson(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<{ ok: boolean; data?: Record<string, unknown> }> {
    try {
      const res = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false };
      const data = (await res.json()) as Record<string, unknown>;
      return { ok: true, data };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Score a model for a task. Returns -1 to exclude, 0+ to rank.
   * Ported verbatim from model-oracle.mjs `scoreModel()`. Bench blending
   * is omitted in S1 (heuristic-only); benchmark hooks live in S4.
   */
  private scoreModel(model: OracleModel, task: OracleTask): number {
    const ep = this.endpoints.get(model.endpointId);
    if (!ep) return -1;
    if (ep.failsafe) return 1; // Failsafe wins only when everything else is gone.

    const isLocal = model.local;
    const isFree = model.capabilities.free || isLocal;
    const sizeB = model.sizeB || 7;

    let score = 0;

    switch (task) {
      case 'agent':
        if (!model.capabilities.tools) return -1;
        score += model.capabilities.thinking ? 30 : 0;
        score += isLocal ? 25 : 0;
        score += isFree ? 15 : 0;
        score += Math.min(sizeB, 70) * 0.5;
        break;
      case 'tool':
        if (!model.capabilities.tools) return -1;
        score += isLocal ? 20 : 0;
        score += isFree ? 10 : 0;
        score += Math.min(sizeB, 30) * 0.3;
        break;
      case 'thinking':
        if (!model.capabilities.thinking) return -1;
        score += model.capabilities.tools ? 15 : 0;
        score += isLocal ? 20 : 0;
        score += Math.min(sizeB, 70) * 0.5;
        break;
      case 'fast':
        score += isLocal ? 15 : 0;
        score += isFree ? 10 : 0;
        score += model.capabilities.tools ? 5 : 0;
        score += Math.max(0, 40 - sizeB) * 0.5;
        break;
      case 'vision':
        if (!model.capabilities.vision) return -1;
        score += isLocal ? 20 : 0;
        score += Math.min(sizeB, 30) * 0.5;
        break;
      case 'free':
        if (!isFree) return -1;
        score += isLocal ? 30 : 10;
        score += model.capabilities.tools ? 15 : 0;
        score += model.capabilities.thinking ? 10 : 0;
        score += Math.min(sizeB, 70) * 0.4;
        break;
      default:
        score += isLocal ? 20 : 0;
        score += Math.min(sizeB, 30) * 0.3;
    }

    if (
      model.lastValidatedOk &&
      model.lastValidatedAt &&
      Date.now() - Date.parse(model.lastValidatedAt) < 600_000
    ) {
      score += 10;
    }

    return Math.round(score * 10) / 10;
  }

  private handle429(modelId: ModelId, endpointId: EndpointId, res: Response): void {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '60', 10) || 60;
    this.recordRateLimit(modelId, endpointId, retryAfter);
  }

  private markValidation(modelId: ModelId, endpointId: EndpointId, ok: boolean): void {
    const models = this.models.get(endpointId);
    if (!models) return;
    const m = models.find((x) => x.id === modelId);
    if (!m) return;
    m.lastValidatedAt = new Date().toISOString();
    m.lastValidatedOk = ok;
  }

  private pruneExpired(): void {
    const now = Date.now();
    let pruned = false;
    for (const [key, entry] of this.rateLimits) {
      if (entry.resetsAt <= now) {
        this.rateLimits.delete(key);
        pruned = true;
      }
    }
    if (pruned && !this.ephemeral) {
      this.saveState();
    }
  }

  private stateFilePath(): string {
    return path.join(this.workspaceRoot, '.autoclaw', 'llm', 'oracle-state.json');
  }

  private loadState(): void {
    try {
      const file = this.stateFilePath();
      if (!fs.existsSync(file)) return;
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<OracleState>;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.rateLimits)) return;
      const now = Date.now();
      for (const entry of parsed.rateLimits) {
        if (entry.resetsAt > now) {
          this.rateLimits.set(`${entry.endpointId}:${entry.modelId}`, entry);
        }
      }
    } catch {
      // Corrupt or unreadable state — start fresh; never throw.
    }
  }

  private saveState(): void {
    try {
      const file = this.stateFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const state: OracleState = {
        version: 1,
        rateLimits: [...this.rateLimits.values()],
      };
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // Best-effort; don't break the loop because we can't persist.
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function offlineEndpoint(cfg: OracleEndpointConfig): OracleEndpoint {
  return {
    id: cfg.id,
    type: cfg.type,
    baseUrl: cfg.baseUrl,
    online: false,
    modelCount: 0,
    failsafe: cfg.failsafe ?? false,
  };
}

function capsBitsFromDetection(caps: DetectedCapabilities): OracleModel['capabilities'] {
  return {
    tools: caps.supportsTools,
    thinking: caps.supportsThinking,
    vision: caps.supportsVision,
    free: caps.isFree,
  };
}

function endpointTypeToLocality(t: EndpointType): 'local' | 'lan' | 'cloud' {
  if (t === 'zmlr') return 'lan';
  return 'local';
}
