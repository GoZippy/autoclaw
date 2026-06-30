# RFC: LLM Provider Abstraction

_Status: revised draft, 2026-05-23. Companion to
[runner-bridge-contract.md](runner-bridge-contract.md) — distinct concern._

## 0. Revision note — 2026-05-23 (Option C: ZMLR-first + oracle fallback)

The first draft of this RFC (2026-05-22) planned an in-process router:
`LlmRegistry` with a six-criterion preference engine, three adapters
(ollama/lmstudio/zippymesh), a workspace policy file, MCP `llm.chat`
write-tools, and a cost-ledger split.

That plan **duplicates work already shipped in
[ZippyMesh LLM Router (ZMLR)](ZMLR)** — smart
routing by `X-Intent`, multi-provider with format translation, combo +
account fallback, rate-limit cooldowns, prompt cache, virtual keys, cost
ledger, an `externalRouterUrl` peer hook, and MCP tool handlers for
`list_models`/`recommend_model`/`validate_model`/`execute_with_routing`.
This revision pivots to **Option C**: ZMLR is the source of truth for
routing; AutoClaw is a client that adds **client-side resilience** when
ZMLR is unreachable (the `src/llm/oracle.ts` fallback ladder, ported
from the upstream model-oracle host's battle-tested
[model-oracle](<internal>/model-oracle/SKILL.md)
skill).

**What stays the same.** The narrow `LlmProvider` interface (§2). The
OpenAI-compatible adapter base (§3.1). The Ollama adapter (§3.2). The
optional `provider?: LlmProvider` field on `LoopServiceAdapter` (§4).

**What changes.** Sections 3.3–7, 9 are rewritten:
- §3.3 LM Studio adapter — **deferred indefinitely** (ZMLR proxies it server-side).
- §3.4 ZippyMesh adapter — **promoted to primary**; absorbs intent + recommend_model routing.
- §5 In-process preference scoring engine — **deleted**; `LlmRegistry.getPreferred()` calls ZMLR's `recommend_model` MCP tool. When ZMLR is unreachable, the oracle ladder picks.
- §6 Config surface — **slimmed**; one provider list, no preference-criterion file.
- §7 MCP `llm.chat`/`llm.models`/`llm.health` write-tools — **replaced** by a small Next.js PR to ZMLR that exposes the existing `src/mcp/zmlr-server.js` handlers at `:20128/mcp`, plus an `autoclaw mcp install` flow that registers ZMLR's MCP in workspace config.
- New §5a — `src/llm/oracle.ts` fallback selector (TS port of `model-oracle.mjs`).
- New §6a — `externalRouterUrl` peer wiring (the "AutoClaw teaches ZMLR" loop).
- §9 sequencing — re-sequenced for the new scope.

**Tradeoff accepted.** AutoClaw becomes entangled with ZMLR's product
roadmap. Mitigation: only `ZippyMeshProvider` knows ZMLR specifics; the
rest of AutoClaw sees the narrow `LlmProvider` interface. If ZMLR
changes a contract, one adapter file changes.

## 1. Problem & scope

`Runner` (`src/runners/types.ts`) is **agentic**: a runner takes a prompt
and returns a `DispatchResult` describing an entire autonomous work
cycle. Right shape for Claude Code, Cursor, Kiro, Hermes, AutoGPT.

Wrong shape for: a KDream tick scoring a candidate; an MCP write-tool
summarizing a finding; an orchestrator scorer needing embeddings; a
runner that wants to burn cheap local tokens (Ollama, LM Studio) on
routine work and reserve cloud agents for review; routing through the
user's **ZippyMesh LLM Router** on `http://localhost:20128/v1` —
documented in `adapters/zippymesh/README.md` and
`adapters/claude-code/mcp-zippymesh.md`, today wired per-host (Kilo,
Cursor, Continue) with no AutoClaw-side integration point.

We need a **second, narrower interface** — `LlmProvider` — that does one
job: turn a chat message list into a chat completion (plus models /
health / embeddings). **Additive.** Existing `HermesRunner`,
`LoopServiceAdapter`, and the four agent runners stay as-is. A runner
may *optionally* hold an `LlmProvider` reference (§4); none is required
to.

