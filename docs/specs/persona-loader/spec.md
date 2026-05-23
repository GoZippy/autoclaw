---
spec_id: persona-loader
title: Persona loader, `/persona` slash command, and dispatch wiring (Phase A finish)
status: verify
owner: architect
created: 2026-05-23
updated: 2026-05-23
implemented_in: src/personas/{loader,provider-stub,frontmatter,command}.ts
tests_in: src/test/personas-loader.test.ts (12 passing)
supersedes: []
superseded_by: null
references:
  - docs/rfc/specialized-agents.md
  - docs/rfc/llm-provider-abstraction.md
  - docs/V3_1_ROADMAP.md
  - src/personas/types.ts
  - skills/architect/SKILL.md
acceptance:
  - given: "skills/architect/SKILL.md exists with valid frontmatter"
    when: "the user types `/persona architect 'draft a short RFC about X'` in any host's chat panel"
    then: "the loader reads SKILL.md, builds a PersonaProfile, dispatches to the persona's preferred provider (or its fallback), and the architect's response is returned in the chat panel"
  - given: "the preferred provider (ollama:llama3.1:70b) is unreachable"
    when: "the loader attempts dispatch"
    then: "the loader transparently falls back to providerFallback, logs the downgrade once, and the user still gets a response"
  - given: "no SKILL.md exists for the requested persona id"
    when: "the user types `/persona unknown-id 'X'`"
    then: "the loader returns a clear error listing available personas; no dispatch happens"
  - given: "the persona's toolAllowList denies a tool the LLM tries to call"
    when: "dispatch is in flight"
    then: "the call is blocked, a finding_report is written to the shared inbox, and the user is shown the denial"
non_goals:
  - Per-persona long-term memory (`.autoclaw/memory/personas/<id>/`) — that's Phase C.
  - Cross-project memory promotion — Phase C.
  - Subcontract integration (`subcontract_request.payload.brief.persona_id`) — Phase C.
  - Auto-trigger on `task_complete` (doc-writer's auto-fire) — Phase D.
  - VS Code panel UI for "what has the persona learned" — Phase C/D.
---

# Persona loader, `/persona` slash command, and dispatch wiring

## Summary

Make `/persona <id> "<prompt>"` actually work end-to-end. Today `src/personas/types.ts`
defines the `PersonaProfile` contract and `skills/architect/SKILL.md` exists,
but there is no loader, no slash command, and no dispatch path. After this
spec ships, a user can invoke `/persona architect "draft a short RFC about X"`
in chat and the architect persona answers, routed through its preferred LLM
provider with the right trust preset.

This is also the **first pilot** of the spec-as-contract template at
[docs/specs/_template.spec.md](../_template.spec.md). Any pain encountered
writing or implementing against this spec is feedback on the template
itself.

## Read first

An implementer must skim:

- [docs/rfc/specialized-agents.md](../../rfc/specialized-agents.md) §2-4 (PersonaProfile schema, spin-up protocol)
- [docs/rfc/llm-provider-abstraction.md](../../rfc/llm-provider-abstraction.md) §2-4 (LlmProvider contract — *only types needed; full Phase B builds the adapters*)
- [src/personas/types.ts](../../../src/personas/types.ts) — the existing contract
- [skills/architect/SKILL.md](../../../skills/architect/SKILL.md) — the reference SKILL.md to parse
- [src/runners/registry.ts](../../../src/runners/registry.ts) — for the `translateTrust` reuse and the registry-of-things pattern
- [src/mcp/server.ts](../../../src/mcp/server.ts) — for how the existing tools are dispatched

## Design

### Inputs

1. A `skills/<id>/SKILL.md` file with YAML frontmatter conforming to `PersonaProfile`.
2. The user's slash invocation: `/persona <id> "<prompt>"`.
3. The current workspace's available LLM providers (registered later in
   Phase B — for this spec, only a placeholder fallback resolver is needed).
4. The current workspace's `.autoclaw/orchestrator/state.json` (so the
   persona invocation appears in `governance` audit and the cost ledger).

### Outputs

1. A response shown in the host's chat panel.
2. An entry in the per-session `.autoclaw/orchestrator/comms/comms-log.jsonl`
   recording the invocation (persona id, provider used, duration, token
   count, fallback flag).
3. A `finding_report` to `shared/` **only** if the dispatch hit a trust-
   preset denial or a sustained provider failure.
