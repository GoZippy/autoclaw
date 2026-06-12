---
spec_id: agent-trigger-hooks
title: Event-driven trigger hooks — wake agents on comms/build events, with fleet HALT
status: draft  # draft | review | pilot | implement | verify | done
owner: claude-code
created: 2026-06-12
updated: 2026-06-12
supersedes: []
superseded_by: null
references:
  - orchestrate-gates-and-routing.spec.md
  - ../research/2026-06-11-fable-5-agent-patterns.md
  - ../research/2026-06-11-loss-function-development.md
  - ../AGENT_SESSION_PROTOCOL.md
acceptance:
  - given: a hooks.yaml rule {on: message, filter: {type: review_request, to: kilocode}, action: dispatch}
    when: a review_request lands in inboxes/kilocode/
    then: within one tick a `agents/_dispatch/next-kilocode-*.json` file exists and a `hook_fired` entry is appended to the comms log
  - given: the HALT file `.autoclaw/orchestrator/HALT` exists
    when: any hook condition matches
    then: no action fires; a `hook_suppressed` audit entry is written instead
  - given: a rule with cooldown_seconds 300 that fired 10 seconds ago
    when: the same condition matches again
    then: the action does not fire; the suppression is audited
non_goals:
  - A general workflow engine (n8n/Temporal class) — rules are flat event→action pairs
  - Cross-machine event transport beyond the existing cloud relay
  - Replacing Claude Code's native /loop and /schedule — those remain the per-session loop primitives; hooks complement them on the AutoClaw side
---

# Event-driven trigger hooks — wake agents on comms/build events

## Summary

Today AutoClaw's coordination is **pull-based**: agents poll their inbox at the
start of a cycle, and a fixed dispatch loop writes `agents/_dispatch/next-*`
files on a timer. Nothing *reacts* to events — a `review_request` sits unread
until the target agent's next poll; a failed autobuild step or a stalled
heartbeat notifies no one. This spec adds a small, audited **event → action**
hook layer so that comms and build events wake the right agent (dispatch file,
VS Code notification, skill launch, runner spawn, or relay forward) — pushing
AutoClaw toward "agents check in and begin working on assigned tasks" without
forcing all comms through the orchestrator. It also introduces the **fleet HALT
kill switch** and per-firing **audit log** recommended by the 2026-06-11
research (bounded autonomy: "audit logs, diffs, and a kill switch").

## Read first

- `src/comms.ts` — message envelope, `sendMessage`, `appendCommsLog`, inbox layout
- `src/extension.ts` — the existing dispatch tick that writes `agents/_dispatch/next-*.json` (the consumer this spec reuses); chokidar is already a dependency
- `src/hooks/conflictDetection.ts` — existing hook-style module; match its shape
- `src/autobuild.ts` — step execution + failure surface (the `autobuild_fail` event source)
- `docs/AGENT_SESSION_PROTOCOL.md` — message types and the watch-mode contract

## Design

### Inputs (event sources)

| `on` value | Source | Payload fields available to `filter` |
|---|---|---|
| `message` | chokidar watch on `comms/inboxes/**` (new file) | `type`, `from`, `to`, `task_id`, `sprint`, `requires_response` |
| `heartbeat_stall` | scan of `comms/heartbeats/*.json` on the tick | `agent_id`, `seconds_stale` |
| `claim_stale` | scan of `comms/claims/*.json` vs owner heartbeat | `task_id`, `agent_id`, `seconds_stale` |
| `consensus` | result of a consensus evaluation (review command / bridge) | `task_id`, `status`, `final_verdict`, `gate_failed` |
| `autobuild_fail` | a workflow step exits non-zero / times out | `workflow`, `step`, `exit_code` |

### Rule config — `.autoclaw/orchestrator/hooks.yaml`

```yaml
hooks:
  - id: wake-reviewer
    on: message
    filter: { type: review_request }       # equality match on payload fields; `to` defaults to any
    action: dispatch                        # dispatch | notify | launch_skill | spawn_runner | relay
    target: "{{to}}"                        # template over payload fields
    cooldown_seconds: 300
  - id: surface-stall
    on: heartbeat_stall
    filter: { seconds_stale_gte: 600 }      # _gte/_lte numeric comparators
    action: notify
  - id: redispatch-redgate
    on: consensus
    filter: { final_verdict: needs_changes }
    action: dispatch
    target: "{{author_agent_id}}"
```

### Actions

| `action` | Mechanism (reuses existing machinery) |
|---|---|
| `dispatch` | Write `agents/_dispatch/next-<target>-<ts>-<rand>.json` — the file the existing dispatch consumer already honors. Payload carries the triggering event. |
| `notify` | VS Code toast + output-channel line (and dashboard badge when the fleet view lands). |
| `launch_skill` | Invoke the `autoclaw.launchSkill` flow with a pre-filled prompt for the target platform (adapter deep-link where supported, clipboard otherwise) — this is how a hook "starts a chat session." |
| `spawn_runner` | Start a registered runner (`LocalCoderRunner` / `LoopServiceAdapter`) with the event payload as the task brief. |
| `relay` | Forward the event through the cloud relay to the target machine's inbox (cross-machine wake). |

### Safety rails (non-negotiable)