**Out of scope:** tool-calling agent loops (`Runner`'s job), any change
to `dispatch()`, `state.json`, heartbeats, or claims.

## 2. Provider interface

`src/llm/types.ts` (new module — sibling of `src/runners/`, not nested).

```ts
/** Stable provider id, e.g. "ollama", "lmstudio", "zippymesh", "openai". */
export type LlmProviderId = string;

/** What this provider can do. Mirrors runners' Capabilities shape. */
export interface LlmCapabilities {
  /** Server-sent streaming chunks via fetch ReadableStream. */
  streaming: boolean;
  /** OpenAI-style `tools: [...]` function calling. */
  toolUse: boolean;
  /** `response_format: { type: 'json_object' }` (or equivalent). */
  jsonMode: boolean;
  /** `embeddings.create` endpoint reachable. */
  embeddings: boolean;
  /** Reported context window for the *default* model, in tokens. */
  contextWindow: number;
  /**
   * Locality of inference. Drives the `local` / `private` preference
   * criteria (§5). `local` = same machine; `lan` = on workspace LAN;
   * `cloud` = public internet.
   */
  locality: 'local' | 'lan' | 'cloud';
  /** Provider exposes per-call cost in USD on responses. */
  reportsCost: boolean;
  /** Model families exposed (`llama`, `qwen`, `claude`, `gpt`, ...). */
  modelFamilies: string[];
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on `role: 'tool'` to bind the response to a prior tool_call. */
  toolCallId?: string;
  /** Set on `role: 'assistant'` to expose function calls the model emitted. */
  toolCalls?: LlmToolCall[];
  /** Optional name (OpenAI multi-user convention; ignored by most providers). */
  name?: string;
}

export interface LlmToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string }; // arguments is a JSON string
}

export interface LlmChatRequest {
  /** Model id as the provider names it (e.g. "llama3.1:8b", "gpt-4o-mini"). */
  model: string;
  messages: LlmMessage[];
  /** Sampling. All optional; provider applies its own defaults. */
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Force JSON object output where supported (LM Studio, Ollama, ZippyMesh). */
  jsonMode?: boolean;
  /** Tool/function definitions, if the caller wants tool use. */
  tools?: LlmToolDef[];
  /** `auto` (default), `none`, or `{ name: "..." }` per OpenAI. */
  toolChoice?: 'auto' | 'none' | { name: string };
  /** When true, the returned promise resolves to a streaming iterator. */
  stream?: boolean;
  /** Hard wall-clock cap; provider should AbortController past this. */
  timeoutMs?: number;
  /**
   * Routing hints surfaced to providers that understand them (ZippyMesh).
   * Plain providers ignore unrecognised keys.
   */
  hints?: {
    /** Intent string — ZippyMesh uses `X-Intent: code` etc. */
    intent?: 'code' | 'review' | 'plan' | 'summarize' | 'chat';
    /** Hard locality constraint — bail if not satisfiable. */
    requireLocality?: 'local' | 'lan' | 'cloud';
    /** Prefer this model family if available; soft constraint. */
    preferFamily?: string;
    /** Allow fallback to other models in the same family on rate-limit. */
    allowFallback?: boolean;
  };
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Reported USD for this call; `undefined` if the provider doesn't say. */
  costUsd?: number;
  /** Cached input tokens reused, when reported. */
  cachedInputTokens?: number;
}

export interface LlmChatResponse {
  /** Echo of the chosen model — may differ from the request when fallback fires. */
  model: string;
  /** Provider id that actually served the call. Differs from request for ZippyMesh. */
  servedBy: LlmProviderId;
  message: LlmMessage;
  /** "stop" | "length" | "tool_calls" | "content_filter" | provider-specific. */
  finishReason: string;
  usage?: LlmUsage;
  /** Wall-clock duration of the request in ms. */
  durationMs: number;
}

/** Streaming variant — `chat()` returns this when `request.stream === true`. */
export interface LlmChatStream {
  /** Async-iterate chunks. Each chunk is a partial message delta. */
  [Symbol.asyncIterator](): AsyncIterator<LlmChatChunk>;
  /** Abort the in-flight request. */
  cancel(): Promise<void>;
}

export interface LlmChatChunk {
  delta: { role?: LlmMessage['role']; content?: string; toolCalls?: LlmToolCall[] };
  finishReason?: string;
  usage?: LlmUsage; // present on the final chunk for providers that report it
}

export interface LlmModelInfo {
  id: string;
  /** When known — Ollama reports it via `/api/tags`, OpenAI via `/v1/models`. */
  contextWindow?: number;
  family?: string;
  /** Per-token price in USD ($/1M tokens). Cloud only. */
  pricePerMillionInput?: number;
  pricePerMillionOutput?: number;
  /** True if served locally / on the same host as the caller. */
  local?: boolean;
}

export interface LlmHealthReport {
  ok: boolean;
  /** Reachable at the configured endpoint. */
  reachable: boolean;
  /** Auth (where required) is present and accepted. */
  authPresent: boolean;
  /** Reported server version, when available. */
  version?: string;
  /** Number of models currently loadable. */
  modelCount: number;
  /** ISO timestamp of the most recent successful chat call. */
  lastChatAt?: string;
  recentErrors: { class: LlmErrorClass; count: number }[];
}

export type LlmErrorClass =
  | 'auth'             // 401/403 or missing token
  | 'rate_limit'       // 429
  | 'context_overflow' // request > model.contextWindow
  | 'model_missing'    // model id not loaded / unknown
  | 'timeout'
  | 'transport'        // network failure
  | 'internal';        // 5xx, unparseable response

/** Result of detect(), mirrors runners' shape for fleet-view consistency. */
export type LlmDetection =
  | { found: true; version: string; endpoint: string }
  | { found: false; reason: 'not_running' | 'no_auth' | 'version_too_old'; hint: string };

/**
 * The narrow contract every adapter implements. Sibling to `Runner` but
 * scoped to raw LLM completion — no session lifecycle, no agentic loop.
 */
export interface LlmProvider {
  readonly id: LlmProviderId;
  readonly capabilities: LlmCapabilities;

  detect(): Promise<LlmDetection>;
  chat(req: LlmChatRequest): Promise<LlmChatResponse | LlmChatStream>;
  models(): Promise<LlmModelInfo[]>;
  health(): Promise<LlmHealthReport>;
  /** Optional embeddings; throws `not_implemented` if `capabilities.embeddings === false`. */
  embed?(input: string | string[], model?: string): Promise<number[][]>;
}
```

A registry sibling to `RunnerRegistry` lives at `src/llm/registry.ts`:

```ts
export class LlmRegistry {
  register(p: LlmProvider): void;
  detect(): Promise<{ provider: LlmProvider; detection: LlmDetection }[]>;
  list(): LlmProvider[];
  listActive(): LlmProvider[];
  get(id: LlmProviderId): LlmProvider | undefined;
  /**
   * Select a provider for a request honoring the §5 preference order plus
   * any per-request `hints` (e.g. `requireLocality: 'local'`).
   */
  getPreferred(opts: LlmPreferenceOptions): LlmProvider | null;
}
```

## 3. Adapters

All adapters live under `src/llm/adapters/`. Node 18+ global `fetch`; no
extra dependencies. Token / endpoint come from env (consistent with
`HermesRunner` / `LoopServiceAdapter`).

### 3.1 `openai-compatible.ts` (the base)

Almost every interesting endpoint speaks the OpenAI REST surface
(`POST /v1/chat/completions`, `GET /v1/models`, `POST /v1/embeddings`).
One implementation covers all; subclasses specialise endpoint, auth, and
capabilities.

```ts
export interface OpenAiCompatConfig {
  id: LlmProviderId;
  endpoint: string;               // base, e.g. "http://localhost:11434"
  /** Path prefix for the OpenAI-compatible surface. Default `/v1`. */
  v1Prefix?: string;
  auth?: {
    kind: 'none' | 'bearer' | 'header';
    tokenEnv?: string;            // env var name; never the secret itself
    headerName?: string;          // for kind: 'header'
  };
  /** Extra static headers (ZippyMesh uses these for intent/session hints). */
  extraHeaders?: Record<string, string>;
  defaultModel?: string;
  capabilities?: Partial<LlmCapabilities>;
}

export class OpenAiCompatProvider implements LlmProvider {
  constructor(cfg: OpenAiCompatConfig);
  async chat(req: LlmChatRequest): Promise<LlmChatResponse | LlmChatStream> {
    // POST `${endpoint}${v1Prefix}/chat/completions` with the OpenAI body.
    // Apply `hints.intent` as `X-Intent: ${intent}` (ZippyMesh convention).
    // Stream via fetch + ReadableStream → async iterator when stream=true.
  }
  async models(): Promise<LlmModelInfo[]> { /* GET /v1/models */ }
  async embed(input, model) { /* POST /v1/embeddings */ }
  async detect(): Promise<LlmDetection> { /* GET /v1/models with 5s timeout */ }
  async health(): Promise<LlmHealthReport>;
}
```

### 3.2 `ollama.ts`

Ollama exposes **two** APIs side-by-side: native (`/api/chat`,
`/api/generate`, `/api/tags`, `/api/embeddings`) and, since v0.1.30+,
OpenAI-compat at `/v1/*`. **Use the OpenAI-compat surface** — no bespoke
mapper. Native `/api/tags` is used in `models()` because it returns
`modified_at` and parameter sizes the OpenAI route omits.

```ts
export class OllamaProvider extends OpenAiCompatProvider {
  constructor(endpoint = process.env.OLLAMA_HOST ?? 'http://localhost:11434') {
    super({
      id: 'ollama',
      endpoint,
      v1Prefix: '/v1',
      auth: { kind: 'none' },
      capabilities: {
        streaming: true,
        toolUse: true,        // Ollama gained tools in 0.3.0; gate on detect()
        jsonMode: true,
        embeddings: true,
        contextWindow: 8192,  // refined per-model from /api/show
        locality: 'local',
        reportsCost: false,
        modelFamilies: [],    // populated by models()
      },
    });
  }
  /** Override: use `/api/tags` for richer model metadata. */
  async models(): Promise<LlmModelInfo[]>;
  /** Override: `OLLAMA_HOST` env determines endpoint, no auth check. */
  async detect(): Promise<LlmDetection>;
}
```

**Verified (Ollama docs, 2026-05):** `OLLAMA_HOST` defaults to
`http://127.0.0.1:11434`; `/api/tags` lists installed models;
`/api/chat` accepts `{ model, messages, stream, options, tools }`;
OpenAI-compat docs at `ollama/ollama/blob/main/docs/openai.md`.
**Assumption:** tool-use varies per model — call may 400 even when
`capabilities.toolUse === true`; surfaced as `errorClass: 'internal'`.

### 3.3 `lmstudio.ts` — DEFERRED INDEFINITELY

LM Studio is OpenAI-compatible at `:1234/v1` and was originally planned
as a one-line subclass. **2026-05-23 revision:** deferred indefinitely.
Rationale:

- ZMLR already lists LM Studio as a backend
  ([routing/engine.js scoring](ZMLR\src\lib\routing\engine.js)
  treats it as a candidate). Users who want LM Studio configure it once
  in ZMLR and AutoClaw inherits.
- The oracle ladder (§5a) probes LM Studio at `:1234` directly when ZMLR
  is unreachable, but only as one rung — the ladder itself does the work,
  not a standalone `LmStudioProvider` class.
- Reviving this adapter is a one-file change if a future code path needs
  raw direct access (mirror §3.2 with the LM Studio endpoint). Not now.

### 3.4 `zippymesh.ts` — PROMOTED TO PRIMARY

ZMLR ([ZMLR](ZMLR))
is now AutoClaw's **primary** routing path. Documented surfaces:
[adapters/zippymesh/README.md](../../adapters/zippymesh/README.md),
[adapters/claude-code/mcp-zippymesh.md](../../adapters/claude-code/mcp-zippymesh.md).

**Verified contracts** (code survey 2026-05-23, against
[ZMLR src/ at the same date](ZMLR\src)):

- **OpenAI-compat surface** at `:20128/v1/chat/completions` —
  request entry [`src/sse/handlers/chat.js:131`](ZMLR\src\sse\handlers\chat.js) reads `x-zippy-intent`
  and [`src/lib/routing/smartRouter.js:269`](ZMLR\src\lib\routing\smartRouter.js)
  reads `x-intent`. Both flow into the routing engine. **Send both;
  prefer `x-intent` as canonical** (matches the README and the
  `routing/intentDetector.js` consumer).
- `x-session-parallel: true` + `x-session-id: <id>` — both honored at
  `smartRouter.js:53-54`; required when AutoClaw fans out a `/mateam`
  session so ZMLR picks distinct backends per parallel agent.
- Model id `"auto"` — special, lets ZMLR pick from the playbook.
- Auth — locally optional; bearer via `ZIPPYMESH_TOKEN` env when configured.

```ts
export class ZippyMeshProvider extends OpenAiCompatProvider {
  constructor(endpoint = process.env.ZIPPYMESH_HOST ?? 'http://localhost:20128') {
    super({
      id: 'zippymesh',
      endpoint,
      v1Prefix: '/v1',
      auth: { kind: 'bearer', tokenEnv: 'ZIPPYMESH_TOKEN' }, // optional locally
      extraHeaders: { 'X-Client': 'autoclaw' },
      defaultModel: 'auto',
      capabilities: {
        streaming: true,
        toolUse: true,
        jsonMode: true,
        embeddings: true,        // ZMLR proxies to a backend that has it
        contextWindow: 200000,   // pessimistic ceiling; backend-dependent
        locality: 'lan',         // router is local, backends may be cloud
        reportsCost: true,       // router reports rolled-up cost
        modelFamilies: [
          'llama', 'qwen', 'claude', 'gpt', 'gemini', 'groq-llama',
        ],
      },
    });
  }

  /** Override: emit BOTH `x-intent` and `x-zippy-intent`, plus session headers. */
  protected augmentHeaders(req: LlmChatRequest): Record<string, string> {
    const h: Record<string, string> = { 'X-Client': 'autoclaw' };
    if (req.hints?.intent) {
      h['x-intent'] = req.hints.intent;
      h['x-zippy-intent'] = req.hints.intent;
    }
    if (req.hints?.sessionParallel) {
      h['x-session-parallel'] = 'true';
      if (req.hints.sessionId) h['x-session-id'] = req.hints.sessionId;
    }
    return h;
  }

  /** Override: `servedBy: 'zippymesh'` but expose ZMLR-routed backend in finishReason. */
  protected parseResponse(json: unknown, req: LlmChatRequest): LlmChatResponse;

  /**
   * MCP-side: call ZMLR's `recommend_model` handler. Used by `LlmRegistry.getPreferred()`.
   * Requires the ZMLR HTTP MCP route to be wired (see §7); if absent, returns null
   * and the oracle ladder takes over.
   */
  async recommendModel(intent: string, constraints?: {
    maxLatencyMs?: number;
    maxCostPerMTokens?: number;
    minContextWindow?: number;
    preferFree?: boolean;
    preferLocal?: boolean;
  }): Promise<{ model: string; fallbackChain: string[] } | null>;
}
```

### 3.5 (Future) `openai.ts`, `anthropic.ts`, `groq.ts`

Trivial subclasses with cloud endpoints + bearer-from-env. **Out of
scope initially** — ZippyMesh proxies them and agent CLIs handle their
own auth. Add only when a code path needs raw cloud LLM access
independent of a runner.

## 4. How runners use `LlmProvider`

A runner *may* hold a provider when its host doesn't bring its own LLM
(custom loop services, "thin" runners), or when AutoClaw wants to
**augment** the runner's own output (e.g. summarize rationale before
storing). `LoopServiceAdapter` and `HermesRunner` gain an optional
field, **set at construction only** — no existing method body changes:

