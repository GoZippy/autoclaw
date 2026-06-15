# Multi-Project Orchestration — Architectural Review & Integrated Plan

**Status:** Review + plan (2026-06-15)
**Reviewer:** Claude Code (`agent_id = claude-code`), on the AutoClaw repo
**Reviews:** `CheckItFixIt/docs/MULTI_AGENT_MULTI_PROJECT_ORCHESTRATION.md` (the "CIF proposal")
**Companion broadcast:** `comms/inboxes/shared/20260615-pm-feature_request-claude-code.json`

This document critiques the CIF multi-project proposal **against what AutoClaw
already ships or has designed**, corrects the places where it reinvents or
diverges from existing conventions, and folds the genuinely-new parts into the
existing v3.1 → v4 roadmap. It is written for the AutoClaw orchestrator + the
human owner, not for CheckItFixIt.

---

## 0. TL;DR verdict

The proposal is **directionally right and solves a real, live problem** (the
Guru-Connect fan-out + concurrent-session collisions). But it was written from
inside the CheckItFixIt repo without sight of AutoClaw's existing fleet,
program-plane, hook, and ORG-model work, so **three of its four pillars
partially duplicate or diverge from designs we already have**, and its single
most valuable idea (`dependencies.json` + `api_change`) is the one piece with
*no* existing equivalent.

| CIF pillar | Verdict | Why |
|---|---|---|
| **F1/F3 — workspace/scope claiming** | **Rework, don't adopt as-written** | Diverges from the shipped task-claim convention *and* the unshipped scope question is already answered by the **program-plane registry**. Right idea, wrong home + duplicate axis. |
| **F4 — dependency registry + `api_change`** | **Adopt & extend** | Genuinely new. Highest value. Tie it to contract tests + the intelligence layer. |
| **F2 — `{project,role,assignee,depends_on}` tracking** | **Fold into ORG model** | Overlaps `org.yaml`/sub-orchestrator (V4 ORG-1..4) + fleet roles. Board-shape extension is good and compatible. |
| **F6 — hooks** | **Adopt — but it's a NEW hook system, not our existing one** | AutoClaw has zero harness-level (`.claude/settings.json`) hooks. PreToolUse enforcement is a real capability gap. Do NOT conflate with our orchestrator-side `triggerHooks` runtime. |
| **F5 — platform independence** | **Already our posture** | Reinforces existing all-local / vendor-neutral direction. No change needed. |

---

## 1. What the proposal gets right

1. **The problem is real and already biting.** The doc was *born from a live
   collision* — the authoring subagent was scoped to docs-only because another
   agent was editing `src/` payment code concurrently. This is exactly the
   failure `AGENT_SESSION_PROTOCOL.md §5.4` warns about, now manifesting across
   *projects*, not just tasks.
2. **The Guru-Connect fan-out is the correct priority target.** One producer
   (`payments-api`, `tenant-api`, `zippycoin-api`) feeding CheckItFixIt **and**
   ZippyHealth is the highest-blast-radius edge in the workspace. A silent
   breaking change there surfaces at runtime in a *different* repo.
3. **"Offload to a hook" is the right instinct** — enforcement that depends on
   an agent *remembering* the protocol is the honor system, and the honor
   system already failed (that's why the doc exists).
4. **Advisory-first, block-opt-in is the correct rollout shape.** Hard-locking
   on day one would break the very multi-session workflow it's trying to
   protect.
5. **Backward-compatible, additive file conventions** — extending existing
   `comms/`, `board.json`, `state.json` rather than a greenfield rewrite is the
   right discipline and matches how AutoClaw has grown.

---

## 2. Where it collides with what we already have (the corrections)

### 2.1 Claiming — the proposal opens a *third* claim convention

We already have **two** claim notions in tension, and the proposal would add a
third without reconciling them:

| Convention | Where | Granularity | TTL | Heartbeat? |
|---|---|---|---|---|
| **Implemented** (`src/orchestrator/claim.ts:22`) | `comms/agents/<agent>/claim-<taskId>-<ts>.json` | **task** | **10 s** | none (passive expiry) |
| **Documented** (`AGENT_SESSION_PROTOCOL.md §4`, `cross-agent-protocol.md`) | `comms/claims/<task-id>.json` | **task** | 2 h | owner-heartbeat staleness |
| **CIF proposal** | `claims/{project}.json` (array) | **project / path-glob** | 30 min | 2-min heartbeat |

Two problems:

- **The code and the protocol doc already disagree** on path and TTL. Adding a
  third schema cements the drift. **Fix the existing divergence first** (pick
  `comms/claims/` as canonical, give `claim.ts` heartbeat renewal) before
  layering scope-leases on top.
- **Task-claim and scope-lease are orthogonal axes that the proposal
  conflates.** "I own work item CIF-FIX-12" (a *task* claim — fast, 10 s,
  headless-dispatch contention) is not the same as "I hold a lease over
  `src/payments/**` for the next 30 min" (a *scope* lease — human-paced editing
  session). Folding `task_id` into the scope record blurs them. Keep them
  separate: **a task claim *implies* a scope lease**, but a long editing
  session can hold a scope lease with no task claim at all. Different TTLs are
  correct *because* they're different things — do not unify the 10 s and 30 min.

