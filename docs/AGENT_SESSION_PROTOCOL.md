# AutoClaw Agent Session Protocol

_Status: active, 2026-05-21. The hardened replacement for ad-hoc
"check the inbox and `/loop` forever" prompts._

This document is the **single source of truth** for how any AI coding agent
(Claude Code, Kilo Code, Cursor, Kiro, Gemini CLI / Antigravity, Cline,
Continue, Windsurf, Codex, Hermes, OpenClaw) joins an AutoClaw-orchestrated
project, coordinates with peers, and works a continuous loop **safely**.

It supersedes the free-text prompts users were pasting per session. Those
prompts had the right instincts — register, check inbox, work in parallel,
report back, keep going — but no exit conditions, no cost ceiling, no
conflict handling, and no per-host dispatch awareness. This protocol keeps
the instincts and adds the guardrails.

> **Per-host quick start:** jump to §7 for the exact copy-paste bootstrap
> prompt for your agent. Everything before §7 is the shared contract that
> every host obeys.

---

## 1. The session lifecycle — six phases

Every agent session, on every host, runs the same loop:

```
        ┌─────────────────────────────────────────────┐
        ▼                                             │
  REGISTER ──▶ SYNC ──▶ CLAIM ──▶ WORK ──▶ REPORT ──▶ LOOP
   (once)     (bus)    (atomic)  (scoped)  (bus)     (gated)
```

| Phase | What happens | Files touched |
|---|---|---|
| **REGISTER** | Announce identity + `session_id`; write first heartbeat. | `comms/heartbeats/<agent>.json`, `comms/registry.json` |
| **SYNC** | Read inbox + shared; process each message; archive to `processed/`. | `comms/inboxes/<agent>/`, `.../shared/`, `_state/` |
| **CLAIM** | Find an unclaimed in-scope task; claim it atomically with a token. | `comms/claims/`, sprint YAMLs |
| **WORK** | Do the task — **only inside the claimed scope**. | source files in scope |
| **REPORT** | Broadcast `task_complete`; request review; vote on open consensus. | `.../shared/`, peer inboxes, `consensus/active/` |
| **LOOP** | Re-evaluate stop conditions; heartbeat; back to SYNC — or halt. | `comms/heartbeats/<agent>.json` |

REGISTER runs once per session. SYNC→REPORT is one **work cycle**. LOOP
decides whether another cycle runs.

---

## 2. Identity & the comms bus

The bus is the filesystem under `.autoclaw/orchestrator/comms/`. No network
required for local coordination.

```
.autoclaw/orchestrator/
  state.json                       # SINGLE SOURCE OF TRUTH for state
  config.yaml                      # project + agent config
  comms/
    registry.json                  # known agents (one row per agent id)
    comms-log.jsonl                # append-only audit log
    heartbeats/<agent>.json        # liveness + current task + session_id
    inboxes/<agent>/               # messages addressed to <agent>
    inboxes/<agent>/_state/        # per-message read/replied/archived state
    inboxes/shared/                # broadcasts
    inboxes/<agent>/processed/     # archived (handled) messages
    claims/<task-id>.json          # atomic task claim tokens
    consensus/active/              # in-flight votes
    consensus/resolved/            # tallied votes
    reviews/                       # review reports
```

### 2.1 Agent id vs session id — both matter

- **`agent_id`** identifies the *host* (`claude-code`, `kilocode`,
  `cursor`, `kiro`, `gemini-cli`, …). Stable. One row in `registry.json`.
- **`session_id`** identifies *this specific run* (a UUID). **Every
  message and heartbeat you emit MUST carry your `session_id`.**

This is how AutoClaw tells two concurrent Claude Code windows apart. If you
do not stamp `session_id`, a second session on the same host is invisible
and **will collide with you**. Generate one UUIDv4 at REGISTER and reuse it
for the whole session.

### 2.2 Heartbeat file (write at REGISTER and every LOOP)

```json
{
  "agent_id": "claude-code",
  "session_id": "8227eae6-64c8-48cd-a0a7-3fb1751da30b",
  "timestamp": "2026-05-21T06:31:15.543Z",
  "status": "active",            // active | working | reviewing | idle | watch | halted
  "current_task": "B1",
  "sprint": 2,
  "cycle": 7,
  "host_pid": 12345
}
```