```ts
// loop-service-adapter.ts (proposed addition, additive)
export interface LoopServiceConfig {
  // ...existing fields unchanged...
  /** Optional LLM provider for pre-/post-dispatch chat helpers. */
  provider?: LlmProvider;
}

export class LoopServiceAdapter implements Runner {
  // ...existing fields...
  protected readonly provider?: LlmProvider;

  constructor(config: LoopServiceConfig) {
    // ...existing assignments...
    this.provider = config.provider;
  }
}
```

`HermesRunner` follows the same shape — optional ctor arg, stored,
otherwise unused by the base implementation.

**Worked example — a thin loop service backed by a local model:**

```ts
// .autoclaw/orchestrator/config.yaml
// loop_services:
//   - id: "local-coder"
//     endpoint: "http://localhost:9100"  // tiny custom HTTP shell
//     llm_provider: "ollama"             // resolved against LlmRegistry
//     capabilities: { resumableSessions: false }

// At wire-up time:
const ollama = registry.get('ollama');
if (!ollama) throw new Error('ollama not detected; cannot wire local-coder');

const localCoder = new LoopServiceAdapter({
  id: 'local-coder',
  endpoint: 'http://localhost:9100',
  provider: ollama,
});
runnerRegistry.register(localCoder);
```

A subclass overrides `buildDispatchBody` to ask its provider for a
plan before submitting the prompt to the loop service:

```ts
export class LocalCoderRunner extends LoopServiceAdapter {
  protected async buildDispatchBody(opts: DispatchOptions): Promise<Record<string, unknown>> {
    if (!this.provider) return super.buildDispatchBody(opts);

    const plan = await this.provider.chat({
      model: 'llama3.1:8b',
      messages: [
        { role: 'system', content: 'Break the user task into 3-5 numbered steps.' },
        { role: 'user', content: opts.prompt },
      ],
      jsonMode: true,
      hints: { intent: 'plan', requireLocality: 'local' },
      timeoutMs: 30_000,
    });

    return {
      ...super.buildDispatchBody(opts),
      preamble: 'message' in plan ? plan.message.content : undefined,
    };
  }
}
```

`provider` is an injected dependency, never a global lookup inside the
adapter. **A runner that doesn't need raw LLM access (Claude Code,
Cursor, Kiro, Gemini, Hermes, plain AutoGPT) never touches
`LlmProvider`.** No existing runner is rewritten.

KDream / `recommend_model` / MCP callers use the registry directly:

```ts
const provider = llmRegistry.getPreferred({
  explicitProviderId: undefined,
  hints: { intent: 'review', requireLocality: 'lan' },
});
if (provider) {
  const res = await provider.chat({ model: 'auto', messages: [...] });
}
```

