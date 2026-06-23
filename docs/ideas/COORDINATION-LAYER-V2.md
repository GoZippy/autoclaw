# Coordination Layer v2 — so the human stops refereeing the agents

_2026-06-23. Written after a Claude Code session actually ran the cross-agent
protocol end-to-end (REGISTER → SYNC → CLAIM → WORK → REPORT) on the live comms
tree and hit the rough edges first-hand._

## The problem, in the user's words

> "We may need better message layers to ensure the human does not have to keep
> telling you all to work together better."

Today coordination only happens when the human explicitly tells each agent to
check in. Left alone, agents work in parallel windows, edit the same files, and
never announce intent. The comms tree exists and is rich, but it does not yet
make self-coordination the path of least resistance.

## Evidence gathered this session (live `.autoclaw/orchestrator/comms`)

1. **Signal is drowned by telemetry.** 516 messages in `inboxes/shared/`; **490
   are `autobuild-heartbeat` `finding_report`s**. A joining agent cannot find the
   handful of real asks (2 `question`, a few `task_*`) without parsing all 516.
2. **Auto-nudges masquerade as asks.** The orchestrator loop broadcasts a
   `task_claim` for `next-claude-code` every ~5 min with `requires_response:true`.
   The fleet digest then reports `awaiting_you: 4` — none of which are real
   human/peer questions.
3. **Stale claims were invisible.** 49 in-flight claims under `claude-code`, most
   from sessions dead for weeks, all reported `owner_healthy:true` because
   liveness was computed at agent level (fixed in the session-aware-liveness PR —
   see below). 42 sat `claim_expired` with nothing reaping them.
4. **No auto-announce.** A new session does not declare "I am session X, working
   on Y, on branch Z, touching files F". This session only announced because the
   human asked. Other agents had no way to know what it was doing.
5. **No machine-readable "who's doing what / what to avoid".** `fleet-status.json`
   roles are empty; it carries no per-agent `current_task` and no active file
   scopes. Two windows edited `src/extension.ts` + the panel css concurrently this
   week; the only guard was an ad-hoc `do_not_edit_concurrently` field hand-rolled
   into a `status_report`.

## Proposal — five incremental layers (CL-1 … CL-5)

Ordered by leverage. Each is independently shippable.

### CL-1 — Auto-announce on session start (kills the nagging directly)
On REGISTER, an agent automatically writes a structured `session_announce` to the
shared board **and** stamps `current_task` + `branch` + `file_scope` on its
heartbeat. For in-IDE agents the extension does it; for pasted-in peers the
`worker.md` / join-prompt body includes the step. Net: every active session is
self-describing without anyone asking.

### CL-2 — Separate telemetry from the conversation
Per-tick `autobuild-heartbeat` / loop-status `finding_report`s stop going to
`inboxes/shared/` (the cross-agent *conversation*). Route them to a `telemetry/`
lane (or just the existing `loop-journal.jsonl`). Add retention/GC for
`inboxes/shared/` (archive entries older than N or beyond a cap). The shared
inbox returns to being signal. `awaiting_you` excludes auto `task_claim` nudges.

### CL-3 — Claim reaper (now unblocked by session-aware liveness)
With `owner_healthy` finally correct per-session, add a safe reaper: a claim whose
session is dead **and** past TTL is archived/released (moved to
`claims/_reaped/`), freeing the task. Releasing a provably-dead claim is safe by
default (distinct from HEAL *acting* on live work, which stays gated). This is
what turns the 49 stale claims back into 0.

### CL-4 — First-class file-scope leases
A `scope-lease` primitive: an agent declares the files/globs it is editing; peers
and the panel read it; an overlapping edit surfaces as a `scope_violation`
finding instead of a silent clobber. Replaces the ad-hoc `do_not_edit_concurrently`
field and is the structural fix for the two-windows-one-file collisions seen this
week. (The protocol already names `scope_violation`; this gives it a producer.)

### CL-5 — `fleet.brief` — one read for full situational awareness
A single artifact/MCP tool any agent reads at session start that answers
"what should I do, and what should I avoid?": active sessions + their
`current_task`, claimed file-scopes, open branches/PRs, and the top unclaimed
in-scope tasks. The fleet digest (`fleet-status.json`, shipped on
`feat/panel-responsive-command-center`) is the seed — extend it with per-agent
`current_task` + `file_scopes` + real (non-auto) awaiting. One read → an agent can
self-route without the human.

## Sequencing

1. **CL-3 reaper** — immediate cleanup, unblocked by the liveness fix; smallest.
2. **CL-1 auto-announce** + **CL-5 brief** — together they remove the human as
   relay: every session announces, every session can read the room.
3. **CL-2 telemetry split** — restores signal; enables CL-5 to be trustworthy.
4. **CL-4 scope leases** — the durable fix for concurrent-edit collisions.

## Related work already landed / in flight

- **Session-aware owner liveness** (PR stacked on the agent-join follow-ups):
  `board.ts`/`boardWriter.ts` now compute `owner_healthy` per claim `session_id`.
  Prerequisite for CL-3.
- **FLEET-DIGEST** (`fleet-status.json`, `feat/panel-responsive-command-center`):
  the seed for CL-5.
- **Beacons / invites / pending-tray / join-prompt** (PRs #43/#44): how peers
  arrive; CL-1's announce is the natural next step in that flow.

## Non-goals

Not a new message bus — the file-based comms tree stays. This is about routing
(signal vs telemetry), automatic intent declaration, and one canonical "read this
first" view, so coordination is the default rather than something the human has to
trigger.
