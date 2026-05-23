# Specialized Agent Personas — RFC

_Status: draft, 2026-05-22. Author: Claude Code subagent dispatched from the
v3 design wave. Companion RFC: [llm-provider-abstraction.md](./llm-provider-abstraction.md) (provider field on `PersonaProfile`)._

## 0. Why this RFC

Today AutoClaw has two coordination primitives and no notion of *who* is on
the team. `/sprint` (née `orchestrate`) hands tasks to **hosts**
(`claude-code`, `kilocode`, `cursor`, …) — that is, to *which LLM CLI
happens to be running* — and `/team` (née `mateam`) fans a single task out
into four generic roles (Researcher → Coder → Reviewer → Verifier) that
exist only for the lifetime of that task. There is no architect that
remembers a project's decisions across sprints, no security auditor that
keeps a list of patterns it has flagged before, no doc-writer with house
style learned over time.

This RFC defines **personas**: long-lived, project-aware specialist roles
that the orchestrator instantiates on top of the existing host runners and
the bi-temporal memory model. A persona is **not** a new host, **not** a
new transport, and **not** a replacement for `/team`'s in-task pipeline.
A persona is a *named identity, mission, tool budget, exemplar set, and
memory namespace* that any runner can adopt for a dispatch.

Assumption (mark): personas are a *layer over* `agent_id`, not a
replacement. The bus contract in `AGENT_SESSION_PROTOCOL.md` is unchanged.
A dispatch is `runner = claude-code, persona = architect, session_id =
<uuid>`; on the bus it still presents as `agent_id = claude-code` with a
new optional `persona_id` field on heartbeats and messages.

---

## 1. Roster

Fourteen personas. The roster is opinionated and finite: there is no
"persona factory" UI in 3.0 — adding a persona is a code change, because
their tool allowlists and trust presets are security-relevant. Open
questions §8 covers user-defined personas later.