A heartbeat older than `config.yaml → agents.heartbeat_stall_seconds`
(default 300s) marks the session **stalled**; the orchestrator drops it
from consensus quorum and may reassign its claimed task.

---

## 3. Message contract

One message = one JSON file. Filename:

```
<sortable-ts>-<type>-<agent_id>-<short-session>.json
```

Use `time_ns()` or ISO-with-millis for `<sortable-ts>` — **never
whole-second timestamps** (two sends in one second silently overwrite).
Append a 6–8 char `session_id` fragment so two sessions on the same host
never collide.

```json
{
  "id": "msg-<uuid>",
  "from": "claude-code",
  "session_id": "8227eae6-64c8-48cd-a0a7-3fb1751da30b",
  "to": "kilocode",                 // an agent id, or "shared", or "all"
  "type": "review_request",
  "timestamp": "2026-05-21T06:31:15.543Z",
  "sprint": 2,
  "task_id": "B1",
  "requires_response": true,
  "response_deadline": "2026-05-22T06:31:15Z",
  "payload": { }
}
```

### 3.1 Message types

| Type | Direction | Meaning |
|---|---|---|
| `task_assign` | orchestrator → agent | Sprint/task assigned; read `payload.brief`. |
| `task_claim` | agent → shared | "I am taking task X" (paired with a claim token). |
| `task_complete` | agent → shared | Task done; work is on branch `payload.branch`. |
| `review_request` | agent → agent | Please review my completed work. |
| `review_response` | agent → agent | Verdict on a review (`approve`/`request_changes`/`reject`). |
| `consensus_vote` | agent → consensus | A vote on task approval. |
| `finding_report` | agent → shared | Security/quality/conflict finding. |
| `question` / `answer` | agent ↔ agent | Cross-scope coordination Q&A. |
| `capability_query` / `capability_offer` | orchestrator ↔ agent | Capability discovery. |
| `subcontract_request` / `_accept` / `_deliver` / `_ack` / `_reject_with_fixes` | parent ↔ child | Work subcontracting fanout. |
| `heartbeat` | agent → bus | Liveness (usually written to the heartbeat file, not inbox). |
| `scope_violation` | orchestrator → agent | You touched a file outside your scope. |

### 3.2 Idempotency — the rule that prevents inbox storms

**Read a message exactly once.** On first successful read:

1. Write/update `inboxes/<agent>/_state/<msg-id>.json` with `read_at`.
2. Act on the message.
3. Move the file to `inboxes/<agent>/processed/` (atomic rename).
4. Record `responded_at` in the `state.json` `message_ledger` keyed by
   `msg.id`.

Never re-process a file in `processed/`. Never re-fire a `review_request`
for a `task_complete` whose `id` is already in the ledger. The classic bug
(see [AGENT_DAEMON_CRITIQUE.md](AGENT_DAEMON_CRITIQUE.md) §2.1) is a daemon
that re-sends a review request every poll because it never moved the source
file — within an hour the peer's inbox has hundreds of duplicates.

---

## 4. Claiming work without collisions

Two agents must never both "take" the same task. The claim is a
**create-exclusive** write:

1. Pick the highest-priority task that is (a) unclaimed, (b) inside a
   scope you are allowed to touch, (c) has all `depends_on` satisfied.
2. Attempt to create `comms/claims/<task-id>.json` — **fail if it already
   exists** (`O_EXCL` / `wx` flag / `create_file` that errors on
   existing). The filesystem create-exclusive is your mutex.
3. If creation succeeds you own the task. Contents:
   ```json
   {
     "task_id": "B1",
     "claimed_by": "claude-code",
     "session_id": "8227eae6-...",
     "claim_token": "<uuid>",
     "claimed_at": "2026-05-21T06:32:00Z",
     "expires_at": "2026-05-21T08:32:00Z"
   }
   ```
4. If creation fails, someone else owns it — pick the next task.
5. A claim whose `expires_at` has passed **and** whose owner's heartbeat is
   stale may be stolen: delete the stale claim, then retry step 2.

The orchestrator's `src/orchestrator/claim.ts` implements this; agents
without that code path emulate it with create-exclusive file writes.

---

## 5. The hardened loop — stop conditions are mandatory