- **Fleet HALT kill switch:** if `.autoclaw/orchestrator/HALT` exists, *no hook
  fires* and the dispatch tick pauses; every suppressed firing is audited as
  `hook_suppressed`. A VS Code command pair (`AutoClaw: HALT fleet` /
  `Resume fleet`) creates/removes the file. This satisfies hard-rule territory:
  one operator action stops all automated waking, machine-wide (the file is
  also mirrored over the relay so remote workers see it).
- **Cooldown per rule** (`cooldown_seconds`, default 300) + **global cap**
  (`max_firings_per_hour`, default 30) — hooks must never busy-spin an agent.
- **Audit:** every firing/suppression appends `{rule_id, on, action, target,
  event, timestamp}` to the comms log (`type: hook_fired | hook_suppressed`)
  and to `comms/hooks/audit.jsonl`.
- **No self-amplification:** events generated *by* a hook action (e.g. the
  dispatch file it wrote) are tagged `via_hook: <rule_id>` and never match
  `message` rules — a hook cannot trigger a hook.

### Outputs

- `agents/_dispatch/next-*.json` files (existing consumer), notifications,
  runner spawns, relay messages — all tagged `via_hook`.
- `comms/hooks/audit.jsonl` + `hook_fired`/`hook_suppressed` comms-log entries.
- `.autoclaw/orchestrator/HALT` honored by hooks AND the existing dispatch tick.

### Algorithm / contract

```ts
// src/hooks/triggerHooks.ts
export interface HookRule {
  id: string;
  on: 'message' | 'heartbeat_stall' | 'claim_stale' | 'consensus' | 'autobuild_fail';
  filter?: Record<string, string | number | boolean>; // equality; *_gte/*_lte numeric
  action: 'dispatch' | 'notify' | 'launch_skill' | 'spawn_runner' | 'relay';
  target?: string;            // "{{field}}" templates over the event payload
  cooldown_seconds?: number;  // default 300
}
export interface HookEvent { on: HookRule['on']; payload: Record<string, unknown>; via_hook?: string; }

// Pure (unit-testable): which rules fire for an event, given last-fired times + HALT state.
export function matchHooks(rules: HookRule[], event: HookEvent, state: HookRuntimeState, now: number): HookDecision[];
// Side-effecting executor: performs the action, writes audit, updates state.
export async function executeHook(decision: HookDecision, deps: HookDeps): Promise<void>;
```

The watcher/tick wiring lives in `extension.ts` (one chokidar watcher on
`inboxes/**`, plus checks folded into the existing periodic tick). The matcher
is pure so the firing semantics (filters, cooldown, HALT, via_hook exclusion)
are fully unit-tested without fs/vscode.

## Acceptance criteria

1. **Wake on review_request** — rule `wake-reviewer`; drop a `review_request`
   into `inboxes/kilocode/`; within one tick a `next-kilocode-*` dispatch file
   exists with `via_hook: wake-reviewer`, and `hook_fired` is in the comms log.
2. **HALT stops everything** — create `.autoclaw/orchestrator/HALT`; repeat #1;
   no dispatch file; `hook_suppressed` audited. Remove HALT; firing resumes.
3. **Cooldown** — two matching events 10s apart with `cooldown_seconds: 300`;
   exactly one firing, one suppression.
4. **No self-amplification** — a dispatch file written by a hook does not match
   any `message` rule.
5. **Zero-config no-op** — no `hooks.yaml` ⇒ no watcher behavior change, no new
   writes (golden no-op).

## Sequencing

| Step | Deliverable | Owner | Exit gate |
|---|---|---|---|
| 1 | `HookRule`/`HookEvent` types, yaml loader, pure `matchHooks` (filters, cooldown, HALT, via_hook) + unit tests | claude-code | Acceptance #3, #4 pure-logic versions pass |
| 2 | `executeHook` actions: `dispatch` + `notify` + audit writes | claude-code | Acceptance #1 passes end-to-end |
| 3 | HALT kill switch: file check in hooks + existing dispatch tick + the two VS Code commands | claude-code | Acceptance #2 passes |
| 4 | `launch_skill` + `spawn_runner` actions | claude-code | hook can open a pre-filled chat/runner session |
| 5 | `relay` action (cross-machine wake) + HALT mirroring over relay | claude-code | remote inbox receives the wake |

## Non-goals

(See frontmatter.) Notably: this is not a workflow engine — chaining belongs to
the orchestrator/goal-loop layer (`orchestrate-gates-and-routing.spec.md` and a
future goal-loop spec), not to hooks.

## Open questions

- Should default rules ship enabled (review_request→dispatch, task_assign→dispatch,
  heartbeat_stall→notify) or does `hooks.yaml` start empty with a documented
  starter file? Leaning: ship a commented starter file, nothing enabled silently.
- `launch_skill` deep-link support varies per platform (Kiro launchSkill fix
  history) — which adapters can open a session programmatically vs clipboard?

## Don't-do

- **No hook may edit files or run repo-mutating commands.** Hooks wake agents;
  agents do work under the existing claim/scope rules.
- **Never fire without an audit entry** — an unobserved automation is the exact
  failure mode the research warns about ("a constraint without an instrument is
  a vibe").
- **Don't bypass HALT for any action type**, including notify.
- **Don't watch `agents/_dispatch/`** — that's an output surface; watching it
  recreates self-amplification.
