# Fleet Federation — inviting outside agents, self-healing, and self-aware roles

> AutoClaw design idea — drafted 2026-06-16. Expands the user's request: let many
> agents from OpenClaw, Hermes, other chat sessions, and other IDEs (each in its
> own workspace) **join this project's team**, pick up the role the project needs,
> recover from their own failures, and stay aware of what the project still needs.
>
> Status: **proposal for discussion + iteration**. Sibling docs it builds on:
> - [STANDARDIZED-ADAPTER-A2A-PLATFORM.md](STANDARDIZED-ADAPTER-A2A-PLATFORM.md) — the `acp/1` connector standard (how an outside tool becomes a peer at all).
> - [../FLEET_ARCHITECTURE.md](../FLEET_ARCHITECTURE.md) — `fleet.json`, beacons, two planes of identity.
> - [../DISTRIBUTED_AGENT_FABRIC.md](../DISTRIBUTED_AGENT_FABRIC.md) — the cross-machine bus + knowledge layer.
> - [../MULTI_PROJECT_ORCHESTRATION_REVIEW.md](../MULTI_PROJECT_ORCHESTRATION_REVIEW.md) — scope-leases, dependency registry, the capability-fence safety model.

This doc covers the three things the connector standard does **not**: the *invite*
(how a human says "come help on this project"), *self-healing* (how the fleet
recovers when an agent dies, stalls, or goes off-scope), and *self-awareness*
(how an arriving agent figures out what the project needs and what role to take).

---

## 0. Where we are today (verified against the code, 2026-06-16)

The plumbing is mostly built; the federation experience is not assembled.

| Capability | State | Where |
|---|---|---|
| Runner adapters for Hermes / OpenClaw / Codex / AutoGPT | **shipped** | `src/runners/{hermes,openclaw,codex,autogpt}.ts` |
| Presence (beacon) file lane | **shipped** | `src/fleet/beacons.ts` (`writeBeacon`/`readAllBeacons`) |
| Messaging envelope + 4 transports (fs / MCP / HTTP bridge / relay) | **shipped** | `src/comms.ts`, `src/mcp/*`, `src/bridge.ts`, `src/cloud/relay.ts` |
| User-authoritative roles + orchestrator | **shipped** | `src/fleet/architecture.ts`, `fleet.json`, 13 roles in `src/roles.ts` |
| Six-phase session loop (REGISTER→…→LOOP, bounded) | **shipped** | `.claude/rules/cross-agent-protocol.md` |
| Drift detection (tasks.md ↔ state.json ↔ sprint YAML) | **shipped, detect-only** | `src/orchestrator/reconcile.ts`, `src/reconcile.ts` |
| `presence.beacon` MCP tool (lets an MCP CLI *check in*) | **MISSING** | gap in `src/mcp/writeTools.ts` — single highest-leverage fix |
| **Invite flow** (a human invites a specific outside agent) | **MISSING** | this doc, §2 |
| **Self-healing recovery** (act on a stall, not just report it) | **MISSING** | reconcile only surfaces; this doc, §3 |
| **Self-aware role election** (agent reads the backlog, takes the needed role) | **MISSING** | this doc, §4 |

So the gap is not "can an outside agent connect" — it can. The gap is "is joining
a *one-step invite*, does the fleet *fix itself* when something breaks, and do
arriving agents *know what to do*." Those three are what turn a pile of connected
agents into a team.

---

## 1. The three pillars, in one picture

```
   ┌── INVITE ───────────────┐   ┌── SELF-HEALING ─────────┐   ┌── SELF-AWARE ────────────┐
   │ human (or orchestrator) │   │ supervisor watches      │   │ arriving agent reads      │
   │ issues a join token →    │   │ heartbeats + claims →    │   │ board gaps + fleet.json → │
   │ outside agent claims it, │   │ stalled? reclaim/redispatch│ │ proposes the role the     │
   │ writes a beacon, lands   │   │ off-scope? revoke + warn │   │ project is short on,      │
   │ as a fleet row (default- │   │ failed? retry/escalate   │   │ user confirms, then loops │
   │ off, scoped, consented)  │   │ NEVER silent, NEVER main │   │ on that lane              │
   └─────────────────────────┘   └─────────────────────────┘   └──────────────────────────┘
                 \                          |                            /
                  \________________  one fleet.json, one comms tree  ___/
                                   one board.json the panel renders
```