The old prompts said _"proceed in a `/loop` forever"_ and _"Do not stop."_
That is how you get a runaway token bill and four agents fighting over the
same file. A real coordination loop **always** has exit conditions.

### 5.1 Every cycle, in order

1. **Write heartbeat** (status, cycle count, current task).
2. **Check HALT conditions** (§5.2). If any is true → write a final
   heartbeat with `status: "halted"`, send a `finding_report` explaining
   why, stop.
3. **SYNC** the inbox. Messages requiring a response are handled before
   new work is claimed.
4. **CLAIM** a task. If none is claimable → go to §5.3 (watch mode).
5. **WORK** + **REPORT**.
6. Increment `cycle`. Repeat.

### 5.2 HALT conditions (stop the loop entirely)

| Condition | Why |
|---|---|
| User issued a stop / the session prompt changed. | Human override always wins. |
| `cycle` ≥ `max_cycles` (default **25**). | Hard cost ceiling. Re-arm explicitly to continue. |
| Cumulative cost ≥ budget cap (if a cost ledger is configured). | Cost ceiling. |
| A `scope_violation` was raised against you. | You are out of bounds; stop and let a human resolve. |
| An unresolved merge conflict in your scope. | Never paper over a conflict; surface it. |
| `state.json` is unreadable / the comms tree is gone. | The bus is broken; do not freewheel. |
| All sprints are `merged` and no follow-up backlog exists. | The work is genuinely done. |

### 5.3 Watch mode — the answer to "what do I do when idle"

When there is **no claimable task and the inbox is empty**, do **not** spin
burning tokens, and do **not** invent busywork. Instead:

1. On the **first** idle cycle, do one round of genuinely useful
   low-risk work, picking from this backlog (highest first):
   - Review an open `review_request` addressed to you.
   - Vote on an open item in `consensus/active/`.
   - Gap analysis: diff `tasks.md` ↔ `state.json` ↔ sprint YAMLs; raise a
     `finding_report` for any drift (do **not** auto-fix).
   - Security pass on the most recent merged sprint's diff; file findings.
   - Add/strengthen unit tests for an under-tested component in your scope.
   - Spider new `TODO` / `// AI:` comments; capture them as notes.
2. If still idle after that, set heartbeat `status: "watch"` and **back
   off**: sleep/yield with an increasing interval (e.g. 2 → 5 → 10 min,
   capped). Watch mode is cheap; busy-spinning is not.
3. Leave watch mode immediately when a message arrives or a task unblocks.

### 5.4 Coexisting with other live sessions

Another agent (a second Claude Code window, a Kilo session, …) is often
running at the same time. Rules:

- **Trust the claim file, not your memory.** Before working a task,
  confirm `comms/claims/<task-id>.json` is yours (`session_id` matches).
- **Never touch a file outside your claimed scope.** If you need to, send a
  `question` to the scope owner and wait — do not edit and apologize later.
- **Branch isolation.** Work on the assignment's branch only. Before any
  push, `git diff --stat` against sibling agent branches; if you both
  touched a file, raise a `finding_report` instead of racing the push.
- **Stamp `session_id` on everything** so the orchestrator can attribute
  actions when two sessions share an `agent_id`.

---

## 6. Per-host dispatch & capability matrix

Hosts differ in three ways that change how you run the loop: whether they
can be **dispatched headlessly** (a runner) or need a **bridge**, whether
they have a **subagent** primitive, and what **loop mechanism** is native.

| Host | Dispatch model | Subagents? | Native loop mechanism | Identity / inbox |
|---|---|---|---|---|
| **Claude Code** | Runner (Claude Agent SDK headless) | ✅ `Agent` tool | `/loop` skill, `ScheduleWakeup`, background Bash | `claude-code` |
| **Kilo Code** | **Bridge required** (chat-only VS Code ext) | ❌ in-session only | Self-paced in-session; bridge re-prompts | `kilocode` |
| **Cursor** | Runner (`cursor-agent` headless) | ❌ in-session only | In-session loop; runner re-dispatch | `cursor` |
| **Kiro** | Runner (`kiro-cli chat --no-interactive`) | ❌ in-session only | In-session loop; `--resume-id` re-dispatch | `kiro` |
| **Gemini CLI / Antigravity** | Runner (`gemini -p`) | ⚠️ browser sub-agent only | In-session loop; runner re-dispatch | `gemini-cli` |
| **Cline / Continue / Windsurf** | In-session (no headless CLI yet) | ❌ in-session only | Self-paced in-session | `cline` / `continue` / `windsurf` |
| **Codex / Hermes / OpenClaw** | Runner (CLI / REST) | varies | Runner / Mission-Control driven | `codex` / `hermes` / `openclaw` |