## 5. Routing — delegate to ZMLR

The original draft built a six-criterion in-process preference engine
(`'explicit' | 'workspace' | 'cost' | 'latency' | 'local' | 'private' |
'model_family'`). **Deleted in this revision.** Reason: ZMLR already
implements this work in
[`src/lib/routing/engine.js`](ZMLR\src\lib\routing\engine.js)
— playbook selection by intent/group/pool/client/device, candidate
gathering across equivalent models + connections, rate-limit filtering,
trust/cost/latency/country/IP filters, scoring and sorting, with
optional routing-memory bias and vision-boost. AutoClaw running its own
parallel engine would only introduce drift.

```ts
// src/llm/registry.ts — slimmed
export class LlmRegistry {
  register(p: LlmProvider): void;
  detect(): Promise<{ provider: LlmProvider; detection: LlmDetection }[]>;
  list(): LlmProvider[];
  listActive(): LlmProvider[];
  get(id: LlmProviderId): LlmProvider | undefined;

  /**
   * Resolve a provider for a request. Algorithm:
   *   1. If caller named a provider explicitly, return it.
   *   2. Otherwise, prefer 'zippymesh'. If it's healthy, ask its
   *      `recommend_model` MCP tool for a routing decision and return
   *      a thin wrapper that pins the request to that backend.
   *   3. If ZMLR is unreachable or returns no decision, delegate to
   *      `oracle.pick()` (see §5a) for client-side fallback.
   */
  getPreferred(opts: {
    explicitProviderId?: LlmProviderId;
    hints?: LlmChatRequest['hints'];
  }): Promise<LlmProvider | null>;
}
```

The criterion-list and per-intent preference YAML are deleted. Per-intent
preference lives **inside ZMLR** as routing playbooks — configured in
ZMLR's dashboard, exported as `adapters/zippymesh/mateam-playbook.json`
and `kdream-playbook.json` already in this repo. One source of truth.

A `requireLocality` hint, if set on the request, is still honored — it
is forwarded to ZMLR as a constraint header (when supported) and the
oracle ladder filters on `capabilities.locality` before validating
candidates.

## 5a. `src/llm/oracle.ts` — the fallback ladder

When `LlmRegistry.getPreferred()` can't reach ZMLR, the oracle takes
over. This is a TypeScript port of the upstream model-oracle host's
[`model-oracle`](<internal>/model-oracle/SKILL.md)
skill — same fallback ladder, same rate-limit tracking, same `qwen3:0.6b`
failsafe.

```ts
// src/llm/oracle.ts
export type OracleTask = 'agent' | 'tool' | 'thinking' | 'fast' | 'vision' | 'free';

export interface OracleEndpoint {
  id: string;                            // 'ollama-local', 'lmstudio-local', 'zippymesh', 'ollama-failsafe'
  baseUrl: string;                       // e.g. 'http://127.0.0.1:11434'
  online: boolean;
  latencyMs?: number;
  modelCount: number;
}

export interface OracleModel {
  id: string;                            // 'llama3.1:8b', 'qwen3:0.6b', ...
  endpointId: string;
  score: number;                         // 0-100 by task fit
  capabilities: { tools: boolean; thinking: boolean; vision: boolean };
  /** Set when a recent 429 was recorded; oracle excludes until resetsAt. */
  rateLimitedUntil?: string;
}

export interface OracleDecision {
  task: OracleTask;
  recommended: OracleModel | null;       // null only if every rung failed (incl. failsafe)
  alternatives: OracleModel[];
  /** True when the recommendation came from the `qwen3:0.6b@:11435` failsafe. */
  failsafe: boolean;
}

export class Oracle {
  /** Discover endpoints (ZMLR :20128, Ollama :11434, LM Studio :1234, failsafe :11435). */
  refresh(): Promise<OracleEndpoint[]>;
  /** Pick the best model for a task. Re-queries fresh each call — no cross-turn cache. */
  pick(task: OracleTask): Promise<OracleDecision>;
  /** Probe a model end-to-end (cheap completion) to confirm it's truly serving. */
  validate(modelId: string, endpointId: string): Promise<{ ok: boolean; rateLimited: boolean }>;
  /** Record a 429 so subsequent `pick()` calls exclude this model until `resetsAt`. */
  recordRateLimit(modelId: string, endpointId: string, resetsAfterSec: number): void;
  /** Status snapshot for the fleet panel / `/recall`. */
  status(): Promise<{ endpoints: OracleEndpoint[]; rateLimited: { modelId: string; until: string }[] }>;
}
```

**Ladder (matches the SKILL.md verbatim):**
1. `pick('agent')` — best model with tools + thinking.
2. `pick('tool')` — any model with tools.
3. `pick('free')` — any free/local model.
4. `pick('fast')` — smallest/fastest model.
5. If all return null: `refresh()`, wait 10s, retry from rung 1.
6. **Failsafe:** `qwen3:0.6b` on `http://127.0.0.1:11435` — always-on,
   `decision.failsafe = true`. AutoClaw warns the user via the fleet
   panel when the failsafe fires more than twice per minute.

**Rate-limit posture.** Oracle never retries a 429 model without
checking `resetsAt` first. `recordRateLimit()` writes to a per-process
in-memory map AND appends to `.autoclaw/llm/oracle-state.json` (TTL-keyed,
truncated when entries expire) so a fresh process started within `resetsAt`
reads it back. (This diverges intentionally from the Bun original —
long autonomous AutoClaw loops restart often and re-firing paid 429s is
the failure mode to prevent. The on-disk store is local-only; no
cross-machine sync.) The persona loader and any `chat()` caller invokes
`recordRateLimit()` on 429.