4. No file edits unless the persona itself writes one through its
   `outputArtifacts` allowlist (architect, e.g., may write to `docs/rfc/`
   or `docs/specs/`; this is per-persona policy, not the loader's
   responsibility).

### Contract — TypeScript surface

```ts
// src/personas/loader.ts
export interface LoaderOptions {
  workspaceRoot: string;
  /** Where skill packages live; defaults to `<workspaceRoot>/skills`. */
  skillsRoot?: string;
}

export interface DispatchOptions {
  prompt: string;
  /** Override the persona's preferred provider for this call. */
  providerOverride?: ProviderRef;
  /** When true (default), fall back through providerFallback on failure. */
  allowFallback?: boolean;
  /** Carried into the cost ledger and any finding_report. */
  sessionId: string;
}

export interface DispatchResult {
  ok: boolean;
  response?: string;
  provider: ProviderRef;        // which one actually answered
  fallbackTaken: boolean;
  tokens?: { input: number; output: number };
  durationMs: number;
  errorClass?: ErrorClass;
  errorMessage?: string;
}

export class PersonaLoader {
  constructor(opts: LoaderOptions);
  /** List ids of personas whose SKILL.md is present + parseable. */
  list(): Promise<PersonaId[]>;
  /** Load + cache a persona profile from its SKILL.md frontmatter. */
  load(id: PersonaId): Promise<PersonaProfile>;
  /** Run a persona against a prompt; returns the dispatch result. */
  dispatch(id: PersonaId, opts: DispatchOptions): Promise<DispatchResult>;
}
```

Frontmatter parsing reuses an existing YAML parser if present in the tree,
else `JSON.parse` of a `--- ... ---` block via a tiny hand parser scoped
to the keys in `PersonaProfile`. Do **not** add a new dep for this.

### Slash-command wiring

Register a VS Code chat command `/persona` that:

1. Splits args: `<id> <prompt>` (id is the first word; the rest is the prompt).
2. Validates `id` is in `loader.list()`; if not, lists available ids and
   returns.
3. Calls `loader.dispatch(id, { prompt, sessionId, allowFallback: true })`.
4. Renders `result.response` in the chat panel.
5. On fallback, prepends a one-line notice: `(using fallback provider:
   <id>)`.

For hosts without a slash-command surface (Kilo today), expose the same
behavior as a function `dispatchPersona(id, prompt)` so the existing
bridge can call it.

### Provider resolution

Until Phase B lands the real `src/llm/`, this spec ships a minimal stub:

- `resolveProvider(ref: ProviderRef)` returns an adapter that implements
  a one-method `chat(prompt) → string` interface.
- Built-in stub adapters:
  - `claude-code-runner` — shell out to the parent host's CLI (for
    fallback)
  - `inline` — return a deterministic stub message (for tests only)
- Any `ollama:*` ref returns a "provider not yet available, falling back"
  signal; the loader honors `providerFallback` and continues.

This keeps the loader testable and useful **before** Phase B, and the
swap to real `LlmProvider` instances in Phase B is mechanical.

### Trust enforcement

Before dispatch:

- Resolve the persona's `toolAllowList` / `toolDenyList` against the
  host's tool category names via `translateTrust(runnerId, persona.trust)`
  (already exists in `src/runners/registry.ts`).
- The denied set is passed to the provider adapter; on a denial during
  dispatch, the adapter returns `{ errorClass: 'tool_denied', … }` and
  the loader writes a `finding_report`.

### File layout

```
src/personas/
  types.ts           # exists — no change
  loader.ts          # new — PersonaLoader class
  provider-stub.ts   # new — minimal resolveProvider for pre-Phase-B
  command.ts         # new — VS Code slash-command registration
  index.ts           # update — re-export the new public surface
src/test/
  personas-loader.test.ts  # new — unit tests for list/load/dispatch/fallback
```

`extension.ts` wiring is **out of scope here** — the file is owned by a
peer session. The loader exposes `registerPersonaCommand(context)` that
session can call when it's ready; until then the loader works from the
chat-panel via the existing command registration path the peer uses for
other slash commands.

## Acceptance criteria (expanded)

Each of these must pass before `status: implement → verify`.

1. **Happy path.**
   *Given* a freshly cloned workspace, `npm run compile && npm test` are
   clean, and `skills/architect/SKILL.md` exists with valid frontmatter.
   *When* a test invokes `loader.dispatch('architect', { prompt: 'hi',
   sessionId: 'test-1' })` with the `inline` provider stub.
   *Then* the result is `{ ok: true, provider: 'inline', fallbackTaken:
   true, response: '<stub message>' }`, and the comms-log gains a row
   `{ persona: 'architect', provider: 'inline', fallback_taken: true }`.

