# AutoClaw / VoidSpec — Multi-Agent Coordination Improvements

_Author: kiro (session 2026-05-08). Status: proposal / backlog._

This document captures gaps observed while running AutoClaw v2.1.x as the
cross-agent coordinator on the ZippyPanel sprint, plus concrete changes to
AutoClaw (agent protocol / panel / extension) and VoidSpec (spec-to-plan
pipeline) that would let agents like Kiro, Kilo Code, Claude Code, Roo, and
Cursor loop autonomously over long-running programs without constant
human re-priming.

## 1. Pain Points Observed Today

### 1.1 The shared mailbox is append-only but agents never mark messages "read"

- `.autoclaw/orchestrator/comms/inboxes/<agent>/` accumulates JSON files
  indefinitely. There's no "seen" bit, no "archived" subfolder, no inbox
  summary in the panel. Every session has to re-triage its inbox from scratch.
- Concrete symptom: at session start I found three messages in
  `inboxes/kiro/` — one was already handled a session ago, two were current.
  No way to tell without reading all three and checking timestamps against
  shared-inbox broadcasts.

### 1.2 Heartbeats exist but agents don't know they're expected to write them

- AutoClaw extension writes heartbeats for detected VS Code extensions based
  on `vscode.extensions.getExtension()` + recent file-save signals. That's a
  coarse proxy. It catches "the extension is loaded" but not "this specific
  chat session is actually working on a task."
- Kilo Code, Claude Code (CLI variants), Cursor — none of them write their
  own heartbeats. They rely on the host extension's heuristic.
- Result: the panel shows Kilo as "idle" even while a KiloCode chat session
  is actively editing files, because the last save wasn't in the last 2 min.

### 1.3 Task status truth is split across three files

- `.kiro/specs/zippy-panel/tasks.md` — human-readable checklist, agents mark `[x]`
- `.autoclaw/orchestrator/state.json` — machine-readable counts, drifts
- `.autoclaw/orchestrator/sprints/*.yaml` — sprint status field
- `comms-log.jsonl` — task_claim / task_complete broadcasts

All four drifted during this sprint. `state.json` said 9 sprints, sprint
files on disk said 17, tasks.md was the only actually-current source. The
orchestrator extension polls from `plan-summary.yaml` but never reconciles
back into `tasks.md`.

### 1.4 No claim contention resolution

- If two agents run `task_claim` for the same task-id within seconds of each
  other, both files land in `inboxes/shared/` and neither agent notices. The
  protocol relies on everyone reading the log before claiming, but there's
  no mandatory "ack your claim was first" step.

### 1.5 The parallel-execution-plan.md is human-authored and drifts from orchestrator output

- Sprint assignments, migration reservations, and package ownership are
  duplicated in `docs/parallel-execution-plan.md` and in
  `.autoclaw/orchestrator/sprints/*.yaml`. They already disagree today
  (9 sprints vs 17 sprints). The ownership hook reads parallel-execution,
  the panel reads the yamls — they should be one artefact.

### 1.6 Review loop is slow and one-directional

- `review_request` → `review_response` works, but there's no partial
  re-review. KiloCode sent me a request, I replied with 3 findings, they
  sent a `task_update` saying "in progress", and the loop stalled because
  I was offline when they completed the fixes. They had to assume I'd
  re-review on next session — no auto-handoff, no timeout promotion.

### 1.7 Autoclaw panel has no inbox-focused view

- Panel shows "Messages: 1" but opening it shows every comms-log line, not
  just "messages requiring YOUR response". I have 16 open tasks and no way
  to see at a glance "2 of them need a decision from you."

### 1.8 No cross-repo coordination

- Autoclaw itself is in `K:\Projects\autoclaw`; ZippyPanel is in
  `K:\Projects\ZippyPanel`. Each has its own `.autoclaw/`. An agent working
  the autoclaw codebase (me, earlier today) has no visibility into the
  ZippyPanel sprint, and vice versa. Multi-repo programmes need a
  higher-level "program" scope above the per-repo orchestrator.

### 1.9 Agents can't subcontract

- If I (Kiro) need a KiloCode-style deep refactor done, I can't say
  "dispatch subtask to KiloCode and wait." I have to manually assemble a
  prompt, switch tabs, paste, then poll. The `Agent` tool exists in Claude
  Code but nothing comparable in Kiro/KiloCode today.

## 2. Proposed Improvements (Ranked)

### P0 — Ship These First

#### 2.1 Inbox state machine

Add `.autoclaw/orchestrator/comms/inboxes/<agent>/_state/<message-id>.json`:

```json
{ "message_id": "msg-...", "read_at": "...", "replied_at": "...", "archived_at": null }
```

The panel reads this plus the messages themselves, and surfaces:
- Unread count (primary badge on the Messages section)
- Awaiting-your-response count (messages with `requires_response=true` and no reply_at)
- Archive button per entry

Agents write the state file when they open / reply / archive. Backwards
compatible: if `_state/` is empty, everything is "unread."

#### 2.2 Session heartbeats, not extension heartbeats

Every time an agent (chat session) emits a comms message OR runs the
`@autoclaw status` chat participant, it writes a heartbeat with a
`session_id` dimension. Extension-level heartbeats become a fallback. The
panel shows "3 kiro sessions active (2 min / 5 min / 12 min ago)" instead
of a single "idle" dot.

