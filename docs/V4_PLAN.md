# V4 Plan — An Agent Development Organization in a Box

_Drafted 2026-06-12 from user steering (see memory: project_v4_vision_steering)
plus the 2026-06-11 research wave (Fable-5 agent patterns, loss-function
development) and a full repo inventory. **V3_1_ROADMAP.md remains the source of
truth for in-flight v3.x work**; this doc governs the arc after it. Naming
follows house convention (`V<major>_PLAN.md`); epics carry themed prefixes for
BACKLOG.md._

---

## 0. North star

**From idea to shipped product, run like a real development organization —
usable by a senior engineer, a vibe coder, or a noob with an idea.**

A real org has layers: someone owns the product goal, someone architects,
someone breaks work down, many hands build in parallel, peers review, QA
verifies against acceptance criteria, a release manager ships, and everyone
reports upward while retaining autonomy downward. AutoClaw v4 is that org as
software: personas for the roles, the comms bus for the reporting lines, the
subcontract tree for delegation, gates for QA, the fleet panel for the
manager's wall, and memory so the org *learns*.

Default assumption: **orchestration is long-running.** A project is opened once
and managed for weeks, not prompted for minutes. (Per the Fable-5 research:
"the model is stateless; the system around it compounds.")

### Principles (carry over from v3, sharpened)

1. **Local-first** — files in-repo are the source of truth; relay/cloud is opt-in transport.
2. **Visibility ≠ centralization** — every layer *publishes* status upward; no layer *routes* through the top. Delegated autonomy is the point.
3. **Opt-in everything** — absent new config, behavior is byte-identical (the gates/routing spec set the pattern).
4. **Evidence over opinion** — gates run commands; rubrics are fenced; reports are audited against tool results.
5. **Don't reimplement the host** — `/loop` and `/schedule` are Claude Code natives; AutoClaw supplies the prompts, configs, and harnesses *for* them and for every other host (Cursor, Kiro, Codex CLI, Hermes, OpenClaw…).

---

## 1. Where we are (inventory, 2026-06-12)

Stronger than commonly assumed — most pillars have a foundation already:

| Capability | Exists today |
|---|---|
| Fleet dashboard | `src/panel/fleetPanel.ts` — agent cards, parent↔subagent tree, "Awaiting You", activity feed, cost ledger, LMD health grid |
| Heterogeneous runners | 9 native: claude-code, cursor, kiro, gemini-cli, codex, hermes, openclaw, autogpt (+ kilocode bridge companion) — `src/runners/` |
| Delegation | Subcontract state machine (`src/orchestrator/subcontract.ts`) + protocol message family; atomic claims |
| Personas | `PersonaProfile` + loader + architect skill; per-persona bi-temporal memory shards with privacy gating (`src/memory/personas.ts`) |
| Memory tiers | core/recall/archive with bi-temporal facts (`src/memory/tiers.ts`); kdream consolidation pipeline; KG daemon (`packages/kg-daemon`) |
| Gates & routing | Verifier independence live; acceptance-command gate + tier×phase routing lib (this week — `docs/specs/orchestrate-gates-and-routing.spec.md`) |
| Cross-machine | Self-hostable relay + heartbeat/inbox forwarding (v3.3.0); fleet-view pull partial (AF-10c) |
| Metrics/cost | p50/p95/p99 task durations (`src/metrics.ts`); cost ledger (`src/mcp/costLedger.ts`); audit comms-log |

The v4 work is mostly **closing loops between systems that already exist**, not
building new ones.

---

## 2. Pillars and epics

### P1 · ONB — Onboarding & guidance (noob → engineer)

*Today:* starter templates (`skills/orchestrate/templates/starter/`), per-host
bootstrap prompts (protocol §7), 8 IDE adapters. *Gap:* no interview, no guided
path; "Launch Skill" is a flat prompt list that assumes you already know what
orchestration is.

- **ONB-1 — `/autoclaw init` interview.** A conversational wizard: *what are you
  building → how hands-on do you want to be → which agents/IDEs do you already
  have → long-running or one-shot?* Output: a scaffolded manifest (tasks with
  `phase`, `acceptance`, `criticality`), goals doc, recommended personas, and
  the right bootstrap prompts for the user's installed hosts. Three presets:
  **Guided** (noob: wizard decides, explains everything), **Standard**,
  **Expert** (manifest-first).
