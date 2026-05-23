---
spec_id: llm-provider-s1
title: LLM provider abstraction — S1 foundation (types + registry + openai-compatible + ollama)
status: draft
owner: architect
created: 2026-05-23
updated: 2026-05-23
supersedes: []
superseded_by: null
references:
  - docs/rfc/llm-provider-abstraction.md
  - docs/V3_1_ROADMAP.md
  - docs/specs/persona-loader/spec.md
  - src/runners/types.ts
  - src/runners/registry.ts
  - src/runners/hermes.ts
acceptance:
  - given: "Ollama is running on the default port (11434) with at least one model pulled"
    when: "registry.detect() is called"
    then: "the Ollama adapter reports `{ found: true, models: [...non-empty] }` and is added to the active set"
  - given: "the Ollama adapter is active"
    when: "registry.get('ollama').chat({ prompt: 'reply with the literal text OK' }) is called"
    then: "the response is a string containing 'OK', returned within the request's timeoutMs, with token counts populated"
  - given: "Ollama is NOT running"
    when: "registry.detect() is called"
    then: "the Ollama adapter reports `{ found: false, reason: 'not_installed' | 'no_auth', hint: '...' }`, is marked disabled, and no exception escapes"
  - given: "the persona loader (Phase A spec) is configured with preferredProvider 'ollama:llama3.1:8b'"
    when: "the LLM registry is wired into resolveProvider()"
    then: "persona dispatch routes through the Ollama adapter and the response appears in the chat panel"
non_goals:
  - LM Studio adapter — S2.
  - ZippyMesh adapter + `:20128/v1` header thread-through — S2.
  - `autoclaw llm install` command writing per-host config — S2.
  - MCP `llm.chat` / `llm.models` / `llm.health` write-tools — S3.
  - `LocalCoderRunner` (a runner that *is* a local LLM + tool surface) — S3.
  - Cost-ledger join with the runners' cost ledger — S4.
  - Streaming responses surfaced via MCP — deferred.
  - Auto-downgrading models when the host can't run the requested size — see open questions.
---

# LLM provider abstraction — S1 (types + registry + openai-compatible base + Ollama)

## Summary

Land the foundation of `src/llm/`: a `LlmProvider` interface, a registry,
the OpenAI-compatible base adapter (so most providers are a one-line
subclass), and the first concrete adapter (Ollama). After S1, anything
in the codebase that wants to call a local LLM can do so via the
registry, and the persona loader (Phase A) gets a real provider to
route to.

This is the foundational slice of [docs/rfc/llm-provider-abstraction.md](../../rfc/llm-provider-abstraction.md);
S2 (LM Studio + ZippyMesh + install) and S3 (MCP + LocalCoderRunner)
build on it.

## Read first

- [docs/rfc/llm-provider-abstraction.md](../../rfc/llm-provider-abstraction.md) §1-3 (problem, interface, OpenAI-compatible + Ollama adapters)
- [src/runners/types.ts](../../../src/runners/types.ts) — match the existing TS contract style (`detect`, `health`, `ErrorClass`, `Capabilities`)
- [src/runners/hermes.ts](../../../src/runners/hermes.ts) — sibling REST-adapter pattern (HTTP client style, error class mapping)
- [src/runners/registry.ts](../../../src/runners/registry.ts) — the `RunnerRegistry` pattern this LLM registry mirrors
- [docs/specs/persona-loader/spec.md](../persona-loader/spec.md) — your first consumer; its `provider-stub.ts` swaps to the real `LlmProvider` here

## Design

### Inputs

1. The user's workspace `.autoclaw/llm/config.yaml` (read-only in S1 —
   parsing the file is enough; `autoclaw llm install` writes it in S2).
   Until that file exists, the registry uses sensible env-var defaults
   (`OLLAMA_HOST=http://127.0.0.1:11434`).
2. Ambient process env (`OLLAMA_HOST`, `OLLAMA_NUM_PARALLEL`, etc.).
3. A `DispatchOptions`-style call from a consumer (persona loader, future
   `LocalCoderRunner`, future MCP tool).

### Outputs

1. A `chat()` response string with token counts and duration.
2. Health snapshots (`detect()`, `health()`).
3. A model list (`models()`).
4. A row appended to `.autoclaw/llm/cost-ledger.jsonl` per call
   (`{ provider, model, prompt_tokens, completion_tokens, duration_ms,
   timestamp, sessionId }`). Separate from the runner cost-ledger per the
   RFC §8 — joined in S4.

### Contract — TypeScript surface

