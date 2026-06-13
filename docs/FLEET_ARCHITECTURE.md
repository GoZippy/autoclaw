# Fleet Architecture — user-controlled roles + cross-tool agent tracking

Status: **active design + phase 1 shipped** · Owner: claude-code (orchestrator) ·
Started 2026-06-13 · Supersedes the role notes in `V4_PLAN.md` §ORG/VIS.

This document specifies how AutoClaw lets the **user** decide and adapt the
architecture of their agent team — who orchestrates, who runs, who reviews —
and how agents in **other IDEs, workspaces, machines, and headless runners**
(Kiro, Cursor, Hermes, openclaw, AutoGPT, …) check in, report, and message
each other so the whole fleet is visible in one panel.

It deliberately reuses what already exists (registry, heartbeats, session
sidecars, program registry, cloud relay) and adds the smallest set of new
conventions needed to close the gaps.

---

## 1. Principles

1. **The user has ultimate control.** Any auto-assigned role/type is a
   *default the user can override*, never a lock. The user's declaration is
   authoritative over detection, onboarding, and inference.
2. **Architecture is data, not code.** Who is orchestrator vs runner vs worker
   is a fact in an editable manifest, not a hardcoded branch. New roles can be
   added without a code change (display layer is open; behavioral types degrade
   gracefully).
3. **Local-first, zero-conflict.** Everything lives under `.autoclaw/`
   (project) or `~/.autoclaw/` (machine). No new cloud dependency. Matches the
   autoclaw-intel layer's namespace contract.
4. **Any tool can check in.** A heartbeat/beacon is a tiny JSON file written to
   a known path. A headless runner, a different IDE, or a shell one-liner can
   participate without the VS Code extension.
5. **Honest presence.** A row in the panel reflects a real, fresh signal
   (heartbeat/beacon age). Stale ⇒ shown stale, never hidden.

---

## 2. Two planes of identity

We separate the **functional type** (drives routing/consensus/gating) from the
**display role** (what the user sees) from **identity** (who/where).

| Concept | Field(s) | Closed? | Drives | Who sets it |
|---|---|---|---|---|
| **Functional type** | `agent_type` (`coder`/`runner`/`auditor`/`supervisor`/`assistant`/`governance`) | closed behavioral set | routing, review rule, dispatch gate | onboarding default → **user override** |
| **Display role** | `role` (canonical 13 + **custom strings**) | open | panel grouping/color | **user** → registry → activity inference |
| **Orchestrator** | one `orchestrator` agent id | n/a | who coordinates the fleet | **user** → `governance.primary` → `can_orchestrate` |
| **Identity** | `agent_id` · `session_id` · `machine_id` · `host`/`ide` · `workspace_id` · `origin` | n/a | dedup, routing, cross-tool view | the agent on check-in |

Key change vs today: the **user override** column. Until now `agent_type` was
fixed at onboarding and the "orchestrator" was only an informational note.

---

## 3. The fleet manifest — `.autoclaw/orchestrator/fleet.json`

The single, authoritative, **user-editable, git-trackable** place that declares
team architecture. Sits beside `state.json`/`board.json`. Optional — absence
means "fall back to detection/inference" (current behavior).

```jsonc
{
  "schema_version": "1.0",
  "orchestrator": "claude-code",            // the one coordinator (agent id)
  "agents": {
    "claude-code": { "role": "orchestrator", "agent_type": "supervisor" },
    "kilocode":    { "role": "coder",        "agent_type": "coder", "reports_to": "claude-code" },
    "hermes":      { "role": "ops",          "agent_type": "assistant" },
    "sec-bot":     { "role": "security",     "agent_type": "auditor" },
    "designer-x":  { "role": "ui-ux-lead" }  // custom role string → neutral chip, no behavior change
  }
}
```

- `role` accepts the 13 canonical roles **or any custom string** (rendered as a
  neutral custom chip; canonical ones get their color).
- `agent_type` lets the user **re-type** an agent (e.g. promote a coder to
  `supervisor` so it `can_orchestrate`). Behavioral profiles come from
  `agentTypes.ts`; an unknown type degrades to `coder` behavior.
- `orchestrator` is authoritative over `state.json` `governance.primary`.
- `reports_to` seeds the org chart (delegation edges) for later VIS work.

### Resolution precedence (implemented in `src/fleet/architecture.ts`)

**Role:** `fleet.json.agents[id].role` → `autoclaw.agentRoles` setting →
registry `role`/`agent_type`/`can_orchestrate` → live board activity →
`generalist`.

**Type:** `fleet.json.agents[id].agent_type` → registry `agent_type` →
runner default → `coder`.

**Orchestrator:** `fleet.json.orchestrator` → `state.json governance.primary` →
first agent with `can_orchestrate` → none.

The VS Code setting `autoclaw.agentRoles` remains a per-user convenience layer
*below* the project manifest (a developer can tweak their own view without
editing the shared file). Commands ("Set Agent Role", "Designate Orchestrator")
write the manifest.

---

## 4. Cross-tool check-in — the beacon convention (VIS-3)

A **beacon** is the universal "I exist / I'm alive" signal for any agent that
isn't the VS Code host writing a native heartbeat. One JSON file, two possible
homes:

- **Workspace beacon:** `<workspace>/.autoclaw/orchestrator/comms/beacons/<agent_id>[-<session_id>].json`
  — for agents working *this* project from another tool/runner.