**ZMLR-as-rung.** When `ZippyMeshProvider.chat()` returns 429, the
caller records the rate limit against `endpointId: 'zippymesh'` and the
resolved upstream model. `LlmRegistry.getPreferred()` then skips step 2
(the `recommend_model` delegation) until the TTL expires — ZMLR is
treated as a ladder rung, not a routing decider, while the upstream
cools off. Oracle's `pick()` may still choose ZMLR with a *different*
backend (via `validateModel`) if one is available; the rate limit is
keyed to `(endpointId, modelId)`, not endpoint alone.

**Validation posture.** Every `pick()` returns a model + endpoint pair;
the caller validates with a cheap completion before committing to a long
job. This is the trick that makes the ladder reliable in the wild — a
model can be advertised but not actually loaded.

## 6. Config surface — slimmed

```
.autoclaw/
  llm/
    config.yaml          # provider endpoints only (no preference engine)
    cost-ledger.jsonl    # per-call cost roll-up; one append per chat()
    health-cache.json    # last detect()/health() result, TTL 60s
    oracle-state.json    # rate-limit memory written by Oracle.recordRateLimit (S1: persisted, TTL-keyed)
```

`config.yaml` shape:

```yaml
providers:
  - id: zippymesh
    endpoint: http://localhost:20128
    auth: { kind: bearer, tokenEnv: ZIPPYMESH_TOKEN }
    extraHeaders: { X-Client: autoclaw }
  - id: ollama
    endpoint: http://localhost:11434
  # LM Studio not listed; ZMLR proxies it server-side. Oracle probes
  # :1234 directly only as a ladder rung when ZMLR is unreachable.

# Optional: pin a model when caller doesn't say what's loaded locally.
defaultModel:
  ollama:    llama3.1:8b
  zippymesh: auto

# Oracle failsafe endpoint (override only if you've moved it).
oracle:
  failsafe:
    baseUrl: http://127.0.0.1:11435
    model: qwen3:0.6b
```

**No per-intent preference YAML.** Per-intent routing lives inside ZMLR
as playbooks. AutoClaw exports the two we ship today
([`adapters/zippymesh/mateam-playbook.json`](../../adapters/zippymesh/mateam-playbook.json),
[`adapters/zippymesh/kdream-playbook.json`](../../adapters/zippymesh/kdream-playbook.json))
and `autoclaw llm install` (below) imports them into the user's ZMLR
dashboard via ZMLR's existing `POST /api/playbooks` endpoint.

`package.json` extension manifest stays single-knob:

```jsonc
"autoclaw.llm.primaryProviderId": {
  "type": "string",
  "default": "zippymesh",
  "description": "Workspace primary LLM provider. Defaults to zippymesh; falls back to oracle ladder when unreachable."
}
```

**Idempotent install command.** Same surface, slimmer behavior:

```
autoclaw llm install [--zippymesh] [--ollama] [--scope workspace|user]
```

- Runs each requested provider's `detect()`.
- For every reachable provider, ensures a matching entry exists in
  `.autoclaw/llm/config.yaml` (workspace scope) or `~/.autoclaw/llm.yaml`
  (user scope). Re-running is a no-op when entries are unchanged.
- **If `--zippymesh` and ZMLR is reachable:** import the two shipped
  playbooks via ZMLR's dashboard API (idempotent — checks for matching
  playbook id first). Register the ZMLR MCP route (§7) in the workspace's
  MCP config if not already present.
- Reports a summary table (`OK`, `SKIPPED — unreachable`, `ADDED`,
  `PLAYBOOK_IMPORTED`, …) per provider.
- No mutation outside `.autoclaw/llm/`, (when `--scope user`) the
  user-scoped config file, and ZMLR's playbook list.

## 6a. `externalRouterUrl` peer wiring

ZMLR's routing engine supports an external peer via
[`src/lib/routing/engine.js:223-284`](ZMLR\src\lib\routing\engine.js)
— when `settings.externalRouterUrl` is set, ZMLR POSTs candidate-routing
context and merges any `suggestedModelIds` the peer returns. AutoClaw
wires itself as that peer so ZMLR can learn from AutoClaw's task
context (which persona is asking, which sprint, which subcontract, etc.).

**Exact contract** (from the code survey, not the docs):

- **Method:** `POST`, `Content-Type: application/json`.
- **URL:** whatever the user pastes into ZMLR's `settings.externalRouterUrl`
  (no schema imposed by ZMLR). AutoClaw exposes the endpoint at
  `http://127.0.0.1:<AUTOCLAW_LLM_PEER_PORT>/llm/peer/route` (default
  port `20129` — one above ZMLR — overridable via env).
- **Request body:** `{ model: string, intent: string | null, hasImage:
  boolean, estimatedTokens: number, clientId: string | null }`.
- **Body size cap:** 10 KB enforced by ZMLR.
- **Timeout:** ZMLR cancels after 3 s. AutoClaw's handler MUST return
  within that window — recommended budget: ≤200 ms.
- **Response body:** `{ suggestedModelIds: string[] }` — strings shaped
  as ZMLR's `provider/model` (e.g. `"openai/gpt-4o"`,
  `"ollama/llama3.1:70b"`). AutoClaw computes the order from the active
  persona's `providerFallback` plus session context.
- **Failure mode:** ZMLR continues without reordering on any error or
  timeout. AutoClaw's handler MUST therefore be best-effort, not blocking.