```ts
// src/llm/types.ts
export type ProviderId = string;            // "ollama" | "lmstudio" | "zippymesh" | ...
export type ModelId = string;               // "llama3.1:70b", "qwen2.5-coder", ...

export interface ProviderCapabilities {
  /** Server supports SSE / chunked streaming. */
  streaming: boolean;
  /** Server honors tool/function calling. */
  toolUse: boolean;
  /** Server can return JSON-mode responses. */
  jsonMode: boolean;
  /** Maximum context window in tokens, if knowable. */
  contextWindow?: number;
  /** True for fully local providers (no network egress). */
  local: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatOptions {
  model?: ModelId;                          // default = provider's first available
  messages: ChatMessage[];
  prompt?: string;                          // sugar for messages: [user prompt]
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  jsonMode?: boolean;
  /** Used for the cost-ledger row. */
  sessionId?: string;
  /** Used for routing/audit. */
  callerPersonaId?: string;
}

export interface ChatResult {
  ok: boolean;
  response?: string;
  model: ModelId;
  tokens?: { input: number; output: number };
  durationMs: number;
  errorClass?: ErrorClass;     // reuse the runner one
  errorMessage?: string;
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  detect(): Promise<DetectionResult>;       // reuse from runners
  models(): Promise<ModelId[]>;
  chat(opts: ChatOptions): Promise<ChatResult>;
  health(): Promise<HealthReport>;          // reuse from runners
}
```

### OpenAI-compatible base

Most servers (LM Studio, vLLM, llama.cpp's server, ZippyMesh, and Ollama
via its OpenAI-compat shim) accept the same HTTP shape on `/v1/chat/completions`.
Implement the base once:

```ts
// src/llm/openai-compatible.ts
export interface OpenAiCompatibleOptions {
  id: ProviderId;
  baseUrl: string;                          // e.g. "http://127.0.0.1:1234/v1"
  apiKey?: string;
  capabilities: ProviderCapabilities;
  /** Map this provider's model-list call to a `ModelId[]`. */
  modelsPath?: string;                      // default "/v1/models"
  /** Hook to inject extra request headers (e.g. ZippyMesh `X-Intent`). */
  extraHeaders?: (opts: ChatOptions) => Record<string, string>;
}
export class OpenAiCompatibleProvider implements LlmProvider { /* … */ }
```

Subclasses provide only the wiring that differs:

```ts
// src/llm/ollama.ts
export class OllamaProvider extends OpenAiCompatibleProvider {
  constructor(host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434') {
    super({
      id: 'ollama',
      baseUrl: `${host}/v1`,
      capabilities: { streaming: true, toolUse: true, jsonMode: true, local: true },
      modelsPath: '/api/tags',     // Ollama uses native path, mapped to ModelId[]
    });
  }
  // Override models() to map Ollama's /api/tags response to ModelId[]
  async models(): Promise<ModelId[]> { /* … */ }
}
```

### Registry

```ts
// src/llm/registry.ts
export class LlmRegistry {
  constructor(workspaceRoot: string);
  register(provider: LlmProvider): void;
  detectAll(): Promise<Map<ProviderId, DetectionResult>>;
  get(id: ProviderId): LlmProvider | undefined;
  /** Resolve a ProviderRef like "ollama:llama3.1:70b" to a provider+model. */
  resolve(ref: ProviderRef): { provider: LlmProvider; model: ModelId } | undefined;
  /** Best provider per the policy chain ('explicit' | 'workspace' | 'local' | 'cost' | 'latency'). */
  preferred(opts?: { criteria?: PreferenceCriterion[] }): LlmProvider | undefined;
}
```

The persona loader's `resolveProvider()` from Phase A is rewritten to
call `LlmRegistry.resolve(ref)`. Tests for the loader's fallback path
keep passing.

### File layout

```
src/llm/
  types.ts              # interfaces + ProviderRef parsing
  openai-compatible.ts  # base provider class
  ollama.ts             # Ollama subclass + /api/tags mapping
  registry.ts           # LlmRegistry
  costLedger.ts         # appends to .autoclaw/llm/cost-ledger.jsonl
  index.ts              # barrel export
src/test/
  llm-types.test.ts     # ProviderRef parsing / capabilities defaults
  llm-ollama.test.ts    # mocked HTTP + detect()/models()/chat()/health()
  llm-registry.test.ts  # registration, detection, preferred() policy
```

No deps added. Use Node 18+ global `fetch`. Tests use a tiny in-memory
HTTP responder (same pattern as `src/test/cloudRelay.test.ts`).

## Acceptance criteria (expanded)