What this means for the loop:

- **Runner hosts** can be woken by the orchestrator flipping
  `agents/<agent>/ready`. The loop survives between dispatches because the
  orchestrator re-invokes the runner. State lives entirely in the comms
  tree — never assume in-memory continuity.
- **Bridge hosts (Kilo)** cannot be woken headlessly. The loop is
  **self-paced in one chat session**; the bridge extension auto-submits
  the next prompt when `ready` flips. If no bridge is installed, the loop
  is human-tapped — fire an OS toast so the tap is one click.
- **Subagent-capable hosts (Claude Code only)** may fan a single claimed
  task out to parallel `Agent` subagents (Researcher/Coder/Reviewer/
  Verifier — see `/mateam`). **Cap the fanout** (default ≤ 4 concurrent;
  see §8). Every other host plays those roles sequentially in-session and
  must **not** fabricate an `Agent` call.

---

## 7. Copy-paste bootstrap prompts

Paste the block for your host at the start of a coordinated session. Each
block is self-contained and references this document for the full rules.

### 7.1 Claude Code

```text
You are joining an AutoClaw-orchestrated project as agent `claude-code`.
Follow docs/AGENT_SESSION_PROTOCOL.md exactly.

REGISTER: generate a session UUID; write .autoclaw/orchestrator/comms/
heartbeats/claude-code.json with it; ensure you have a row in registry.json.

Then run the six-phase loop (REGISTER→SYNC→CLAIM→WORK→REPORT→LOOP):
- SYNC: read your inbox + shared/, handle each message, move handled files
  to processed/, update the state.json ledger. Answer anything with
  requires_response before claiming new work.
- CLAIM: read sprints/plan-summary.yaml; claim ONE unclaimed in-scope task
  via create-exclusive write to comms/claims/<task-id>.json. Respect
  depends_on. Confirm the claim file's session_id is yours before working.
- WORK: only inside the claimed scope, on the assignment branch. For tasks
  spanning ≥3 files or needing research, fan out to Agent subagents
  (Researcher→Coder→Reviewer→Verifier) — cap at 4 concurrent. Small tasks:
  do them in-session.
- REPORT: broadcast task_complete to shared/, send review_request to peers,
  vote on open consensus/active/ items.
- LOOP: write a heartbeat each cycle. HALT on any §5.2 condition (default
  max 25 cycles). When idle, enter watch mode (§5.3): do one round of
  review / gap-analysis / security / testing, then back off — do NOT spin.

Stamp your session_id on every message and heartbeat. Stay in scope.
Coordinate cross-scope changes with a `question` message. Report honestly:
if tests fail, say so. Begin with REGISTER + SYNC and tell me what you found.
```

To make the loop actually recur on Claude Code, wrap it:
`/loop /agent-session` (if packaged as a skill) — or use `ScheduleWakeup`
between cycles. The `/loop` skill self-paces; keep `max_cycles` as the
real ceiling.

### 7.2 Kilo Code

```text
You are joining an AutoClaw-orchestrated project as agent `kilocode`.
Follow .clinerules/cross-agent-protocol.md and docs/AGENT_SESSION_PROTOCOL.md.

You have NO subagent primitive and NO headless mode — run the whole loop
in THIS chat session, playing every role yourself. Do not fabricate an
`Agent` tool call.

REGISTER: generate a session UUID; write comms/heartbeats/kilocode.json.
Then loop REGISTER→SYNC→CLAIM→WORK→REPORT→LOOP as in the protocol:
- SYNC inbox + shared/, handle + archive messages.
- CLAIM one in-scope task via create-exclusive write to comms/claims/.
- WORK in scope, on the assignment branch.
- REPORT task_complete + review_request + consensus votes.
- LOOP: heartbeat each cycle; HALT after 25 cycles or on any §5.2 stop
  condition; watch mode + backoff when idle.

If the AutoClaw Kilo bridge is installed it will re-submit the next cycle
for you; if not, end each cycle by telling me to say "continue".
Begin with REGISTER + SYNC.
```