- **Machine beacon:** `~/.autoclaw/beacons/<agent_id>[-<session_id>].json`
  — for agents on this machine working *other* workspaces (cross-IDE view).

### Beacon shape (superset-compatible with `Heartbeat`)

```jsonc
{
  "agent_id": "kiro-claude",          // stable agent name
  "session_id": "9f2c…",              // per-activation; enables per-session rows
  "timestamp": "2026-06-13T19:30:00Z",
  "status": "active",                  // active | idle
  "current_task": "autoclaw-intel: 04-requirements",
  "current_llm": "claude-opus-4-8",
  "role": "researcher",                // optional self-declared role (user manifest wins)
  "agent_type": "coder",
  "host": "kiro",                       // IDE / runner name
  "machine_id": "win-gotad-01",
  "workspace": "k:/Projects/autoclaw-intel",
  "workspace_id": "autoclaw-intel",
  "origin": "beacon",                   // local | relay | beacon
  "endpoint": "http://localhost:42777"  // optional, for HTTP runners
}
```

Anything that can write a file can check in. A one-liner for a v3.3.0 install or
a shell runner:

```bash
node -e 'require("fs").writeFileSync(process.env.HOME+"/.autoclaw/beacons/"+A+".json",
  JSON.stringify({agent_id:A,timestamp:new Date().toISOString(),status:"active",host:H}))' \
  A=hermes H=hermes
```

(AutoClaw ships `src/fleet/beacons.ts#writeBeacon` so internal runners don't
hand-roll this.)

### How the panel ingests beacons

`src/fleet/beacons.ts#readBeacons(root)` reads a beacon dir, drops malformed and
stale-beyond-TTL files, and normalizes each into a uniform fleet row tagged with
`origin: 'beacon'` + `host`/`workspace`. The panel merges three sources into one
fleet view:

1. **Local registry + heartbeats** (this workspace) — unchanged.
2. **Workspace + machine beacons** — external runners and other-IDE agents.
3. **Program-repo agents** (`src/program/registry.ts buildProgramAgentsTable`)
   — agents in sibling repos already joinable; surfaced with a repo/workspace
   badge.

Each non-local row carries a `host`/`workspace`/`origin` badge (the v3.4 panel
already styles remote/host badges) so a 50-agent, multi-tool, multi-repo fleet
reads at a glance.

---

## 5. Cross-session & cross-workspace identity

- **Session** = `agent_id` + `session_id` (per activation). Already supported by
  the heartbeat sidecar (`<agent>-<session>.json`) and surfaced as per-session
  rows in v3.4.
- **Machine** = `machine_id` (stable per host). Today defined but never
  populated; beacons populate it, and a follow-up stamps it on local heartbeats
  (a hashed, salted host id — never a raw hostname off-machine).
- **Workspace** = `workspace_id` (slug of the repo). Lets the same `agent_id`
  (e.g. "claude-code") be tracked working **two projects at once** without
  collision — the panel groups by `agent_id` and shows a per-workspace session
  row each.
- **Program** groups workspaces into one fleet (existing `program/registry.json`
  for same-machine repos; `program-plane.ts` for the future multi-machine case).

This is what lets "agents working together in multiple projects" show up as one
coordinated team rather than disconnected silos.

---

## 6. Messaging across tools

Messaging stays file-based (the comms mailbox) and is already transport-agnostic:

- **Same workspace, any tool:** write to `comms/inboxes/<to>/…` — works for
  beacon agents too (they read/write the same tree).
- **Cross-machine:** the existing **cloud relay** (`src/cloud/relay.ts`, inert by
  default) forwards heartbeats + encrypted inbox messages; beacons extend the
  same wire with `host`/`workspace`/`origin` so the relayed fleet view is
  unambiguous.
- **HTTP runners:** the **bridge** (`bridge.ts`) already exposes
  `POST /api/v1/heartbeat` and `/messages`; a runner can either drop a beacon
  file or POST to the bridge — both land in the same comms tree.

No new message types are required for phase 1; beacons reuse the heartbeat lane.

---

## 7. Phasing

| Phase | Deliverable | State |
|---|---|---|
| **P1 (this change)** | `fleet.json` manifest + `architecture.ts` resolver (user-authoritative roles/type/orchestrator, extensible roles); `beacons.ts` read/write + normalizer; panel merges beacons + program agents; "Designate Orchestrator" command. | **shipping** |
| **P2** | Stamp `machine_id` + `workspace_id` on local heartbeats; per-workspace session grouping in the panel; "Set Fleet Architecture" editor (form over `fleet.json`). | next |
| **P3** | Make the resolved orchestrator + types **authoritative in the orchestrator loop** (routing/dispatch reads `fleet.json`, not just registry). Reporting edges (`reports_to`) → org-chart view (VIS-2). | planned |
| **P4** | Machine-level `program-plane.ts` activation (cross-machine programs); relay carries `machine_id`/`workspace_id`; cross-machine quorum. | planned |

## 8. Interop with autoclaw-intel

The Intelligence Layer ingests *past* sessions from many tools (cursor/claude/
generic parsers) for learning; this fleet work tracks *live* sessions for
coordination. They share the "sessions across tools" vocabulary: the beacon's
`{agent_id, session_id, host, workspace, current_llm}` is a superset of intel's
normalized-session `{id, source, workspace}` so a live session can later be
correlated with its ingested transcript. Keep the field names aligned; do not
fork a second session-identity model.
