# Fable 5 Agent Patterns — What AutoClaw Should Borrow

_Date: 2026-06-11 — research synthesis, no source code modified._
_Author: claude-code research session._

## 0. Source

@0xCodez, **"Build self-improving agent system with Fable 5 in 14 steps:
loops, dynamic workflows, routines"** (X article, June 11, 2026; the body is
auth-gated but the **user supplied the full text verbatim**, so this synthesis
is grounded in the primary source, not derivatives). Cross-checked against the
authoritative Fable 5 behavioral guidance bundled in the `claude-api` skill
(`shared/model-migration.md` → Migrating to Claude Fable 5). The article cites
Anthropic engineering posts (Lance Martin, Prithvi Rajasekaran), the Parameter
Golf and Continual Learning Bench experiments, and Fable's launch docs
(launched June 9, 2026).

> Benchmark figures below (verification coverage %, ~6× Parameter Golf, SWE
> numbers) are the article's / Anthropic's claims — indicative. The
> **architecture and prompting discipline** is the durable takeaway and is
> high-confidence.

**Why this matters for us:** AutoClaw *is* an agent system — an orchestrator
that decomposes goals, spawns scoped sub-agents, gates on review, and persists
coordination state. The article is essentially an external spec for the thing
we already build (`orchestrate`, `mateam`, `kdream`, the cross-agent protocol,
the fabric). Its value is **validation + a concrete checklist of gaps**, not a
new paradigm.

---

## 1. The reframe: self-improving ≠ self-learning

The article's central correction, worth internalizing before any AutoClaw work:

- **Self-learning** = the model updates its own weights. Fable 5 does **not**
  do this; no production model does. (Recursive self-improvement is a
  *direction*, not a shipping capability.)
- **Self-improving** = the *system around* the stateless model compounds. Each
  session writes lessons to memory; Skills sharpen as edge cases are added;
  state files accumulate verified facts; eval loops refine prompts/rubrics.
  **The model stays the same; the environment it runs in gets sharper.**

> "Rather than directly prompting and steering Fable 5, it's often better to
> design loops that let the model self-correct in response to environment
> feedback (e.g. `/goal` or Outcomes) and manage its own context (e.g. via
> memory)." — Anthropic engineering

### The compound stack (build bottom-up; leverage compounds upward)

| Layer | Contents | AutoClaw analog |
|---|---|---|
| **4 · Self-improvement** | vision self-checks, eval loops, rule distillation | `verify`, `code-review`, consensus gates → write lessons back |
| **3 · Memory** | state files, Skills, knowledge bases, written lessons | `kdream` consolidation; this repo's `MEMORY.md` convention; fabric KG |
| **2 · Orchestration** | `/goal`, Outcomes, Dynamic Workflows, Routines | `orchestrate` DAG/sprints, `mateam` fan-out, `autobuild`/`schedule`, `loop` |
| **1 · Primitives** | Fable 5, sub-agents, worktrees, tools | the spawned agents + Agent-tool `isolation: worktree` |

Every layer-1 output flows up to layer 4, gets graded/distilled, and is written
back to layer 3 — so tomorrow's layer-1 run inherits sharpened memory and
refined Skills. **AutoClaw already has all four layers; what's thin is the
"write the graded lesson back" arc that closes the loop.**

---

## 2. The 4-tier cost-capability routing (most actionable for spawning)

The single most directly applicable idea. Fable 5 is ~**5× Opus 4.8 per token**
of real work ($10/$50 list = 2× Opus, but the new tokenizer spends ~30% more
tokens and it thinks longer on hard tasks). So production teams **route by task
complexity, not by default** — the same pattern Anthropic uses internally:

| Tier | Model | Role |
|---|---|---|
| Orchestrator | **Fable 5** (`claude-fable-5`) | Plan across days, delegate, vision-check, distill rules from accumulated evidence. Reserve for where "days at a time" earns the price. |
| Hard-bounded subtasks | **Opus 4.8** (`claude-opus-4-8`) | Architecture decisions, complex debugging, deep code reviews delegated by the orchestrator. **Also the explicit fallback** for any request Fable's classifiers block. |
| High-volume workers | **Sonnet 4.6** (`claude-sonnet-4-6`) | Lint passes, simple refactors, test scaffolding, doc updates — the bulk of fan-out. |
| Graders / classifiers | **Haiku 4.5** (`claude-haiku-4-5`) | Independent-context verifier sub-agents and cheap classifiers. Low cost, fresh window — ideal for the verifier role. |

