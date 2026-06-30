# Cross-Project Survey — Patterns AutoClaw Should Borrow

_Date: 2026-05-22 — read-only audit, no source code modified._
_Author: claude-code research session._

## 0. Scope

Surveyed:

* GitHub repos under `GoZippy/*` (~95 repos returned) and orgs `ZippyNetworks`,
  `Zippy-s-Public-Stuff`, `ZippyCoin-org`, `ZippyMesh`. Top-level metadata only.
* Local trees under `<local-projects>\` and `<local-projects>\Tomorrow Inc\`. Only the
  top-level `README.md`, `CLAUDE.md`, `AGENTS.md`, and `docs/` indices were
  read — never full source.
* `GoZippy/VoidSpec` sibling repo (deep-read; root files + `docs/` list +
  `.voidrules`) compared to AutoClaw's `src/voidspec/{types,sync,dispatch}.ts`.

Skipped: anything inside `node_modules/`, large `Yufok1` archive docs, all
forks that aren't agent/orchestration-relevant.

---

## 1. Inventory — repos & trees actually inspected

| Source | Type | One-line purpose | Why interesting |
|---|---|---|---|
| `GoZippy/VoidSpec` (private, `VoidSpec_v1` branch) | VS Code/Void IDE extension, TypeScript | Spec-driven dev: turn prompts → `requirements.md`/`design.md`/`tasks.md`, A/B prompt tester, milestone manager, visual workflow designer | The sibling of AutoClaw's `.voidspec/` integration. Compared below. |
| `GoZippy/autoclaw` (this repo) | VS Code extension | This project. Reference baseline. | — |
| `GoZippy/coven` (fork of OpenCoven) | Rust workspace, npm wrapper | "Project-scoped harness sessions" — local-first substrate for Codex/Claude Code with `coven` TUI, gateway, MCP | Closest peer to AutoClaw's launcher/runner concept; has a cleaner cross-host launch surface |
| `GoZippy/openclaw-mission-control` (fork) | Web app | Centralized ops dashboard for OpenClaw — orgs, board groups, boards, tasks, gateways, approvals | Pattern source for ZippyPanel-style governance/audit layer on top of AutoClaw |
| `GoZippy/oh-my-codex` (fork) | Codex augmentations | Adds hooks/agent teams/HUDs to OpenAI Codex | Hook & team patterns transferable to claude-code adapter |
| `GoZippy/career-ops` (fork) | Claude Code skill bundle | 14 skill modes, Go dashboard, batch processing | Reference for skill packaging discipline |
| `GoZippy/Enterprise-Crew-skills` (fork) | Skill bundles | Collection of agent skills/scripts | Skill-format reference |
| `GoZippy/ralph-orchestrator` (fork) at `<local-projects>\ralph-orchestrator` | Rust monorepo | "Improved Ralph Wiggum" autonomous loop — `ralph-core`, `ralph-adapters`, `ralph-cli`, `ralph-tui`, `ralph-telegram`, `ralph-web` | Mature event-loop + adapter design + spec discipline ("specs are contracts") |
| `GoZippy/spec-kit` (fork) | Spec-driven dev toolkit | Generic SDD template | Naming convention reference |
| `GoZippy/STFU.md` (fork) | Prompt | "Cut agent yap by ~80%" | One-liner prompt overlay worth borrowing |
| `GoZippy/CLAUDE-CODE-SYSTEM-PROMPT` (fork) | Doc | Living doc of CC system prompt | Empty in practice — skipped |
| `GoZippy/9router` / `lm-proxy` / `RouteLLM` / `open-llm-router` / `zippymesh-llm-router` | LLM gateways | Multi-provider routing layer | Provider-routing primitives for AutoClaw cloud relay |
| `<local-projects>\ZippyPanel` | Go + Next.js | Self-hostable hosting control plane (AGPLv3). Ships `.autoclaw/orchestrator/`, `.autoclaw/kdream/`, `.kiro/specs/`, `.kiro/steering/`, parallel-agent steering, sprint reviewer agent | The richest *consumer* of AutoClaw conventions — its `.autoclaw/orchestrator/` structure (templates, agents, lib, hooks) is the canonical example to lift |
| `<local-projects>\ZippyVoice` | Polyglot (TS control plane + Python media) | Multi-tenant voice automation: control / conversation / media / integration planes | Plane-separation pattern transferable to AutoClaw's runner/orchestrator split |
| `<local-projects>\zippyswap` | Next.js + Solidity-ish | HTLC atomic-swap DEX | Not orchestration-relevant — skipped |
| `<local-projects>\Yufok1\Convergence_Engine` | Massive doc-heavy Python project | "Convergence engine" — agency/causation/butterfly subsystems | Anti-pattern source: doc-archive sprawl |
| `<local-projects>\KiroAutomation` | VS Code extension + executor | Autonomous task execution from `.kiro/specs/*/tasks.md`, multi-workspace, plugin system, session persistence | **High signal.** Directly comparable to AutoClaw orchestrator. Plugin architecture worth copying. |
| `<local-projects>\AgentEnsemble-v1` | Python | Agent ensemble experiments | Light — skipped after FEATURES.md |
| `<local-projects>\AgentWise_Zippy\AgentWise\agentwise` | Claude Code multi-agent system | Specialized sub-agents (backend, frontend, db, devops, design, research, testing, review, deploy) defined as `.claude/agents/*.md` with `tools:` frontmatter; `.claude/commands/*.md` for slash commands | **High signal.** Pattern for AutoClaw's mateam-spawned subagents. |
| `<local-projects>\ClawCracker` | TS/pnpm | Sibling-named — minimal content; skipped |
| `<local-projects>\zippy-mcp` | TS | MCP-kit experiments | MCP integration reference |
| `<local-projects>\Tomorrow Inc\Webster\webster-v1.0.0` | Chrome extension | AI sidebar for HubSpot/Marketo/Salesforce/Segment. Has `.autoclaw/kdream/` already wired. | Consumer of AutoClaw memory pattern |
| `<local-projects>\Tomorrow Inc\Factory-Registry-v1` | AWS CDK + Kiro specs | Agent Factory + private MCP registry on AWS; ships `.autoclaw/mateam/scratch/<date>-<lane>/{plan,context,output}.md` from a real mateam run | Real-world mateam artifact layout — adopt as canonical mateam template |
| `GoZippy/CLAUDE-CODE-SYSTEM-PROMPT` | Doc | One line of content — skipped |
| `GoZippy/conducty`, `GoZippy/portless`, `GoZippy/openaide`, `GoZippy/hindsight`, `GoZippy/mempalace` | Forks | Adjacent: batch-planning, port aliasing, worktree-based agent workspaces, agent memory benchmarks | Reference-only; ideas folded into §2 |

Repos listed in `gh` output but **not opened** (skipped — not orchestration-relevant or already known): forks of `dokploy`, `aider`, `firecrawl`, `jan`, `LlamaFactory`, `Deep-Live-Cam`, `omi`, `VibeVoice`, `hyperframes`, `playcanvas_engine`, `Latte`, `Perplexica`, etc., plus the long tail of Lovable scaffold repos under `Zippy-s-Public-Stuff`.

---

## 2. Adoptable patterns

Each item: **(a)** where it comes from · **(b)** why it helps AutoClaw · **(c)** integration shape.

### 2.1  Loop-discipline rules as a short overlay

* **Seen in** `ralph-orchestrator/CLAUDE.md` and adjacent autonomous-loop
  projects. The common themes: re-read state each cycle; plans go stale;
  prefer typed signals over scripted branches; trust the loop once the
  signals are good.
* **Why** AutoClaw's perpetual-loop work (see commit `1653976`) re-invents
  loop discipline ad hoc. A short rules-overlay that fits in any agent's
  context catches the common pitfalls cheaply.
* **Shape** Add `skills/loop-discipline/SKILL.md` (one-page, our own words)
  and reference it from `docs/AGENT_SESSION_PROTOCOL.md §7 "Per-host
  bootstrap"`. Do **not** embed in the protocol body — keep it as a
  recallable skill. **Do not borrow the source project's vocabulary in the
  user-facing skill name or rule wording** (per the ZippyTech voice rule).

### 2.2  Spec-as-contract workflow (`draft → review → pilot → implement → verify → done`)

* **Seen in** `ralph-orchestrator/DEVELOPMENT.md` and `.ralph/specs/*.spec.md`
  (acceptance criteria in Given/When/Then frontmatter with `status:`).
* **Why** AutoClaw's `docs/rfc/` and `docs/specs/` directories are
  inconsistently formatted; VoidSpec sync already produces spec-shaped data.
  Standardising on a single spec frontmatter would let `sprintMarkdownGenerator`
  consume specs directly. (Our own template at `docs/specs/_template.spec.md`
  uses our own field names — we adopt the idea, not the borrowed vocabulary.)
* **Shape** Add `docs/specs/_template.spec.md` with the frontmatter
  (`status: draft | review | implemented`, `gap_analysis`, `related:`), and
  teach `orchestrator/sprintMarkdownGenerator.ts` to read it.

### 2.3  Sub-agent role file format

* **From** `<local-projects>\AgentWise_Zippy\AgentWise\agentwise\.claude\agents\*.md`
  — every agent is `---\nname:\ndescription:\ntools: Read,Edit,...\n---` then a
  short role brief. Same pattern in `ZippyPanel/.kiro/agents/sprint-reviewer.md`.
* **Why** AutoClaw's `mateam` skill spawns sub-agents but their role
  definitions are inline strings inside the skill. Externalising them makes
  them swappable and lets `ZippyPanel`-style consumers ship custom roles.
* **Shape** Create `skills/mateam/agents/{backend,frontend,reviewer,…}.md`
  with the same frontmatter; loader resolves `name`→file at fan-out time.
  Cap at 4 concurrent per the existing cross-agent-protocol rule.

### 2.4  Mateam scratch-dir layout (already proven in the wild)

* **From** `<local-projects>\Tomorrow Inc\Factory-Registry-v1\.autoclaw\mateam\scratch\<date>-<lane>\{plan,context,output}.md`.
* **Why** A real production mateam run already chose this layout. AutoClaw's
  `skills/mateam/` currently doesn't enforce a layout, so consumers are
  forking conventions.
* **Shape** Document this exact triplet (`plan.md` / `context.md` /
  `output.md`) in `skills/mateam/SKILL.md` and add a `_template/` dir the
  skill copies in.

### 2.5  Plugin/extension points for runners

* **From** `KiroAutomation/extension/src/plugins/PluginInterfaces.ts` —
  `TaskProcessor`, `PromptGenerator`, `CompletionDetector` with explicit
  pre/process/post hooks, registry, discovery.
* **Why** AutoClaw runners (`src/runners/*`) are hard-coded per host. A
  Kiro-style interface would let third parties ship runners as VS Code
  extensions that AutoClaw discovers.
* **Shape** Define `src/runners/pluginInterfaces.ts` mirroring the three
  Kiro interfaces. Existing runners (`runners/claude-code`,
  `runners/kilocode`, etc.) implement the interface; loader scans
  `vscode.extensions.all` for contributions named `autoclaw.runners`.

### 2.6  Plane separation (`control / conversation / media / integration`)

* **From** `<local-projects>\ZippyVoice\Docs\design-document.md §1`.
* **Why** AutoClaw is starting to grow a "cloud relay" (commit `9ae660c`)
  and a perpetual loop (`1653976`) in the same package. ZippyVoice's plane
  model is the right mental separation for `daemon/` (control),
  `orchestrator/` (conversation/work), `runners/` (media analog — the side
  that actually does work), `mcp/` + `bridge/` + `cloud/` (integration).
* **Shape** Rename `docs/V3_PLAN.md` section headings to those four planes
  and group new packages accordingly. No code move — just terminology
  alignment so contributors know which plane a change belongs in.

### 2.7  Approval/governance overlay (mission-control style)

* **From** `openclaw-mission-control` README — "route sensitive actions
  through explicit approval flows", activity timeline, gateway-aware
  orchestration.
* **Why** AutoClaw's MCP write-tool gate (commit `1653976`) is binary
  allow/deny. A two-state "needs approval / approved by `<human>` at `<ts>`"
  log gives ZippyPanel and Factory-Registry a real audit trail.
* **Shape** Add `.autoclaw/orchestrator/approvals/{pending,approved,denied}/`
  with one JSON per write-gate trip. Surface in the existing status bar
  panel (`src/statusbar/`) with a quick-pick to approve. Defer the dashboard
  UI to ZippyPanel.

### 2.8  Provider-routing layer (LLM proxy)

* **From** `9router` / `lm-proxy` / `RouteLLM` / `zippymesh-llm-router` /
  `open-llm-router` (five different forks the user keeps in scope).
* **Why** AutoClaw assumes whatever the host is. A small provider-routing
  shim inside the cloud-relay (Sprint 4 cloud relay MVP, commit `9ae660c`)
  lets a single user share Claude Code on one machine and OpenAI on another
  through the same orchestrator.
* **Shape** Don't write a new router. In `src/cloud/relay.ts`, add a
  `provider: string` field on inbound requests and route to whichever
  runner's `isAvailable()` matches. Document `zippymesh-router` as the
  recommended external proxy.

### 2.9  Webview/sidebar pattern from Webster

* **From** `Webster/webster-v1.0.0/README.md` — a 420-px sliding panel with
  chat + context scraping + DOM action execution.
* **Why** AutoClaw already has a webview (`src/webview/`, `media/`). The
  Webster split (background service worker ↔ content script ↔ isolated
  sidebar) is a cleaner mental model than the current single-webview design.
* **Shape** No immediate change — file under `docs/IDEAS_LOG.md` as a
  pattern to consider for a future "AutoClaw browser companion" if cross-
  machine routing (memory item `project_phase2_part_b_complete.md`) ever
  reaches a browser host.

### 2.10  `STFU.md` as an optional verbose-mode counter

* **From** `GoZippy/STFU.md` fork.
* **Why** Several AutoClaw skills (mateam, orchestrate) produce wall-of-text
  responses; ZippyPanel users complained. Adding an opt-in "concise" overlay
  prompt is free.
* **Shape** Add `.claude/rules/concise-mode.md` (off by default) and a
  `autoclaw.conciseMode: boolean` setting that, when true, prepends the
  overlay to dispatched agent prompts.

### 2.11  Idea-honing → research → design → impl spec tree

* **From** `ralph-orchestrator/.ralph/specs/<feature>/{rough-idea,idea-honing,
  research/*,design/detailed-design,implementation/plan}.md` directory
  structure.
* **Why** AutoClaw's research lives flat under `docs/research/` with
  date-prefixed filenames. Ralph's per-feature directory keeps everything
  about one feature co-located, which would have made finding the v2.5.0
  capability-router work faster.
* **Shape** New work after 2026-05-22 should use
  `docs/specs/<feature>/{idea,research/*,design,plan}.md`. Existing
  `docs/research/v2-*-report.md` files are kept for history.

---

## 3. VoidSpec deep-dive — sibling repo vs AutoClaw's `src/voidspec/`

### What the sibling `GoZippy/VoidSpec` actually is

* Standalone VS Code/Void IDE extension (TypeScript, ~34 KB `extension.ts`,
  ~31 KB compiled `extension.js`). MIT-licensed.
* Default branch: `VoidSpec_v1`. Last push 2026-05-21 — actively maintained.
* Feature set per its `README.md`:
  * Spec generation from a feature description → writes `requirements.md`,
    `design.md`, `tasks.md` to `specs/`.
  * A/B prompt testing with rubric scoring + CSV export.
  * Visual task overlay + milestone auto-archive.
  * Drag-and-drop workflow designer (n8n-style) with Activity Bar views.
  * Premium/free tier gating.
  * Grok (xAI) API integration as the spec generator.
* Layout: `src/{ai,logging,milestones,spec,ui}/`, `extension.ts`, `tests/`,
  rich `docs/` (PRD, design_spec, plan_spec, distribution_strategy, …).
* `.voidrules` declares: docs under `docs/`, specs under `specs/`, templates
  under `.voidspec/templates/`, workflow defs under `.voidspec/workflows/`.

### What AutoClaw's `src/voidspec/` actually is

* Three TS files (~36 KB total): `types.ts`, `sync.ts`, `dispatch.ts` plus a
  test file. Pure file-I/O + string processing; no LLM calls, no network.
* Job: **bidirectional sync** of a `tasks.yaml` (any VoidSpec-shaped) ↔
  AutoClaw's sprint state.
  * Shared-id namespace: `VS-<id>` (`src/voidspec/types.ts:136`).
  * Conflict rule: VoidSpec wins on "what" (title/desc/deps), AutoClaw wins
    on "how far" (status). See `sync.ts:11-17`.
  * Status vocabulary normaliser handles ~12 synonyms (`types.ts:183-209`).
  * Dispatch: prefers a `runner-voidspec` runner if available, else native
    conversion (`dispatch.ts:55-90`).
* Tests cover round-trip, write-back, conflict, dispatch, and a real-FS
  end-to-end (`src/test/voidspec.test.ts`).

### Comparison

| Axis | `GoZippy/VoidSpec` extension | AutoClaw `src/voidspec/` |
|---|---|---|
| Purpose | **Generate** specs/tasks via AI | **Sync** existing specs/tasks bidirectionally |
| Source of truth | Itself | The external VoidSpec workspace |
| Has AI | Yes (Grok) | No — pure I/O |
| Owns UI | Yes (panels, designer) | No — VS Code command only |
| Owns task file | Writes `specs/*.md` | Reads/writes `.voidspec/tasks.yaml` only |
| Tests | Has `tests/` + `coverage/` | Has unit tests + 6 suites |
| Compatible? | Yes — AutoClaw reads what VoidSpec writes; `tasks.yaml` is the contract | — |

### Recommendation: **complementary, not merge**

1. **Keep them separate.** VoidSpec is a *producer* (AI → spec files);
   AutoClaw's `voidspec/` is a *consumer* (spec file → execution state).
   Merging would entangle a Grok-dependent producer with AutoClaw's
   currently provider-agnostic execution layer.
2. **Formalise the contract.** Lift the `tasks.yaml` shape AutoClaw parses
   (`src/voidspec/types.ts` + `sync.ts:42-118`) into a small spec doc
   `docs/specs/voidspec-tasks-yaml.md` and PR it to `GoZippy/VoidSpec` as the
   canonical task-file format. That removes the "best-effort YAML parser"
   risk on AutoClaw's side.
3. **Reuse VoidSpec's `docs/` discipline.** VoidSpec ships `prd.md`,
   `design_spec.md`, `plan_spec.md`, `distribution_strategy.md` as a fixed
   set. Adopt the same fixed names under `docs/specs/<feature>/` per §2.11.
4. **Defer a `runner-voidspec` runner** until VoidSpec actually exposes a
   programmatic dispatch API (today it's command-driven only). The seam in
   `dispatch.ts:55-95` is already correct — leave it alone.
5. **Cross-link.** Add a top-of-file comment in
   `src/voidspec/types.ts` pointing at `github.com/GoZippy/VoidSpec` so the
   relationship survives author turnover.

---

## 4. Don't-do list — anti-patterns seen in the survey

1. **Doc-archive sprawl.** `Yufok1/Convergence_Engine/docs/archive/<date>/`
   has 80+ retrospective Markdown files (`*_FIX*.md`,
   `*_INTEGRATION*.md`, `*_VERIFICATION*.md`). AutoClaw already has 17
   files in `docs/research/`; cap it at one report per release and a
   single rolling `docs/IDEAS_LOG.md`. Don't dated-archive every fix.

2. **Putting `.kilo/node_modules/` and `.autoclaw/node_modules/` under
   source control.** Seen in `ZippyPanel` (hundreds of `README.md` results
   in `node_modules/`). AutoClaw's `.gitignore` already covers
   `node_modules` — keep it that way and audit consumer projects.

3. **README that's a single line.** `GoZippy/CLAUDE-CODE-SYSTEM-PROMPT/README.md`
   = `"living document for Claude Code system prompt\n\ngg"`. If a doc is
   one line, it's a `docs/TODO.md` placeholder, not a README. AutoClaw's
   `docs/AGENT_DAEMON_CRITIQUE.md` is at risk of this — either fill it or
   merge it.

4. **`README-SECURE.md` and `SECURITY-ANALYSIS.md` as separate top-level
   files.** Seen in `AgentWise`. AutoClaw should keep security findings in
   a single audit log under `.autoclaw/orchestrator/consensus/security/`,
   not a top-level proliferation.

5. **Auto-generated Lovable scaffolds in personal-named repos** (the long
   tail of `Zippy-s-Public-Stuff/*-NNNNN` repos). Don't let AutoClaw's
   `autobuild` skill commit experiments to personal/public namespaces by
   default — keep them in `.autoclaw/autobuild/scratch/` until promoted.

6. **Re-invented sprint-assignment templates.** ZippyPanel has *three*
   variants: `.autoclaw/orchestrator/templates/sprint-assignment.md`,
   `.kiro/steering/parallel-agents.md`, `scripts/sprint-kickoff.md`. They
   disagree on field order and naming. Pick one (the
   `parallel-agents.md` shape — it's the most complete) and delete the
   rest in consumer projects. AutoClaw should ship exactly one template.

7. **Multi-line agent role definitions inlined into TypeScript strings.**
   Saw this in AutoClaw's `skills/mateam/` (referenced from
   project memory). Externalise per §2.3 — no inline role prompts.

8. **Naming a default branch something other than `main`/`master`.**
   VoidSpec uses `VoidSpec_v1` as the default branch. That breaks every
   tool that assumes `main`. Don't follow this; keep AutoClaw on `master`.

9. **"Best-effort YAML parsers" in production code.** `src/voidspec/sync.ts`
   currently rolls its own (`parseVoidSpecYaml`, lines 61-118). It works,
   but it's a foot-gun. Once the contract per §3-2 is published, replace
   with a real YAML parser (already a transitive dep via `yaml` package).

10. **Mixing memory storage roots.** `Webster/.autoclaw/kdream/memory/MEMORY.md`
    uses a different layout than `<local-projects>\autoclaw\.autoclaw\` (kdream
    has `journals/`, `lineage/`, `nursery/`, `audit/`). Document the
    canonical layout in `docs/specs/kdream-memory-layout.md`; don't let
    each consumer invent its own.

---

## 5. Concrete next steps for AutoClaw (ordered, low-risk first)

1. Add `docs/specs/voidspec-tasks-yaml.md` documenting the `tasks.yaml`
   contract AutoClaw parses today. (Pure documentation — no code change.)
2. Add `docs/specs/_template.spec.md` with spec-as-contract frontmatter.
3. Add `skills/mateam/_templates/{plan,context,output}.md` matching the
   Factory-Registry layout in §2.4.
4. Externalise mateam sub-agent roles to
   `skills/mateam/agents/*.md` per §2.3.
5. Define `src/runners/pluginInterfaces.ts` (no implementation churn — just
   the interface).
6. Publish the `VS-` namespace rule and conflict policy in
   `docs/specs/voidspec-shared-namespace.md` (lifted directly from
   `types.ts:136-181`).
7. Audit consumer projects (ZippyPanel, Webster, Factory-Registry) and pick
   the single sprint-assignment template per §4-6.

None of these touch `package.json`, `tsconfig.json`, or `extension.ts`.
