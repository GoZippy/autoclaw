# RFC: LLM Provider Abstraction

_Status: draft, 2026-05-22. Companion to
[runner-bridge-contract.md](runner-bridge-contract.md) — distinct concern._

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

### 3.3 `lmstudio.ts`

LM Studio's local server is **OpenAI-compatible only** — no native API.
Listens on `:1234/v1` by default, no auth.

```ts
export class LmStudioProvider extends OpenAiCompatProvider {
  constructor(endpoint = process.env.LMSTUDIO_HOST ?? 'http://localhost:1234') {
    super({
      id: 'lmstudio',
      endpoint,
      v1Prefix: '/v1',
      auth: { kind: 'none' },
      capabilities: {
        streaming: true,
        toolUse: true,
        jsonMode: true,
        embeddings: true,
        contextWindow: 8192,
        locality: 'local',
        reportsCost: false,
        modelFamilies: [],
      },
    });
  }
}
```

**Verified (LM Studio docs, 2026-05):** server at
`http://localhost:1234/v1` exposes `/chat/completions`, `/completions`,
`/embeddings`, `/models`. **Assumption:** `tools` support varies by
loaded model (same caveat as Ollama).

### 3.4 `zippymesh.ts`

The user's local LLM router on `:20128/v1`, already documented in
`adapters/zippymesh/README.md` and `adapters/claude-code/mcp-zippymesh.md`.
OpenAI-compatible surface plus extra header conventions:

- `X-Intent: code | review | plan | summarize | chat` — drives playbook
  selection in the router.
- `X-Session-Parallel: true` — used during MAteam fan-out.
- Special model id `"auto"` — the router picks a backend itself.

The adapter sets `X-Intent` from `LlmChatRequest.hints.intent` and
defaults the model to `"auto"`.

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
  /** Override: thread `hints.intent` through as `X-Intent`. */
  protected augmentHeaders(req: LlmChatRequest): Record<string, string>;
  /** Override: `servedBy: 'zippymesh'` but expose `routedTo` in finishReason. */
  protected parseResponse(json: unknown, req: LlmChatRequest): LlmChatResponse;
}
```

**Assumption:** `X-Intent` and `X-Session-Parallel` are honored over
the OpenAI-compat surface (the README shows them verbatim in human-IDE
configs). Verify by curling `:20128/v1/chat/completions` with and
without the header before defaulting to `on`.

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

## 5. Routing / preference

`PreferenceCriterion` in `src/runners/types.ts` is currently
`'explicit' | 'workspace' | 'cost' | 'latency'`. The LLM registry needs
a **parallel** criterion set — not a modification of the runner one —
because the meanings differ:

```ts
// src/llm/types.ts
export type LlmPreferenceCriterion =
  | 'explicit'        // caller named the provider
  | 'workspace'       // workspace's primary llm provider
  | 'cost'            // lowest $/token from recent ledger
  | 'latency'         // lowest p50 ms
  | 'local'           // capabilities.locality === 'local'
  | 'private'         // 'local' or 'lan' (i.e. NOT 'cloud')
  | 'model_family';   // matches request.hints.preferFamily

export interface LlmPreferenceOptions {
  explicitProviderId?: LlmProviderId;
  workspacePrimaryProviderId?: LlmProviderId;
  preferenceOrder?: LlmPreferenceCriterion[];
  costByProviderId?: Record<LlmProviderId, number>;
  p50LatencyMsByProviderId?: Record<LlmProviderId, number>;
  hints?: LlmChatRequest['hints'];
}

const DEFAULT_LLM_PREFERENCE_ORDER: readonly LlmPreferenceCriterion[] = [
  'explicit', 'workspace', 'private', 'cost', 'latency',
];
```

A `requireLocality` hint is a **hard filter** applied before any
criterion — providers whose `capabilities.locality` doesn't match are
removed from the candidate set entirely.

**Workspace policy.** `.autoclaw/orchestrator/config.yaml` gains:

```yaml
llm:
  # Per-intent provider preference. Each key is a hint.intent value; each
  # value is an ordered preference list of provider ids (or 'auto').
  preference:
    code:      ['ollama', 'zippymesh']         # cheap local for routine code
    review:    ['zippymesh', 'ollama']         # ZM picks a strong reviewer
    plan:      ['zippymesh']                   # always route through ZM
    summarize: ['ollama']
    chat:      ['ollama', 'lmstudio', 'zippymesh']
  # Criteria ordering when preference lookup falls through.
  preferenceOrder: ['explicit', 'workspace', 'private', 'cost', 'latency']
  # Hard locality constraint for any provider used by background KDream ticks.
  kdream:
    requireLocality: 'local'
