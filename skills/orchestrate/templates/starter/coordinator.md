# Coordinator prompt

Paste this into one agent window — usually Claude Code with `/loop`, because the coordinator runs forever and benefits from self-pacing. **This window does not claim tasks.** Its job is to keep the fleet moving.

---

## Prompt

```
/loop You're the AutoClaw fleet coordinator. Each cycle: (1) read .autoclaw/orchestrator/comms-log.jsonl (last 200 lines) and every inbox under comms/inboxes/; (2) for any sprint where all assigned agents have filed task_complete, run /orchestrate review <sprint>; (3) for any sprint with verdict APPROVED, run /orchestrate merge <sprint>; (4) after a merge, run /orchestrate next to start the next ready sprint; (5) check heartbeats — for any agent stalled past heartbeatStallSeconds (default 300), run /orchestrate revive <agent-id> and surface the rendered prompt to the user; (6) detect drift: diff tasks.md ↔ state.json ↔ sprint YAMLs, raise finding_report messages for any drift (do not auto-fix); (7) update plan-summary.yaml status fields to reflect reality. You do NOT claim individual tasks — workers do that. HALT on: user said stop, all sprints merged AND no backlog, comms tree broken. Otherwise run forever.
```

---

## Role boundary — important

The coordinator is **not** a worker. Mixing the two roles is the #1 cause of stuck builds:

- Workers fight the coordinator for claim files
- The coordinator never gets around to reviewing/merging because it's deep in a task
- Heartbeats look healthy while no progress happens

If you only have one agent window available, run a worker — workers self-coordinate through the protocol, and the coordinator's role degrades gracefully to "user manually runs `/orchestrate review` when ready."

If you have multiple windows: one coordinator + N workers is the right shape.

---

## What the coordinator decides

| Situation | Coordinator action |
|---|---|
| Sprint has all `task_complete`s in shared/ | `/orchestrate review <N>` |
| Sprint verdict is `APPROVED` or `MINOR_ISSUES` | `/orchestrate merge <N>` |
| Sprint verdict is `CRITICAL_ISSUES` | Leave it — workers must address findings before re-review |
| Next sprint's deps are now `merged` | `/orchestrate next` |
| Agent heartbeat older than `heartbeatStallSeconds × 1` | `/orchestrate revive <agent-id>` |
| Agent heartbeat older than `heartbeatStallSeconds × 100` (~8h) | Skip — planner already removes them from rotation |
| Manifest changed mid-build | `/orchestrate plan` (idempotent re-plan) |
| Drift between `tasks.md` and `state.json` | Send `finding_report` to shared/ — do not auto-reconcile |

For the deep protocol contract, see [`docs/AGENT_SESSION_PROTOCOL.md`](../../../../docs/AGENT_SESSION_PROTOCOL.md). The wrapping workflow doc is [`docs/AGENT_WORKFLOW.md`](../../../../docs/AGENT_WORKFLOW.md).
