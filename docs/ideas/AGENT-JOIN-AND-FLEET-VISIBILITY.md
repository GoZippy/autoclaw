# Agent Join Experience + Fleet Visibility

_2026-06-22 — addresses the "how does an external tool actually JOIN this project
as a collaborating agent?" confusion, and the request for better per-agent
workload / task / history visibility._

## Why this doc exists

A Codex desktop chat session, asked to "join as an agent" on another project,
reviewed all of AutoClaw and concluded it had to: install the `codex` CLI, set
`OPENAI_API_KEY`, run `autoclaw.fabric.onboard`, add a `WA-3` slot in
`config.yaml`, bump `work_agents`, and re-run `/orchestrate plan`.

**Every fact was correct — but it answered the wrong question.** That is the
*headless-runner* path: AutoClaw owns a `codex -q '<prompt>'` subprocess, a fresh
process per dispatch. It is **not** how an interactive chat session you are
already talking to joins and collaborates. Codex conflated "the `codex` CLI
runner" with "me, this chat." Those are two genuinely different integration
models, and the conflation is the root of the confusion.

## The two join models

| | **Headless runner** | **Interactive peer** |
|---|---|---|
| Who drives | AutoClaw owns the subprocess | The chat session drives itself |
| Mechanism | `codex -q`, fresh process per task | Joins the file bus / MCP / beacon and loops |
| Used by | `/orchestrate` WA-slots, `fleet start` | Claude Code & Kilo today; should also cover Codex-desktop, Claude-desktop/cowork, OpenClaw, Hermes |
| State | Stateless between dispatches | Persistent session, shows up as a live agent row |
| Onboard | `autoclaw.fabric.onboard` → registry | beacon/invite → comms inbox + heartbeat loop |

For an **interactive peer** there are three sub-lanes (see
`docs/AGENT_SESSION_PROTOCOL.md` §10.2):

- **MCP** (best — Codex/Claude-desktop): mount `autoclaw-mcp`, call
  `presence.beacon` / `claim.task` / `consensus.vote`. No file plumbing.
  Caveat: MCP writes are **denied by default** until `allowWrites:true`
  (`.autoclaw/mcp/config.json` or `AUTOCLAW_MCP_ALLOW_WRITES=true`).
- **REST** (Hermes/AutoGPT): `POST /api/v1/claims/<task_id>`, `/heartbeat`,
  `/messages` via the bridge (`src/bridge.ts`).
- **Filesystem** (OpenClaw, one-liner): write a beacon + drop message files into
  the comms inboxes following the `§3` filename convention, honoring idempotency.

## Gaps that made joining hard (verified against source)

1. **Identity was hardcoded** — `AGENT_DEFINITIONS` is a fixed list of 9 extension
   IDs; a new agent type was never auto-given an inbox / registry row.
2. **No file-bus scaffolder** — a file-only agent had to replicate the whole
   protocol by hand.
3. **≥2-agent provisioning floor** — `provisionCrossAgentComms` bailed unless 2+
   agents were detected, so a lone newcomer got no comms tree.
4. **The invite command copied a bare token, not a prompt** — leaving the human to
   hand-write how the target tool should consume it.
5. **Federation built but inert** — invites/beacons/`presence.beacon`/pending-tray
   all exist, but the join handshake was never packaged for a human to drive.
6. **7 of 9 runners had no keepalive template** — `/orchestrate revive <id>`
   errored "no template registered" for codex, claude-desktop, cursor, kiro,
   gemini-cli, hermes, openclaw, autogpt.
7. **No per-agent completed-work history anywhere** — claims are deleted on
   completion and `board.json` is a live snapshot, so finished work vanished.
   The kanban had no Done lane; the sidebar card showed only current work.

## What shipped on `feat/agent-join-overhaul`

### Slice A — one-click join-prompt generator
- `src/fleet/joinPrompt.ts` — pure, vscode-free renderer. `JOIN_TARGETS` maps
  each tool to a join lane (mcp / http / fs / slash); `renderJoinPrompt` and
  `renderJoinPromptForInvite` produce ONE ready-to-paste prompt carrying the
  agent_id, workspace, invite token, lane-specific steps, a pointer to the
  protocol doc, and the six-phase loop body.
- Command **`autoclaw.fleet.joinPrompt`** ("Generate Join Prompt for Agent…") —
  pick the tool + role + type + scope, issues an invite, copies the full prompt.
- `skills/orchestrate/templates/starter/join.md` — static per-tool reference.

### Slice B — per-agent workload + completed-work history
- `src/taskLedger.ts` — durable append-only `task-ledger.jsonl`.
  `appendTaskCompletion` is hooked on every `task_complete`; `summarizeByAgent`
  produces `{ assigned, inProgress, doneToday, doneTotal, recentCompleted }`.
- Kanban gains a **Done lane** (`src/webview-render-board.ts`), reconstructed
  from the ledger (the section badge still counts open work only).
- Agent cards gain a **workload rollup** + collapsible **Completed work** list
  (`src/webview-render.ts`).

### Slice C — plumbing quick-wins
- 8 new keepalive templates (codex, claude-desktop, cursor, kiro, gemini-cli,
  hermes, openclaw, autogpt) tailored to each runner's loop mechanism.
- `src/fleet/scaffold.ts` — `scaffoldAgent()` wires an arbitrary agent id into
  the comms tree (inbox + registry row + bootstrap rules + keepalive mapping).
  Command **`autoclaw.fleet.scaffoldAgent`**.
- Provisioning floor lowered to **≥1**; provisioned registry rows now carry
  `loop_mechanism` + `keepalive_template` so `/orchestrate revive <id>` resolves.

### Panel affordance
The Agents section header now always shows **Join prompt…** + **Invite…**
buttons (previously hidden until an agent was already pending — so you could not
invite the *first* agent from the panel). Empty tray shows an onboarding hint.

## Follow-ups (not in this branch)

- Wire the MCP `allowWrites` flip into the join flow (today a human must set it).
- Surface `fleet.json` / `needs.json` authoring in the UI so role election has a
  live manifest to read.
- Self-healing supervisor (the act-then-report ladder in
  `FLEET-FEDERATION-SELF-HEALING.md` §3) is still detect-only.
- Promote the richer cost-ledger per-agent model (today only in the command-only
  Manager tab) into the sidebar.