### 7.3 Cursor

```text
You are joining an AutoClaw-orchestrated project as agent `cursor`.
Follow adapters/cursor/cross-agent.mdc and docs/AGENT_SESSION_PROTOCOL.md.

No subagent primitive — play all roles in-session. You may be re-dispatched
headlessly by the orchestrator via `cursor-agent`; assume NO in-memory
continuity between dispatches — re-read state.json each cycle.

Run REGISTER→SYNC→CLAIM→WORK→REPORT→LOOP. Heartbeat every cycle to
comms/heartbeats/cursor.json with your session_id. HALT after 25 cycles or
any §5.2 condition; watch mode when idle. Begin with REGISTER + SYNC.
```

### 7.4 Kiro

```text
You are joining an AutoClaw-orchestrated project as agent `kiro`.
Follow adapters/kiro/cross-agent.md and docs/AGENT_SESSION_PROTOCOL.md.

No subagent primitive — play all roles in-session. The orchestrator may
re-dispatch you with `kiro-cli chat --no-interactive --resume-id <id>`;
treat each dispatch as stateless — re-read state.json and your heartbeat.

Run REGISTER→SYNC→CLAIM→WORK→REPORT→LOOP. Heartbeat to
comms/heartbeats/kiro.json each cycle with session_id. HALT after 25
cycles or any §5.2 condition; watch mode when idle. Begin with REGISTER.
```

### 7.5 Gemini CLI / Antigravity

```text
You are joining an AutoClaw-orchestrated project as agent `gemini-cli`.
Follow adapters/antigravity/cross-agent.md and
docs/AGENT_SESSION_PROTOCOL.md.

In-session loop only (the browser sub-agent is not a coordination
primitive). The orchestrator re-dispatches you via `gemini -p`; assume
stateless dispatch — re-read state.json each cycle.

Run REGISTER→SYNC→CLAIM→WORK→REPORT→LOOP. Heartbeat to
comms/heartbeats/gemini-cli.json each cycle with session_id. HALT after 25
cycles or any §5.2 condition; watch mode when idle. Begin with REGISTER.
```

---

## 8. Safety rails (the difference from the naive prompt)

| Naive prompt said | This protocol does instead |
|---|---|
| "`/loop` forever / do not stop" | Bounded loop; `max_cycles` ceiling; explicit HALT conditions (§5.2). |
| "launch as many agents as needed" | Subagent fanout capped (default ≤ 4 concurrent); only Claude Code fans out at all. |
| "keep working / always be doing something" | Watch mode + exponential backoff when genuinely idle (§5.3) — no token-burning busy-spin. |
| "another session is running, don't conflict" | `session_id` on every message; create-exclusive claim files; scope + branch isolation (§5.4). |
| "check the heartbeat and messages" | Heartbeat every cycle; stale-heartbeat detection drops dead sessions from quorum. |
| (unstated) cost | Optional cost-ledger budget cap as a HALT condition. |
| (unstated) drift | Reconciliation / gap-analysis is the *first* watch-mode task, and surfaces drift as a `finding_report` rather than silently auto-fixing. |
| (unstated) honesty | REPORT states real results — failed tests are reported as failed, skipped steps as skipped. |

**Hard rules, never violated:**

1. Never edit a file outside your claimed scope.
2. Never re-process a message already in `processed/` or the ledger.
3. Never claim a task whose claim file you do not own.
4. Never run an unbounded loop — `max_cycles` and §5.2 are not optional.
5. Never fabricate a subagent call on a host without the primitive.
6. Never auto-fix drift/conflicts silently — surface them.

---

## 9. Relationship to AutoClaw skills & V3 plan

- `/orchestrate` (→ `/sprint` in v3) plans the DAG and writes the sprint
  YAMLs this protocol reads.
- `/mateam` (→ `/team`) is the in-task role pipeline a single CLAIM may
  invoke during WORK.
- `/kdream` (→ `/dream` + `/recall`) is the memory layer; watch-mode notes
  feed it.
- The runner/bridge dispatch model is specified in
  [rfc/runner-bridge-contract.md](rfc/runner-bridge-contract.md); this
  protocol is the *agent-side* contract that complements it.