- **ONB-2 — Launch Skill catalog rework.** Replace the flat list with a
  goal-oriented picker: "Start a new project / Resume orchestration / Add an
  agent to the fleet / Review & merge / Health check", each with a one-line
  *when-to-use* and the filled-in prompt. (Direct response to "current list is
  limited and hard to understand.")
- **ONB-3 — Steering surface.** A `GOALS.md`-style standing context file the
  orchestrator reads every cycle (project intent, constraints, taste), editable
  by the user anytime — the "give context and steering" channel, modeled on the
  Fable guidance to state the full goal up front.
- **ONB-4 — Long-running by default.** `init` offers to set up the loop
  scaffolding per host (Claude Code: `/loop` + `/schedule` prompt snippets;
  other hosts: their loop equivalents or AutoClaw's orchestratorLoop) with HALT
  + budget rails pre-configured.

### P2 · ORG — The dev-team org model (roles, delegation, reporting)

*Today:* personas (architect shipped; security-auditor, doc-writer planned),
subcontract machine, agent types (coder/runner/auditor/supervisor/assistant/
governance). *Gap:* no org chart wiring the roles together; no sub-orchestrator.

- **ORG-1 — Org-chart manifest.** `org.yaml`: roles → personas → delegation
  edges (who may subcontract to whom) and reporting edges (who summarizes to
  whom, on what cadence). The orchestrator enforces edges; the fleet panel
  renders the chart.
- **ORG-2 — Sub-orchestrator (team lead) role.** A supervisor-type agent that
  owns a scope subtree: claims a feature, decomposes it, runs its own
  mini-sprint with its own workers, and reports a *summary* upward —
  the protocol's subcontract family, promoted to a first-class layer. This is
  the structural answer to "delegated autonomy at reasonable layers."
- **ORG-3 — Full persona roster.** Ship the remaining core roles: product-owner
  (turns user intent into manifests), tech-lead (sub-orchestrator default
  persona), qa-verifier (runs acceptance gates + adversarial review),
  release-manager (merge/changelog/publish), plus the planned security-auditor
  and doc-writer. Each persona = SKILL.md + PersonaProfile + memory shard.
- **ORG-4 — Reporting cadence.** Standardized `status_report` message
  (summarized, evidence-linked) flowing up the reporting edges; rendered in the
  panel's activity feed. Workers keep working; managers read summaries.

### P3 · VIS — Heterogeneous fleet visibility (see everything, force nothing)

*Today:* FleetPanel (single machine), board.json, LMD health, relay forwarding.
*Gap:* cross-machine view (AF-10c), message-flow visualization, non-VS-Code
session tracking.

- **VIS-1 — Finish AF-10c fleet-view GA.** Cross-machine agent rows live in the
  panel via relay pull (already partially cached).
- **VIS-2 — Message-flow view.** Render the comms log as a conversation graph:
  who asked whom for what, which reviews are pending, which subcontracts are
  open — the "see messaging between agents" ask. Data already exists
  (comms-log.jsonl + inboxes); this is a panel surface.
- **VIS-3 — Session beacons for un-bridged tools.** A tiny convention + helper
  so any external session (a Codex CLI run, a Hermes daemon, a Cursor chat)
  can drop heartbeat/status files into the comms tree (or POST to the bridge)
  without adopting the whole protocol — minimum-viable visibility for
  heterogeneous work. The MCP server's read tools already give such agents
  recall/fleet.status; this adds the *write-presence* half.
- **VIS-4 — Work-product trail.** Per-task diff surfacing in the panel (link
  each completed task to its branch diff + gate results + review verdicts) —
  the research's "audit logs, diffs, kill switch" triad completed.

### P4 · FED — Federated autonomy (no forced hub)

*Today:* relay forwards heartbeats/inboxes machine-to-machine; bus drivers
fs/ws/nats. *Gap:* peer-to-peer delegation across machines still implicitly
assumes the orchestrator in the middle.

- **FED-1 — Peer delegation.** Subcontract requests routable agent→agent across
  machines via relay without orchestrator mediation; orchestrator gets the
  audit copy (visibility), not a veto (autonomy). Governance agents retain veto
  only where `org.yaml` says so (e.g. security scopes).
- **FED-2 — Capability marketplace.** Agents publish `capability_offer`s
  (already in the protocol) into a queryable directory; any agent (not just the
  orchestrator) can discover and subcontract a capable peer. Pairs with REP-1
  so discovery is ranked by track record.
- **FED-3 — Long-running self-learning workers.** First-class lifecycle for
  always-on agents (OpenClaw, Hermes): register once, advertise capabilities +
  memory surface, accept subcontracts over the bridge, report learnings back to
  shared memory (MEM-3).

### P5 · REP — Reputation & track-record routing

*Today:* task durations only; cost ledger; consensus outcomes written but not
aggregated. *Gap:* nothing records *success*, so routing can't prefer "agents
that succeeded at similar tasks before."

- **REP-1 — Track-record ledger.** Append-only per-agent record per completed
  task: capability tags, phase, outcome (consensus verdict + gate pass/fail),
  duration, cost, rework count. Sources already exist (voteWriter, gate_checks,
  metrics, costLedger) — this is a join, exactly the shape the cost-ledger S4
  plan anticipated.
- **REP-2 — Reputation factor in `scoreAgent`.** A per-(agent, capability)
  success EMA as another soft multiplier alongside `tierFactor` — same opt-in,
  never-zero pattern. New agents get a neutral prior (cold-start safe).
- **REP-3 — Spawn-by-reputation.** When fan-out needs a new worker, prefer
  instantiating the runner/persona with the best track record on similar tags
  (and surface *why* in the audit log).

### P6 · MEM — Memory that compounds (the overhaul)

*Today:* tiers + bi-temporal facts + persona shards + kdream pipeline + KG
daemon — strong but **fragmented**; no provenance; no cross-agent sharing.
*Gap targets (from the Fable/LFD research + user: "memory is still lacking").*

- **MEM-1 — Provenance on every fact.** `verified_by` (command/session/task
  evidence) + the 5-stage discipline (fail→investigate→verify→distill→consult)
  on all writers (kdream, personas, orchestrator). A fact without provenance is
  a guess and is ranked as such.
- **MEM-2 — One write/read contract.** Single `memory` module API all writers
  use (tiers, persona shards, KG ingest) so a lesson lands once and is
  queryable everywhere; read-at-start/write-at-end enforced via HKS hooks at
  session boundaries (memory-loop pattern from the comment harvest).
- **MEM-3 — Cross-agent shared memory.** Workspace-scoped shared lessons
  (privacy-gated, like the persona global mirror) so one agent's verified fix is
  every agent's context — the fabric's "knowledge graph of thoughts" made real
  via the existing KG daemon.
- **MEM-4 — Skills that compound.** After non-trivial failures, the responsible
  persona appends to its own SKILL.md (`Known failure modes` / `Anti-patterns`)
  via micro-PR — the kdream dream pipeline already has the micro-PR mechanism.

### P7 · HKS — Hooks & event automation

Specced: `docs/specs/agent-trigger-hooks.spec.md` (event→action rules: message/
stall/consensus/build-fail → dispatch/notify/launch_skill/spawn_runner/relay,
with cooldowns, audit, no self-amplification, and the **fleet HALT kill
switch**). This is the "trigger other agents and chat sessions to check in and
begin working" layer.

- **HKS-1..5 —** per the spec's sequencing table (pure matcher → dispatch/notify
  → HALT → launch_skill/spawn_runner → relay).

### P8 · QLT — Quality substrate (gates, budgets, goal-loops)

*Today (this week):* verifier independence live; acceptance gate + tier×phase
routing lib (+ live activation in flight). *Remaining from the research:*

- **QLT-1 — Budgets as instruments.** Implement heartbeat-v2's
  `token_budget_remaining` + cost fields; a `budget` query any agent can call
  ("a constraint without an instrument is a vibe"); wall-clock + spend HALT
  ceilings enforced at runtime.
- **QLT-2 — Goal/outcome loop.** An outer loop mode for orchestrate: descend
  toward a metric with a fenced rubric (LFD's 4-part loss function as the task
  template), stall detection + forced-entropy nudge, iteration log. Nested-loop
  shape: host timer (`/loop`) outside, condition (goal gate) inside, skill
  innermost.
- **QLT-3 — Work-state checkpoint/resume.** Per-task progress snapshots in the
  claim dir so a killed window resumes, not restarts — the prerequisite for
  credible "days-long" runs.
- **QLT-4 — LFD designer skill.** A `/lfd`-style persona step that generates the
  rubric + instruments + fences for a goal (model: elvisun/loss-function-development).

---

## 3. Sequencing

| Wave | Target | Epics |
|---|---|---|
| **v3.4** (next) | Close the quality loop + first automation | finish gates live-activation; HKS-1..3 (hooks + HALT); REP-1 ledger; ONB-2 catalog rework; MEM-1 provenance |
| **v3.5–3.6** | The org takes shape | ONB-1 init interview; ORG-1/2 org chart + sub-orchestrator; VIS-1/2 fleet GA + message flow; REP-2 scorer factor; QLT-1 budgets; MEM-2 unified contract |
| **v4.0** | Organization in a box | ORG-3/4 full roster + reporting; FED-1/2/3 federation; VIS-3/4; REP-3; MEM-3/4; QLT-2/3/4 goal-loops + resume |

Gating rule for every epic: **opt-in, golden no-op test, evidence-grounded
acceptance** (the pattern set by `orchestrate-gates-and-routing.spec.md`).

## 4. Relationship to prior plans

- `V3_1_ROADMAP.md` — still authoritative for Phases A–D in flight (personas,
  LLM providers). V4 pillars absorb its trajectory: ORG-3 continues its persona
  phases; REP-1 implements its S4 cost-ledger join.
- `DISTRIBUTED_AGENT_FABRIC.md` / BACKLOG AF-x — FED + VIS epics are the
  continuation; AF-10c lands as VIS-1; AF-11 (A2A) feeds FED-1.
- Research wave 2026-06-11 (`research/2026-06-11-*.md`) — P5/P6/P7/P8 implement
  its prioritized recommendations; the gates spec was its first slice.

## 5. Don't-do

- No forced hub: any design where worker→worker traffic must transit the
  orchestrator fails review (visibility copies are fine).
- No silent automation: every hook/dispatch/spawn is audited; HALT stops all of it.
- No reimplementation of host primitives (`/loop`, `/schedule`, subagents) —
  integrate, don't clone.
- No new memory store before MEM-2 unifies the three we have.
- Cloud/relay remains opt-in; local-first tracking stays (no GitHub-issue
  migration — per standing user preference).
