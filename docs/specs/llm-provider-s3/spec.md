---
spec_id: llm-provider-s3
title: Phase B S3 — externalRouterUrl peer + LoopServiceAdapter optional provider + LocalCoderRunner
status: draft
owner: architect
created: 2026-06-13
updated: 2026-06-13
supersedes: []
superseded_by: null
references:
  - docs/rfc/llm-provider-abstraction.md
  - docs/specs/llm-provider-s1/spec.md
  - docs/specs/llm-provider-s2-autoclaw-side/spec.md
  - src/llm/registry.ts
  - src/runners/loop-service-adapter.ts
acceptance:
  - given: "AutoClaw's peer server is started on 127.0.0.1:20129"
    when: "a client POSTs `{ model: 'auto', intent: 'code', hasImage: false, estimatedTokens: 800, clientId: null }` to /llm/peer/route"
    then: "the response is `{ suggestedModelIds: [...] }` (possibly empty) within 200 ms, with 200 status and Content-Type: application/json"
  - given: "the peer server is running with autoclaw.llm.peerEnabled: false"
    when: "the extension activates"
    then: "the server does NOT bind a port; no resource is held"
  - given: "the peer server receives a body exceeding 10 KB"
    when: "the request is handled"
    then: "it responds 413 (or short-circuits with `{ suggestedModelIds: [] }`) without buffering the rest of the body"
  - given: "the peer server is bound to a port and stop() is called"
    when: "stop() resolves"
    then: "the port is released; subsequent listen() on the same port succeeds"
  - given: "a LoopServiceAdapter built with `provider: anLlmProvider`"
    when: "a subclass calls `this.provider` from its dispatch flow"
    then: "the provider is the same instance passed in; no behavior change for adapters that ignore the field"
  - given: "a LocalCoderRunner constructed with the Ollama provider and a tiny loop-service stub"
    when: "dispatch({ prompt: 'count to 3' }) is called"
    then: "provider.chat is invoked once with a planning system prompt; the resulting plan is included in the dispatch body submitted to the loop service; the dispatch result is forwarded back"
non_goals:
  - Switching the peer server on by default (defer until field latency is measured per RFC §8 open question 5).
  - Wiring AutoClaw to publish the peer URL into ZMLR's `settings.externalRouterUrl` (manual config for now).
  - Streaming, WebSocket, or push semantics on the peer server.
  - Token-budget enforcement on LocalCoderRunner (handled by the loop service / persona scope).
  - Removing LM Studio adapter (still deferred per RFC §3.3).
---

# Phase B S3 — peer-server + LoopServiceAdapter provider + LocalCoderRunner

## Summary

Three deliverables on top of S2 — all RFC §4 and §6a items that close the
ZMLR↔AutoClaw feedback loop and demonstrate the "thin runner + local
LLM" pattern.

1. **`src/llm/peer-server.ts`** — a loopback-only HTTP handler that
   responds to ZMLR's `externalRouterUrl` POST. Reads the persona +
   sprint context AutoClaw already holds, returns a `suggestedModelIds`
   array ZMLR uses to reorder its candidate list. Off by default; opt-in
   via `autoclaw.llm.peerEnabled`. Hard ≤200 ms budget; never throws.

2. **Optional `provider?: LlmProvider` on `LoopServiceAdapter`** — purely
   additive. Existing adapters keep their dispatch unchanged. Subclasses
   that want a local LLM for pre-/post-dispatch helpers can opt in.

3. **`src/runners/local-coder.ts` (`LocalCoderRunner`)** — extends
   `LoopServiceAdapter`. Overrides the dispatch body construction to
   ask its provider for a numbered plan before submitting the prompt.
   Worked example of RFC §4. Used by users who want an agentic loop
   running entirely on local Ollama with no cloud runner.

## Read first

- [docs/rfc/llm-provider-abstraction.md](../../rfc/llm-provider-abstraction.md) §4 (runners and providers), §6a (peer wiring), §8 (open question 5)
- [docs/specs/llm-provider-s2-autoclaw-side/spec.md](../llm-provider-s2-autoclaw-side/spec.md) — what the registry already provides
- [src/runners/loop-service-adapter.ts](../../../src/runners/loop-service-adapter.ts) — the base we extend
- [src/llm/registry.ts](../../../src/llm/registry.ts) — `LlmRegistry.getPreferred()` powers the peer suggestion

