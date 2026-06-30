---
spec_id: llm-provider-s1
title: LLM provider abstraction — S1 foundation (types + registry + ZippyMesh + Ollama + Oracle)
status: pilot
owner: architect
created: 2026-05-23
updated: 2026-05-24
pilot_evidence:
  - "693 passing tests (44 new for S1, 0 failing) — 2026-05-24"
  - "Persona loader's 12 existing tests still green after provider-stub rewire"
  - "Compile clean (tsc -p ./), adapters:check green"
supersedes: []
superseded_by: null
references:
  - docs/rfc/llm-provider-abstraction.md
  - docs/V3_1_ROADMAP.md
  - docs/specs/persona-loader/spec.md
  - src/runners/types.ts
  - src/runners/registry.ts
  - src/runners/hermes.ts
  - adapters/zippymesh/README.md
  - adapters/zippymesh/mcp-setup.md
acceptance:
  - given: "ZMLR is running on the default endpoint (127.0.0.1:20128) with at least one provider configured"
    when: "registry.detect() is called"
    then: "the ZippyMesh adapter reports `{ found: true, version: '<x>', endpoint: 'http://127.0.0.1:20128' }` and is added to the active set with `id: 'zippymesh'`"
  - given: "ZMLR is running and exposes /v1/chat/completions"
    when: "registry.get('zippymesh').chat({ model: 'auto', messages: [{role:'user', content:'reply OK'}], hints: { intent: 'chat' } }) is called"
    then: "the response contains 'OK' within timeoutMs, both `x-intent` and `x-zippy-intent` headers were sent, token counts are populated, and a ledger row is appended using the ZICO-aligned schema `{ provider:'zippymesh', model:<resolved>, operation:'chat', tokens, costCents, runId, sessionId, timestamp }`"
  - given: "ZMLR is NOT running but Ollama is on 127.0.0.1:11434 with at least one model pulled"
    when: "registry.getPreferred({ hints: { intent: 'chat' } }) is called"
    then: "the result is the OllamaProvider (because the oracle ladder selected it); no exception escapes; a one-line warning is logged that ZMLR was unreachable"
  - given: "Both ZMLR and Ollama are unreachable but the failsafe (qwen3:0.6b on 127.0.0.1:11435) is up"
    when: "oracle.pick('agent') is called"
    then: "the decision returns `{ recommended: { id:'qwen3:0.6b', endpointId:'ollama-failsafe' }, failsafe: true }`; a status entry shows the failsafe was used"
  - given: "Ollama is up, a model returns HTTP 429"
    when: "the caller invokes `oracle.recordRateLimit(modelId, 'ollama-local', 3600)` and then `oracle.pick('agent')`"
    then: "the rate-limited model is excluded from the candidate set until `resetsAt`; the next-best candidate is returned; the rate-limit entry is written to `.autoclaw/llm/oracle-state.json` so a fresh process started within `resetsAt` reads it back and still excludes the model"
  - given: "ZMLR is reachable and selected a backend, but that backend returns HTTP 429"
    when: "`ZippyMeshProvider.chat()` sees the 429 and the caller invokes `oracle.recordRateLimit(<resolvedModel>, 'zippymesh', <resetsAfterSec>)` then `registry.getPreferred()` is called again"
    then: "the registry treats ZMLR as a ladder rung (not a routing decider) for this task; the next `pick()` returns a non-ZMLR model (OllamaProvider or failsafe) until the 429 expires"
  - given: "a fresh workspace where `autoclaw llm install` has never been run"
    when: "S1 initializes (extension activate, or first `registry.getPreferred()` call)"
    then: "if `qwen3:0.6b` is not on disk and Ollama is installed, S1 runs `ollama pull qwen3:0.6b` and starts a dedicated `:11435` instance (or detects an already-running one); failure to install does NOT block S1 — the oracle just reports `failsafe: null` and the persona loader surfaces the missing failsafe in the fleet panel"
  - given: "the persona loader (Phase A) is configured with preferredProvider 'ollama:llama3.1:8b'"
    when: "the LLM registry replaces the persona loader's provider-stub.ts and `loader.dispatch('architect', { prompt: 'x' })` is called"
    then: "persona dispatch routes through ZMLR when reachable (because `recommend_model` picks it), falls back to OllamaProvider when ZMLR is down, falls back to the oracle ladder when both fail — all existing persona-loader tests still pass"
