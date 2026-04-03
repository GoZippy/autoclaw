/**
 * AutoClaw Intelligent Routing Engine
 *
 * Provides smart LLM provider routing with:
 * - ZMLR-first dispatch (offloads routing intelligence to ZippyMesh LLM Router)
 * - Per-provider rate-limit tracking and exponential backoff
 * - Task-type → capability ranking (research / coding / review / planning / final-review)
 * - Automatic failover across providers and models
 * - Context compression for model migration
 * - Usage stats persisted to .autoclaw/routing/
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type TaskType = 'research' | 'coding' | 'review' | 'planning' | 'final-review' | 'general';
export type ModelTier = 'local' | 'free' | 'low-cost' | 'mid' | 'sota';
export type FailoverMode = 'auto' | 'ask' | 'disabled';

export interface ProviderModel {
  /** Unique id used in requests */
  id: string;
  /** Display name */
  name: string;
  /** Which provider owns this model */
  provider: string;
  tier: ModelTier;
  /** Context window (tokens) */
  contextWindow: number;
  /** Scores 0-1 per task type; higher = better for that task */
  capabilities: Record<TaskType, number>;
  /** Requests per minute limit (null = unknown / unlimited) */
  rpmLimit: number | null;
  /** Whether tool/function calling is supported */
  supportsFunctions: boolean;
  /** Whether the model is accessible via ZMLR routing */
  routedViaZMLR?: boolean;
}

export interface Provider {
  id: string;
  name: string;
  /** Base URL for direct requests (bypassing ZMLR) */
  baseUrl: string;
  /** API key env var name */
  apiKeyEnvVar?: string;
  /** Whether this is a locally hosted provider (no key needed) */
  isLocal?: boolean;
  models: ProviderModel[];
  /** Health: 'up' | 'degraded' | 'down' */
  status: 'up' | 'degraded' | 'down';
  lastChecked?: string;
}

export interface RateLimitEntry {
  provider: string;
  model: string;
  /** Timestamps of recent requests (rolling window for RPM calc) */
  recentRequests: number[];
  /** Unix ms until this model is usable again (0 = available) */
  backoffUntil: number;
  /** Total error count for this session */
  errorCount: number;
  /** Total success count for this session */
  successCount: number;
}

export interface RoutingDecision {
  provider: string;
  model: string;
  modelId: string;
  /** True when routed through ZMLR rather than direct provider */
  viaZMLR: boolean;
  /** Why this model was chosen */
  reason: string;
  /** Fallback chain if this fails */
  fallbackChain: Array<{ provider: string; modelId: string }>;
}

export interface RoutePromptOptions {
  taskType?: TaskType;
  /** Force a specific model id (skips ranking) */
  forceModel?: string;
  /** Force routing through ZMLR */
  forceZMLR?: boolean;
  /** Preferred tier ceiling (will not use higher-tier models) */
  maxTier?: ModelTier;
  /** Minimum capability score required for task type (0-1) */
  minCapability?: number;
  /** Additional system context to prepend (used during migration) */
  systemContext?: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Timeout ms (default 30 000) */
  timeoutMs?: number;
  /** Max retry attempts across failover chain */
  maxRetries?: number;
}