```

The user-stated requirement — _"prefer local for routine tasks; cloud
for review"_ — collapses to `code: [ollama]`, `review: [zippymesh]`.

## 6. Config surface

```
.autoclaw/
  llm/
    config.yaml          # provider list + preference (mirrors mcp/config.json)
    cost-ledger.jsonl    # per-call cost roll-up; one append per chat()
    health-cache.json    # last health() result, TTL 60s
```

`config.yaml` shape:

```yaml
providers:
  - id: ollama
    endpoint: http://localhost:11434
  - id: lmstudio
    endpoint: http://localhost:1234
  - id: zippymesh
    endpoint: http://localhost:20128
    auth: { kind: bearer, tokenEnv: ZIPPYMESH_TOKEN }
    extraHeaders: { X-Client: autoclaw }

preference:                            # see §5 above
  code:    [ollama, zippymesh]
  review:  [zippymesh]
preferenceOrder: [explicit, workspace, private, cost, latency]

# Optional: declare a default-model alias per provider for callers that
# don't know what's loaded locally.
defaultModel:
  ollama:    llama3.1:8b
  lmstudio:  local-default
  zippymesh: auto
```

`package.json` extension manifest gets a settings stanza for the
"primary" provider only (mirrors `autoclaw.runner.preferenceOrder`):

```jsonc
"autoclaw.llm.primaryProviderId": {
  "type": "string",
  "default": "zippymesh",
  "description": "Workspace primary LLM provider. Falls back to preferenceOrder when absent."
}
```

**Idempotent install command.** Add a new entry point to the existing
`autoclaw mcp install` CLI surface — same idempotency pattern as that
command:

```
autoclaw llm install [--ollama] [--lmstudio] [--zippymesh] [--scope workspace|user]
```

- Runs each requested provider's `detect()`.
- For every reachable provider, ensures a matching entry exists in
  `.autoclaw/llm/config.yaml` (workspace scope) or `~/.autoclaw/llm.yaml`
  (user scope). Re-running is a no-op when entries are unchanged
  (`mergeRegistryFile`-style diff, like `src/mcp/install.ts`).
- Reports a summary table (`OK`, `SKIPPED — unreachable`, `ADDED`, …) per
  provider, identical in shape to `mcp install`'s `formatReport`.
- No mutation outside `.autoclaw/llm/` and (when `--scope user`) the
  user-scoped config file.

## 7. MCP angle — `llm.chat`

**Recommendation: yes — add `llm.chat`, `llm.models`, `llm.health` as
gated write tools in `src/mcp/writeTools.ts`.** Rationale:

1. The MCP server is workspace-scoped and already gates writes behind
   `autoclaw.mcp.allowWrites` (`writeTools.ts:73`). The LLM-call gate is
   strictly *narrower* than that (provider mediates) so it inherits the
   existing audit + per-tool authorization plumbing for free.
2. KDream `recommend_model` and `list_models` already exist as
   ZippyMesh-specific MCP tools (`adapters/claude-code/mcp-zippymesh.md`).
   `llm.chat` generalizes them across providers.
3. Cross-host fan-out — Cursor or Kiro asking AutoClaw to run a quick
   local completion without re-implementing the routing layer per host.

Tool surface:

```ts
// Inserted into the WRITE_TOOLS array in src/mcp/writeTools.ts.
// All three go through the existing checkWriteGate + authorizeWriteTool.
{
  name: 'llm.chat',
  description: 'Run one chat completion through the AutoClaw LLM router.',
  inputSchema: {
    type: 'object',
    properties: {
      provider: { type: 'string', description: 'Provider id, or "auto" for routed.' },
      model: { type: 'string' },
      messages: { type: 'array', items: { /* LlmMessage shape */ } },
      hints: { type: 'object' },
      jsonMode: { type: 'boolean' },
      maxTokens: { type: 'number' },
    },
    required: ['messages'],
  },
}
{ name: 'llm.models', /* lists models per provider */ }
{ name: 'llm.health', /* per-provider HealthReport */ }
```

**Audit:** every `llm.chat` invocation appends to
`.autoclaw/llm/cost-ledger.jsonl` (the chat call does this anyway) **and**
the existing `write_tool_audit` row in `state.json` — so denied calls,
allowed calls, and cost together land in one fleet-visible record.

**Streaming:** `llm.chat` is a one-shot tool; for now it always sets
`stream: false` on the underlying request. A streaming variant
(`llm.chat.stream`) can be added when an MCP client demands it; defer
because the protocol's streaming story for tool results is still moving.

## 8. Open questions

1. **Ollama tool-use stability per model.** Adapter advertises
   `toolUse: true` but the loaded model may not support it. Should the
   adapter probe (load a tiny model, call `/api/show` for `capabilities`)
   on first use, or accept the per-call 400 and surface it?
2. **ZippyMesh extra headers** — are `X-Intent` and `X-Session-Parallel`
   honored over the OpenAI-compatible surface, or only over a ZM-native
   endpoint we haven't found yet? `adapters/zippymesh/README.md` shows
   them in human-IDE config; this RFC assumes the same headers work over
   `:20128/v1` — needs a one-off curl confirmation against a running ZM
   instance.
3. **Cost ledger scope.** AutoClaw already has a runner-level
   `costByRunnerId`. Should `llm/cost-ledger.jsonl` roll up into the same
   ledger via `src/mcp/costLedger.ts`, or stay separate? Recommend
   separate at first (different units: $/token vs $/dispatch) with a
   `/recall`-visible join later.
4. **Embeddings provider.** `docs/V3_PLAN.md` Phase 3 declares
   "Embedding via ZippyMesh on :20128" but `kg-daemon` currently embeds
   in-process. Once `LlmProvider.embed()` lands, should `kg-daemon` adopt
   it (dependency injection of an `LlmProvider`) or keep its own path for
   isolation? Out of scope for this RFC; flag for the KG owner.
5. **Resilience.** What happens when the preferred provider goes
   unreachable mid-loop? Current proposal: `detect()` runs lazily before
   each `chat()` if the last health probe is older than 60s; on failure,
   the registry transparently retries with the next provider in the
   preference list **only when `hints.allowFallback === true`** —
   otherwise surface the error. Confirm with implementation.
6. **Streaming over MCP.** As above — punt until a real consumer asks.

## 9. Sequencing

Adapter-ship order, smallest viable first:

| Sprint | Deliverable | Why first |
|---|---|---|
| **S1** | `src/llm/types.ts` + `src/llm/registry.ts` + `openai-compatible.ts` base | Types-only landing; same pattern as `src/runners/types.ts`. Zero behavior change. |
| **S1** | `ollama.ts` | Most users have Ollama; no auth; verifies the base. |
| **S2** | `lmstudio.ts` | One-line subclass; expands the local matrix. |
| **S2** | `zippymesh.ts` + `X-Intent` thread-through | The headline integration — first time AutoClaw code talks to ZMLR directly. |
| **S2** | `.autoclaw/llm/config.yaml` parser + `autoclaw llm install` | Idempotent install + workspace policy expressible. |
| **S3** | MCP `llm.chat` / `llm.models` / `llm.health` tools | Cross-host surface; depends on §7 + audit plumbing. |
| **S3** | Optional `LlmProvider` field on `LoopServiceAdapter` + worked `LocalCoderRunner` | Demonstrates the "thin runner + local LLM" pattern. |
| **S4** | Cost-ledger roll-up + `recommend_model` rewritten on top of the registry | Closes the loop with KDream. |
| **Defer** | `openai.ts`, `anthropic.ts`, `groq.ts` (direct cloud) | ZippyMesh already proxies them; only add when a non-runner code path needs raw cloud access. |
| **Defer** | Streaming over MCP | No consumer yet. |