| # | Persona | Mission (1 line) | When orchestrator invokes | Tool allowlist / trust preset | Typical handoff partner | Typical artifact |
|---|---|---|---|---|---|---|
| 1 | **architect** | Own system shape: module boundaries, data flow, public APIs, RFCs. | Project bootstrap; before any sprint that adds a new module or surface; before a refactor touching ≥3 modules. | Read + grep + write to `docs/rfc/`, `docs/adr/`, `*.md`. **No code edits.** Trust `auto`. | doc-writer (publishes), refactor-specialist (executes). | `docs/rfc/<topic>.md`, `docs/adr/NNNN-<slug>.md`, a module-graph diagram. |
| 2 | **debug-specialist** | Reproduce, localize, and minimally fix a bug from a failing test, stack trace, or repro. | A `finding_report` with `kind: "bug"`; a `task_assign` whose brief contains a stack trace; CI red on `main`. | Read + grep + run tests + write to the suspect file + write to `test/`. Trust `auto`; `turbo` only inside a worktree. | test-author (locks in repro), code-reviewer (verifies fix scope). | Minimal patch + new regression test + 1-paragraph root-cause note in the PR body. |
| 3 | **security-auditor** | Find injection, auth, secret-handling, supply-chain, and unsafe-deserialization risks. Block-merge on critical findings. | After every `task_complete` whose diff touches `auth*`, `crypto*`, `mcp*`, env handling, network I/O; on every release branch. | Read + grep + run linters/scanners + write to `docs/security/findings/`. **No code edits.** Trust `off` for any tool that can exfiltrate (network); `auto` for read tools. | code-reviewer (joint sign-off), supply-chain-auditor (lockfile siblings). | A `finding_report` per issue with severity + CWE + minimal repro + suggested fix. |
| 4 | **usability-auditor** | Audit the *human-facing* surface: command UX, error messages, onboarding flows, defaults, toast copy. | Sprints that change a slash command, a status-bar string, a doctor output, or a settings key. | Read + grep + headless run of the extension's quick-start script + write to `docs/ux/`. Trust `auto`. | doc-writer, code-reviewer. | A `finding_report` of confusing copy / surprising defaults with rewrite suggestions; an `exemplar.md` of accepted before/after pairs. |
| 5 | **doc-writer** | Keep public docs (`README`, `docs/*`, slash-command help, `SKILL.md`) accurate and tight. | After a `task_complete` whose diff touches a public API, CLI flag, or default; on rename PRs; on release. | Read + grep + write to `docs/**`, `README.md`, `skills/*/SKILL.md`. **No code edits.** Trust `auto`. | architect (publishes the RFC), code-reviewer. | A doc patch + a `bibliography.md` entry citing the source of every claim. |
| 6 | **code-reviewer** | Read a diff like a senior reviewer: logic, edge cases, style fit, test coverage. Vote on consensus. | Every `review_request` addressed to it; every `task_complete` requiring quorum approval. | Read + grep + run tests. **No edits.** Trust `auto`. | architect (defers on shape questions), security-auditor (defers on security). | A `review_response` with `approve` / `request_changes` / `reject` and inline notes; a vote file in `consensus/active/`. |
| 7 | **refactor-specialist** | Behaviour-preserving restructuring: rename, extract, inline, move, dedupe. | An accepted architect proposal; a code-reviewer flag of duplication or excessive surface; a `// AI:refactor` spider hit. | Read + grep + write across the in-scope files + run tests. Trust `auto`; `turbo` only inside a worktree branch. | test-author (locks behaviour first), code-reviewer (verifies no semantic drift). | A diff with a "behaviour matrix" note: what's preserved, what's renamed, what's gone. |
| 8 | **test-author** | Write tests *first* for an under-tested area: unit, integration, golden, mutation. | A coverage gap raised in watch mode; a debug-specialist flagging an untested path; before any refactor-specialist touch. | Read + grep + write to `test/**`, `__tests__/**`, `*.test.ts`. **No source edits.** Trust `auto`. | refactor-specialist, debug-specialist. | New test files + a `verify.md` line: "N new tests, all red before / all green after." |
| 9 | **performance-analyst** | Profile, measure, propose. Numbers, not feelings. | A `// AI:perf` spider hit; a regression flagged in CI timing; before a release touched hot paths. | Read + grep + run benchmarks/profilers + write to `docs/perf/`. **No source edits.** Trust `auto`. | architect (shape changes), refactor-specialist (executes the change). | A bench diff + before/after numbers + a fix proposal (handed to refactor-specialist). |
| 10 | **creative / ideator** | Generate *more* options for a problem with the architect or product owner. Cheap brainstorming, not commitment. | When the orchestrator detects a task is *exploratory* (brief contains "explore", "options", "spike", "alternatives"); when an RFC has fewer than 3 considered alternatives. | Read + grep + write to `docs/explore/`. **No code edits.** Trust `auto`. | architect (selects), doc-writer (preserves the selected path). | A `docs/explore/<topic>.md` with ≥3 numbered options, each with pros/cons and a "kill criterion". |
| 11 | **devops** | CI, release scripts, npm publish wiring, lint/format toolchain, GitHub Actions, packaging matrix. | Tasks touching `.github/workflows/`, `package.json` scripts, `release-please`, `npm publish`, `vsce package`. | Read + grep + write to `.github/**`, `scripts/**`, `package.json` (with explicit allowlist), CI YAML. Trust `auto`; `off` for any tool that prints secrets. | supply-chain-auditor (sibling on lockfile changes), code-reviewer. | A CI yaml patch + a doctor-section update describing the new step. |
| 12 | **supply-chain-auditor** | New dependency risk: license, maintainer count, last-publish age, transitive blast radius, `postinstall` scripts. | Any `task_complete` whose diff modifies `package-lock.json`, `pnpm-lock.yaml`, `requirements.txt`, `Cargo.lock`. | Read + grep + offline lockfile inspection. **No edits.** Trust `off` for network tools (so it cannot be tricked into pulling a poisoned package). | security-auditor (joint sign-off on critical), devops. | A `finding_report` per added/upgraded dep with risk score; unanimous-vote block on any `postinstall` script or sub-1-week-old package. |
| 13 | **migration-shepherd** | Plan and execute renames, version bumps, deprecation aliases, doctor migration sections. _(Marked as bonus #13 — fits AutoClaw's recurring rename pattern.)_ | A breaking-API change; a directory rename (`.autoclaw/kdream/` → `.autoclaw/dream/`); a slash-command rename. | Read + grep + write across the project (scoped to changed paths only) + run migration scripts. Trust `auto`. | architect, doc-writer, devops. | A migration script + alias shims + doctor section + `CHANGELOG.md` entry. |
| 14 | **release-captain** | Drive a release end-to-end: changelog, version bump, publish, smoke, registry verification. _(Marked as bonus #14 — AutoClaw publishes to two registries today.)_ | A `task_assign` of type `release`; cron-triggered weekly cut; manual `/sprint release`. | Read + write to `CHANGELOG.md`, `package.json` version field, run `npm publish` (gated). Trust `auto`; `npm publish` requires explicit human approval even at `turbo`. | devops, doc-writer, security-auditor (last-look). | A tag, two registry publish receipts (VS Code Marketplace + Open VSX), a `published.md` postmortem section. |

**Hard constraint on the allowlist column:** "No code edits" means the
persona's `pathScope` excludes `src/**`. The orchestrator enforces this via
the existing scope-violation audit (`runners/types.ts` `ScopeDeclaration`).
Reviewers that need to edit must escalate via a `subcontract_request` to
refactor-specialist or debug-specialist.

---

## 2. Persona schema

A persona is data, not code. The TS interface below is the on-disk shape
of `skills/<persona>/persona.json` (and the in-memory shape the
orchestrator and `/team` load).

```ts
// src/personas/types.ts (proposed location, NOT in scope for this RFC)

import type { ScopeDeclaration, TrustPreset } from '../runners/types';
// ProviderSelector is defined in docs/rfc/llm-provider-abstraction.md.
// While that RFC is in flight we type it as a structural shape so this
// file compiles without import churn.
export type ProviderSelector = {
  /** Preferred provider id, e.g. "anthropic", "openai", "google". */
  provider: string;
  /** Preferred model id within that provider, e.g. "claude-opus-4-7". */
  model?: string;
  /** Fallback chain, tried in order if the preferred provider is down. */
  fallbacks?: Array<{ provider: string; model?: string }>;
};

/** Stable, kebab-case id matching the roster. Used as a directory name. */
export type PersonaId =
  | 'architect'
  | 'debug-specialist'
  | 'security-auditor'
  | 'usability-auditor'
  | 'doc-writer'
  | 'code-reviewer'
  | 'refactor-specialist'
  | 'test-author'
  | 'performance-analyst'
  | 'creative'
  | 'devops'
  | 'supply-chain-auditor'
  | 'migration-shepherd'
  | 'release-captain';

export interface ArtifactSpec {
  /** Kind name used in `runners/types.ts#ArtifactRef.kind`. */
  kind: string;
  /** Glob the artifact is expected to live at (forward-slashed). */
  pathGlob: string;
  /** Whether the orchestrator should require this artifact before ack. */
  required: boolean;
  /** One-line description for the persona's prompt. */
  description: string;
}

export interface ExemplarRef {
  /**
   * Relative path under the persona's memory dir
   * (`<scope>/personas/<id>/exemplars/`). Markdown or unified diff.
   */
  path: string;
  /** Why this exemplar is "what good looks like" — 1 sentence. */
  why: string;
  /** Optional anti-pattern flag — see §3. */
  antiPattern?: boolean;
}

export interface PersonaProfile {
  /** Stable id, kebab-case. Matches the directory name. */
  id: PersonaId;
  /** Human-friendly name, e.g. "Security Auditor". */
  displayName: string;
  /** Short tagline shown in fleet view; ≤ 80 chars. */
  tagline: string;
  /**
   * The mission prompt prepended to every dispatch. ≤ 800 tokens. Written in
   * the second person ("You are the security auditor…"). Stored as a
   * markdown file alongside the JSON; this field is its relative path.
   */
  mission_prompt: string;
  /**
   * Host-specific tool categories this persona may use. Translated to
   * runner flags at dispatch (see runners/types.ts §3 trust presets).
   * Empty means "use the runner's defaults" — discouraged for security
   * personas.
   */
  tool_allowlist: string[];
  /** Tool categories denied even when present in the host defaults. */
  tool_denylist: string[];
  /** Trust preset baseline; the orchestrator may downgrade per dispatch. */
  trust_preset: TrustPreset;
  /**
   * Path & branch scope this persona is allowed to touch. Composed with the
   * task's scope at dispatch (intersection — never expand the task scope).
   */
  scope: Pick<ScopeDeclaration, 'pathScope' | 'branchScope'>;
  /**
   * Preferred LLM provider/model for this persona. See companion RFC
   * docs/rfc/llm-provider-abstraction.md for the resolution rules. The
   * orchestrator falls back to the workspace default if the preferred
   * provider is not available on the dispatching runner.
   */
  provider: ProviderSelector;
  /**
   * Input artifacts the persona expects to find before it starts work.
   * The orchestrator verifies their presence and refuses to dispatch
   * otherwise (with a clear "missing input" finding).
   */
  inputs: ArtifactSpec[];
  /** Output artifacts the persona is expected to produce. */
  outputs: ArtifactSpec[];
  /**
   * Programmatic success criteria, e.g. "all tests in test/security/
   * pass", "doc-writer artifacts include a bibliography entry per
   * external claim". Checked by Verifier in /team or by the orchestrator
   * before broadcasting task_complete.
   */
  success_criteria: string[];
  /**
   * "What good looks like" exemplars — accepted outputs from prior
   * sessions. Loaded into the dispatch context (with byte cap; see §3).
   */
  exemplars: ExemplarRef[];
  /**
   * Max concurrency the orchestrator should run for this persona. Some
   * personas (security-auditor, release-captain) are singletons per
   * project at a time; others (test-author, doc-writer) can fan out.
   */
  max_concurrent: number;
  /**
   * Whether this persona's findings can *block* a merge. Security-auditor
   * and supply-chain-auditor are blocking; usability-auditor is advisory.
   */
  blocking: boolean;
  /** Schema version; bumped when the orchestrator must migrate the JSON. */
  schema_version: 1;
}
```

Notes on the schema:

- `tool_allowlist` / `tool_denylist` are **category names**, not tool
  names — runners normalize. AutoClaw already uses this shape in
  `ScopeDeclaration.trustAllowList` (RFC §4). Personas just preset it.
- `provider` is the bridge to the companion LLM-provider RFC. Today the
  workspace picks the host (`claude-code`); the persona narrows by
  *model* within that host. If the host doesn't ship the preferred
  model, the orchestrator either degrades to the host default (with a
  `finding_report`) or fails fast (`requireMcp`-style flag — TBD in the
  provider RFC).
- The whole `PersonaProfile` is committed in `skills/<persona>/`. The
  only mutable per-project state is in `.autoclaw/memory/personas/<id>/`
  (§3).

---

## 3. Memory model per persona

Each persona has its own memory namespace, layered on the existing
bi-temporal fact store (`src/memory/bitemporalFact.ts`,
`src/memory/tiers.ts`). The point: a security-auditor that flagged a
`shell-quoting` pattern on sprint 2 should *not* re-discover the same
pattern on sprint 11 — it should recall, cite, and possibly cross-check.

### 3.1 On-disk layout

Two scopes, mirroring AutoClaw's project-vs-global split:

```
# Project-scoped (in the repo, under .autoclaw):
.autoclaw/memory/personas/<persona-id>/
  lessons.md              # heuristics learned this project ("In Foo, X means Y")
  exemplars/              # accepted outputs from prior sessions; ≤ 32 KB each
    NNNN-<slug>.md
  anti-patterns.md        # mistakes the persona has made; "do NOT do X here"
  bibliography.md         # citations (URLs, file:line refs) it has used well
  facts/                  # bi-temporal facts namespaced to this persona
    <fact-id>.json        # BitemporalFact shape (subject prefixed "persona:<id>:")
  index.json              # TierRecord index (recall layer reads it)

# Global (cross-project):
~/.autoclaw/personas/<persona-id>/
  lessons.md              # heuristics that ported successfully across ≥2 projects
  exemplars/
  anti-patterns.md
  bibliography.md
  facts/
  index.json
```

The directory choice is deliberate: `lessons.md` and `anti-patterns.md`
are **human-readable markdown** so the user can audit and edit them by
hand. Facts go through the bi-temporal store so supersession + time-travel
queries work — useful for "what was the security-auditor's view of the
auth flow as of v2.5.0?".

### 3.2 Bi-temporal fact subjects

Persona facts use a subject namespace to avoid colliding with the global
memory:

```
persona:architect:module-boundary:src/orchestrator
persona:security-auditor:pattern:shell-quoting
persona:doc-writer:style:imperative-mood
```

This keeps the existing `currentFact(facts, subject)` and `factAsOf`
helpers working without modification — they're already
subject-keyed.

### 3.3 Tiers and promotion (per persona)

The `tiers.ts` rules apply *per persona*, not globally. Concretely:

- `core/` for a persona is a tiny per-persona file (`core.md`, hard-capped
  at 4 KB — half the global core cap of 10 KB so 14 personas can't blow
  the budget even loaded simultaneously). Lives at
  `.autoclaw/memory/personas/<id>/core.md`. Loaded into every dispatch
  for that persona.
- `recall/` is everything in `lessons.md`, `exemplars/`, `bibliography.md`,
  and `facts/`. Loaded *on demand* via persona-aware `/recall`.
- `archive/` is what `tiers.ts#planPromotions` demotes after
  `archiveAfterSessions` idle. Persona archives stay in
  `.autoclaw/memory/personas/<id>/archive/`.

### 3.4 Promotion path: scratch → persona-recall → persona-archive

The lifecycle of a learned lesson:

1. **Session scratch.** During a dispatch the persona writes
   observations to `.autoclaw/mateam/scratch/<session>/<persona>-notes.md`
   (re-using `/team`'s scratchpad convention).
2. **Dream extraction.** The `/dream` pipeline's
   `extract → dedupe → conflictResolve` stages, when run **per-persona**,
   pull `FACT[…]` lines out of those notes, dedupe against the persona's
   existing facts, and supersede when contradictory. Output: new facts
   under `.autoclaw/memory/personas/<id>/facts/`.
3. **Recall promotion.** A fact accessed by the persona in ≥2 future
   sessions, *or* one explicitly approved by the user via `/recall
   persona <id> --promote <fact-id>`, gets a tier transition to `recall`
   (the existing tier; the persona namespace just scopes it).
4. **Core promotion.** A `recall` fact that's been accessed in ≥5
   sessions and is under 256 bytes gets a line added to the persona's
   `core.md` (subject to the 4 KB cap). This is rare and conservative.
   Bigger lessons stay in `lessons.md`.
5. **Anti-pattern flagging.** When a `review_response: reject` or
   `subcontract_reject_with_fixes` cites a persona, the orchestrator
   appends a one-line anti-pattern entry to
   `anti-patterns.md` with the rejecting message's `id`. The persona
   loads `anti-patterns.md` *before* `lessons.md` so "do NOT" wins on
   tie.
6. **Archive demotion.** Standard `tiers.ts#planPromotions`: a recall
   fact untouched for `archiveAfterSessions` (default 8) sessions moves
   to `archive/`. Archived persona facts are still available to
   time-travel `/recall` but are not loaded into prompts.

**No automatic forgetting.** Demotion to `archive` is the lowest
operation the system performs without user consent. Deleting a lesson is
always an explicit user action — see §8.2.

---

## 4. Spin-up protocol

When the orchestrator decides task `T` needs persona `P`, the dispatch
chain is:

1. **Selection.** The orchestrator's planner (currently `/sprint`,
   eventually `/sprint` + persona router) reads the task's `kind`,
   diff scope, and trigger conditions in §1 and chooses a persona. A
   task may invoke ≥1 persona; the planner emits one
   `subcontract_request` per persona.
2. **Persona load.** The orchestrator reads:
   - `skills/<P>/persona.json` (the `PersonaProfile`).
   - The mission prompt (`mission_prompt` path).
   - The persona's `core.md` (≤ 4 KB).
   - The persona's `anti-patterns.md` and last N exemplars (N tuned to fit
     the dispatching runner's context budget; cap 32 KB total).
   - For known subjects of the task, the matching persona facts via
     `currentFact()`.
3. **Scope composition.** The dispatch's `ScopeDeclaration` is the
   *intersection* of the task's scope and the persona's `scope` field.
   The persona may never widen the task's path/branch scope; it may
   only narrow it. The composed `scope.json` is written under
   `agents/<agent>/scope.json` per RFC §4 in the runner-bridge contract.
4. **Trust preset.** The persona's `trust_preset` is the *upper bound*;
   the workspace's preset (default `auto`) is the lower bound. The
   orchestrator picks the lower of the two. So a `turbo` workspace
   still cannot give the security-auditor `turbo` (its preset is `off`
   for network).
5. **Provider resolution.** Per the companion RFC
   [llm-provider-abstraction.md](./llm-provider-abstraction.md):
   - If the dispatching runner supports the persona's preferred provider
     + model → use it.
   - Otherwise → try fallbacks in order. If none match → degrade to the
     runner's default model and emit a `finding_report` of `kind:
     "persona_provider_degraded"`. Do not fail the dispatch.
6. **Subcontract message.** The persona dispatch is *always* a
   subcontract — the existing
   `src/orchestrator/subcontract.ts#SubcontractDriver.open` is reused
   verbatim. The orchestrator is the `parent`; the runner (e.g.
   `claude-code`) is the `child`. The `payload.brief` field carries:

   ```json
   {
     "subcontract_id": "<uuid>",
     "subcontract_phase": "request",
     "task_id": "T",
     "parent": "orchestrator",
     "child": "claude-code",
     "brief": {
       "persona_id": "security-auditor",
       "persona_schema_version": 1,
       "mission_excerpt": "<first 200 chars of mission_prompt>",
       "inputs": [{ "kind": "diff", "path": "agents/claude-code/work/diff.patch" }],
       "expected_outputs": [{ "kind": "finding_report", "pathGlob": "comms/inboxes/shared/*finding_report*.json" }],
       "success_criteria": ["all critical findings filed before task_complete"],
       "scope": { "pathScope": ["src/auth/**", "src/mcp/**"] },
       "trust": "off",
       "provider": { "provider": "anthropic", "model": "claude-opus-4-7" }
     }
   }
   ```

   The `payload.brief.persona_id` field is **new**. Adding it does not
   break the bus contract — `payload` is free-form in AGENT_SESSION_PROTOCOL
   §3. Listeners that don't understand `persona_id` just ignore it.
7. **Heartbeat & message stamping.** The runner stamps `persona_id` on
   every heartbeat and outbound message during the dispatch (alongside
   `agent_id` and `session_id`). This is the bus's view of "which
   persona is currently driving claude-code". Fleet view groups by
   `persona_id` when set, falling back to `agent_id`.
8. **Completion.** The runner delivers via
   `SubcontractDriver.deliver(deliverable, brief)`. The deliverable is
   the artifact reference produced (a `finding_report` path, an RFC
   markdown, a patch). The orchestrator validates against
   `PersonaProfile.outputs` + `success_criteria` and either `ack`s or
   `rejectWithFixes`. On `ack`, the orchestrator runs the persona's
   memory-promotion pipeline (§3.4).

**Reuse, not new transport.** Every message above rides the existing
filesystem bus. No new directories, no new message types. The persona
layer is *purely* a `payload` convention plus a memory namespace plus a
scope/trust preset.

---

## 5. Cross-project learning

A persona's lessons live in two scopes:

- **Project-scoped** in `.autoclaw/memory/personas/<id>/` (in the repo).
  This is the default home for new lessons.
- **Global** in `~/.autoclaw/personas/<id>/` (in the user's home).
  Promoted lessons that proved useful across multiple projects live
  here.

### 5.1 Promotion to global

A lesson is promoted from project to global when **all** of:

1. The bi-temporal fact has been *accessed and re-confirmed* (no
   superseding contradiction) in **≥2 distinct projects**. "Distinct
   project" is keyed by the workspace's `installation_id` (Antigravity
   precedent, V3_PLAN.md §4).
2. The fact's `content` passes the **secrets / PII filter** (§5.2).
3. The user has opted in via `autoclaw.personas.crossProjectLearning =
   true` (default: **off** — see §8.3).

The `/dream` pipeline's promotion stage (extended in C2) runs the check
nightly when the user has opted in; otherwise it is no-ops.

### 5.2 Privacy rules — never carry secrets across projects

When a lesson is considered for global promotion, the dream pipeline runs
a secrets scrub:

- **Path tokens:** any path containing the project's name, the project's
  workspace folder name, or the workspace's `installation_id` is
  rejected. Lesson must be **path-agnostic** to leave the project.
- **Identifier tokens:** any string matching the workspace's known repo
  remotes, npm scope, package name, organization name is rejected.
- **Secret patterns:** anything matching the AutoClaw secret regex set
  (the same set used by `/dream` drift-check for env exfiltration —
  V3_PLAN.md §2 step 4) is rejected and the source fact is also flagged
  for review.
- **User content:** an explicit per-persona `allowlist` and `denylist` in
  `~/.autoclaw/personas/<id>/privacy.json` lets the user opt specific
  subjects in or out.

When a lesson is rejected for global promotion, it stays project-scoped
and a `finding_report` is emitted with `kind:
"global_promotion_blocked"` so the user can see *what* was redacted.

### 5.3 Loading order at dispatch

Per-persona memory is loaded in this order (later wins on tie, never
silently overwrites):

1. Global `core.md` (≤ 4 KB).
2. Global `lessons.md` (clipped to budget).
3. Project `core.md` (≤ 4 KB).
4. Project `lessons.md` (clipped to budget).
5. Project `anti-patterns.md` (loaded *last*, so "do NOT" wins on tie).

Total persona memory budget per dispatch: 32 KB hard cap. Exceeding it
triggers `tiers.ts#planCoreOverflow`-style eviction down the list.

### 5.4 Forking & sharing

The roster ships with seed lessons (the `exemplars/` checked in to
`skills/<id>/exemplars/`). Those *are* the cross-project baseline. The
user's global directory adds to that baseline; it does not replace it.
A future "share my architect's lessons" knob is out of scope (§8.5).

---

## 6. Roster bootstrap

The roster lives under `skills/<persona>/`, parallel to the existing
skills (`autobuild/`, `kdream/`, `mateam/`, `orchestrate/`). Each persona
ships:

```
skills/<persona>/
  SKILL.md           # human-readable skill spec (rendered into adapters)
  persona.json       # the PersonaProfile (§2)
  mission.md         # the mission prompt referenced by mission_prompt
  exemplars/         # seed exemplars (committed; never rewritten)
    0001-<slug>.md
  README.md          # what this persona is for (links to RFC)
```

### 6.1 `SKILL.md` template, generated from the roster table

Each persona's `SKILL.md` is generated from a single row of §1 plus the
`mission.md` body. The generator (`scripts/build-persona-skills.ts`,
out of scope to implement here) ensures every persona's `SKILL.md`
follows the same shape:

```markdown
---
name: <persona-id>
description: <tagline from §1>. Trigger on "/<persona-id>", "<keywords>", "persona:<persona-id>".
---

# <displayName> — Specialized Persona

## Mission
<contents of mission.md, ≤ 800 tokens>

## When invoked
<row "When orchestrator invokes" from §1>

## Tools & trust
<row "Tool allowlist / trust preset" from §1>

## Inputs / outputs
- Inputs: <from persona.json#inputs>
- Outputs: <from persona.json#outputs>

## Memory
This persona reads its memory namespace at
`.autoclaw/memory/personas/<persona-id>/` (project) and
`~/.autoclaw/personas/<persona-id>/` (global). See
docs/rfc/specialized-agents.md §3.

## How /team picks me
Roster row in docs/rfc/specialized-agents.md §1.
```

`npm run adapters:check` (existing CI gate; V3_PLAN.md §1) extends to
also assert that every `skills/<persona>/SKILL.md` is generator-clean,
preventing drift between the RFC table and the on-disk skills.

### 6.2 How `/team` and `/sprint` pick from the roster

- **`/team`** today decomposes into Researcher → Coder → Reviewer →
  Verifier. After this RFC lands, `/team`'s role mapping gets a small
  table: certain `kind` hints in the brief promote a generic role to a
  persona-backed one. Concretely:

  | Brief contains | Coder becomes | Reviewer becomes |
  |---|---|---|
  | `"bug"`, stack trace | debug-specialist | code-reviewer + security-auditor (if `auth/crypto/mcp`) |
  | `"refactor"`, `"extract"`, `"rename"` | refactor-specialist | code-reviewer + test-author (regression) |
  | `"doc"`, `"readme"`, `"changelog"` | doc-writer | usability-auditor |
  | `"perf"`, `"slow"`, `"benchmark"` | performance-analyst | architect (shape) |
  | `"deps"`, `"upgrade"`, `"lockfile"` | _(none — Coder still does it)_ | supply-chain-auditor (mandatory) + security-auditor |
  | `"release"`, `"publish"` | release-captain | devops + security-auditor |
  | _(otherwise)_ | generic Coder | generic Reviewer (today's behaviour) |

  This is a **superset** of today's behaviour — no brief triggers a
  *regression* on `/team`'s current pipeline.

- **`/sprint`** picks personas at planning time, when reading
  `tasks.md` and emitting the sprint YAML. A persona assignment is
  rendered into the sprint YAML's per-task block:

  ```yaml
  - id: B1
    title: Tighten MCP env-var handling
    depends_on: [A4]
    persona: security-auditor      # ← new optional field
    scope: { pathScope: [src/mcp/**, src/runners/**] }
  ```

  If the field is absent, `/sprint` continues to assign tasks at the
  host level as today. The persona field is read by the orchestrator
  during the dispatch step (§4 step 1) and stamped into the
  `subcontract_request`.

### 6.3 The user-facing slash command — `/persona`

A thin convenience over the orchestrator: `/persona <id> <task brief>`
spins up exactly one persona on the current runner without going through
`/sprint`. Useful for ad-hoc work ("run the security-auditor over the
current diff") and for testing personas in isolation.

---

## 7. First three to ship

The three personas most likely to deliver immediate value on AutoClaw
itself, ranked. AutoClaw is a code-heavy multi-host extension shipping
frequently to two registries — these three pay for themselves on the
*current* repo.

### 7.1 architect (ship first)

**Why first.** AutoClaw has accumulated ten+ RFCs in `docs/` and three
plan documents that contradict each other in places. New sprints
routinely require re-reading `V3_PLAN.md`, the daemon critique, and the
agent-session protocol *every cycle*. An architect persona that owns the
canonical RFC index and writes new RFCs against the existing decision
record turns this into one prompt-load instead of one rediscovery per
session.

**Rollout.** Week 1 of the next minor: implement `PersonaProfile`
loading + `/persona architect` slash command. Seed `skills/architect/`
with the 14 existing RFCs/plans as initial `bibliography.md` and three
exemplars (V3_PLAN.md §1 naming-table refactor, the runner contract, the
MCP server RFC). First production use: write the
`docs/rfc/llm-provider-abstraction.md` companion to this RFC.

### 7.2 security-auditor (ship second)

**Why second.** AutoClaw writes secrets through MCP env handling, the
cloud relay (D-series workstream), and the publish pipeline. The
existing `/dream` drift-check already scans for secrets in MCP env
(V3_PLAN.md §2 step 4) — the security-auditor extends that into a
continuous reviewer with memory of patterns it has flagged before. The
unanimous-vote-on-security-findings rule (cross-agent protocol §
Consensus) gives it real teeth.

**Rollout.** Week 2: implement persona memory loader + the
`subcontract_request.payload.brief.persona_id` extension. Seed
`skills/security-auditor/` with patterns from the existing
`docs/research/` security write-ups and from the cloud-relay design
notes. First production use: audit the cloud-relay MVP (D.1–D.4) before
GA.

### 7.3 doc-writer (ship third)

**Why third.** Every AutoClaw release renames or repackages things
(slash-command renames, `.autoclaw/kdream → /dream`, the adapter target
move). Docs lag behind by a release routinely. A doc-writer persona that
runs after every `task_complete` with a public-API delta — and that
remembers the project's house style from prior accepted edits — closes
the loop. It also unblocks the usability-auditor (which depends on
doc-writer's exemplar set to know what "good copy" looks like).

**Rollout.** Week 3: implement the auto-trigger from `task_complete`
(read the diff, check for public-API matches, dispatch). Seed
`skills/doc-writer/` with three accepted doc PRs as exemplars (the v3
naming migration doc, the MCP install hero section in V3_PLAN.md §5, the
runner-bridge contract README). First production use: rewrite every
SKILL.md once the rename ships, audit the deprecation notices, and
publish the v3.0 release notes.

Personas 4–14 ship opportunistically; #4 (refactor-specialist) is the
obvious follow-on once architect is producing RFCs that need executing.

---

## 8. Open questions

### 8.1 How does the user audit what a persona has "learned"?

Two surfaces. **Fleet view** gets a "Personas" tab listing each persona,
its project memory size, last access, top-5 most-cited facts (via
`currentFact()` joins on the persona's subjects). **CLI** gets `autoclaw
persona inspect <id>` which dumps `lessons.md`, `anti-patterns.md`, and
the latest 20 facts with their bi-temporal windows. Open: should the
fleet view also expose the *global* memory? Recommendation: yes, with a
red "global" tag, because the cross-project blast radius makes it the
thing the user most needs to see.

### 8.2 How does the user forget on demand?

Three granularities:

- **`autoclaw persona forget <id> <fact-id>`** — appends a "tombstone"
  bi-temporal fact (`content: "REDACTED"`, `superseded_by: null`,
  `valid_from: now`) so the supersession chain is preserved (audit
  trail) but the persona stops loading the old content. The original is
  moved to `archive/` and zeroed *only* on a follow-up explicit
  `--purge` flag.
- **`autoclaw persona reset <id>`** — wipes the project memory dir for
  one persona after a confirmation prompt. Re-seeds from
  `skills/<id>/exemplars/`. Global memory untouched unless
  `--global` is passed.
- **`autoclaw persona reset --all`** — escape hatch. Same as above for
  every persona.

Open: should forget be a `/note` flavor instead of a CLI command, so
it's accessible from any host? Probably yes for the per-fact form.

### 8.3 How do we prevent a persona drifting on bad lessons?

The biggest risk. Mitigations layered:

- **Anti-pattern wins on tie** (§3.4 step 5). Every `reject_with_fixes`
  citing a persona writes a "do NOT" line that loads *before*
  `lessons.md`.
- **Confidence decay.** Bi-temporal facts already carry `confidence`
  (`bitemporalFact.ts` line 62). The promotion check (§3.4 step 3)
  multiplies confidence by an access-recency factor; facts whose decayed
  confidence drops below 0.3 are demoted to `archive` rather than loaded.
- **User confirmation on global promotion** (§5.1). A lesson can never
  cross the project boundary without the user opting in *and* surviving
  the secrets scrub.
- **Quarterly review prompt.** The dream pipeline once per N sessions
  (default 30) surfaces the top-5 most-loaded persona facts as a
  `finding_report: persona_lessons_review` and asks the user to confirm
  or reject. Drift gets caught before it compounds.
- **Cross-persona check.** Before a security-auditor lesson is
  promoted, the code-reviewer persona runs a sanity check against it (a
  cheap second opinion). This is novel and unproven — open question
  whether it actually catches drift or just doubles the cost.

### 8.4 Persona vs. agent_id in fleet view

Today `agent_id` is the primary key in `registry.json`. After this RFC,
a single `claude-code` row might be driving five different personas
across five concurrent dispatches. Do we want one row per persona,
parented under the host agent? Recommendation: yes — `registry.json`
grows a `personas: { active: [...], history: [...] }` field per row,
and the fleet view renders them as child nodes. But this expands the
schema; needs a small migration story (B+ workstream territory).

### 8.5 User-defined personas

The roster is finite for a reason (security-relevant allowlists). But a
user adding a `"copy-editor"` persona for their own project should
probably be cheap. Two options:

- **(a) Defer.** Personas stay code-only until 3.x. Users can request
  additions through GitHub.
- **(b) Add a "user persona" path** at `~/.autoclaw/personas/_user/<id>/`
  that bypasses the kebab-case `PersonaId` union but is forced to
  `trust: off` for any tool category that doesn't appear on a hard
  default safe list. Path/branch scope must be explicit.

Recommendation: (a) for 3.0, (b) for 3.1 once the roster has shaken out.
The marginal value of user personas before the canonical roster proves
itself is low.

### 8.6 Roster cost ceiling

Loading 14 persona schemas + base prompts could balloon the
orchestrator's planner context. Mitigation: lazy-load. The planner reads
*only* `persona.json` (small JSON) at planning time, and the full
`mission.md` + memory only at dispatch time, only for the chosen
persona. Worth a measurement on the largest sprint we've planned to
date.

### 8.7 What happens when two personas disagree?

The 2/3 consensus rule (cross-agent protocol § Consensus) already
handles disagreement between *agents*. Between *personas* on the same
host, the orchestrator should run them in parallel where possible (e.g.
security-auditor + code-reviewer on the same diff) and only escalate to
a human when their `review_response` verdicts conflict. Open: do we
need a "tiebreaker" persona, or is the architect that role by default?
Recommendation: architect is the tiebreaker; if the architect is one
of the conflicting parties, escalate to human.

---

## 9. Relationship to other RFCs

- [docs/rfc/llm-provider-abstraction.md](./llm-provider-abstraction.md)
  — companion. Defines `ProviderSelector` (§2) and the
  provider-fallback semantics referenced in §4 step 5. Personas are the
  *what* (mission + memory + scope); the provider RFC is the *who*
  (which model runs the dispatch).
- [docs/rfc/runner-bridge-contract.md](./runner-bridge-contract.md) —
  parent. Defines `Runner`, `ScopeDeclaration`, `TrustPreset`. Personas
  are a layer on top — never modify the runner contract.
- [docs/rfc/mcp-server.md](./mcp-server.md) — sibling. The
  `recall(query)` MCP tool grows a `persona: <id>` filter; the
  `claim_task(id)` write tool grows an optional `persona_id` argument
  so external dispatchers can adopt a persona without going through the
  orchestrator's slash commands.
- [docs/AGENT_SESSION_PROTOCOL.md](../AGENT_SESSION_PROTOCOL.md) —
  unchanged transport. The persona layer rides on `payload.brief` and
  optional `persona_id` heartbeat/message fields. No new message
  types.
- [docs/V3_PLAN.md](../V3_PLAN.md) — this RFC slots into Workstream C
  as **C.15** (proposed). Sequencing-wise, lands after C.1–C.4 (skill
  split, dream pipeline, tiers, bi-temporal) — those are prerequisites.