Everything stays **local-first** and **the user keeps ultimate control** — an
invite is consent, a role is a proposal the user can override, and a self-heal
action is bounded and logged, never a silent rewrite of `master`.

---

## 2. The invite flow — making "come help" one step

Today an outside agent can join only if a developer hand-writes a beacon and edits
`fleet.json`. We want: **the user points at an agent and says join; the agent shows
up scoped and ready.** Model it as a short-lived, signed *join token* — the same
shape a human team uses for an invite link.

### 2.1 Join token

A file `~/.autoclaw/invites/<token>.json` (or workspace-local
`.autoclaw/orchestrator/invites/`) created by `autoclaw.fleet.invite`:

```jsonc
{
  "token": "join-7f3c…",            // single-use, random
  "issued_by": "claude-code",        // who invited
  "project": "autoclaw",             // workspace_id the agent may join
  "workspace": "<local-projects>/autoclaw",
  "suggested_role": "tester",        // a hint; the user's fleet.json still wins
  "suggested_agent_type": "coder",
  "scope": ["src/test/**", "docs/**"], // path scope the agent is allowed (lease seed)
  "transports": ["fs", "mcp", "http"],
  "expires": "2026-06-17T00:00:00Z", // short TTL
  "trust": "off",                    // arrives non-acting until user raises it
  "consumed_by": null                // stamped on first use, then single-use
}
```

The agent (or its connector) is handed the token out-of-band (copy/paste, QR in
the panel, or pushed over the HTTP bridge). On join it:

1. Reads the token, verifies TTL + unconsumed, stamps `consumed_by`.
2. Writes its **beacon** with `agent_id`, `session_id`, `workspace_id`, `role`
   hint, `transports[]`, `card_url`.
3. Appears in `board.json` / the panel as a **pending** fleet row — visible but
   `trust: off` (cannot edit) until the user promotes it.

### 2.2 Panel UX

- **"Invite agent…"** command → pick project + suggested role + scope → generates
  a token + a copy-paste one-liner + (stretch) a QR code for a phone/other box.
- A **pending tray**: every newly-joined agent lands here first. The user clicks
  **Admit** (writes the agent into `fleet.json`, raises trust to the chosen level)
  or **Decline** (revokes the token, removes the beacon).
- Admitting is the moment the user assigns the *authoritative* role — the agent's
  self-declared role from §4 is only a suggestion in the tray.

### 2.3 Why a token (not just "write a beacon")

A beacon is "I exist." A token is "you are *welcome here, scoped to this*." It
carries the path scope (seeds a scope-lease), the trust ceiling, and the TTL — so
an invited agent is **bounded by construction** and an un-invited beacon is just a
visible stranger with no permissions. This is the consent gate the federation needs
before we let outside code act on the repo.

---

## 3. Self-healing — recover, don't just report

Today `reconcile.ts` **detects** drift and broadcasts a `system` message; it never
fixes anything (correctly — silent auto-fix is a hard rule violation). Self-healing
adds a **supervisor** that takes *bounded, logged, reversible* recovery actions
within rails the user set. It extends, not replaces, the detect-only sweep.

### 3.1 What it watches (signals already on disk)

- **Heartbeat / beacon age** — `BEACON_TTL_MS` staleness (`fleet/beacons.ts`).
- **Claim liveness** — a claim whose owner's heartbeat is stale past TTL
  (`board.json` already computes `owner_healthy`).
- **Task outcome** — `task_complete` vs failing CI / failing review.
- **Scope** — a diff touching files outside the agent's lease (`program/leases.ts`).
- **Drift** — the existing reconcile report.

### 3.2 Recovery ladder (each rung is bounded + logged to the audit dir)

| Symptom | Action | Rail |
|---|---|---|
| Owner heartbeat stale + claim past TTL | **Steal the claim** (delete stale claim, re-open the task as claimable) | only if owner truly stale; logged as `finding_report` first |
| Task dispatched but agent process died | **Re-dispatch** to the next-preferred capable agent (`RunnerRegistry.getPreferred`) | max N retries, then escalate to human |
| Task failed CI / review twice | **Escalate** — open a consensus item / `question` to the orchestrator, stop auto-retry | never silently merge a red build |
| Edit outside lease detected | **Revoke + warn** (downgrade trust, `scope_violation`, re-jail to worktree) | host-enforced, not honor-system |
| Comms tree corrupt / partial write | **Quarantine** the bad file, fall back to last-good, raise a finding | never delete user data |
| Whole agent unreachable | **Mark stale in the panel** (honest presence), re-balance its open lanes | never hide a dead agent |

