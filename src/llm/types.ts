/**
 * LLM provider abstraction — types only.
 *
 * Implements the narrow `LlmProvider` interface from
 * [docs/rfc/llm-provider-abstraction.md](../../docs/rfc/llm-provider-abstraction.md)
 * and [docs/specs/llm-provider-s1/spec.md](../../docs/specs/llm-provider-s1/spec.md).
 *
 * This module is types-only; no runtime logic. Adapters live in sibling
 * files (`openai-compatible.ts`, `zippymesh.ts`, `ollama.ts`); the
 * registry composes them (`registry.ts`).
 */

import type { ErrorClass } from '../runners/types';

export { ErrorClass };

/** Stable provider id, e.g. `"zippymesh"`, `"ollama"`. */
export type ProviderId = string;

/** Model id as the provider names it (e.g. `"auto"`, `"llama3.1:8b"`). */
export type ModelId = string;

/** Endpoint id used by the oracle (`"zmlr-local"`, `"ollama-local"`, ...). */
export type EndpointId = string;

/** Oracle task class — drives scoring per RFC §5a. */
export type OracleTask = 'agent' | 'tool' | 'thinking' | 'fast' | 'vision' | 'free';

/**
 * Locality of inference. `local` = same host; `lan` = workspace LAN
 * (router/ZMLR); `cloud` = public internet.
 */
export type Locality = 'local' | 'lan' | 'cloud';

/**
 * Static description of what an LLM provider can do. Mirrors the runners'
 * `Capabilities` shape but scoped to chat-completion concerns.
 */
export interface ProviderCapabilities {
  /** Server supports SSE / chunked streaming. */
  streaming: boolean;
  /** Server honors OpenAI-style `tools: [...]` function calling. */
  toolUse: boolean;
  /** Server supports `response_format: { type: 'json_object' }`. */
  jsonMode: boolean;
  /** `embeddings.create` endpoint reachable. */
  embeddings: boolean;
  /** Reported context window for the default model, in tokens. */
  contextWindow?: number;
  /** Locality of inference (drives `requireLocality` filtering). */
  locality: Locality;
  /** Provider exposes per-call cost in USD/cents on responses. */
  reportsCost: boolean;
  /** Model families exposed (`llama`, `qwen`, `claude`, `gpt`, ...). */
  modelFamilies: string[];
  /** Prompt harness ids this provider/router can safely serve. */
  promptHarnesses?: string[];
}

/** A single chat message, role-tagged. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/**
 * Routing hints surfaced to providers that understand them (ZippyMesh).
 * Plain providers ignore unrecognised keys.
 */
export interface ChatHints {
  /** ZMLR's playbook key. Drives `x-intent` / `x-zippy-intent` headers. */
  intent?: 'code' | 'review' | 'plan' | 'summarize' | 'chat' | 'debug';
  /** Hard locality constraint — providers that don't match are filtered out. */
  requireLocality?: Locality;
  /** Soft preference for a model family. */
  preferFamily?: string;
  /** Set during /mateam fan-out so ZMLR picks distinct backends per agent. */
  sessionParallel?: boolean;
  /** Session id paired with `sessionParallel`. */
  sessionId?: string;
}

/** Per-call chat options. */
export interface ChatOptions {
  /** Model id; falls back to the provider's `defaultModel`. */
  model?: ModelId;
  /** Full message array. */
  messages?: ChatMessage[];
  /** Sugar for `[{ role: 'user', content: prompt }]`. */
  prompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  jsonMode?: boolean;
  hints?: ChatHints;
  /** Per-tool allow list, surfaced to the runner/persona layer. */
  toolAllowList?: string[];
  /** Per-tool deny list. */
  toolDenyList?: string[];
  /** Cost-ledger correlation id. */
  sessionId?: string;
  /** Cost-ledger correlation id (often persona dispatch id). */
  runId?: string;
  /** Cost-ledger persona id. */
  callerPersonaId?: string;
}

/** Result of one chat call. */
export interface ChatResult {
  ok: boolean;
  response?: string;
  /** Model id that actually served (may differ from request when ZMLR routes). */
  model: ModelId;
  /** Provider id that served. May differ from `request.providerId` for ZMLR. */
  servedBy: ProviderId;
  tokens?: { input: number; output: number };
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Cost in **cents** (ZICO-aligned). Absent when provider doesn't report. */
  costCents?: number;
  errorClass?: ErrorClass;
  errorMessage?: string;
  /** HTTP status for transport-level errors; absent for parser/internal. */
  httpStatus?: number;
}

/** Input to {@link LlmProvider.embed} — one or many texts to embed. */
export interface EmbedOptions {
  /** Text(s) to embed. A single string yields one vector; an array yields one per item. */
  input: string | string[];
  /** Embedding model id; falls back to the provider default. */
  model?: ModelId;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Routing hints (e.g. intent) for a router that selects an embedding backend. */
  hints?: ChatHints;
}