1. **Ollama detected when running.**
   *Given* Ollama is up on `127.0.0.1:11434` with `llama3.1:8b` pulled
   (or the test mock equivalent).
   *When* `registry.detectAll()` runs.
   *Then* the result includes `{ id: 'ollama' → { found: true, version:
   '<x>', models: ['llama3.1:8b', …] } }`, and `registry.get('ollama')`
   returns the live adapter.

2. **Round-trip chat.**
   *Given* the Ollama adapter is registered.
   *When* `provider.chat({ prompt: 'reply with the literal text OK',
   sessionId: 's-1' })` is called with `timeoutMs: 30000`.
   *Then* the result is `{ ok: true, response: contains 'OK', tokens:
   { input > 0, output > 0 }, durationMs < 30000 }` and a row is
   appended to `.autoclaw/llm/cost-ledger.jsonl` with the same
   `sessionId`.

3. **Ollama absent — graceful.**
   *Given* nothing on port 11434 (or `OLLAMA_HOST` set to an unreachable
   address with a short connect timeout).
   *When* `registry.detectAll()` runs.
   *Then* the Ollama entry is `{ found: false, reason: 'not_installed',
   hint: contains 'install Ollama and pull a model' }`; no exception
   escapes; `registry.get('ollama')` returns undefined.

4. **Persona loader integration.**
   *Given* the persona loader from
   [persona-loader/spec.md](../persona-loader/spec.md) is installed and
   the LLM registry is wired into its `resolveProvider`.
   *When* a test invokes `loader.dispatch('architect', { prompt: '…' })`.
   *Then* the dispatch routes through `OllamaProvider.chat` when Ollama
   is up, and falls back per the persona's `providerFallback` when it's
   not — no behavior change visible to the persona-loader tests.

5. **Compile + adapters:check stay green.**
   *Given* the S1 files land.
   *When* `npm run compile && npm run adapters:check && npm run test:unit`
   are run.
   *Then* all three pass; existing 625 tests keep passing; the
   new test files add ≥ 8 cases.

## Sequencing

| Step | Deliverable | Owner | Exit gate |
|---|---|---|---|
| 1 | `src/llm/types.ts` + `llm-types.test.ts` (ProviderRef parsing, defaults) | llm-impl | ≥ 4 cases pass |
| 2 | `src/llm/openai-compatible.ts` (the base) | same | unit-test with a stubbed `fetch` covers `chat`, `models`, error mapping |
| 3 | `src/llm/ollama.ts` (subclass + `/api/tags` mapping) | same | tests against a tiny in-memory Ollama responder pass |
| 4 | `src/llm/registry.ts` + cost-ledger writes | same | preferred() policy tests pass; ledger row appears |
| 5 | Persona-loader rewires `resolveProvider` to the LLM registry | persona-loader-impl (cross-spec) | the persona-loader S1 tests still pass; round-trip end-to-end works |

## Non-goals (repeated)

- LM Studio (S2), ZippyMesh (S2), install command (S2), MCP tools (S3),
  LocalCoderRunner (S3), cost-ledger join (S4), streaming over MCP
  (deferred). No direct cloud adapters (`openai.ts`, `anthropic.ts`) in
  any sprint while ZippyMesh proxies them.

## Open questions

1. **Model-floor fallback.** Persona prefers `ollama:llama3.1:70b`, but
   the host can't run 70b. Should `OllamaProvider.chat` probe and silently
   downgrade to the largest installed model, or fail with a hint? Recommend:
   downgrade with a single one-line warning in the cost-ledger row's
   `notes` field; never silent.
2. **Concurrent dispatch budget.** Spawning N concurrent persona dispatches
   × local model = unbounded RAM. Cap at `min(host_cores/2, 4)` concurrent
   `chat()` calls per `OllamaProvider`? Belongs in the registry, not the
   adapter.
3. **Ollama version floor.** Some `/v1` compatibility quirks were fixed in
   recent Ollama versions. Set a minimum-supported version in `detect()`?
   Recommend: yes — warn but don't block below `0.5.0`.

## Don't-do

- **Don't add an `openai` SDK dep.** A 30-line `fetch` against
  `/v1/chat/completions` covers everything S1 needs.
- **Don't hardcode endpoints in adapter constructors.** Always read env
  with a documented default; tests inject a fixed `baseUrl`.
- **Don't log prompts or responses** to the cost-ledger or any other log;
  log counts only. (Same posture as the cloud-relay D-series.)
- **Don't share state between adapters.** Each adapter owns its own HTTP
  client and cache; the registry just holds references.
- **Don't bake retry into the adapter.** Retry is the *caller's* policy
  (loader, MCP tool, runner). Keep adapters single-shot.