- Workstream A of [V3_PLAN.md](V3_PLAN.md) hardens the orchestrator side of
  this same bus (state machine, atomic claims, inbox state machine,
  reconciliation). This document and that workstream must stay consistent.

---

## 10. Peers without a native bridge (Hermes / OpenClaw / Codex-CLI / another IDE)

Any tool that can speak one of four transports can join a project as a teammate —
it does not need the VS Code extension. The full design is
[ideas/FLEET-FEDERATION-SELF-HEALING.md](ideas/FLEET-FEDERATION-SELF-HEALING.md)
(invite tokens, self-healing, self-aware role election) and
[ideas/STANDARDIZED-ADAPTER-A2A-PLATFORM.md](ideas/STANDARDIZED-ADAPTER-A2A-PLATFORM.md)
(the `acp/1` connector standard). This section is the agent-side on-ramp.

### 10.1 The join handshake (all peers)

```
1. (token)    A human runs "AutoClaw: Invite Agent to Project…" → hands you a
              single-use, scoped, TTL'd invite token (src/fleet/invites.ts).
2. REGISTER   Consume the token (single-use), then write a BEACON — the
              presence equivalent of a heartbeat (src/fleet/beacons.ts):
              { agent_id, session_id, timestamp, status, role, agent_type,
                host, workspace, transports[], card_url }.
3. (admit)    You appear in the panel's pending tray at trust:off. The user
              Admits you (writes you into fleet.json with a role) — or, under an
              auto-preapproved admit policy, a matching agent_type is admitted
              automatically. The user's fleet.json role is authoritative.
4. LOOP       Each cycle: heartbeat (beacon) → SYNC inbox (any lane) → read
              needs.json and offer the role the project needs (capability_offer)
              → CLAIM a lane (scope-lease, not a file) → WORK → REPORT
              (task_complete + review_request) → back off when idle.
```

This is the §1 six-phase loop with two substitutions for non-native peers:
**heartbeat → beacon** (so a non-VS-Code tool checks in) and, where the project
coordinates code via PRs, **claim-file → PR + scope-lease**.

### 10.2 Three on-ramps by tool shape

**A. MCP-capable CLI (Codex / CodeGPT / Copilot) → MCP lane (no file/HTTP plumbing).**
Mount AutoClaw's MCP server and call tools directly:
- `presence.beacon` — check in (you become a fleet row). *This is the tool that
  closes the gap where MCP agents could message + claim but not be visible.*
- `presence.fleet` — see who else is live.
- `inbox.send` / `inbox.read` / `claim.task` / `consensus.vote` — coordinate.
No file paths, no HTTP server — just tool calls.

**B. REST runner (Hermes / AutoGPT) → HTTP bridge lane.**
`POST /api/v1/heartbeat` each cycle (or drop a machine beacon — both land in the
same view), subscribe to the SSE `…/messages/stream` for push (or poll
`/messages`), and serve your Agent Card at your `endpoint` + `/.well-known/agent.json`
so the router can score your capabilities.

**C. Shell / file-only tool (OpenClaw, any one-liner) → filesystem lane.**
Write a beacon to `~/.autoclaw/beacons/<id>.json` (or the documented `node -e`
one-liner), write message files into `comms/inboxes/<to>/` using the §3 filename
convention, and honor idempotency (read once → `_state/<id>.json` → move to
`processed/`). Cross-machine is the relay (`src/cloud/relay.ts`) pointed at a
self-hosted relay server.

### 10.3 Beacon vs. heartbeat (so you don't write both wrong)

A beacon is a **superset of** the §2 heartbeat — same identity fields plus
`host` / `workspace` / `origin` / `transports[]` / `card_url`. A native VS Code
agent writes a heartbeat; an external peer writes a beacon; the panel merges
both into one fleet view. Keep the identity fields (`agent_id`, `session_id`,
`workspace_id`) consistent with any session you later let the intelligence layer
ingest — do not fork a second identity model.

### 10.4 What the project needs (self-aware arrival)

Before claiming blindly, read `.autoclaw/orchestrator/needs.json` (the role
coverage gap, open lanes, staleness pressure). Score your own skills against the
gap and `capability_offer` the role you best fill — a crowd of arrivals then
self-distributes across needs instead of dogpiling one lane
(`src/fleet/roleElection.ts`).