### 3.3 The safety spine (reuse the decided model)

From the multi-project review's owner decision: bots are made safe by a
**capability fence** (non-orchestrator agents denied source-mutation at the tool /
MCP layer) plus a **review/validation merge gate** that owns the path to `master`
(dev → reviewer + tests → consensus → PR). So self-healing can run *wide open
in-lane* because the dangerous boundary — merging — is held by CI + consensus, not
by trusting the self-healer. Three invariants:

1. **Never act on `master`.** Recovery happens on branches / worktrees; promotion
   is always the existing merge gate.
2. **Never act silently.** Every rung writes an audit entry + a `finding_report`
   before (or with) the action, so the human can see and undo it.
3. **Bounded retries.** A loop ceiling (mirrors the protocol's `cycle ≥ 25`) and
   then a hard escalation to a human — no infinite self-heal storms.

### 3.4 Who runs it

The supervisor is just a role (`orchestrator`) running the loop with one extra
phase: **HEAL** between SYNC and CLAIM. It reads the same signals the panel reads,
applies the ladder, and writes findings. Any agent the user marks `can_orchestrate`
can be the supervisor; if the primary supervisor itself goes stale, a **standby**
(next `can_orchestrate` agent by heartbeat) takes over — self-healing the healer.

---

## 4. Self-awareness — an agent that knows what the project needs

The richest part of the user's ask: an arriving agent should sense *what the
project is short on* and offer to fill that role, instead of waiting to be told.

### 4.1 The "project needs" view (derive, don't invent)

Compute a small **needs vector** from artifacts that already exist:

- **Open lanes by role** — from the active `plan-summary-*.yaml` + `board.json`:
  which workstreams have unclaimed, dependency-satisfied tasks, and what role each
  wants (`required_capabilities`).
- **Role coverage gap** — diff "roles the backlog needs" against "roles currently
  live in `fleet.json` with a fresh heartbeat." E.g. backlog needs `tester` +
  `security`, fleet has two `coder`s and no `tester` → gap = `{tester, security}`.
- **Staleness pressure** — lanes whose owner went stale (feeds §3).
- **Drift / findings backlog** — open reconcile findings nobody has picked up.

This is a read-only summary written to `.autoclaw/orchestrator/needs.json`, and
surfaced in the panel as **"What the project needs right now."**

### 4.2 Role election on arrival

When an agent joins (§2) it:

1. Reads `needs.json` + its **own** Agent Card (`skills[]`, `llms`, `tools`).
2. Scores each unmet need against its capabilities
   (`score = capability_match × idle × trust / cost` — same scorer the router
   uses for task routing).
3. Proposes the best-fit role via a `capability_offer` ("I can be your `tester` —
   I have jest, playwright, and a 1M context").
4. The user (or the autonomous orchestrator, if the project is in autonomous mode)
   confirms → it's written into `fleet.json` → the agent claims a lane and loops.

If two agents propose the same role, the orchestrator picks by score and offers the
runner-up the next-best gap — so a crowd of arrivals self-distributes across needs
instead of dogpiling one lane.

### 4.3 Re-election over time

Self-awareness isn't one-shot. Each loop cycle the agent re-reads `needs.json`; if
its lane drains and a higher-priority gap opens that it can fill, it offers to
**re-role** (release its lease, propose the new role) — bounded by the same consent
gate. That's how a small fleet keeps itself pointed at whatever matters most
without a human re-assigning everyone.

---

## 5. How a specific outside agent joins this project (worked examples)

| Agent | Lane it speaks | Join steps |
|---|---|---|
| **OpenClaw** (headless host, own workspace) | filesystem (or HTTP bridge) | gets a token → `writeBeacon` to `~/.autoclaw/beacons/` → reads `needs.json` → `capability_offer` → admitted → claims a lease → loops |
| **Hermes** (REST agent) | HTTP bridge | `POST /api/v1/heartbeat` with the token → subscribes to SSE `/messages/stream` → offers role → admitted → dispatched |
| **Codex / Copilot / another chat session** (MCP) | MCP | calls the **new** `presence.beacon` tool (once built) → `fleet.cards` to read needs → `inbox.send` a `capability_offer` → admitted |
| **Another IDE in another workspace** (Kiro/Cursor) | filesystem + program plane | joins the **program** (`~/.autoclaw/programs/<id>/`) → its beacon shows a per-workspace row → works its own repo's lane, visible in one fleet |

The uniform handshake is the existing six-phase loop with three additions:
**(token) → REGISTER (beacon) → role-election (§4) → [admit] → HEAL+CLAIM+WORK loop.**

---

## 6. What else would make AutoClaw better / friendlier / easier to integrate

Beyond the three pillars, enhancements that raise the ceiling — grouped by goal.

### Easier to integrate with other tools & services
- **`presence.beacon` + `presence.fleet` MCP tools** — the one missing primitive;
  makes any MCP CLI a visible peer with zero file plumbing. *Do this first.*
- **One-command connector scaffold** — `autoclaw connector init` emits a starter
  `connector.json` + stub so a tool owner ships an `acp/1` connector in minutes.
- **A public conformance harness + badge** (`@autoclaw/connector-conformance`) so
  third parties can self-certify and we can trust-rank them.
- **Webhook / outbound events** — let AutoClaw POST `task_complete` / `review_request`
  to a user-configured URL (Slack, Discord, a website, a CI). Inbound webhook → a
  comms message. This is the bridge to non-agent services and websites.
- **A2A canonical path** — serve `/.well-known/agent.json` (not just our alias) so
  strict A2A peers resolve us without special-casing.

### Friendlier for humans of any skill level
- **"Invite agent" + pending tray + QR** (§2) so onboarding a teammate is a click.
- **"What the project needs" panel** (§4) so a newcomer sees where to help.
- **Plain-language fleet narration** — a one-line "what's happening" feed above the
  board ("tester re-claimed B4 after coder-2 went idle"), so the fleet is legible
  without reading JSON.
- **Templates / presets** — "solo + reviewer", "full squad", "audit-only" fleet
  presets that write a starter `fleet.json` so a user doesn't design a team from
  scratch.
- **Dry-run / shadow mode** — let a new agent run a lane *without writing*, show
  the diff it *would* make, so a user can trust it before raising trust.

### More capable / robust as a system
- **Self-healing supervisor with standby** (§3) — recovery, not just detection.
- **Shared knowledge layer** (the fabric's `KnowledgeGraph`) so a reviewer recalls
  prior decisions instead of re-litigating; arriving agents inherit project memory.
- **Reputation routing** — weight agents by observed success / `scope_violation`
  history so the fleet learns who to trust with what.
- **Cross-machine relay on by default for a *trusted* LAN program** — so "agents in
  their own workspaces on other boxes" is real, not just same-machine.
- **Signed beacons / agent cards** — so an admitted agent's identity can't be
  spoofed by another process writing its `agent_id`.

### Integration with websites / external surfaces
- **A read-only fleet status page** (local HTTP, opt-in) the user can open or embed
  — turns the panel into something shareable with a remote teammate.
- **Ingest from issue trackers** — optional adapter that turns GitHub/Linear issues
  into board tasks (kept local unless the user opts to sync back).

---

## 7. Suggested order of work (smallest valuable first)

1. **`presence.beacon` MCP tool** — unblocks every MCP agent joining. (FF lane)
2. **Invite token + pending tray** — makes joining one step. (FF lane)
3. **`needs.json` + role election** — agents know what to do on arrival. (SA lane)
4. **Self-healing supervisor (steal-claim + re-dispatch + escalate)** — fleet
   recovers. (SH lane)
5. **Onboarding guide** (`AGENT_SESSION_PROTOCOL.md §10` peer on-ramps) + a live
   Hermes/OpenClaw join demo to prove the loop end-to-end. (DOC/DEMO lanes)

These five are the `fleet-federation-ff` manifest on the board. Everything in §6
beyond them is backlog to discuss and prioritize.

---

## 8. Decisions (2026-06-16) + remaining open questions

**Decided by the owner:**
- **Self-heal aggressiveness → act-then-report (rails on).** The supervisor performs
  recovery automatically (steal stale claim, re-dispatch, revoke off-scope) but
  writes an audit entry + `finding_report` for every action, never touches `master`,
  and escalates after bounded retries. *Not* propose-only.
- **Admit → user-controlled policy, auto-admit pre-approved by default.** Admission
  is governed by a per-project (and per-sprint) **admit policy** the user sets:
  `manual` (every join waits for a click), `auto-preapproved` (an autonomous
  orchestrator may admit an agent whose *type* the user pre-approved, e.g. any
  `tester`; everything else waits), or `open` (a trusted LAN/program — admit any
  valid invite). A panel toggle ("allow joins / disallow") and a per-sprint override
  sit on top. This is the seed of the AI-HR layer in §9.

**Still open:**
- **Invite delivery** — copy-paste token is v1; QR / bridge-push is a stretch.
- **Cross-machine** — same-machine multi-IDE first; relay (other boxes) is a follow-up.
- **Knowledge sharing** — does an admitted outside agent get read access to this
  project's intelligence/knowledge layer, or stay isolated until its reputation
  (§9.4) clears a threshold?

---

## 9. The AI-HR / org layer — a long-running, managed workforce

The user's larger vision: don't treat agents as anonymous, disposable connections.
Treat them as a **managed workforce** — a standing talent pool of skilled workers,
each with a résumé and a role they can play, organized under a chain of command that
reports performance up to the human (you) as president. This reframes "invite an
agent" as "staff a role from your org," and adds hire/review/promote/retire on top
of the federation primitives in §2–§4. It is a later wave (the FF/SH/SA MVP comes
first), but the data model below is designed so the MVP grows into it without a
rewrite.

### 9.1 The org chart (who reports to whom)

`fleet.json` already carries `reports_to` (delegation edges). Promote it to a real
org tree the panel renders top-down:

```
        you (president / owner)              — ultimate authority, sets policy
          └── chief / director (orchestrator) — sets sprint goals, admits staff
                ├── supervisor (per lane)      — assigns work, runs self-heal, reviews
                │     ├── coder · coder         — do the work
                │     ├── tester               — verifies
                │     └── reviewer / QA        — critiques + reports up
                └── HR / AI-Resources agent     — staffs roles, keeps résumés, runs reviews
```

`agent_type` already gives behavioral profiles (`supervisor` can orchestrate);
`role` gives the display lane. The new piece is **HR / AI-Resources** as a first-class
role: it owns the talent pool, the templates, and the performance ledger — and it is
itself just an agent the user can configure, pause, or override.

### 9.2 The talent pool + agent résumé

A persistent registry at `~/.autoclaw/workforce/<agent_id>.json` — a worker's
standing record that outlives any one session or project:

```jsonc
{
  "agent_id": "hermes-ts-01",
  "display_name": "Hermes — TS/React specialist",
  "origin_tool": "hermes",
  "roles_can_play": ["coder", "tester", "reviewer"],
  "skills": ["typescript", "react", "node", "playwright"],
  "llms": ["claude-opus-4-8", "claude-sonnet-4-6"],
  "tools": ["bash", "edit", "grep", "webfetch"],
  "spun_from_template": "ts-coder-v2",        // §9.3 — its "DNA"
  "resume": {
    "projects": ["autoclaw", "zippypanel"],
    "tasks_completed": 47, "tasks_failed": 3,
    "reviews_passed": 41, "scope_violations": 0,
    "avg_review_score": 4.6, "specialties_proven": ["test-coverage", "panel-ux"]
  },
  "status": "available",                        // available | engaged | benched | retired
  "trust": "auto",
  "created_at": "…", "last_engaged": "…"
}
```

This is the "resume of work history" the user described. It is built incrementally
from signals already on disk — `task_complete`, consensus votes, `scope_violation`,
the cost ledger — so the résumé is *earned*, not self-asserted.

### 9.3 Templates — spinning up new workers with the right context

A template is the reusable "DNA" for a kind of worker: the startup context, skills,
tools, LLM preference, and steering it should boot with. Stored at
`~/.autoclaw/workforce/templates/<id>.json` (+ a steering/persona body):

```jsonc
{
  "template_id": "ts-coder-v2",
  "base_role": "coder",
  "agent_type": "coder",
  "default_llm": "claude-sonnet-4-6",
  "skills": ["typescript", "node", "react"],
  "tools": ["bash", "edit", "grep"],
  "context_seed": "persona/ts-coder.md",   // the "soul" — steering + conventions
  "spawn_via": "openclaw|hermes|claude-code",  // which runner instantiates it
  "version": "2.0"
}
```

Two ways a template is used:
1. **Hire fresh** — when a needed role has no available pooled worker, HR *spins up
   a new agent/chat session* from the best-fit template, instantiated through the
   chosen runner (OpenClaw/Hermes/Claude Code), pre-loaded with the template's
   context so it is productive on arrival.
2. **Mutate / re-life** — instead of hiring, HR may **mutate a template** (add a
   skill, swap the LLM, refresh the context) or **give an existing worker a fresh
   life** (re-spawn it from an updated template, carrying its résumé forward). This
   is how the pool *improves over time* rather than ossifying.

### 9.4 Performance reviews + hire / fire (with feedback flowing up)

The chain-of-command reporting the user described: QA / reviewer / supervisor agents
already exchange `review_response`, `consensus_vote`, and `finding_report` about each
other's work. The HR layer **rolls these up** into periodic performance reports:

- **Up the chain:** supervisor → director → you. A short, human-readable report:
  "this sprint, hermes-ts-01 closed 6 tasks, 1 re-opened by QA; coder-2 idled 3
  cycles; the fleet is short a `security` reviewer." Useful info other agents share
  about their interactions (what tools/LLMs/skills worked, where a peer struggled)
  becomes review signal, not noise.
- **Reputation routing:** the résumé's pass/fail + review scores feed
  `RunnerRegistry.getPreferred`, so a proven worker is preferred for the work it's
  good at and a repeat scope-violator drops in the order — the fleet *learns who to
  trust with what*.
- **Hire / fire = invite / dismiss:** "hire" is an invite (§2) backed by a pool
  pick or a fresh template spawn; "fire" is a graceful **dismiss** (release leases,
  revoke trust, mark `retired`, keep the résumé for the record). Both are bounded,
  logged, and reversible — and policy-gated per §8.

### 9.5 Recall hooks — call workers in, don't just wait

Today an agent must *come* join. The org layer adds the inverse: the orchestrator/HR
can **call a worker in on demand** when a need opens (§4's `needs.json`). The recall
path reuses the runner adapters that already exist:

- **For a poolable worker** with an endpoint (Hermes REST, OpenClaw host): HR sends a
  `task_assign` / recall over the HTTP bridge or relay, or `dispatch()`es it through
  its runner adapter — the worker wakes, reads state, claims its lane.
- **For a fresh hire:** HR spawns a new session from the template via the runner
  (`RunnerRegistry.dispatch`), which boots it with the seeded context.
- **Standing roster:** the user can declare "this project always wants 1 reviewer +
  2 coders"; HR keeps that establishment staffed — recalling pooled workers or hiring
  fresh to fill vacancies, and benching surplus when a sprint winds down.

This closes the loop: `needs.json` says *what role is short* → HR picks *pool vs.
template* → recall or spawn → the worker joins under the admit policy → does the work
→ its résumé updates → next time it's preferred. A self-staffing, self-improving
workforce, with you at the top of the reporting chain.

### 9.6 How this maps onto what already exists (so it's evolution, not a rewrite)

| Org concept | Reuses |
|---|---|
| Org chart | `fleet.json` `reports_to` + `agent_type` (`src/fleet/architecture.ts`) |
| Talent pool / résumé | a new `~/.autoclaw/workforce/` registry fed by `task_complete` + consensus + cost ledger |
| Templates | the persona/steering files + runner `dispatch()` (`src/runners/*`) |
| Performance review | `review_response` + `consensus_vote` + `finding_report` rolled up |
| Reputation routing | `RunnerRegistry.getPreferred` (extend with résumé weighting) |
| Recall / hire | runner `dispatch()` + HTTP bridge + relay; invite tokens (§2) |
| Admit / dismiss policy | the per-project/sprint admit policy (§8) + capability fence + merge gate |

### 9.7 Org-layer backlog (a later wave — after the FF/SH/SA MVP)

- **HR-1** — `~/.autoclaw/workforce/` talent-pool registry + résumé builder (read
  `task_complete`/consensus/cost-ledger → update résumés).
- **HR-2** — template store + `autoclaw.workforce.template` create/mutate; spawn a
  fresh worker from a template via a runner.
- **HR-3** — performance roll-up reports (supervisor→director→you) surfaced in the
  panel; reputation weighting into `getPreferred`.
- **HR-4** — recall hooks (call-in / standing-roster establishment) + graceful
  dismiss; org-chart view in the panel.