**Recommendation:** Add scope-leases as a **new, distinct primitive** layered
on the existing claim infra — not a redefinition of `claims/`. The one piece
the proposal has that our `claim.ts` lacks and *should* gain regardless is
**heartbeat-renewed leases with explicit expiry** (our current task claims
expire passively and silently).

### 2.2 The "where do claims live" open question is already answered

The proposal's **open question #5** (per-repo `.autoclaw/` vs one shared root)
is the entire subject of **`docs/specs/program-plane-registry.md`** — a Phase-4
spec with a defined pull-forward path, motivated by the *exact same scenario*
(Kiro's note: "an agent working autoclaw has no visibility into the ZippyPanel
sprint").

Putting `claims/checkitfixit.json` and `dependencies.json` **inside the
CheckItFixIt repo** is the wrong home: a *cross-project* registry living in one
of the projects means the other repos can only see it if CheckItFixIt happens
to be checked out at a stable path. **Cross-project claims and the dependency
registry belong in the program plane** (`~/.autoclaw/programs/<id>/`), which is
machine-global and repo-agnostic by design. This single correction resolves
open questions #5 **and** #7 (session identity — the program plane already
defines `<machine_id>::<platform>::<window_id>`, and beacons already carry
`session_id` + `machine_id` + `workspace_id`).

**This is the most important architectural change: the CIF proposal is really
a request to pull the program plane forward from Phase 4, plus add two new
sub-registries to it (cross-project leases + dependencies).**

### 2.3 PM/PO roles overlap the planned ORG model

The proposal invents `po-guru-connect` / `pm-*` bot identities and a parallel
role scheme. We already have:

- **Fleet roles** (`src/fleet/architecture.ts`, `src/roles/`) — 13 canonical +
  unlimited custom, with resolution precedence `fleet.json` → setting →
  registry → inferred. `product-owner`, `tech-lead`, `qa-verifier`,
  `release-manager` are *already in the planned roster* (V4 ORG-3).
- **The V4 ORG model** (`docs/V4_PLAN.md §2.P2`): `org.yaml` manifest (roles →
  personas → delegation + reporting edges), sub-orchestrator (team-lead owns a
  feature scope, runs a mini-sprint, reports up), and a `status_report` message
  type flowing up reporting edges.

**Recommendation:** Do **not** mint a separate PM/PO identity scheme. Express
PO/PM as **fleet roles scoped per project in `org.yaml`** (e.g. role
`product-owner` with `scope: guru-connect`). The proposal's board-shape
extension — adding `{project, role, assignee, status, depends_on}` to tasks —
is good, additive, and compatible; adopt *that* part directly. The key rule the
proposal states ("PO/PM coordinate, never edit source") is correct and should
become an `org.yaml`-enforced invariant. The **autonomy posture** for these
roles is specified in §3.7 (target: fully-autonomous-but-gated, user-toggled).

### 2.4 "Hooks" means two different things — don't conflate them

AutoClaw already has a `src/hooks/` runtime, but it is **not** what the
proposal means:

| | AutoClaw `triggerHooks` (exists) | CIF proposal hooks (new) |
|---|---|---|
| Lives in | `.autoclaw/orchestrator/hooks.yaml` | `.claude/settings.json` |
| Fires on | `message`/`heartbeat_stall`/`claim_stale`/`consensus`/`autobuild_fail` (FS-watched events) | `PreToolUse`/`PostToolUse`/`Stop`/`SessionStart`/`SubagentStop` (harness tool lifecycle) |
| Can it block an edit? | **No** — passive; only `dispatch`/`notify`/`launch_skill`/`spawn_runner`/`relay` | **Yes** — `exit 2` blocks the tool call |
| Who runs it | the orchestrator loop | the Claude Code harness |