AutoClaw's handler is **read-only** — it never mutates ZMLR state or
the workspace; it just informs the routing decision. Lives at
[`src/llm/peer-server.ts`](../../src/llm/peer-server.ts) (new) and
starts when the extension activates if `autoclaw.llm.peerEnabled` is
true (default off — opt-in for now, until we've measured the latency
impact).

## 7. MCP angle — don't duplicate ZMLR; close the MCP route gap

**Original recommendation** (now reversed): add `llm.chat`/`llm.models`/
`llm.health` as gated write tools in `src/mcp/writeTools.ts`.

**2026-05-23 revision.** Don't. ZMLR ships an MCP server object at
[`src/mcp/zmlr-server.js`](ZMLR\src\mcp\zmlr-server.js)
already exposing `list_models`, `recommend_model`, `validate_model`,
`get_models_by_capability`, `get_routing_metadata`, and
`execute_with_routing`. Duplicating that surface in AutoClaw forks the
tool definitions and creates the parallel-router problem one level up.

**The actual gap** (found by the code survey): ZMLR's MCP server object
is **not wired to an HTTP route**. The README says clients can hit
`http://localhost:20128/mcp` but no Next.js route handler exists. The
handlers are pure JS functions awaiting a route.

**Phase B includes a small PR to ZMLR** that adds the missing HTTP
route — a single `src/app/api/mcp/route.js` (or `/mcp/[tool]/route.js`)
file that dispatches POST bodies to the existing handlers. Once landed,
`autoclaw llm install` (§6) registers `http://localhost:20128/mcp` in
the workspace's MCP server config and AutoClaw consumers (persona
loader, KDream, future MCP-aware clients) call ZMLR's tools directly.

**Why a PR to ZMLR vs. building it in AutoClaw:**
- The handlers already exist in ZMLR; adding the route is one file.
- Other ZMLR clients (Cursor, Continue, Claude Code via MCP) benefit too.
- AutoClaw's MCP surface stays focused on workspace-level tools
  (state.json, comms inboxes, runners) — not LLM dispatch, which is
  ZMLR's job.

**If the PR is rejected or stalls** (ZMLR is the user's own project, so
this is unlikely): AutoClaw's `ZippyMeshProvider.recommendModel()` calls
the MCP handler functions directly via a Node-side import when running
in the same workspace tree (`require('zippymesh-router/src/mcp/zmlr-server.js')`),
falling back to the oracle when the import path isn't available.

**AutoClaw's own MCP write-tools** (`writeTools.ts`) — unchanged by this
RFC. No `llm.*` tools added. Existing workspace tools stay.

**Streaming over MCP** — deferred. No consumer yet; ZMLR's own MCP route
can deal with streaming later if a client asks.

## 8. Open questions

Several first-draft questions were closed by the 2026-05-23 code surveys.
Resolved ones folded into the design above. Still open:

1. **Ollama tool-use stability per model.** Adapter advertises
   `toolUse: true` but the loaded model may not support it. Should the
   adapter probe (`/api/show` for `capabilities`) on first use, or
   accept the per-call 400 and surface it? Recommend: probe on
   `OllamaProvider.models()`, cache the capability, surface 400 as
   `errorClass: 'internal'`. Confirm in S1.