## Design

### `src/llm/peer-server.ts`

```ts
export interface PeerServerOptions {
  /** Port to bind. Default 20129. */
  port?: number;
  /** Bind host. Default 127.0.0.1 — loopback only. */
  host?: string;
  /** Hard per-request budget. Default 200 ms. */
  budgetMs?: number;
  /** Hard body cap matching ZMLR's contract. Default 10 * 1024. */
  bodyCapBytes?: number;
  /** Source of suggestions. Required. */
  suggest: (req: PeerRouteRequest) => Promise<PeerRouteResponse> | PeerRouteResponse;
}

export interface PeerRouteRequest {
  model: string;
  intent: string | null;
  hasImage: boolean;
  estimatedTokens: number;
  clientId: string | null;
}

export interface PeerRouteResponse {
  /** ZMLR-shaped 'provider/model' strings, in preferred order. */
  suggestedModelIds: string[];
}

export class PeerServer {
  constructor(opts: PeerServerOptions);
  start(): Promise<void>;   // resolves when listening
  stop(): Promise<void>;    // resolves when closed
  url(): string;            // http://host:port/llm/peer/route
}
```

**Routing:** POST `/llm/peer/route` only. Anything else → 404. Method
mismatch → 405.

**Performance posture:** the `suggest` callback MUST stay synchronous-fast
or use cached state. Any path that hits disk, IPC, or the network blows
the budget. The default `suggest` reads only in-memory state (active
persona id, recent dispatch history, last `LlmRegistry.getPreferred()`
result).

**Body cap:** the request body is read with a streaming limit; once the
cap is exceeded the server short-circuits to
`{ suggestedModelIds: [] }` so ZMLR continues without us (per the
RFC §6a "non-fatal on failure" contract).

**Loopback only:** binds 127.0.0.1; not configurable to bind 0.0.0.0
(the protocol is ZMLR↔AutoClaw on one host).

### Optional `provider?` on `LoopServiceAdapter`

Smallest possible change:

```ts
// LoopServiceConfig — additive optional field
export interface LoopServiceConfig {
  // ...existing fields...
  /** Optional LLM provider for pre-/post-dispatch chat helpers. */
  provider?: LlmProvider;
}

// LoopServiceAdapter — store as protected, no behavior change.
export class LoopServiceAdapter implements Runner {
  protected readonly provider?: LlmProvider;

  constructor(config: LoopServiceConfig) {
    // ...existing assignments...
    this.provider = config.provider;
  }
}
```

No method body changes in the base class. No existing test changes.

### `LocalCoderRunner`

```ts
export class LocalCoderRunner extends LoopServiceAdapter {
  constructor(config: LoopServiceConfig) {
    super(config);
    if (!this.provider) {
      // We could throw, but a missing provider is recoverable: the
      // subclass simply forwards the prompt as-is, which is the base
      // adapter's behavior. Log once and continue.
    }
  }

  /** Override the dispatch body to inject a plan preamble. */
  protected async buildDispatchBody(opts: DispatchOptions): Promise<Record<string, unknown>> {
    const base = await super.buildDispatchBody(opts);
    if (!this.provider) return base;
    try {
      const plan = await this.provider.chat({
        prompt: opts.prompt,
        messages: [
          { role: 'system', content: 'Break the user task into 3-5 numbered steps. Output the list and nothing else.' },
          { role: 'user', content: opts.prompt },
        ],
        hints: { intent: 'plan', requireLocality: 'local' },
        timeoutMs: 20_000,
        sessionId: opts.sessionId,
      });
      if (plan.ok && plan.response) {
        return { ...base, preamble: plan.response };
      }
    } catch {
      // Best-effort. Plan failure must not block the dispatch.
    }
    return base;
  }
}
```

`buildDispatchBody` doesn't exist on the base `LoopServiceAdapter` yet —
we add a protected `buildDispatchBody(opts): Promise<Record<string, unknown>>`
to the base (returns the existing body shape verbatim) and call it from
the existing `dispatch()` method. That's the one base-class touch that's
genuinely needed; it has no behavior change for existing adapters because
the default impl returns the same body the existing code constructs.

### File layout