export interface RoutePromptResult {
  content: string;
  provider: string;
  model: string;
  viaZMLR: boolean;
  /** Tokens used if reported */
  tokensUsed?: number;
  /** Which attempt succeeded (0-indexed) */
  attemptIndex: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Built-in provider + model catalog
// (Users can extend via settings autoclaw.routing.providers)
// ──────────────────────────────────────────────────────────────────────────────

const TIER_ORDER: ModelTier[] = ['local', 'free', 'low-cost', 'mid', 'sota'];

export const DEFAULT_MODELS: ProviderModel[] = [
  // ── Local (Ollama / LM Studio) ───────────────────────────────────────────
  {
    id: 'ollama/qwen2.5-coder:7b',
    name: 'Qwen2.5 Coder 7B (local)',
    provider: 'ollama',
    tier: 'local',
    contextWindow: 32768,
    capabilities: { research: 0.5, coding: 0.65, review: 0.5, planning: 0.45, 'final-review': 0.35, general: 0.55 },
    rpmLimit: null,
    supportsFunctions: false,
  },
  {
    id: 'ollama/llama3.1:8b',
    name: 'Llama 3.1 8B (local)',
    provider: 'ollama',
    tier: 'local',
    contextWindow: 131072,
    capabilities: { research: 0.55, coding: 0.55, review: 0.5, planning: 0.5, 'final-review': 0.35, general: 0.55 },
    rpmLimit: null,
    supportsFunctions: false,
  },
  // ── Free tier (OpenRouter) ───────────────────────────────────────────────
  {
    id: 'openrouter/qwen/qwen3-30b-a3b:free',
    name: 'Qwen3 30B A3B (free)',
    provider: 'openrouter',
    tier: 'free',
    contextWindow: 40960,
    capabilities: { research: 0.65, coding: 0.7, review: 0.65, planning: 0.6, 'final-review': 0.5, general: 0.65 },
    rpmLimit: 3,
    supportsFunctions: true,
    routedViaZMLR: true,
  },
  {
    id: 'openrouter/google/gemini-2.0-flash-exp:free',
    name: 'Gemini 2.0 Flash Exp (free)',
    provider: 'openrouter',
    tier: 'free',
    contextWindow: 1048576,
    capabilities: { research: 0.72, coding: 0.68, review: 0.7, planning: 0.65, 'final-review': 0.55, general: 0.7 },
    rpmLimit: 10,
    supportsFunctions: true,
    routedViaZMLR: true,
  },
  {
    id: 'openrouter/meta-llama/llama-4-scout:free',
    name: 'Llama 4 Scout (free)',
    provider: 'openrouter',
    tier: 'free',
    contextWindow: 131072,
    capabilities: { research: 0.68, coding: 0.65, review: 0.62, planning: 0.6, 'final-review': 0.5, general: 0.65 },
    rpmLimit: 5,
    supportsFunctions: true,
    routedViaZMLR: true,
  },
  // ── Low-cost ─────────────────────────────────────────────────────────────
  {
    id: 'openrouter/google/gemini-flash-1.5',
    name: 'Gemini Flash 1.5',
    provider: 'openrouter',
    tier: 'low-cost',
    contextWindow: 1000000,
    capabilities: { research: 0.78, coding: 0.72, review: 0.75, planning: 0.7, 'final-review': 0.62, general: 0.75 },
    rpmLimit: 60,
    supportsFunctions: true,
    routedViaZMLR: true,
  },
  {
    id: 'openrouter/anthropic/claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'openrouter',
    tier: 'low-cost',
    contextWindow: 200000,
    capabilities: { research: 0.75, coding: 0.75, review: 0.75, planning: 0.72, 'final-review': 0.65, general: 0.75 },
    rpmLimit: 60,
    supportsFunctions: true,
    routedViaZMLR: true,
  },
  // ── Mid ──────────────────────────────────────────────────────────────────
  {
    id: 'openrouter/openai/gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openrouter',
    tier: 'mid',
    contextWindow: 128000,
    capabilities: { research: 0.8, coding: 0.8, review: 0.8, planning: 0.78, 'final-review': 0.72, general: 0.8 },
    rpmLimit: 60,
    supportsFunctions: true,
    routedViaZMLR: true,
  },
  {
    id: 'openrouter/anthropic/claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'openrouter',
    tier: 'mid',
    contextWindow: 200000,
    capabilities: { research: 0.88, coding: 0.9, review: 0.9, planning: 0.88, 'final-review': 0.85, general: 0.88 },
    rpmLimit: 60,
    supportsFunctions: true,
    routedViaZMLR: true,
  },
  // ── SOTA ─────────────────────────────────────────────────────────────────
  {
    id: 'openrouter/anthropic/claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'openrouter',
    tier: 'sota',
    contextWindow: 200000,
    capabilities: { research: 0.95, coding: 0.95, review: 0.97, planning: 0.97, 'final-review': 0.98, general: 0.95 },
    rpmLimit: 30,
    supportsFunctions: true,
    routedViaZMLR: true,
  },
  {
    id: 'openrouter/openai/o3',
    name: 'OpenAI o3',
    provider: 'openrouter',
    tier: 'sota',
    contextWindow: 200000,
    capabilities: { research: 0.93, coding: 0.95, review: 0.95, planning: 0.97, 'final-review': 0.96, general: 0.94 },
    rpmLimit: 20,
    supportsFunctions: true,
    routedViaZMLR: true,
  },
  {
    id: 'openrouter/google/gemini-2.5-pro-preview-03-25',
    name: 'Gemini 2.5 Pro Preview',
    provider: 'openrouter',
    tier: 'sota',
    contextWindow: 1048576,
    capabilities: { research: 0.95, coding: 0.93, review: 0.94, planning: 0.95, 'final-review': 0.95, general: 0.94 },
    rpmLimit: 20,
    supportsFunctions: true,
    routedViaZMLR: true,
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// RoutingEngine class
// ──────────────────────────────────────────────────────────────────────────────

export class RoutingEngine {
  private rateLimits = new Map<string, RateLimitEntry>();
  private zmlrUrl: string;
  private zmlrAvailable = false;
  private zmlrLastChecked = 0;
  private readonly ZMLR_CHECK_INTERVAL_MS = 30_000;
  private workspaceRoot: string | undefined;
  private statsPath: string | undefined;

  constructor() {
    const cfg = vscode.workspace.getConfiguration('autoclaw.routing');
    this.zmlrUrl = cfg.get<string>('zmlrUrl', 'http://localhost:20128');
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (this.workspaceRoot) {
      this.statsPath = path.join(this.workspaceRoot, '.autoclaw', 'routing', 'stats.jsonl');
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Choose the best routing decision for a given task type and options.
   * Returns a RoutingDecision without actually sending a request.
   */
  async decide(taskType: TaskType, opts: Partial<RoutePromptOptions> = {}): Promise<RoutingDecision> {
    await this._refreshZMLRStatus();

    // ZMLR-first: if running, always prefer it as the execution layer
    if (this.zmlrAvailable && !opts.forceModel) {
      const ranked = this._rankModels(taskType, opts.maxTier, opts.minCapability);
      const primary = ranked[0];
      return {
        provider: primary.provider,
        model: primary.name,
        modelId: primary.id,
        viaZMLR: true,
        reason: `ZMLR routing with best available ${taskType} model (${primary.name})`,
        fallbackChain: ranked.slice(1, 4).map(m => ({ provider: m.provider, modelId: m.id })),
      };
    }

    // Direct routing fallback
    const ranked = this._rankModels(taskType, opts.maxTier, opts.minCapability).filter(
      m => !this._isBackedOff(m.id)
    );
    if (ranked.length === 0) {
      throw new Error('No available models — all providers are backed off. Try again later or configure additional providers.');
    }
    const primary = ranked[0];
    return {
      provider: primary.provider,
      model: primary.name,
      modelId: primary.id,
      viaZMLR: false,
      reason: `Direct routing to ${primary.name} (ZMLR unavailable)`,
      fallbackChain: ranked.slice(1, 4).map(m => ({ provider: m.provider, modelId: m.id })),
    };
  }

  /**
   * Route a prompt through the best available provider, with automatic failover.
   */
  async routePrompt(opts: RoutePromptOptions): Promise<RoutePromptResult> {
    const taskType = opts.taskType ?? 'general';
    const maxRetries = opts.maxRetries ?? 3;
    const timeoutMs = opts.timeoutMs ?? 30_000;

    await this._refreshZMLRStatus();

    // Build the failover chain
    const chain = this._buildFailoverChain(taskType, opts);

    let lastError: Error | undefined;
    for (let i = 0; i < Math.min(chain.length, maxRetries); i++) {
      const candidate = chain[i];
      try {
        const result = await this._sendPrompt(candidate, opts.messages, timeoutMs, opts.systemContext);
        this._recordSuccess(candidate.modelId);
        await this._appendStats({ event: 'success', ...candidate, taskType, attemptIndex: i });
        return { ...result, attemptIndex: i };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this._recordError(candidate.modelId, lastError);
        await this._appendStats({ event: 'error', ...candidate, taskType, attemptIndex: i, error: lastError.message });
        console.warn(`[AutoClaw Routing] Attempt ${i + 1} failed (${candidate.modelId}): ${lastError.message}`);
      }
    }

    throw lastError ?? new Error('All routing attempts failed');
  }

  /**
   * Compress a conversation history into a minimal context for model migration.
   * Returns a condensed messages array safe to send to a lower-context model.
   */
  compressContext(
    messages: Array<{ role: string; content: string }>,
    targetContextTokens: number
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    // Rough token estimate: 1 token ≈ 4 chars
    const estimateTokens = (s: string) => Math.ceil(s.length / 4);

    const systemMsgs = messages.filter(m => m.role === 'system');
    const conversationMsgs = messages.filter(m => m.role !== 'system');

    const systemContent = systemMsgs.map(m => m.content).join('\n\n');
    const systemTokens = estimateTokens(systemContent);
    let budget = targetContextTokens - systemTokens - 200; // 200 token safety margin

    // Walk from the end (most recent) backwards until we exceed budget
    const included: typeof messages = [];
    for (let i = conversationMsgs.length - 1; i >= 0; i--) {
      const t = estimateTokens(conversationMsgs[i].content);
      if (budget - t < 0) {
        // Summarize older messages as a single system note
        const dropped = conversationMsgs.slice(0, i + 1);
        const summary = `[Context compressed: ${dropped.length} earlier messages omitted. Key facts preserved above.]`;
        included.unshift({ role: 'system', content: summary });
        break;
      }
      budget -= t;
      included.unshift(conversationMsgs[i]);
    }

    const result: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    if (systemContent) {
      result.push({ role: 'system', content: systemContent });
    }
    result.push(...(included as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>));
    return result;
  }

  /**
   * Returns current rate-limit / backoff state for all tracked models.
   */
  getRateLimitStatus(): RateLimitEntry[] {
    return Array.from(this.rateLimits.values());
  }

  /**
   * Returns all known models ranked for a given task type.
   */
  getRankedModels(taskType: TaskType, maxTier?: ModelTier): ProviderModel[] {
    return this._rankModels(taskType, maxTier);
  }

  /** Whether ZMLR is currently reachable */
  get zmlrOnline(): boolean {
    return this.zmlrAvailable;
  }

  /** Force a re-check of ZMLR availability */
  async recheckZMLR(): Promise<boolean> {
    this.zmlrLastChecked = 0;
    await this._refreshZMLRStatus();
    return this.zmlrAvailable;
  }

  /**
   * Record a model as rate-limited externally (e.g. from KiloCode error parsing).
   */
  markRateLimited(modelId: string, backoffMs = 60_000): void {
    const entry = this._getOrCreateEntry(modelId);
    entry.backoffUntil = Date.now() + backoffMs;
    entry.errorCount++;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _rankModels(taskType: TaskType, maxTier?: ModelTier, minCapability = 0): ProviderModel[] {
    const cfg = vscode.workspace.getConfiguration('autoclaw.routing');
    const customModels: ProviderModel[] = cfg.get('customModels', []);
    const all = [...DEFAULT_MODELS, ...customModels];

    const tierCeiling = maxTier ? TIER_ORDER.indexOf(maxTier) : TIER_ORDER.length - 1;

    return all
      .filter(m => {
        const tierIdx = TIER_ORDER.indexOf(m.tier);
        return tierIdx <= tierCeiling && (m.capabilities[taskType] ?? 0) >= minCapability;
      })
      .sort((a, b) => {
        // Primary: task capability score (descending)
        const capDiff = (b.capabilities[taskType] ?? 0) - (a.capabilities[taskType] ?? 0);
        if (Math.abs(capDiff) > 0.05) { return capDiff; }
        // Secondary: tier (higher = better within same capability band)
        return TIER_ORDER.indexOf(b.tier) - TIER_ORDER.indexOf(a.tier);
      });
  }

  private _buildFailoverChain(taskType: TaskType, opts: Partial<RoutePromptOptions>): Array<{
    modelId: string; provider: string; viaZMLR: boolean;
  }> {
    const chain: Array<{ modelId: string; provider: string; viaZMLR: boolean }> = [];

    if (opts.forceModel) {
      chain.push({ modelId: opts.forceModel, provider: 'custom', viaZMLR: this.zmlrAvailable });
      return chain;
    }

    const ranked = this._rankModels(taskType, opts.maxTier, opts.minCapability);
    for (const model of ranked) {
      if (this._isBackedOff(model.id)) { continue; }
      chain.push({
        modelId: model.id,
        provider: model.provider,
        viaZMLR: this.zmlrAvailable && (model.routedViaZMLR ?? false),
      });
      if (chain.length >= 5) { break; }
    }

    return chain;
  }

  private async _sendPrompt(
    candidate: { modelId: string; provider: string; viaZMLR: boolean },
    messages: Array<{ role: string; content: string }>,
    timeoutMs: number,
    systemContext?: string
  ): Promise<Omit<RoutePromptResult, 'attemptIndex'>> {
    const allMessages = systemContext
      ? [{ role: 'system', content: systemContext }, ...messages]
      : messages;

    if (candidate.viaZMLR) {
      return this._sendViaZMLR(candidate.modelId, allMessages, timeoutMs);
    }
    return this._sendDirect(candidate.modelId, candidate.provider, allMessages, timeoutMs);
  }

  private async _sendViaZMLR(
    modelId: string,
    messages: Array<{ role: string; content: string }>,
    timeoutMs: number
  ): Promise<Omit<RoutePromptResult, 'attemptIndex'>> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      stream: false,
    };

    const res = await fetch(`${this.zmlrUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 429) {
      this.markRateLimited(modelId, this._backoffMs(modelId));
      throw new Error(`Rate limit (429) from ZMLR for model ${modelId}`);
    }
    if (!res.ok) {
      throw new Error(`ZMLR returned ${res.status} for model ${modelId}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return {
      content,
      provider: 'zmlr',
      model: modelId,
      viaZMLR: true,
      tokensUsed: data.usage?.total_tokens,
    };
  }

  private async _sendDirect(
    modelId: string,
    _provider: string,
    messages: Array<{ role: string; content: string }>,
    timeoutMs: number
  ): Promise<Omit<RoutePromptResult, 'attemptIndex'>> {
    // Determine base URL from model id prefix
    let baseUrl = 'https://openrouter.ai/api/v1';
    let authHeader = '';

    if (modelId.startsWith('ollama/')) {
      const cfg = vscode.workspace.getConfiguration('autoclaw.routing');
      baseUrl = cfg.get<string>('ollamaUrl', 'http://localhost:11434/v1');
      // Strip "ollama/" prefix for the actual model name sent to Ollama
      modelId = modelId.replace('ollama/', '');
    } else if (modelId.startsWith('openrouter/')) {
      const key = process.env['OPENROUTER_API_KEY'] ?? '';
      authHeader = key ? `Bearer ${key}` : '';
      modelId = modelId.replace('openrouter/', '');
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authHeader) { headers['Authorization'] = authHeader; }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelId, messages, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 429) {
      this.markRateLimited(modelId, this._backoffMs(modelId));
      throw new Error(`Rate limit (429) from provider for model ${modelId}`);
    }
    if (!res.ok) {
      throw new Error(`Provider returned ${res.status} for model ${modelId}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      provider: _provider,
      model: modelId,
      viaZMLR: false,
      tokensUsed: data.usage?.total_tokens,
    };
  }

  private async _refreshZMLRStatus(): Promise<void> {
    if (Date.now() - this.zmlrLastChecked < this.ZMLR_CHECK_INTERVAL_MS) { return; }
    try {
      const res = await fetch(`${this.zmlrUrl}/health`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(2_000),
      });
      this.zmlrAvailable = res.ok;
    } catch {
      this.zmlrAvailable = false;
    }
    this.zmlrLastChecked = Date.now();
  }

  private _isBackedOff(modelId: string): boolean {
    const entry = this.rateLimits.get(modelId);
    return !!entry && entry.backoffUntil > Date.now();
  }

  private _backoffMs(modelId: string): number {
    const entry = this.rateLimits.get(modelId);
    const errorCount = entry?.errorCount ?? 0;
    // Exponential backoff: 30s, 60s, 120s, 240s, max 600s
    return Math.min(30_000 * Math.pow(2, errorCount), 600_000);
  }

  private _getOrCreateEntry(modelId: string): RateLimitEntry {
    const [providerRaw, ...rest] = modelId.split('/');
    const key = modelId;
    if (!this.rateLimits.has(key)) {
      this.rateLimits.set(key, {
        provider: providerRaw,
        model: rest.join('/'),
        recentRequests: [],
        backoffUntil: 0,
        errorCount: 0,
        successCount: 0,
      });
    }
    return this.rateLimits.get(key)!;
  }

  private _recordSuccess(modelId: string): void {
    const entry = this._getOrCreateEntry(modelId);
    entry.recentRequests.push(Date.now());
    // Keep rolling 60s window
    const cutoff = Date.now() - 60_000;
    entry.recentRequests = entry.recentRequests.filter(t => t > cutoff);
    entry.successCount++;
    // Reset backoff on success
    entry.backoffUntil = 0;
    entry.errorCount = Math.max(0, entry.errorCount - 1);
  }

  private _recordError(modelId: string, err: Error): void {
    const entry = this._getOrCreateEntry(modelId);
    entry.errorCount++;
    const isFetchFail = /fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(err.message);
    const isRateLimit = /429|rate limit|too many/i.test(err.message);
    const backoffMs = isRateLimit ? this._backoffMs(modelId) : isFetchFail ? 15_000 : 5_000;
    entry.backoffUntil = Date.now() + backoffMs;
  }

  private async _appendStats(record: Record<string, unknown>): Promise<void> {
    if (!this.statsPath) { return; }
    try {
      await fs.promises.mkdir(path.dirname(this.statsPath), { recursive: true });
      await fs.promises.appendFile(
        this.statsPath,
        JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n'
      );
    } catch {
      // Non-fatal
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Singleton instance (created lazily)
// ──────────────────────────────────────────────────────────────────────────────

let _engine: RoutingEngine | undefined;

export function getRoutingEngine(): RoutingEngine {
  if (!_engine) {
    _engine = new RoutingEngine();
  }
  return _engine;
}

/** Reset the singleton (call after config changes) */
export function resetRoutingEngine(): void {
  _engine = undefined;
}

// ──────────────────────────────────────────────────────────────────────────────
// Utility: generate a ZMLR-aware system prompt snippet for agents
// Agents can paste this into their context so they know to use ZMLR.
// ──────────────────────────────────────────────────────────────────────────────

export function buildRoutingContextBlock(zmlrUrl: string, taskType: TaskType, modelId: string): string {
  return `
## Routing Context (AutoClaw)
- LLM Router: ZippyMesh LLM Router at ${zmlrUrl}
- Selected model: ${modelId}
- Task type: ${taskType}
- Failover: automatic (engine handles retries across providers)
- If you receive a 429 or fetch error, report it as "[RATE_LIMIT: ${modelId}]" so AutoClaw can reroute.
`.trim();
}