> **AutoClaw takeaway (P0):** our spawning paths (`mateam`, the subcontract
> tree, the capability router) should make **model tier a first-class routing
> decision**. Orchestrator/planner → Fable 5 or Opus 4.8; fan-out workers →
> Sonnet 4.6; verifier/grader sub-agents → Haiku 4.5; classifier-block fallback
> → Opus 4.8. The cross-agent protocol already advertises "LLMs available /
> cost budgets / trust level" (IDEAS_LOG §A.2) — this says *route on those
> fields by economics.* Most AutoClaw work should **not** run on Fable.

---

## 3. The three primitives (orchestration layer)

### 3.1 Loops — `/goal` vs Outcomes (same idea, two harnesses)

Both: a goal/rubric → model runs → **an independent grader checks** → not-met
starts the next iteration → exit when the grader passes. The structural move
that makes them work: **the agent that wrote the code is not the agent that
grades it.**

- `/goal` (Claude Code) — local, in-session, quick, measurable end state.
  Hands-on coding, flaky-test debugging, single-file refinement.
- Outcomes (Managed Agents) — hours/days on hosted infra (sandbox, GPUs);
  file-based rubric with gradable criteria, sub-agent grader, hard
  `max_iterations`.

> **AutoClaw:** `orchestrate` already has review gates and the cross-agent
> `WORK → REPORT → LOOP` cycle. The gap is that our gates are *reviewer
> judgment*, not a **goal + checkable rubric the gate actually runs.**

### 3.2 Dynamic Workflows (Claude Code, shipped 2026-05-28)

Claude writes its **own JS harness on the fly** — `agent()`, `parallel()`,
`pipeline()` primitives plus plain JS to process data between stages. Custom
per task, not generic. Three of six documented patterns fit self-improving
systems: **fan-out-and-synthesize** (N independent pieces, each its own clean
context), **adversarial verification** (a fresh verifier per maker), **loop
until done** (spawn until a stop condition — no new findings / no errors). The
other two: **classify-and-act** (useful for model routing, §2) and **tournament**
(taste-based ranking).

> **AutoClaw:** this is exactly what `orchestrate` produces — a dependency DAG
> + sprint plan. The new framing is the **primitive vocabulary** (fan-out /
> adversarial-verify / loop-until-done) and that the plan should be **strictly
> followed once written**, with per-stage ordering guaranteed.

### 3.3 Worktrees — parallel safety for multi-agent runs

The moment >1 agent runs, files collide. A git worktree = separate working dir
on its own branch sharing repo history, so one agent's edits can't touch
another's checkout. Maker in worktree A, verifier reads worktree B (or A
read-only); parallel structural experiments each in their own worktree; each
days-long phase a separate worktree so a failed phase doesn't poison the rest.
Claude Code exposes this three ways: `git worktree`, a `--worktree` flag, and
**`isolation: worktree` on subagents** (fresh checkout, self-cleaning).

> **AutoClaw:** our cross-agent protocol enforces scope via *claims* + branch
> discipline (the filesystem-as-mutex). Worktrees are the stronger isolation —
> and the Agent tool in this very harness already supports
> `isolation: "worktree"`. `mateam`/`orchestrate` should default parallel
> sub-agents to worktree isolation rather than relying on scope honesty.

### 3.4 Routines (research preview, 2026-04-14)

Saved Claude Code configs (prompt + repos + connectors + permissions) that run
on Anthropic cloud **with your laptop off**. Three triggers → three
self-improvement patterns:

- **Schedule** — "morning briefing": nightly re-run the eval suite, distill new
  failure modes into Skills, post a digest. Sharper while you sleep.
- **API** — "fire on event": CI fails → investigate; Sentry alert → triage.
- **GitHub event** — "learn from real work": PR open → eval against latest
  Skills; merge → write new patterns back to the Skill.

> **AutoClaw:** `autobuild` + `schedule` cover the cron shape; the reframe is
> that a routine should fire a **goal-loop with a checkable rubric**, not a
> one-shot prompt — and that long, "days-long" runs belong on cloud infra
> (CMA/Routines), which is exactly the territory the **fabric** is heading
> toward (cross-machine, laptop-independent execution).