```
src/llm/
  peer-server.ts          # new — PeerServer class
  index.ts                # MODIFIED — re-export PeerServer + types
src/runners/
  loop-service-adapter.ts # MODIFIED — add optional provider + buildDispatchBody hook
  local-coder.ts          # new — LocalCoderRunner
  index.ts                # MODIFIED — re-export LocalCoderRunner
src/test/
  llm-peer-server.test.ts # new — start/stop, request shape, body cap, budget
  runner-local-coder.test.ts # new — plan injection, missing provider fallback, dispatch passthrough
  runner-loop-service.test.ts # MODIFIED — one new case verifying provider field round-trip + buildDispatchBody is called
```

## Acceptance criteria (expanded)

1. **Peer server happy path.** Start a PeerServer with a stub `suggest`
   that returns `['ollama/llama3.1:8b']`. POST a well-formed request.
   Receive 200 + the matching response body within 200 ms.

2. **Peer server off-switch.** With `autoclaw.llm.peerEnabled: false`,
   the extension `activate()` does NOT instantiate or start a
   `PeerServer`. Port 20129 is free.

3. **Peer server body cap.** Send a 12 KB body. Server short-circuits to
   `{ suggestedModelIds: [] }` (or 413) without reading the rest.

4. **Peer server clean shutdown.** start() → stop() releases the port;
   a second start() on the same port succeeds.

5. **LoopServiceAdapter `provider` round-trip.** Construct with
   `{ provider }`; assert `adapter.providerForTest()` returns the same
   instance. Behavior of `detect`/`dispatch`/`health` is unchanged in a
   parity test.

6. **LocalCoderRunner — plan preamble injected.** Mock provider returns
   "1. Do x\n2. Do y". Mock loop-service captures the dispatch body.
   `dispatch({ prompt: 'count to 3' })` causes the loop-service body to
   include `preamble: '1. Do x\n2. Do y'`.

7. **LocalCoderRunner — no provider, no preamble.** Construct without
   `provider`. Dispatch body is whatever the base adapter would have
   sent. Test confirms the body has no `preamble` key.

8. **LocalCoderRunner — plan failure non-fatal.** Mock provider throws.
   Dispatch still succeeds; preamble is absent.

## Sequencing

| Step | Deliverable | Owner | Exit gate |
|---|---|---|---|
| 1 | Spec → review | architect | this file `status: review` |
| 2 | `src/llm/peer-server.ts` + `llm-peer-server.test.ts` (4 cases) | llm-impl | 4 cases pass |
| 3 | `loop-service-adapter.ts`: add `provider?` + `buildDispatchBody()` hook (no behavior change) + one new test case | runner-impl | existing 60+ tests stay green; the new provider round-trip case passes |
| 4 | `src/runners/local-coder.ts` + `runner-local-coder.test.ts` (4 cases) | runner-impl | 4 cases pass |
| 5 | `src/llm/index.ts` + `src/runners/index.ts` exports | llm-impl | compile clean; adapter:check green |

## Open questions

1. **Should the peer server log when ZMLR pings it?** Recommend: no log
   line per request (volume); a periodic counter on the fleet panel
   would be better. S4.
2. **When the registry has no opinion** (e.g. unknown intent), what
   should `suggest()` return? Recommend: `{ suggestedModelIds: [] }` —
   ZMLR treats empty as "no peer opinion, continue with default order".
3. **`buildDispatchBody` API stability.** Adding a protected hook to a
   base class is a minor API expansion. Existing subclasses that
   override `dispatch` aren't affected (the hook only runs from the
   base `dispatch`). Confirm in S3 review.

## Don't-do

- **Don't bind 0.0.0.0.** Loopback only. The peer protocol is a same-host
  AutoClaw↔ZMLR concern.
- **Don't add auth to /llm/peer/route.** Loopback posture matches ZMLR's
  routes; if either side later adds auth, both sides do it in the same
  release.
- **Don't make the suggest() callback async unless needed.** A 200 ms
  budget burns fast if you await anything. Default impl is sync.
- **Don't introduce a queue or persistence.** The peer is stateless;
  ZMLR keeps its own state.
- **Don't auto-write `settings.externalRouterUrl` into ZMLR.** That's a
  manual step until field latency is measured (RFC §8 q5).
- **Don't change `dispatch()` body construction in existing
  subclasses.** The `buildDispatchBody` hook returns the same payload
  the existing code builds; subclasses that override `dispatch` keep
  working unchanged.