These are **complementary, not the same system.** The proposal introduces a
genuinely missing capability: AutoClaw ships **zero** harness-level hooks today
(`.claude/settings.json` has only `enableAllProjectMcpServers`). PreToolUse
edit-guarding at the tool boundary is the strongest, most novel part of the
proposal *because* it's the only thing that can actually **enforce** a lease
rather than detect a violation after the fact.

**Two caveats the proposal under-weights:**

1. **Enforcement is asymmetric.** Only Claude Code supports PreToolUse blocking
   (`registry.json hooks_supported: false` for Kilo/Antigravity). So the hook
   blocks Claude Code while peers stay on the honor system — the disciplined
   agent gets handcuffed while the undisciplined one roams free. Mitigation:
   pair the hook with an **MCP-exposed lease API** (see §3.2) so *every* vendor
   participates uniformly, and treat the PreToolUse hook as a Claude-Code
   *optimization* layered on the cross-vendor MCP/protocol floor — exactly the
   posture the proposal already takes for F5.
2. **`exit 2` on every Edit is a hot path.** A PreToolUse hook runs on *every*
   mutation. It must be a fast local binary/script reading a single JSON file —
   not an LLM call, not a network hop. Budget < ~20 ms. Cache the project→claim
   resolution per session.

---

## 3. New ideas & integrations (the part worth getting excited about)

These go beyond the proposal and exploit assets it didn't know existed.

### 3.1 `dependencies.json` → an actual contract-test gate

The proposal stops at *notifying* consumers. Go one step further and make it
**verify**:

- The `backends`/`contract` block already names an OpenAPI spec
  (`contract: openapi:guru-connect/payments-api/v3.yaml`). On an `api_change`,
  the orchestrator can **auto-run the consumer's contract tests** (in the
  consumer repo) and attach pass/fail to the `api_change` message.
- Wire this into the **existing consensus + autobuild** machinery: a *breaking*
  `api_change` opens a consensus item that the consumers' POs must approve, and
  the producer's merge is gated on consumer contract tests going green
  (reuses `autobuild_fail` → hook → notify). This turns "we told you" into "we
  proved it still works."

### 3.2 Expose lease/claim/dependency ops as MCP tools (interop floor)

We already have `autoclaw-mcp` (read tools shipped; `claim_task` write tool
planned in V3 Workstream B+). **Add `lease.acquire` / `lease.release` /
`lease.list` / `dependency.check` as MCP write-tools.** This is the
vendor-neutral enforcement floor that fixes the §2.4 asymmetry: Kilo, Cursor,
Antigravity et al. call the MCP tool; Claude Code *additionally* gets the
PreToolUse hook as belt-and-suspenders. One implementation, every host.

### 3.3 Intelligence layer → conflict prediction + auto contract-surface detection

The shipped intelligence layer mines past sessions, a tool×project
effectiveness matrix, and workflow sequences (corpus: ~2130 Claude Code
sessions). Two high-value uses:

- **Predict collisions before they happen.** Co-edit frequency from session
  history → suggest scope-lease boundaries ("these files are almost always
  edited together; claim them as one scope") and warn when two live leases sit
  on historically-coupled files even if globs don't literally intersect.
- **Auto-detect contract surfaces.** Instead of hand-maintaining
  `consumed_via` globs, mine which files actually export the API symbols
  consumers import. Keeps `dependencies.json` honest as code drifts.

### 3.4 Cross-project DAG in the fleet panel

The panel (KDreamViewProvider) already renders fleet/beacons. Add a
**producer→consumer edge view** sourced from `dependencies.json`, highlighting
the Guru-Connect fan-out and flashing edges with a pending `api_change`. Makes
the invisible cross-repo coupling visible — directly serves the v4 "fleet
visibility" vision already in memory.

### 3.5 Self-host alignment (Proxmox / Supabase-exit)

The whole mechanism is plain files under `.autoclaw/` → already portable to
Proxmox and git-syncable. One concrete tie-in: when the program plane needs a
*live* (not poll) cross-machine bus, ride the **already-self-hosted
Guru-Connect WebSocket** (the same realtime channel replacing Supabase
realtime) as the `bus_driver: "ws"` option the program-plane spec already
anticipates — no new hosted dependency, consistent with the platform-
independence principle.

### 3.6 Lease negotiation instead of flat denial

`claim_denied` shouldn't be a dead end. When two `claim_request`s overlap, the
orchestrator can propose an **automatic scope split** (e.g. `src/payments/**`
→ requester A keeps `src/payments/gateways/**`, B takes
`src/payments/intents/**`) via the existing `question`/`answer` round-trip,
falling back to a queue if no disjoint split exists. Maximizes parallelism,
which is the whole point of path-scope granularity.

### 3.7 Autonomy model — fully-autonomous-but-gated PO/PM bots (user decision)

**Decision (2026-06-15, owner):** target **fully autonomous PO and PM bots**
that the user can **turn on or off per project or per sprint**, defaulting to a
user-configurable autonomy level (`autonomous` ↔ `human-in-the-loop`) set in
project/space settings. The goal is *high-context, long-running, creatively
autonomous* coordinators that are **non-destructive by construction and gated
in their lanes** — guardrails that add safety **without** clipping the bots'
autonomy or creativity.

The way to get autonomy *and* safety simultaneously is to make the bots
powerful at **planning/breakdown/ownership/review** while making it
*structurally impossible* for them to damage the main tree. Concretely:

1. **Capability fence, not a behavior request.** PO/PM bots are denied
   source-mutation capability at the tool layer (the same PreToolUse edit-guard
   from §2.4, configured so a `role: product-owner|project-manager` session has
   an **empty writable scope** for code — they may write only to
   `board.json`, `org.yaml`, comms, and planning docs). "Coordinate, never edit
   source" stops being a rule an agent must remember and becomes a thing the
   harness/MCP layer won't let them do. This is *non-destructive by
   construction*, so the bots can run wide open inside their lane.

2. **A review/validation management layer owns the gate to `main`.** No
   bot-produced work reaches the main tree without passing an explicit
   ownership→review→validation pipeline:
   `dev agent delivers → reviewer agent(s) + automated tests/contract tests →
   consensus sign-off → PR upstream`. The PO/PM bots *own and drive* this
   pipeline (assigning, tracking, escalating, re-dispatching on red) but the
   **merge authority is the gate, not the bot** — work lands only when the
   gate is green. This reuses the existing consensus + `autobuild` +
   review-SLA machinery; the api-change contract-test gate (§3.1) plugs in here.

3. **Autonomy levels are a setting, enforced as a gate strength.** Per
   project/sprint the user picks:
   - `autonomous` — bots plan, assign, review, and open PRs end-to-end; the
     human is notified, not asked. Gate = automated tests + peer-consensus.
   - `human-in-the-loop` — same bot behavior, but the final merge/PR step
     requires a human approval in the gate (an "Awaiting You" item).
   - `off` — PO/PM bots dormant; classic dev/reviewer flow only.
   Default is user-set per space. The toggle changes *where the gate sits*, not
   *what the bots may attempt* — so turning on HITL never makes the bots dumber,
   it just adds a human checkpoint at the merge boundary.

4. **Safety loops are first-class, not bolt-ons.** Every PO/PM decision cycle
   runs: plan → assign → (dev work, gated) → validate (tests + review) →
   reconcile (the existing drift gap-analysis) → report up (`status_report`).
   A failed validation re-opens the task, never silently merges. Reward-hacking
   fences from the Fable-5/LFD playbook apply (the bot is graded on *gate-green
   delivered work*, not on activity), and the reconciliation sweep surfaces any
   bot-introduced drift as a `finding_report` rather than auto-fixing it.

5. **Larger-project breakdown & ownership controls.** The PO bot owns
   `priority` + `depends_on` (including cross-project edges from
   `dependencies.json`); the PM bot owns `assignee` + `status` and decomposes
   epics into the sprint DAG via `/orchestrate`. Ownership is expressed as
   `org.yaml` scope (a role owns a project or a path-scope), and the
   sub-orchestrator (V4 ORG-2) is the natural home for a per-feature team-lead
   bot that decomposes, runs a mini-sprint, and reports a summary up the
   reporting edge.

This is strictly more ambitious than the CIF proposal's "PO/PM coordinate,
never edit source" and supersedes the earlier draft answer to open question #4.

---

## 4. Recommendations on the proposal's 7 open questions

1. **Warn vs block** → **Warn-only default; block opt-in per project**, but
   make it *enforced via MCP for all hosts* + PreToolUse for Claude Code.
   Recommend blocking ON by default for **producer** repos (Guru-Connect),
   where the blast radius justifies friction.
2. **Claim granularity** → **Path-scope globs**, with intelligence-layer
   co-edit hints to keep scopes sensibly sized (§3.3). Whole-project is just a
   `**` scope — no need for two mechanisms.
3. **Lease TTL & heartbeat** → 30-min TTL / 2-min heartbeat is fine for
   editing sessions; allow per-task override for big refactors (XL effort →
   longer TTL). Keep the **10 s task-claim** TTL untouched — different axis.
4. **PO/PM — bots or you?** → **Fully autonomous PO *and* PM bots, user-
   toggleable per project/sprint** (`autonomous` / `human-in-the-loop` / `off`),
   made safe by a capability fence + a review/validation merge gate rather than
   by limiting bot autonomy. Full model in **§3.7**.
5. **Cross-repo scope** → **Program plane** (`~/.autoclaw/programs/<id>/`), not
   per-repo. Pull the program-plane registry forward. (See §2.2.)
6. **Breaking-change gate** → **Notify always; block-on-consensus for
   `breaking: true` only.** Non-breaking changes notify without gating, so the
   gate doesn't become noise that agents learn to ignore.
7. **Session identity** → Already solved: program-plane
   `<machine_id>::<platform>::<window_id>` + beacon `session_id`/`workspace_id`.

---

## 5. Revised phased rollout (merged into the existing roadmap)

The proposal's P1–P4 are good but should be re-homed onto existing tracks so we
don't fork the architecture.

| Phase | Deliverable | Builds on (existing) | New |
|---|---|---|---|
| **MP-0 — reconcile claims** | Fix the `claim.ts` vs protocol-doc divergence; add heartbeat-renewed leases + explicit expiry to the existing claim infra. | `src/orchestrator/claim.ts`, `AGENT_SESSION_PROTOCOL.md §4` | — |
| **MP-1 — program plane (pull-forward)** | Implement `~/.autoclaw/programs/<id>/registry.json` + "Join Program" command. Home for cross-project state. | `docs/specs/program-plane-registry.md` | pull-forward from Phase 4 |
| **MP-2 — scope leases** | New scope-lease primitive in the program plane; `lease.*` MCP tools; warn-only PreToolUse edit-guard for Claude Code. | claim infra, `autoclaw-mcp` write-tools | PreToolUse hook (first harness hook) |
| **MP-3 — dependency registry** | `dependencies.json` in the program plane + `api_change` flow + Stop-hook contract-surface diff. | consensus, `autobuild`, `conflictDetection.ts` | `dependencies.json`, `api_change` |
| **MP-4 — contract-test gate** | Auto-run consumer contract tests on breaking `api_change`; gate producer merge on consensus + green tests. | autobuild, consensus | contract-test runner |
| **MP-5 — ORG/PM-PO** | `org.yaml` per-project role scoping; board `{project,role,assignee,depends_on}`; `status_report`; **autonomous PO/PM bots** with per-project/sprint autonomy toggle (`autonomous`/`HITL`/`off`), capability-fenced + merge-gated per §3.7. | `org.yaml` (V4 ORG-1..4), fleet roles, consensus + autobuild gate | board-shape extension, autonomy levels, capability fence |
| **MP-6 — intelligence + panel** | Co-edit conflict prediction; auto contract-surface detection; cross-project DAG panel view. | intelligence layer, KDreamViewProvider | conflict-prediction, DAG view |

MP-0/MP-1 are prerequisites; MP-2/MP-3 deliver the bulk of the proposal's
value; MP-4/MP-6 are the force-multipliers that justify doing it inside
AutoClaw rather than as a CheckItFixIt-local hack.

---

## 6. What I would NOT build

- **A second claim schema.** Reconcile first; extend, don't fork.
- **Per-repo `dependencies.json`.** Cross-project state must be program-plane.
- **A separate PM/PO identity namespace.** Use fleet roles + `org.yaml`.
- **Hard-block on day one for consumer repos.** Friction without payoff;
  warn-only earns trust first.
- **Any hosted component.** Stays under `.autoclaw/` / program plane, git- and
  Proxmox-portable, per the platform-independence principle.

---

## 7. One-line summary for the orchestrator / PM bots

> Adopt the CIF proposal's **`dependencies.json` + `api_change`** and
> **PreToolUse enforcement** ideas; re-home its **claims** onto a pulled-forward
> **program plane** (don't fork the claim schema); express **PM/PO** as
> `org.yaml`-scoped fleet roles (don't mint new identities); and multiply its
> value with **contract-test gating, MCP lease tools, and intelligence-driven
> conflict prediction.**