2. **Cost ledger format alignment with ZICO.**
   [ZICO's `BudgetTracker`](<local-projects>\ZippyAI_IDE_Tools\packages\core\src\orchestration\budget-tracker.ts)
   has a clean schema (`{ provider, model, operation, tokens, costCents,
   runId }`) with a per-provider `ProviderPricing` table. Should
   AutoClaw's `llm/cost-ledger.jsonl` adopt that schema verbatim so a
   future merge into a shared `@gozippy/billing` package is cheap?
   Recommend: yes — adopt the field names and units (`costCents` over
   `costUsd`, same `provider/model/runId` tuple). Confirm in S1.
3. **Embeddings provider.** `docs/V3_PLAN.md` Phase 3 declares
   "Embedding via ZippyMesh on :20128" but `kg-daemon` currently embeds
   in-process. Once ZMLR exposes `/v1/embeddings` via the OpenAI-compat
   surface (it already does — backend-dependent), should `kg-daemon`
   adopt it (DI of an `LlmProvider`) or keep its own path for isolation?
   Out of scope for this RFC; flag for the KG owner.
4. **Oracle rate-limit persistence.** ~~Defer to S2.~~ **Resolved
   2026-05-24:** persist from S1. SKILL.md says "do not cache across
   turns" for the *recommendation* (so model selection stays fresh), but
   the *rate-limit map* is exactly the kind of state worth persisting —
   long autonomous AutoClaw loops restart often and re-firing paid 429s
   is the failure mode to prevent. Write to `.autoclaw/llm/oracle-state.json`
   with TTL; local-only (no cross-machine sync). Locked into S1 (see
   spec acceptance criterion #5).
5. **`externalRouterUrl` enablement default.** Phase B ships the peer
   server (§6a) **off by default**. Should it default on once the latency
   has been measured? Decision deferred to first user feedback.
6. **Failsafe install timing.** ~~Wait for `autoclaw llm install` (S2).~~
   **Resolved 2026-05-24:** install at S1 first run. The bottom rung
   must exist from day one or the ladder is theatre — `S1` runs
   `ollama pull qwen3:0.6b` and starts a `:11435` instance (or detects
   one already running) on the first registry initialization. Failure to
   install is non-blocking — the oracle reports `failsafe: null` and the
   persona loader surfaces a fleet-panel notice.

## 8a. Reference — cross-project landscape (2026-05-23)

This RFC was revised after a survey of related GoZippy repos. Findings
not absorbed inline:

- **ZICO ([`<local-projects>\ZippyAI_IDE_Tools`](<local-projects>\ZippyAI_IDE_Tools))**
  has no `LlmProvider` abstraction to reuse; its `AgentAdapter` is at
  the agent-orchestration layer (Cursor/Copilot/local-LLM) and its
  `LocalLLMAdapter` hardcodes Ollama/LM Studio. ZICO's
  `BudgetTracker` + `ProviderPricing` is worth adopting for cost
  ledger (open question 2).
- **ZippyMeshEcosystem ([`<local-projects>\ZippyMeshEcosystem`](<local-projects>\ZippyMeshEcosystem))**
  is stale Rust quantum-crypto work (last activity Oct 2025); ignore
  for LLM routing.
- **zippycoin-apps ([`<local-projects>\zippycoin-apps`](<local-projects>\zippycoin-apps))**
  is active blockchain (wallet/governance/DeFi); no LLM code. Future
  consumer of `@gozippy/llm-router-client` (below) at most.
- **Future extract: `@gozippy/llm-router-client`** — once
  `src/llm/oracle.ts` and the `LlmProvider` interface are stable in
  AutoClaw, extract them plus `ZippyMeshProvider` and `OllamaProvider`
  into a tiny NPM package. Consumers:
  1. AutoClaw (consumer #1, this RFC).
  2. the upstream model-oracle host's openclaw `model-oracle` skill collapses to a 30-line
     wrapper, retiring the duplicated Bun script.
  3. the upstream model-oracle host's `free-models-router` skill folds in as a "free-tier"
     preset.
  4. ZippyAI_IDE_Tools' `LocalLLMAdapter` drops its hardcoded endpoints.
  5. Eventually ZippyGPT_MCP_Server, Zippy-Archon, AgentEnsemble.

  **Don't extract prematurely.** Wait until consumer #2 is real
  (porting the upstream model-oracle host `model-oracle` to TS is the trigger).

## 9. Sequencing — re-sequenced for Option C

Smaller scope, ZMLR-first, oracle-fallback:

| Sprint | Deliverable | Why this slot |
|---|---|---|
| **S1** | `src/llm/types.ts` + `src/llm/registry.ts` + `openai-compatible.ts` base | Types-only landing; the seam every later piece depends on. Zero behavior change. |
| **S1** | `src/llm/zippymesh.ts` (primary) + `src/llm/ollama.ts` (fallback) | Two adapters cover the entire local matrix via ZMLR's server-side routing; one direct local provider for when ZMLR is down. |
| **S1** | `src/llm/oracle.ts` (TS port of the upstream model-oracle host `model-oracle.mjs`) — includes ZMLR as a ladder rung (not just a routing decider) and persists rate-limit map to `.autoclaw/llm/oracle-state.json` | Client-side fallback ladder + persistent rate-limit map + `qwen3:0.6b@:11435` failsafe. The headline new capability. |
| **S1** | `src/llm/failsafe-install.ts` — first-run `ollama pull qwen3:0.6b` + `:11435` instance start | Bottom rung exists from day one; non-blocking on failure. Moved up from S2 (resolved open question 6). |
| **S1** | `src/llm/costLedger.ts` adopting ZICO's `{ provider, model, operation, tokens, costCents, runId }` schema | Aligns with [<local-projects>\ZippyAI_IDE_Tools\packages\core\src\orchestration\budget-tracker.ts](<local-projects>\ZippyAI_IDE_Tools\packages\core\src\orchestration\budget-tracker.ts) so future merge is cheap. |
| **S1** | Persona loader's `provider-stub.ts` swapped for the real registry | First consumer; the persona loader's Phase B integration test is the exit gate. |
| **S2** | **PR to ZMLR**: `src/app/api/mcp/route.js` exposes the existing `src/mcp/zmlr-server.js` handlers at `:20128/mcp` (§7) | Closes the documented-but-unwired gap. Small. Benefits Cursor/Continue too. |
| **S2** | `.autoclaw/llm/config.yaml` parser + `autoclaw llm install` (slim — providers only, no preference engine) | Idempotent install; imports the two shipped playbooks into ZMLR; registers ZMLR's MCP in workspace config. |
| **S2** | `LlmRegistry.getPreferred()` calls ZMLR's `recommend_model` via MCP when reachable; oracle when not | The actual routing decision lands. |
| **S3** | `src/llm/peer-server.ts` — `externalRouterUrl` peer (§6a) | "AutoClaw teaches ZMLR" loop. Off by default until latency is measured. |
| **S3** | Optional `provider?: LlmProvider` field on `LoopServiceAdapter` + worked `LocalCoderRunner` | Demonstrates the "thin runner + local LLM" pattern; unchanged from original. |
| **S4** | `recommend_model` (the AutoClaw side) rewritten on top of the registry; cost-ledger join with runner ledger | Closes the loop with KDream. |
| **S4** | Extract `@gozippy/llm-router-client` once the upstream model-oracle host `model-oracle` is the second real consumer (§8a) | Premature before; deliberate then. |
| **Deferred** | `lmstudio.ts` standalone adapter | ZMLR proxies; oracle probes :1234 directly as a ladder rung. Revive only if a code path needs raw direct access. |
| **Deferred** | `openai.ts`, `anthropic.ts`, `groq.ts` (direct cloud) | ZMLR proxies them; only add when a non-runner code path needs raw cloud access. |
| **Deferred** | MCP `llm.chat` / `llm.models` / `llm.health` in AutoClaw's writeTools.ts | ZMLR's MCP is the canonical surface; AutoClaw consumes, doesn't re-export. |
| **Deferred** | Streaming over MCP | No consumer yet. |