non_goals:
  - LM Studio standalone adapter — DEFERRED INDEFINITELY (RFC §3.3). Oracle probes :1234 as a ladder rung; no `LmStudioProvider` class.
  - In-process preference scoring engine (`LlmPreferenceCriterion`, per-intent YAML) — DELETED, not deferred. ZMLR's playbooks own this.
  - MCP `llm.chat` / `llm.models` / `llm.health` write-tools in AutoClaw — DELETED. ZMLR's MCP is the canonical surface (see S2).
  - The PR to ZMLR adding `src/app/api/mcp/route.js` — that's S2 work, not S1.
  - `externalRouterUrl` peer server (`src/llm/peer-server.ts`) — S3.
  - `LocalCoderRunner` worked example — S3.
  - Cost-ledger join with the runner cost ledger — S4.
  - `@gozippy/llm-router-client` NPM extract — S4 / waits for the upstream model-oracle host second consumer.
  - Direct cloud adapters (`openai.ts`, `anthropic.ts`, `groq.ts`) — DEFERRED; ZMLR proxies.
  - Streaming responses surfaced via MCP — DEFERRED; no consumer.
---

# LLM provider abstraction — S1 (types + registry + ZippyMesh + Ollama + Oracle)

## Summary

Land the foundation of `src/llm/`: the narrow `LlmProvider` interface, an
OpenAI-compatible base adapter, two concrete adapters
(`ZippyMeshProvider` as primary, `OllamaProvider` as fallback), a
client-side fallback `Oracle` ported from the upstream model-oracle host's
[`model-oracle`](<internal>/model-oracle/SKILL.md)
skill, and a cost ledger aligned with ZICO's `BudgetTracker` schema.

After S1, the persona loader (Phase A) gets a real provider chain:
**ZMLR's `recommend_model` first → direct ZMLR chat → OllamaProvider →
oracle ladder → `qwen3:0.6b@:11435` failsafe**. This is the foundational
slice of [docs/rfc/llm-provider-abstraction.md](../../rfc/llm-provider-abstraction.md);
S2 adds the ZMLR HTTP MCP route + `autoclaw llm install`, S3 adds the
externalRouterUrl peer + LoopServiceAdapter integration, S4 closes the
cost-ledger join and extracts the shared package.

## Read first