/** Result of {@link LlmProvider.embed} — mirrors {@link ChatResult}'s shape. */
export interface EmbeddingsResult {
  ok: boolean;
  /** One vector per input (order-preserving). Present only on success. */
  vectors?: number[][];
  /** Vector dimension (length of each vector). Present only on success. */
  dimension?: number;
  /** Model id that actually served (may differ from request when a router routes). */
  model: ModelId;
  /** Provider id that served. */
  servedBy: ProviderId;
  /** Input tokens consumed (embeddings have no output tokens). */
  tokens?: { input: number; output: number };
  durationMs: number;
  /** Cost in cents (ZICO-aligned). Absent when the provider doesn't report. */
  costCents?: number;
  errorClass?: ErrorClass;
  errorMessage?: string;
  httpStatus?: number;
}

/** Detection outcome (mirrors runner shape). */
export type DetectionResult = DetectionResultFound | DetectionResultNotFound;

export interface DetectionResultFound {
  found: true;
  /** Reported version string, when available. */
  version: string;
  /** The endpoint that responded. */
  endpoint: string;
}

export interface DetectionResultNotFound {
  found: false;
  reason: 'not_running' | 'no_auth' | 'version_too_old';
  hint: string;
}

/** One model entry returned by `models()`. */
export interface ModelInfo {
  id: ModelId;
  contextWindow?: number;
  family?: string;
  /** True if served locally / on the same host. */
  local?: boolean;
  /** Parameter size in billions, when known. */
  sizeB?: number;
  /** Capability bits inferred from the model id / metadata. */
  capabilities?: {
    tools?: boolean;
    thinking?: boolean;
    vision?: boolean;
    free?: boolean;
  };
}

/** Health snapshot. */
export interface HealthReport {
  ok: boolean;
  reachable: boolean;
  authPresent: boolean;
  version?: string;
  modelCount: number;
  /** ISO timestamp of the most recent successful chat call. */
  lastChatAt?: string;
  recentErrors: { class: ErrorClass; count: number }[];
}

/**
 * The narrow contract every adapter implements. Sibling to `Runner` but
 * scoped to raw LLM completion — no session lifecycle, no agentic loop.
 */
export interface LlmProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Default model used when `ChatOptions.model` is absent. */
  readonly defaultModel?: ModelId;

  detect(): Promise<DetectionResult>;
  chat(opts: ChatOptions): Promise<ChatResult>;
  models(): Promise<ModelInfo[]>;
  health(): Promise<HealthReport>;
  /**
   * Embed text(s) via the provider's OpenAI-compatible `/v1/embeddings` surface.
   * Optional — present only on providers whose `capabilities.embeddings` is true.
   */
  embed?(opts: EmbedOptions): Promise<EmbeddingsResult>;
}

/* -------------------------------------------------------------------------- */
/*  ProviderRef parsing                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A `ProviderRef` is `<provider-id>` or `<provider-id>:<model-id>`.
 * `model-id` may itself contain colons (e.g. `"llama3.1:70b"`); the
 * split is on the FIRST colon only.
 *
 * Examples:
 * - `"ollama"` → `{ providerId: 'ollama', model: undefined }`
 * - `"ollama:llama3.1:70b"` → `{ providerId: 'ollama', model: 'llama3.1:70b' }`
 * - `"zippymesh:auto"` → `{ providerId: 'zippymesh', model: 'auto' }`
 */
export interface ParsedProviderRef {
  providerId: ProviderId;
  model?: ModelId;
}

export function parseProviderRef(ref: string): ParsedProviderRef {
  const idx = ref.indexOf(':');
  if (idx < 0) {
    return { providerId: ref };
  }
  return {
    providerId: ref.slice(0, idx),
    model: ref.slice(idx + 1),
  };
}

/**
 * Merge a partial capabilities override onto a default. Used by adapter
 * constructors so subclasses can override only what differs.
 */
export function mergeCapabilities(
  base: ProviderCapabilities,
  override?: Partial<ProviderCapabilities>,
): ProviderCapabilities {
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
    modelFamilies: override.modelFamilies ?? base.modelFamilies,
    promptHarnesses: override.promptHarnesses ?? base.promptHarnesses,
  };
}

/**
 * Normalize `ChatOptions` into a guaranteed `messages` array. `prompt`
 * sugar becomes a single user message. Adapters call this once at the top
 * of `chat()` so they never have to branch on `prompt` vs `messages`.
 */
export function normalizeMessages(opts: ChatOptions): ChatMessage[] {
  if (opts.messages && opts.messages.length > 0) {
    return opts.messages;
  }
  if (typeof opts.prompt === 'string') {
    return [{ role: 'user', content: opts.prompt }];
  }
  return [];
}