---

## 4. The self-improvement layer

### 4.1 Verifier sub-agent beats self-critique (structural, not effort)

A model grading its own output sees its own reasoning trail and prefers
conclusions consistent with what it wrote; a separate model sees only the
artifact + rubric. "A verifier sub-agent tends to outperform self-critique with
Fable 5." Parameter Golf: Fable 5 + independent verifier made larger structural
changes and pushed *through* a regression to its biggest win (~6× baseline);
Opus 4.7, self-checking, got stuck tweaking scalars after the first "good
enough" (~1.2×).

> **AutoClaw:** this is our `review_request → review_response → consensus_vote`
> flow — but it argues the reviewer must be a **fresh agent context** (≠ the
> author's session), and the order should be explicit: **deterministic checks
> (tests/linters/builds) → adversarial reviewer → human gate on irreversible
> actions.** Make "reviewer ≠ author session" a hard rule. Graders → Haiku 4.5.

### 4.2 The 5-stage memory progression + the STATE.md file

From the Continual Learning Bench: **Fail → Investigate → Verify → Distill →
Consult.** Sonnet 4.6 exits at stage 1 (notes + guesses, rarely consulted);
Opus 4.7 at stage 3 (~17% verification coverage); Fable 5 completes it (up to
73%). Where the model writes each stage's output is a **state file** with
sections matching the stages:

```markdown
## Verified facts        # stage 3 — stop guessing; each line says how it was checked
## General rules         # stage 4 — consult before re-deriving
## Open failures         # stages 1–2 — work in progress, with repro pointer
## Lessons learned       # stage 4 — distillations
## Last session          # stage 5 — resume pointer, not restart
```

Two operational rules decide whether it compounds or just grows: **write before
walking away** (every session ends by updating STATE.md) and **read at session
start** (without this, even Fable 5 regresses to Sonnet-class memory behavior).

> **AutoClaw:** this *is* `kdream`'s memory-consolidation mandate and mirrors
> this repo's own `MEMORY.md` + one-fact-per-file convention. The discipline we
> lack: **mark each memory with how/when it was verified** (a `Verified-by:`
> line — stage 3 vs a stage-1 guess), and enforce **read-at-start /
> write-at-end** in spawned-agent and cross-agent cycles. The fabric's "shared
> knowledge graph of thoughts" (IDEAS_LOG §A.8) is the multi-agent STATE.md.

### 4.3 Skills that compound (procedural memory that travels)

STATE.md is project memory; **Skills are procedural memory** — "how to do this
kind of thing," across projects. After any non-trivial failure, write the
lesson **into the Skill itself**: it grows `Known failure modes` and
`Anti-patterns (do NOT do)` sections, plus an `Eval suite` line so the loop
verifies the Skill. Skills live in `~/.claude/skills/` and travel with you;
two weeks of disciplined writing beats whatever Fable derives from scratch.

> **AutoClaw:** AutoClaw *ships as skills* (`orchestrate`, `mateam`, `kdream`,
> `autobuild`, …). "Write the confirmed lesson back into the skill, not just
> the chat" is a concrete practice we can adopt for our own skill files —
> each accrues a Known-failure-modes / Anti-patterns section over time. This
> is the highest-fidelity match in the whole article.

### 4.4 Self-verification via vision

Maker writes UI → renders a screenshot → **verifier reads the screenshot with
vision**, compares against the goal, the project's design tokens, and the
previous screenshot in STATE.md → match = done, mismatch = structured diff back
to maker. No human reading the screenshot.

> **AutoClaw:** net-new capability for any UI-producing consumer (e.g. the
> ZippyPanel UI). A `verify`-style gate that screenshots and vision-checks
> against design tokens would catch the failure class text-only review misses.

### 4.5 The Mythos safety boundary — design for the fallback

Fable 5 ships classifiers that decline **cyber / bio / chem / distillation** and
**fall back to Opus 4.8 automatically** (returned as `stop_reason: "refusal"` /
substitution; <5% of sessions; not billed at Fable rates). The classifier is
broad — security tooling, SAST, crypto-primitive review, scientific computing
can all trip it. A loop that *silently* fails on a block looks identical to a
real error until you debug it.

> **AutoClaw takeaway:** any AutoClaw path that pins `claude-fable-5` **must**
> (a) handle `stop_reason: "refusal"` before reading content, (b) route blocked
> task classes to Opus 4.8 explicitly or surface them to a human, (c) have
> Skills document which task classes may hit the classifier, and (d) confirm
> the org meets Fable's **30-day data-retention** requirement (ZDR orgs 400 on
> *every* request) and review retention terms for sensitive data. Treat the
> boundary as a known fallback, not a failure mode.