Concretely: add `session_id` to `Heartbeat` struct in `autoclaw/src/comms.ts`,
require agent messages to include it, and render per-session rows in the
Agents panel.

#### 2.3 Reconciliation sweep job

A new AutoClaw scheduled job (tick every 5 min) that:
1. Reads `.kiro/specs/*/tasks.md` for `- [x]` items
2. Reads `.autoclaw/orchestrator/sprints/*.yaml` for `status:` fields
3. Reads `comms-log.jsonl` for `task_complete` broadcasts
4. Flags mismatches in `panel health` and posts a `system` message to shared

Don't auto-fix — humans should decide on drift. But surface it loudly.

#### 2.4 Single source of truth for sprint assignments

Deprecate `docs/parallel-execution-plan.md`. Move the human-readable bits
into per-sprint `.md` files (`sprints/sprint-N.md`) generated from the
`sprint-N.yaml`. The hook reads the yaml directly; the doc is generated.

### P1 — Next

#### 2.5 Claim tokens

Task-claim messages include a short-lived `claim_token` (uuid). Before
starting work, the agent re-reads the shared inbox and verifies no other
`task_claim` for the same `task_id` was written within 10 seconds. If a
conflict exists, the earlier token wins by timestamp; later claimer falls
back to `next_available_task`.

#### 2.6 Review-round-robin timeout

`review_request` gains an `sla_seconds` field (default 2 hours). If the
target agent hasn't responded in that window, the orchestrator
automatically re-posts to `inboxes/shared/` as `review_request_broadcast`
and any available agent (including the requester) can pick it up.

#### 2.7 Awaiting-response panel tab

New collapsible section in the AutoClaw panel, between Messages and Tasks:
"Awaiting You (N)". Shows only messages where `to == <me>` and
`requires_response=true` and `replied_at==null`.

#### 2.8 Agent cards in the panel

Each agent row gets click-to-expand with:
- Their claimed tasks
- Their sprint assignments
- Their last 5 outbound messages
- A "ping" button that writes a `question` to their inbox

### P2 — Bigger Bets

#### 2.9 Program scope above orchestrator

Add a new directory tier: `.autoclaw/program/` that sits _above_ any single
repo's `.autoclaw/orchestrator/`. Panel supports "add linked workspace,"
stitches together comms logs across repos, and lets agents working on
autoclaw see "someone is blocked on task-13 in ZippyPanel — want me to
help?"

Concretely:
- `program/registry.json` lists participating repos by absolute path
- Each repo's comms-log is tailed into a program-level log
- A single "Agents" table shows agents across all repos with a repo column

#### 2.10 Subcontract protocol

New message type: `subcontract_request`. Semantics:
- Agent A sends `subcontract_request` to Agent B via their inbox
- Contains: task summary, file paths, success criteria, return inbox
- Agent B accepts → sends `subcontract_accept`, starts work
- Agent B completes → sends `subcontract_deliver` with file list + test results
- Agent A verifies → sends `subcontract_ack` OR `subcontract_reject_with_fixes`

This lets Kiro dispatch a refactor to KiloCode without the human being the
relay.

#### 2.11 VoidSpec: spec-diffable tasks

Currently `tasks.md` is a flat markdown list. Agents can't easily diff
"what changed in the spec since my last session." Proposal: VoidSpec emits
`tasks.yaml` alongside `tasks.md`, with per-task IDs stable across edits
and a changelog per task. Orchestrator consumes the yaml as source of
truth; tasks.md is generated view.

#### 2.12 VoidSpec: per-task acceptance criteria → auto-review checklist

Each task in the spec gets explicit `acceptance_criteria:` and
`verification:` keys. The reviewer agent auto-builds its review checklist
from those keys per sprint, rather than running a generic 6-bullet audit.
This makes reviews faster and less subjective.

### P3 — Nice to Have

- Slash command `/autoclaw handoff <agent>` that packages current chat
  context + open files + task claim into a single prompt the target agent
  can consume.
- Conflict-detection hook that runs `git diff --stat` between agent
  branches and warns before two agents push overlapping files.
- Web dashboard outside VS Code (static site fed by comms-log) so
  non-technical stakeholders can watch the sprint without Kiro open.

## 3. Minimal First Milestone

Ship the P0 list as AutoClaw 2.2.0:

1. `2.1` inbox state + panel unread/awaiting counts
2. `2.2` session-level heartbeats
3. `2.3` reconciliation sweep job
4. `2.4` drop parallel-execution-plan.md, generate sprint-N.md from yaml

Estimated effort: 1–2 days of autoclaw extension work + 0.5 day on
ZippyPanel side to clean up drift.

## 4. Open Questions

- Should `inbox/_state/` be per-agent (current proposal) or central
  (easier to audit)? Per-agent fits the existing mailbox model better.
- Do we need cryptographic signing on task_claim to prevent a
  compromised agent from claiming on another agent's behalf? Probably
  overkill for now — all agents share a trust boundary.
- VoidSpec changes are a larger rev; should they wait for a dedicated
  sprint or bundle with the AutoClaw 2.2.0?