2. **Unknown persona.**
   *Given* no `skills/no-such-persona/SKILL.md`.
   *When* `dispatch('no-such-persona', ...)` is called.
   *Then* the result is `{ ok: false, errorClass: 'internal',
   errorMessage: contains 'unknown persona' and lists available ids }`,
   and no row is written to the comms-log.

3. **Tool-denial path.**
   *Given* `skills/architect/SKILL.md` has `toolAllowList: ['read',
   'grep']` (no `write`).
   *When* a provider stub simulates the persona attempting a write tool.
   *Then* the result is `{ ok: false, errorClass: 'tool_denied' }`, and
   exactly one `finding_report` JSON appears under
   `comms/inboxes/shared/` referencing the persona id.

4. **Fallback chain.**
   *Given* a persona whose preferred provider is `ollama:llama3.1:70b`
   (not available in this milestone).
   *When* `dispatch` is called with `allowFallback: true` (default).
   *Then* the loader returns `{ ok: true, provider: <fallback>,
   fallbackTaken: true }`, and the chat panel renders the
   `(using fallback provider: …)` notice.

5. **Slash-command surface.**
   *When* the VS Code chat panel runs `/persona architect "hi"`.
   *Then* the chat panel shows the architect's response and any
   `(using fallback provider: …)` notice; no exception is thrown if the
   architect persona's preferred provider is missing.

## Sequencing

| Step | Deliverable | Owner | Exit gate |
|---|---|---|---|
| 1 | `src/personas/loader.ts` (`list`, `load`) + `personas-loader.test.ts` for those two | persona-loader-impl | `npm test` adds at least 4 cases, passes |
| 2 | `src/personas/provider-stub.ts` + `resolveProvider('inline' \| 'claude-code-runner' \| 'ollama:*')` | same | tests for stub provider + fallback ordering |
| 3 | `loader.dispatch()` + trust-translate wiring | same | tests for happy path, unknown id, tool denial, fallback |
| 4 | `src/personas/command.ts` + `registerPersonaCommand(context)` export | same | exported function; **does not edit extension.ts** |
| 5 | Comms-log writes (persona invocation row) | same | 1 test asserting the row appears |
| 6 | Architect uses this loader to draft `docs/specs/llm-provider-s1/spec.md` (cross-pilot) | architect persona | spec lands at `status: draft`, no manual editing of the loader's output |

## Non-goals (also in frontmatter — repeated for emphasis)

- Persistent persona memory (Phase C).
- Real Ollama / ZippyMesh dispatch (Phase B).
- Auto-trigger of personas from `task_complete` (Phase D).
- Cross-project memory promotion (Phase C).
- A "Personas" tab in the Fleet panel (Phase C/D).

## Open questions

1. **Frontmatter parser.** Reuse VoidSpec's hand parser (`src/voidspec/sync.ts`)
   or pull a real YAML lib? Recommend: hand parser scoped to the
   `PersonaProfile` keys; revisit when Phase C needs richer schemas.
2. **Slash-command across hosts.** Different hosts have different
   slash-command APIs. The loader exports `registerPersonaCommand(context)`
   that owns the VS Code path; Kilo/Cursor/etc bind via the bridge or a
   plain function call. Acceptable for v3.1, but plan a unified
   registration surface for v3.2.
3. **Concurrent invocations.** If two `/persona architect "X"` calls
   land within seconds, do they share a session, queue, or run in
   parallel? Recommend: independent dispatch each (the persona itself is
   stateless without Phase C memory).

## Don't-do

- **Don't add a YAML or markdown-parser dependency** for the loader.
  The existing tree has scoped parsers; reuse one. ([cross-project survey
  §4 anti-pattern #9](../../research/2026-05-22-cross-project-survey.md).)
- **Don't put persona prompts in TypeScript string literals.** Every
  persona's mission text lives in `SKILL.md`, parsed at load time.
- **Don't write to `extension.ts`** — concurrent session owns it.
  Expose `registerPersonaCommand(context)` and document the
  one-line `activate()` addition.
- **Don't bake provider URLs/endpoints into the loader.** Provider
  resolution lives in `src/personas/provider-stub.ts` now and
  `src/llm/registry.ts` in Phase B.
