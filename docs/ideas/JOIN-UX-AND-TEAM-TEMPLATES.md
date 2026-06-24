# Agent Join UX + Team Templates + Playbook

_2026-06-23 — redesigns the "join an agent / invite a peer" experience, adds a
ready-made TEAM TEMPLATE gallery and an in-repo playbook, and fixes a real
render-side correctness bug found along the way. Grounded in a competitive sweep
of SOTA multi-agent systems (see [§Research basis](#research-basis))._

## Why this doc exists

The two sibling commands — `autoclaw.fleet.joinPrompt` ("Generate Join Prompt for
Agent…") and `autoclaw.fleet.invite` ("Invite Agent to Project…") — were a chain of
blank modal pickers: no tooltips, no help text, no recommended defaults, no team
presets, no first-run guidance. A user faced three back-to-back closed lists
(12 tools → 13 roles → **6 bare `agent_type` words**) with nothing explaining what
any option meant or why two of the lists (role vs agent_type) overlap.

## The eight grounded defects

1. **The `agent_type` step discarded data it already owns.** Both commands built
   that step from `['coder','runner',…].map(t => ({label:t}))` — six bare words —
   even though `src/fabric/agentTypes.ts` already carries, per type, a
   `description`, `defaultTrust`, `consensusRule`, `humanInLoop`, `canOrchestrate`,
   and `capabilityTags`. The single most consequential choice in the flow was made
   on the *least* information.
2. **`role` (13) and `agent_type` (6) overlap, never reconciled for the user.**
   orchestrator≈supervisor, reviewer/security≈auditor, ops≈runner,
   researcher≈runner. No bridging copy; users couldn't tell why they answer both.
3. **A latent correctness bug (render side).** The invite layer already stored a
   *distinct* `suggested_agent_type` — but `renderJoinPromptForInvite` only read
   `suggested_role` and never threaded the type, and `beaconJson` collapsed them
   (`obj.role = role; obj.agent_type = role`). So a `reviewer` announced
   `agent_type: "reviewer"`, and the downstream consensus/trust engine never keyed
   it as an `auditor` (read-only + unanimous). The **slash lane omitted
   `agent_type` entirely** — which silently defeats the recommended Solo+Reviewer
   template (its reviewer runs on Claude Code).
4. **The 13 roles had no descriptions.** `ROLE_META` carried `glyph/label/abbrev`
   but no help text; the picker put the raw role id in `item.description`,
   redundant with the label.
5. **No templates, no playbook, no walkthrough.** Every agent was built from a
   blank slate; `package.json` had zero `contributes.walkthroughs`.
6. **The two commands diverged.** `admit_policy` was a real step in `invite` but
   hard-coded to `auto-preapproved` in `joinPrompt`.
7. **The join lane was hidden.** Step 1's tool choice silently selects the lane
   (mcp|http|fs|slash) — the most determinative consequence — yet showed only the
   internal key.
8. **No recommended defaults / no preview-before-mint** (the latter still a P1).

## The role ↔ agent_type reconciliation (the conceptual core)

**Decision: LAYER + AUTO-DERIVE (with an optional override).** Do *not* merge the
vocabularies (they are different abstractions — `role` is the organizational/display
facet the panel groups by; `agent_type` is the behavioural/policy facet carrying
trust + consensus + human-in-loop). Do *not* keep asking for both.

The new single source of truth is `src/fleet/roleType.ts` — a forward
`role → agent_type` map (the inverse already existed in `roles.ts ROLE_SYNONYMS`):

| role | derived agent_type | notes |
|---|---|---|
| orchestrator | supervisor | coordinates; `canOrchestrate` |
| architect | coder | designs **and** edits (alt: supervisor) |
| product | governance | approves / sets requirements (alt: assistant if draft-only) |
| coder | coder | |
| reviewer | auditor | read-only, unanimous |
| security | auditor | read-only, security-tier unanimous |
| tester | coder | edits + runs tests (alt: runner if result-only) |
| designer | coder | edits UI files |
| creative | assistant | drafts copy, human-in-loop |
| docs | coder | writes files (alt: assistant if draft-only) |
| **researcher** | **runner** | one job, returns findings, no session |
| ops | runner | runs a job, returns a result |
| generalist | assistant | safe helper default |

> The map is intentionally **many-to-one** (reviewer and security both → auditor),
> so it is NOT invertible — tests assert validity + the four canonical inverse
> pairs (orchestrator↔supervisor, reviewer↔auditor, ops↔runner,
> generalist↔assistant), not a bijection. `researcher → runner` was pinned to a
> single value so the playbook, the template, and the wizard all agree.

How it surfaces today: after the user picks a **role**, the `agent_type` step opens
with the derived type listed **first** under a "Suggested for this role" header
(data-driven from `agentTypeProfile`), so the common path is "take the top row."
The legitimate divergent cases (product, docs, tester, researcher, architect) are a
scroll away under "Or choose another behavioral type" with full trust/consensus
detail on every row.

## What shipped in this increment

### Correctness — `role ≠ agent_type` announced distinctly on every lane
- **`src/fleet/roleType.ts`** (new, pure) — `ROLE_TO_AGENT_TYPE`,
  `agentTypeForRole`, `deriveAgentType`, `ROLE_TYPE_ALTERNATES`.
- **`src/fleet/joinPrompt.ts`** — added `agentType` to `RenderJoinPromptInput`;
  `effectiveAgentType()` uses the explicit type or derives it from the role;
  `beaconJson` + the **mcp / http / fs / slash** renderers now emit `role` and a
  **distinct** `agent_type`; `renderJoinPromptForInvite` threads
  `invite.suggested_agent_type`. Header gained a "Behavioral type:" line.
- Regression tests assert a `reviewer` announces `agent_type: "auditor"` on all
  four lanes (incl. slash) and through the invite wrapper.

### P0 — the pickers explain themselves (data-driven, drift-proof)
- **`src/roles.ts`** — `RoleMeta` gained `description` (→ `item.detail`) + `hint`
  (→ `item.description`), populated for all 13 roles.
- **`src/extension.ts`** — shared `buildRoleItems` / `buildAgentTypeItems` /
  `buildTargetItems` / `buildAdmitItems` helpers used by both commands. Tools are
  grouped with `QuickPickItemKind.Separator` into **Federation peers** vs **IDE
  hosts**, each row showing its **lane** (`item.description`) + consequence
  (`item.detail`). Roles are grouped by tier. Agent-types are built from
  `agentTypeProfile` so the trust/consensus/human-in-loop summary can never drift.
  `admit_policy` is now a step in **both** commands (was hard-coded in joinPrompt).

### Team templates + playbook (the headline)
- **`src/fleet/teamTemplates.ts`** (new, pure) — a 10-recipe catalog (Solo+Reviewer
  *recommended*, Feature Build Squad, Code-Review Gauntlet, Test-Hardening Pair,
  Security Audit Cell, Docs Sweep, Research+Synthesis, Bug-Hunt Swarm,
  Refactor/Migration Crew, Design+Build Pair). Each seat = role + agent_type + tool
  + scope hint + admit + rationale (+ optional verify hint). Tests enforce every
  seat uses valid taxonomy values and a type that is the role's derived default or
  a **declared** alternate — no silent contradictions.
- **`autoclaw.fleet.addTeam`** ("Add Agent Team from Template…") — a gallery →
  **preview-before-mint** (a modal listing the squad; no token is created until you
  confirm) → fans out one scoped invite per seat → opens one ready-to-paste
  document with each seat's tailored join prompt. Offers the MCP-writes flip once if
  any seat is MCP-lane. Wired to a panel **Add team** message.
- **`docs/MULTI-AGENT-TEAM-PLAYBOOK.md`** — a friendly in-repo playbook explaining
  role vs agent_type, the "how many agents / which tool" guide, every template, and
  the coordination ground-rules in plain words.

## Research basis

A competitive sweep (CrewAI, AutoGen/AG2 + AutoGen Studio, LangGraph
supervisor/swarm, OpenAI Agents SDK, MetaGPT, ChatDev, CAMEL; Roo Code, Kilo Code,
Cline, Cursor, Windsurf, Continue, Aider, Copilot; A2A Agent Cards, MCP, ACP; VS
Code walkthroughs / multi-step QuickInput / template galleries) surfaced the
patterns we adopted:

| System | Role / mode model | Onboarding | Templates |
|---|---|---|---|
| **CrewAI** | one self-describing agent (role + goal + backstory); team mode = sequential vs hierarchical | `crewai create` scaffolds `agents.yaml`/`tasks.yaml`; Studio visual builder | scaffolded crews + example gallery |
| **AutoGen Studio** | team-as-object with named modes (round-robin / selector / swarm / magentic) | drag-and-drop Team Builder, Playground preview | default Gallery, save/publish, JSON import/export |
| **LangGraph** | agent = node; team mode = topology (supervisor vs swarm) | `pip install langgraph-supervisor`; Studio renders the graph | the two prebuilt topologies are the presets |
| **MetaGPT** | closed SOP roles (Product Manager → Architect → Project Manager → Engineer → QA) | one line hires the standard company | the framework *is* one canonical team |
| **Roo Code** | ONE record: `description` (shown) + `whenToUse` (drives delegation) + `groups` (permissions); Orchestrator/Boomerang delegates | redesigned selector shows name + description; hand-edit `.roomodes` | in-extension mode Marketplace |
| **Continue** | per-model `roles` (chat, autocomplete, edit, apply, embed, rerank, summarize; default `[chat, edit, apply, summarize]`); an "Assistant" = a Hub bundle of models+rules+tools. ("Agent" is a chat MODE, not a model role.) | Hub = browsable gallery of blocks + whole assistants | the Hub marketplace |
| **n8n / AutoGen-Studio gallery** | — | "new" offers template-or-blank; card grids with title/description/Use | 1000s of templates; "start from a template, not a blank" |
| **AutoClaw → now** | role (13) primary + **derived** agent_type (6) shown with full trust/consensus detail | self-documenting pickers grouped by lane/tier; team gallery with preview | 10 named team templates + an in-repo playbook |

**SOTA patterns we took:** self-describing rows (Roo/A2A/MCP always render
machine-readable detail to the chooser); team-as-a-preset gallery (everyone leads
with one); a tiny comprehensible top-level choice (LangGraph's two topologies);
preview-before-commit (AutoGen Studio Playground, Windsurf plan); and the 2026
"multi-agent can hurt a strong solo" finding → bias the default to the **smallest
viable team** (Solo + Reviewer).

## Corrected facts (from adversarial verification)

- **`contributes.viewsWelcome` does NOT render on a WebviewView.** The fleet
  surface (`kdreamDashboard`) is a `"type": "webview"` view, so an empty-state CTA
  must live **inside the webview's own HTML** (postMessage → run the command), not
  as a `viewsWelcome`. (Today the panel already shows an onboarding hint; the
  **Add team** button is the new entry point.)
- **There is no `autoclaw.panel.focus`.** The real focus command is the
  auto-generated **`kdreamDashboard.focus`**, and the walkthrough completion event
  is `onView:kdreamDashboard`.
- **`activeItems` and per-item buttons need `createQuickPick`** — the convenience
  `showQuickPick` overload supports `detail`/`description`/`Separator` (all used in
  P0) but **not** a pre-highlighted active item or info buttons. Those land with the
  P1 multi-step wizard, not before.
- `researcher` is pinned to **`runner`** everywhere (the reconciliation draft had
  drifted to `assistant` in one place).

## Follow-ups (not in this increment)

- **P1 — one multi-step `createQuickPick` wizard** with a real Back button,
  step/total progress, inline validation (scope globs via debounced async
  `findFiles`; bridge URL shape), and **preview-before-mint** for `invite` /
  `joinPrompt` too (today only `addTeam` previews before minting). Use ONE
  long-lived QuickInput reused across steps (not dispose-per-step) to avoid Back
  flicker. Pre-select the derived type via `activeItems`. Add per-item info buttons
  explaining "role vs type" and the lanes.
- **First-run walkthrough** (`contributes.walkthroughs` "Get your fleet running",
  4 steps, `completionEvents` on the real commands/views, theme-aware SVG media
  declared in `package.json`) + an in-webview empty-state CTA. _(Partially in this
  increment — see the walkthrough section.)_
- **User-authorable team files** — `.autoclaw/teams/*.yaml` merged with the
  built-in catalog, so teams are shareable / diffable / version-controlled (the one
  competitor affordance — CrewAI `agents.yaml`, Roo `.roomodes`, Continue
  `config.yaml` — still missing). Serves the power-user persona.
- **Expired-token recovery** — a "re-issue join prompt for this seat" affordance +
  TTL visibility, since single-use 24h tokens will die before some users paste.
- **A natural-language goal shim** ("What are you trying to do?" → recommended
  template) over the gallery, à la Roo's "Ask Roo".
- **Per-seat verify command** surfaced in the wizard/preview (a `coder` is *defined*
  by a verify command; seats carry a `verifyHint` today but the wizard doesn't yet
  collect a real test command).
- Edit / replace / remove an existing team member; show which template a running
  fleet came from.

## Testing

- `roleType.test.ts` — validity, the four canonical inverse pairs, many-to-one,
  `researcher → runner`, free-form normalization, alternates.
- `teamTemplates.test.ts` — every seat's role/type/tool/admit valid; type is the
  derived default or a declared alternate; unique kebab ids; one recommended
  starter = builder + read-only auditor.
- `joinPrompt.test.ts` — regression: `reviewer` → `auditor` announced distinctly on
  mcp/http/fs/slash and via `renderJoinPromptForInvite`; explicit override wins;
  header surfaces the type.
- New test files added to the `test:unit` explicit mocha list. `tsc -p ./` clean.