---

## 5. The 14 steps → AutoClaw surface map

| # | Article step | AutoClaw surface / action |
|---|---|---|
| 01 | Fable 5 = Mythos-class, days-long autonomy | fabric (laptop-independent, long-horizon execution) |
| 02 | self-improving ≠ self-learning | framing for kdream / memory design |
| 03 | the 4-layer compound stack | the AutoClaw architecture itself |
| 04 | cost-capability matrix (route by complexity) | **capability router / `mateam` spawn — P0** |
| 05 | `/goal` vs Outcomes (independent grader) | `orchestrate` review gates + `loop` |
| 06 | verifier sub-agent > self-critique | consensus/review — fresh reviewer session, **P1** |
| 07 | Dynamic Workflows (fan-out / adversarial / loop-until-done) | `orchestrate` DAG vocabulary |
| 08 | worktrees for parallel safety | `mateam` subagents → `isolation: worktree`, **P1** |
| 09 | Routines (schedule / API / GitHub triggers) | `autobuild` / `schedule` → rubric loop |
| 10 | 5-stage memory progression | kdream consolidation model |
| 11 | the STATE.md file (read-at-start / write-at-end) | repo memory convention + cross-agent state, **P1** |
| 12 | Skills that compound | write lessons back into AutoClaw's own skills, **P2** |
| 13 | vision self-verify | new `verify` gate for UI tasks, **P2** |
| 14 | Mythos safety boundary / fallback | refusal handling on any Fable call site, **P1** |

---

## 6. Anthropic's Fable/Opus behavioral snippets — bake into spawned prompts

From the authoritative migration guide; reusable as **system-prompt fragments
for any agent AutoClaw spawns** (most also help Opus 4.8). Fable's un-steered
failure modes are over-planning, unrequested tidying/refactors, fabricated
progress claims, adjacent-but-unrequested actions, and (rarely) early stopping
or "context anxiety." Mitigations:

- **Anti-overplanning:** "When you have enough information to act, act. Don't
  re-derive established facts or re-litigate decided questions. Give a
  recommendation, not a survey." *(We already ship a near-identical preamble
  line — keep it in spawned prompts.)*
- **No unrequested tidying:** "Don't add features, refactor, or introduce
  abstractions beyond what the task requires; only validate at system
  boundaries; don't handle scenarios that can't happen."
- **Grounded progress:** "Before reporting progress, audit each claim against a
  tool result from this session. Report only what you can point to." *(Hardens
  honest-reporting hard rule #6 + `task_complete`.)*
- **State boundaries:** "When the user is describing a problem or thinking out
  loud, the deliverable is your assessment — report findings and stop; don't
  apply a fix until asked."
- **Async sub-agents:** "Delegate independent subtasks and keep working while
  they run; intervene if one goes off track." *(The fabric's bidirectional-
  channel goal.)*
- **Memory surface:** "Store one lesson per file with a one-line summary; record
  corrections and confirmed approaches with why; update rather than duplicate;
  delete notes that prove wrong." *(= this repo's memory convention.)*
- **Autonomous-loop guard (for unattended kdream/routine runs):** "You're
  operating autonomously; the user can't answer mid-task, so don't ask 'Want me
  to…?'. For reversible actions that follow from the request, proceed. Before
  ending a turn, if your last paragraph is a plan/question/promise — do that
  work now."
- **`send_to_user` tool:** for async agents that must deliver verbatim content
  mid-run (tool inputs are never summarized).
- **Effort discipline:** default `high`; `xhigh` for the hardest coding/agentic
  work; `low`/`medium` for routine sub-agents. Don't reflexively pin `xhigh`.

API-shape reminders for Fable call sites: thinking always on (omit the param;
explicit `disabled` 400s); no sampling params; no assistant prefill; handle
`refusal`; re-baseline budgets with `count_tokens` (model `claude-fable-5`);
30-day retention required.