- [docs/rfc/llm-provider-abstraction.md](../../rfc/llm-provider-abstraction.md) — full RFC, especially the 2026-05-23 revision note at §0
- [adapters/zippymesh/README.md](../../../adapters/zippymesh/README.md) — ZMLR header contract
- [ZMLR\src\sse\handlers\chat.js](ZMLR\src\sse\handlers\chat.js) — line 131 reads `x-zippy-intent`
- [ZMLR\src\lib\routing\smartRouter.js](ZMLR\src\lib\routing\smartRouter.js) — line 269 reads `x-intent`; lines 53-54 read `x-session-parallel` / `x-session-id`
- [ZMLR\src\mcp\zmlr-server.js](ZMLR\src\mcp\zmlr-server.js) — `recommend_model` handler signature (S1 calls this directly via in-process import as a stopgap until S2's HTTP route lands)
- the upstream model-oracle host `model-oracle.mjs` source — fetch via `scp <internal-host>:model-oracle.mjs ./tmp/` before porting; the SKILL.md alone is not enough for parity
- [src/runners/types.ts](../../../src/runners/types.ts) — match the existing TS contract style (`detect`, `health`, `ErrorClass`, `Capabilities`)
- [src/runners/hermes.ts](../../../src/runners/hermes.ts) — sibling REST-adapter pattern (HTTP client, error class mapping)
- [src/runners/registry.ts](../../../src/runners/registry.ts) — the `RunnerRegistry` pattern this LLM registry mirrors
- [<local-projects>\ZippyAI_IDE_Tools\packages\core\src\orchestration\budget-tracker.ts](<local-projects>\ZippyAI_IDE_Tools\packages\core\src\orchestration\budget-tracker.ts) — the cost-ledger schema we adopt (`provider`, `model`, `operation`, `tokens`, `costCents`, `runId`)
- [docs/specs/persona-loader/spec.md](../persona-loader/spec.md) — your first consumer; its `provider-stub.ts` swaps to the real `LlmProvider`

## Design

### Inputs

1. The user's workspace `.autoclaw/llm/config.yaml` (read-only in S1 — parsing the file is enough; `autoclaw llm install` writes it in S2). Until that file exists, the registry uses sensible env-var defaults (`ZIPPYMESH_HOST=http://127.0.0.1:20128`, `OLLAMA_HOST=http://127.0.0.1:11434`).
2. Ambient process env (`ZIPPYMESH_HOST`, `ZIPPYMESH_TOKEN`, `OLLAMA_HOST`, `AUTOCLAW_LLM_FAILSAFE_HOST` defaulting to `http://127.0.0.1:11435`).
3. A `ChatOptions`-style call from a consumer (persona loader, future MCP tool, future `LocalCoderRunner`).

### Outputs

1. A `chat()` response string with token counts, `servedBy` (which provider actually served), and duration.
2. Health snapshots (`detect()`, `health()`).
3. A model list (`models()`).
4. A row appended to `.autoclaw/llm/cost-ledger.jsonl` per call, schema aligned with ZICO's `BudgetTracker`:
   ```jsonc
   {
     "timestamp": "<iso>",
     "provider": "zippymesh" | "ollama",
     "model": "<resolved>",
     "operation": "chat" | "embed" | "validate",
     "tokens": { "input": 123, "output": 456 },
     "costCents": 0,                // 0 for local; ZMLR-reported when proxying paid
     "runId": "<persona-dispatch-id-or-mcp-call-id>",
     "sessionId": "<from caller>",
     "callerPersonaId": "<optional>",
     "failsafe": false,             // true when oracle's failsafe rung served
     "notes": ""                    // single line, prompt content NEVER logged
   }
   ```
5. Oracle state: rate-limit map (in-memory + `.autoclaw/llm/oracle-state.json` TTL-keyed, **written and read in S1** so long autonomous loops don't re-fire paid 429s across process restarts), last-known endpoint health (memory only).
6. `qwen3:0.6b@:11435` failsafe installed on S1 first run — `ollama pull qwen3:0.6b` then a `:11435` instance (process detection + dedicated start), so the bottom rung is always present without waiting for `autoclaw llm install` (S2).

### Contract — TypeScript surface

```ts
// src/llm/types.ts
export type ProviderId = string;            // "zippymesh" | "ollama"
export type ModelId = string;               // "auto", "llama3.1:70b", "qwen2.5-coder", ...

export interface ProviderCapabilities {
  streaming: boolean;
  toolUse: boolean;
  jsonMode: boolean;
  embeddings: boolean;
  contextWindow?: number;
  /** 'local' (same host), 'lan' (workspace LAN, e.g. ZMLR), 'cloud'. */
  locality: 'local' | 'lan' | 'cloud';
  reportsCost: boolean;
  modelFamilies: string[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatHints {
  /** ZMLR's playbook key. */
  intent?: 'code' | 'review' | 'plan' | 'summarize' | 'chat' | 'debug';
  /** Hard locality constraint. */
  requireLocality?: 'local' | 'lan' | 'cloud';
  /** Set during /mateam fan-out so ZMLR picks distinct backends per agent. */
  sessionParallel?: boolean;
  sessionId?: string;
}

export interface ChatOptions {
  model?: ModelId;                          // default = provider's `defaultModel`
  messages: ChatMessage[];
  prompt?: string;                          // sugar for [{ role:'user', content:prompt }]
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  jsonMode?: boolean;
  hints?: ChatHints;
  /** Used for the cost-ledger row. */
  sessionId?: string;
  runId?: string;
  callerPersonaId?: string;
}

export interface ChatResult {
  ok: boolean;
  response?: string;
  model: ModelId;
  servedBy: ProviderId;                     // differs from request id for ZMLR routes
  tokens?: { input: number; output: number };
  durationMs: number;
  costCents?: number;                       // reported when known (ZMLR paid backends)
  errorClass?: ErrorClass;                  // reuse runner ErrorClass
  errorMessage?: string;
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  detect(): Promise<DetectionResult>;
  models(): Promise<ModelId[]>;
  chat(opts: ChatOptions): Promise<ChatResult>;
  health(): Promise<HealthReport>;
}
```

### OpenAI-compatible base

```ts
// src/llm/openai-compatible.ts
export interface OpenAiCompatibleOptions {
  id: ProviderId;
  baseUrl: string;                          // e.g. "http://127.0.0.1:20128/v1"
  apiKey?: string;
  defaultModel?: string;
  capabilities: ProviderCapabilities;
  modelsPath?: string;                      // default "/v1/models"
  extraHeaders?: Record<string, string>;
  /** Hook subclasses use to inject per-request headers from ChatHints. */
  augmentHeaders?: (opts: ChatOptions) => Record<string, string>;
}
export class OpenAiCompatibleProvider implements LlmProvider { /* … */ }
```

### ZippyMesh subclass (primary)

```ts
// src/llm/zippymesh.ts
export class ZippyMeshProvider extends OpenAiCompatibleProvider {
  constructor(host = process.env.ZIPPYMESH_HOST ?? 'http://127.0.0.1:20128') {
    super({
      id: 'zippymesh',
      baseUrl: `${host}/v1`,
      apiKey: process.env.ZIPPYMESH_TOKEN,  // optional locally
      defaultModel: 'auto',
      capabilities: {
        streaming: true, toolUse: true, jsonMode: true, embeddings: true,
        locality: 'lan', reportsCost: true,
        contextWindow: 200_000,             // pessimistic ceiling
        modelFamilies: ['llama','qwen','claude','gpt','gemini','groq-llama'],
      },
      extraHeaders: { 'X-Client': 'autoclaw' },
      augmentHeaders: (opts) => {
        const h: Record<string, string> = {};
        if (opts.hints?.intent) {
          h['x-intent'] = opts.hints.intent;        // canonical (smartRouter.js:269)
          h['x-zippy-intent'] = opts.hints.intent;  // legacy (chat.js:131)
        }
        if (opts.hints?.sessionParallel) {
          h['x-session-parallel'] = 'true';
          if (opts.hints.sessionId) h['x-session-id'] = opts.hints.sessionId;
        }
        return h;
      },
    });
  }

  /**
   * Call ZMLR's recommend_model handler. In S1, this imports
   * `src/mcp/zmlr-server.js` in-process when ZMLR is in the workspace
   * tree (stopgap). S2 switches to the HTTP MCP route at :20128/mcp.
   */
  async recommendModel(intent: string, constraints?: {
    maxLatencyMs?: number;
    minContextWindow?: number;
    preferFree?: boolean;
    preferLocal?: boolean;
  }): Promise<{ model: string; fallbackChain: string[] } | null>;
}
```

### Ollama subclass (fallback)

```ts
// src/llm/ollama.ts
export class OllamaProvider extends OpenAiCompatibleProvider {
  constructor(host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434') {
    super({
      id: 'ollama',
      baseUrl: `${host}/v1`,
      capabilities: {
        streaming: true, toolUse: true, jsonMode: true, embeddings: true,
        locality: 'local', reportsCost: false,
        contextWindow: 8192,                // refined per-model via /api/show
        modelFamilies: [],                  // populated by models()
      },
      modelsPath: '/api/tags',              // native path; OpenAI route omits modified_at
    });
  }
  /** Map Ollama's /api/tags response to ModelId[]; cache capabilities. */
  async models(): Promise<ModelId[]>;
  /** Probe /api/show on first models() call; cache `capabilities.tools` per model. */
  protected probeModelCapabilities(modelId: string): Promise<void>;
}
```

### Oracle (the fallback ladder)

See RFC §5a for the full type surface. Spec-level requirements:

- **Port from** the upstream model-oracle host's [`~/.openclaw/scripts/model-oracle.mjs`](<internal>/model-oracle.mjs) — fetch the live source before writing; SKILL.md is the *interface*, the mjs is the *behavior*.
- **Endpoint probes** in `refresh()`: `zippymesh@:20128`, `ollama-local@:11434`, `lmstudio-local@:1234`, `ollama-failsafe@:11435`. Skip any that don't respond within 2 s.
- **Scoring** per task type (`agent`/`tool`/`thinking`/`fast`/`vision`/`free`) matches the SKILL.md ladder behavior — agents prefer tool-use + thinking; fast prefers smallest; free filters to local-only.
- **Validation:** every `pick()`-returned model is validated with a `chat({ prompt: '_ping_', maxTokens: 4, timeoutMs: 5_000 })` before being handed to the caller. If validation fails, oracle records the failure and recurses to the next candidate.
- **Failsafe contract:** `qwen3:0.6b@:11435` is *always* the last rung. If it's missing, `pick()` returns `{ recommended: null, failsafe: true, alternatives: [] }` and AutoClaw's persona loader surfaces a user-facing notice.

### Registry

```ts
// src/llm/registry.ts
export class LlmRegistry {
  constructor(workspaceRoot: string, oracle: Oracle);
  register(provider: LlmProvider): void;
  detect(): Promise<{ id: ProviderId; detection: DetectionResult }[]>;
  get(id: ProviderId): LlmProvider | undefined;

  /** Resolve a ProviderRef like "ollama:llama3.1:70b" to a (provider, model) pair. */
  resolve(ref: string): { provider: LlmProvider; model: ModelId } | undefined;

  /**
   * Pick a provider per RFC §5 algorithm:
   *   1. explicit? return it.
   *   2. ZMLR healthy AND has no fresh rate-limit on its previously-picked model?
   *      call its recommend_model; return ZippyMeshProvider pinned to the result.
   *      (ZMLR-side 429s recorded via `oracle.recordRateLimit(..., 'zippymesh', ttl)`
   *      cause this step to skip until the TTL expires — ZMLR becomes a rung,
   *      not a router, while the upstream cools off.)
   *   3. otherwise: oracle.pick() → return the recommended provider pinned to
   *      oracle's recommendation. The ladder considers ZMLR as a rung
   *      (with its rate-limit posture honored), then OllamaProvider, then
   *      the qwen3:0.6b@:11435 failsafe.
   */
  getPreferred(opts: {
    explicitProviderId?: ProviderId;
    hints?: ChatHints;
    task?: OracleTask;                  // when caller knows the task class
  }): Promise<{ provider: LlmProvider; model: ModelId; failsafe: boolean } | null>;
}
```

Oracle's `refresh()` enumerates ZMLR as one endpoint among `ollama-local`,
`lmstudio-local`, and `ollama-failsafe`. A `pick()` decision can land
on ZMLR when the registry's step 2 was skipped due to a recorded 429 —
the ladder picks the next non-rate-limited rung that satisfies the task.

The persona loader's `resolveProvider()` from Phase A is rewritten to
call `LlmRegistry.getPreferred()`. Tests for the loader's fallback path
keep passing (the `inline override hook` test that already exists works
unchanged — it replaces the registry, not the contract).

### File layout

```
src/llm/
  types.ts                # interfaces + ProviderRef parsing
  openai-compatible.ts    # base class
  zippymesh.ts            # ZMLR primary + recommendModel()
  ollama.ts               # Ollama fallback + capability probe
  oracle.ts               # TS port of model-oracle.mjs
  registry.ts             # LlmRegistry with getPreferred() algorithm
  costLedger.ts           # appends ZICO-shaped rows
  index.ts                # barrel
src/test/
  llm-types.test.ts       # ProviderRef parsing / capabilities defaults
  llm-zippymesh.test.ts   # mocked HTTP; header thread-through; recommendModel stub
  llm-ollama.test.ts      # mocked HTTP + detect/models/chat/health
  llm-oracle.test.ts      # ladder behavior, rate-limit map, failsafe path
  llm-registry.test.ts    # getPreferred() three branches + persona-loader rewire
  llm-cost-ledger.test.ts # ZICO schema fidelity
```

No new deps. Node 18+ global `fetch`. Tests use a tiny in-memory HTTP
responder (same pattern as `src/test/cloudRelay.test.ts`).

## Acceptance criteria (expanded)

1. **ZMLR detected when running.**
   *Given* ZMLR is up on `127.0.0.1:20128` (mocked in test with `/v1/models` returning a non-empty list).
   *When* `registry.detect()` runs.
   *Then* the result includes `{ id: 'zippymesh' → { found: true, endpoint: 'http://127.0.0.1:20128', version: '<x>' } }` and `registry.get('zippymesh')` returns the live adapter.

2. **Round-trip chat through ZMLR with intent threading.**
   *Given* the `ZippyMeshProvider` is registered and `/v1/chat/completions` is mocked.
   *When* `provider.chat({ model: 'auto', prompt: 'reply OK', hints: { intent: 'chat' }, sessionId: 's-1', runId: 'r-1' })` is called with `timeoutMs: 30000`.
   *Then* the request carries **both** `x-intent: chat` and `x-zippy-intent: chat` headers, the response is `{ ok: true, response: contains 'OK', servedBy: 'zippymesh', tokens.input > 0, tokens.output > 0, durationMs < 30000 }`, and a row is appended to `.autoclaw/llm/cost-ledger.jsonl` with `{ provider:'zippymesh', operation:'chat', sessionId:'s-1', runId:'r-1' }`.

3. **Oracle ladder takes over when ZMLR is unreachable.**
   *Given* nothing on port 20128 and a mocked Ollama on 11434 with `llama3.1:8b` available.
   *When* `registry.getPreferred({ hints: { intent: 'chat' } })` runs.
   *Then* the result is `{ provider: OllamaProvider, model: 'llama3.1:8b', failsafe: false }` and a single warning is logged that ZMLR was unreachable; no exception escapes.

4. **Failsafe path.**
   *Given* nothing on 20128, nothing on 11434, but a mocked `qwen3:0.6b` on 11435.
   *When* `oracle.pick('agent')` runs.
   *Then* the result is `{ recommended: { id:'qwen3:0.6b', endpointId:'ollama-failsafe' }, failsafe: true }`; the persona loader surfaces a user-facing notice via the existing `(using fallback provider: …)` hook.

5. **Rate-limit exclusion.**
   *Given* Ollama is up; `OllamaProvider.chat` returned 429 once.
   *When* the caller invokes `oracle.recordRateLimit('llama3.1:70b', 'ollama-local', 3600)` and then `oracle.pick('agent')`.
   *Then* `llama3.1:70b` is absent from `decision.recommended` and `decision.alternatives` until `now() + 3600s`; the next-best candidate is returned.

6. **Persona loader integration (cross-spec, Phase A regression).**
   *Given* the persona loader from [persona-loader/spec.md](../persona-loader/spec.md) is installed and its `resolveProvider()` is rewired to call `LlmRegistry.getPreferred()`.
   *When* a test invokes `loader.dispatch('architect', { prompt: '…' })` with ZMLR mocked up, then with ZMLR mocked down + Ollama up, then with both down + failsafe up.
   *Then* dispatch routes through ZMLR / Ollama / failsafe respectively; all 12 existing persona-loader tests keep passing; the `(using fallback provider: …)` notice fires correctly in cases 2 and 3.

7. **Compile + adapters:check stay green.**
   *Given* the S1 files land.
   *When* `npm run compile && npm run adapters:check && npm run test:unit` are run.
   *Then* all three pass; existing 625+ tests keep passing; the new test files add ≥ 18 cases.

## Sequencing

| Step | Deliverable | Owner | Exit gate |
|---|---|---|---|
| 1 | `src/llm/types.ts` + `llm-types.test.ts` | llm-impl | ≥ 4 cases pass (ProviderRef parsing, ChatHints defaults, capability merge) |
| 2 | `src/llm/openai-compatible.ts` (the base) | same | unit-test with a stubbed `fetch` covers `chat`, `models`, error mapping |
| 3 | `src/llm/zippymesh.ts` + `llm-zippymesh.test.ts` | same | header thread-through verified (BOTH `x-intent` and `x-zippy-intent`); `augmentHeaders()` covered |
| 4 | `src/llm/ollama.ts` + `llm-ollama.test.ts` | same | mocked-responder test passes; `/api/tags` mapping correct; capability probe lazy |
| 5 | Fetch the upstream model-oracle host `model-oracle.mjs` source via scp; port to `src/llm/oracle.ts` + `llm-oracle.test.ts` | same | ladder behavior matches the source script's `best`/`validate`/`refresh`/`rate-limit` commands; failsafe path exercised |
| 6 | `src/llm/costLedger.ts` + `llm-cost-ledger.test.ts` (ZICO-aligned schema) | same | row format matches `BudgetTracker`'s field names; `costCents` not `costUsd`; no prompt/response content in the row |
| 7 | `src/llm/registry.ts` + `llm-registry.test.ts` (incl. ZMLR-as-rung branch on 429) | same | `getPreferred()` covers all 3 algorithm branches + the ZMLR-rate-limited skip-to-oracle branch |
| 8 | `src/llm/failsafe-install.ts` — first-run `ollama pull qwen3:0.6b` + `:11435` start (idempotent; non-blocking on failure) | same | re-running is a no-op; failure logged, not thrown |
| 9 | Persona loader: replace `provider-stub.ts` with the registry | persona-loader-impl (cross-spec) | the persona-loader S1 12 tests still pass; round-trip end-to-end works with ZMLR mocked, with ZMLR down + Ollama up, with both down + failsafe up |

## Open questions

1. **`recommend_model` transport in S1.** ZMLR's MCP route doesn't exist yet (RFC §7). S1's `ZippyMeshProvider.recommendModel()` either: (a) calls the JS handler in-process via `require('zippymesh-router/src/mcp/zmlr-server.js')` when the workspace contains a ZMLR checkout, or (b) is a stub that always returns null (forcing the registry to skip step 2 of the `getPreferred` algorithm and go straight to oracle). Recommend: ship (b) for S1 — it keeps the seam clean. The PR to ZMLR + (a) come in S2.
2. ~~**Failsafe model presence.**~~ **Resolved 2026-05-24** — install at S1 first run (step 8 above), not S2. Non-blocking on failure.
3. ~~**In-memory-only oracle state in S1.**~~ **Resolved 2026-05-24** — persist to `.autoclaw/llm/oracle-state.json` from S1 (acceptance criterion #5). Long autonomous loops must not re-fire paid 429s across restarts.
4. **Failsafe-install opt-out.** Should `S1` ship a setting (`autoclaw.llm.installFailsafe`, default `true`) to skip the `ollama pull qwen3:0.6b` step for users who have a smaller failsafe model in mind or no disk budget? Recommend: yes, but keep default `true` so the ladder works out of the box. Confirm during S1 review.

## Don't-do

- **Don't add an `openai` or `@anthropic-ai/sdk` dep.** Bare `fetch` against the OpenAI-compat surface covers everything.
- **Don't hardcode endpoints in adapter constructors.** Always read env with a documented default; tests inject a fixed `baseUrl`.
- **Don't log prompts or responses** to the cost-ledger or any other log; counts only. The ZICO schema permits `costCents` and `tokens` but no payload. Same posture as the cloud-relay D-series.
- **Don't share state between adapters.** Each adapter owns its own HTTP client; the registry holds references; the oracle holds its own state.
- **Don't bake retry into the adapter.** Retry is the *caller's* policy (loader, MCP tool, runner). The oracle handles ladder fallback, but neither it nor the adapters retry an individual `chat()` call.
- **Don't port `smartRouter.js` logic into oracle.ts.** That's ZMLR's job. The oracle is *fallback only* — discovery + validate + rate-limit + failsafe, nothing more. If you find yourself porting playbook scoring, stop.
- **Don't add an LM Studio adapter class.** Oracle probes `:1234` as a ladder rung directly; no `LmStudioProvider`.
- **Don't add MCP `llm.*` write-tools to `src/mcp/writeTools.ts`.** ZMLR's MCP is the canonical surface (RFC §7).