---

## 7. Gap analysis → prioritized recommendations

AutoClaw already does the hard parts (decompose/delegate/verify, review gates,
consensus, file-persisted coordination state, scheduled builds, file-based
memory, capability advertisement). The article validates all of it. Gaps to
close, in priority order:

> **Verified against the codebase 2026-06-12** (two read-only sweeps). The
> recommendations below are no longer speculative — current state confirmed:
> - **Router** scores `capability × trust × idle / cost` ([orchestrate.ts:482](../../src/orchestrate.ts#L482-L520))
>   but **ignores model tier** — agents advertise `llms_available`
>   ([agent-card.ts](../../src/agent-card.ts)) yet `scoreAgent` never reads it. **PARTIAL.**
> - **Review gate** `evaluateConsensus` ([orchestrate.ts:1404](../../src/orchestrate.ts#L1404-L1525))
>   tallies **votes only** — quality-gate commands are mentioned in the skill but
>   **not wired** into the flow. **PARTIAL (opinion, not evidence).**
> - **Reviewer ≠ author**: **no rule** — `ValidationVote` ([:1310](../../src/orchestrate.ts#L1310))
>   lets an author vote on their own task. **MISSING.**
> - **Budgets**: `token_budget_remaining`/`cost_budget` **specced**
>   ([heartbeat-v2.md:47](../specs/heartbeat-v2.md#L47-L75)) but **not implemented**. **PARTIAL.**
> - **Kill switch / cycle ceiling**: per-step SIGKILL + git-diff conflict warnings
>   exist; **no fleet kill switch, `max_cycles` not runtime-enforced.** **PARTIAL.**
> - **kdream memory**: read-at-start/write-at-end + size archiving present
>   ([skills/kdream/SKILL.md:41](../../skills/kdream/SKILL.md#L41-L53)); **no
>   verified-by provenance, no hot/cold layering.** **PARTIAL.**
> - **Work-state resume**: only coordination state persists; **per-task work is
>   not checkpointed** — a killed agent restarts work. **MISSING.**
> - **Worktree isolation**: scope-claims + branch discipline only; **no worktrees**
>   (the Agent tool supports `isolation: worktree`). **MISSING.**
> - **Goal/outcome loop**: loop is a fixed task list with `max_cycles` HALT; **no
>   outcome metric, no forced-entropy stall recovery.** **MISSING (net-new).**
>
> **The top-3 lowest-effort/highest-ROI items (reviewer≠author, tier×phase
> routing, gate-runs-acceptance-command) are now specced:**
> [`docs/specs/orchestrate-gates-and-routing.spec.md`](../specs/orchestrate-gates-and-routing.spec.md).

| # | Recommendation | Lands in | Effort |
|---|---|---|---|
| P0 | **Model-tier routing as a first-class decision** — orchestrator on Fable/Opus, workers on Sonnet 4.6, graders on Haiku 4.5, classifier-block fallback on Opus 4.8; route on the advertised cost/capability fields. | capability router, `mateam`, subcontract tree | M |
| P0 | **Checkable rubrics per task** — command + pass-condition; the review gate *runs* it before consensus, so votes are evidence-grounded. | `orchestrate`, `mateam`, cross-agent consensus | M |
| P1 | **Fresh-context verifier sub-agents** — reviewer ≠ author session; order = deterministic checks → adversarial review → human gate on irreversible actions. | cross-agent protocol (hard rule) | S |
| P1 | **STATE.md discipline** — read-at-start / write-at-end in spawned + cross-agent cycles; `Verified-by:` provenance on consolidated memories. | `kdream`, repo memory convention | S |
| P1 | **Default parallel sub-agents to worktree isolation** instead of scope-honesty. | `mateam`, `orchestrate` | S |
| P1 | **Refusal/fallback handling + 30-day-retention check** on any Fable call site. | any `claude-fable-5` integration | S |
| P2 | **Routines fire goal-loops, not one-shots** (`autobuild`/`schedule` → rubric loop). | `autobuild`, `schedule`, `loop` | S |
| P2 | **Compounding skills** — write confirmed lessons back into AutoClaw's own skill files (Known-failure-modes / Anti-patterns sections). | all AutoClaw skills | S |
| P2 | **Vision-verify gate** for UI-producing tasks (screenshot vs design tokens). | `verify` | M |
| P2 | **Spawned-agent prompt library** — ship the §6 behavioral fragments as reusable blocks. | `mateam`/`orchestrate` templates | S |

None require a rewrite. The article's real contribution is **discipline**:
economic model routing, checkable rubrics, fresh-context verification, verified
read-at-start/write-at-end memory, compounding skills, and explicit handling of
the safety boundary.

---

## 8. The anti-pattern checklist (the article's "§ mistakes", as AutoClaw don'ts)

- Don't run Fable like Sonnet-with-more-context (5-min prompt-and-close burns
  Mythos pricing for no compound effect) → **route by complexity.**
- Don't self-critique → **independent verifier sub-agent.**
- Don't run without STATE.md → every session restarts from zero.
- Don't let Skills go stale → write lessons back after real failures.
- Don't put routine work (docs, lint, simple refactors) on Fable → Sonnet 4.6.
- Don't run days-long sessions on a laptop → cloud (CMA/Routines/fabric).
- Don't ignore the safety boundary → architect the Opus-4.8 fallback explicitly.
- Don't text-only-verify visual output → vision-verify.
- Don't skip `/goal`/Outcomes → loops without an objective grader stop at
  "handled enough," not "done."
- Don't skip the retention-policy review for sensitive data.

---

## 10. Addendum — comment harvest (read live from X via CDP-attached Chrome)

The @0xCodez thread's replies surfaced three things worth keeping:

- **Two reference repos to mine.**
  - `serenakeyitan/awesome-agent-loops` — a catalog of real `/loop` (interval),
    `/goal` (condition), and `/schedule` (cloud cron) patterns. Its organizing
    principle is a **nested-loop architecture — "timer outside, condition
    inside, skill innermost"** (`/loop` wraps `/goal` wraps a skill), with
    verification after each turn and bounded turn limits. Clean framing for how
    AutoClaw's `loop` → `orchestrate`/goal-gate → task-skill should nest.
  - `yucai0302/memory-loop` — a Claude Code **plugin that productizes the
    STATE.md discipline**: `.claude/memory/` with `MEMORY.md` (hot layer,
    injected every session via a **SessionStart hook**), `archive.md` (cold
    layer), `schema.yaml`; a **Stop hook** warns when memory grows too large;
    `/memory-loop:save` writes structured entries; `/memory-loop:compress`
    archives old entries past an ~8K-char threshold. Near-drop-in design
    reference for **kdream**, and validates this repo's own `MEMORY.md`
    convention — with one idea to adopt: **automatic hot/cold compaction with a
    size threshold + hooks**, not just manual curation.
- **Production critique (@ToolRadarAI): "ship audit logs, diffs, and a kill
  switch."** A clean checklist for AutoClaw's bounded-autonomy story: per-step
  **audit logs** (already flagged P1), **diff surfacing** (show what each agent
  changed), and an **emergency kill switch** (beyond cycle-ceiling HALT — an
  operator stop that halts the whole fleet now). Add kill-switch + diff to the
  bounded-autonomy recommendations.
- **Unverified:** a reply claimed an "Anthropic Mythos system prompt leak" (gist
  by @gerardsans) framing Fable/Mythos as a *full agentic system* (local file
  access + search + skills + context management), not a raw model. Treat as
  **unverified rumor** — don't propagate or build on it; noted only because it
  echoes the article's "the model is the substrate, the system compounds"
  thesis. (@rewind02's "state files change the whole game" corroborates the
  STATE.md emphasis.)

## 9. Sources

- @0xCodez, "Build self-improving agent system with Fable 5 in 14 steps"
  (full text supplied by the user; X article body is auth-gated).
- Anthropic — Claude Fable 5 / Mythos 5 launch (2026-06-09); authoritative
  behavioral/migration guidance in the `claude-api` skill
  (`shared/model-migration.md` → Migrating to Claude Fable 5); cited Anthropic
  experiments: Parameter Golf, Continual Learning Bench 1.0.
- Derivative deep-dives consulted while the body was gated: explainx.ai
  (loop/memory), lushbinary.com (long-horizon architecture); comparison
  write-ups (ofox.ai, ayautomate.com, vanbeaumond.nl, rdworldonline.com) for
  indicative benchmark numbers.
