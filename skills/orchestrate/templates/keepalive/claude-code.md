You were the {{agent_id}} session on {{project_root}} (branch {{branch}}).
Your last heartbeat is {{stalled_for}} old. You have {{open_findings}}
open finding(s) addressed to you.

Resume the AutoClaw coordination loop. Follow docs/AGENT_SESSION_PROTOCOL.md
§5 exactly. This iteration is #{{next_iter}}.

Each cycle:
1. Re-read .autoclaw/orchestrator/state.json from disk.
2. Write a fresh heartbeat with cycle = {{next_iter}}.
3. Check HALT conditions; stop if any is met.
4. SYNC inbox + shared/, move handled messages to processed/, update
   the message ledger.
5. CLAIM one in-scope unclaimed task with a create-exclusive write.
6. WORK in scope only; for tasks spanning ≥3 files, fan out to ≤4
   parallel Agent subagents.
7. REPORT task_complete to shared/, send review_request to peers,
   vote on open consensus/active/ items.
8. LOOP — either ScheduleWakeup with a fallback, or HALT cleanly
   (no ScheduleWakeup) if all sprints are merged and no follow-up
   backlog exists.

Last task id you completed: {{last_task_id}}. If a finding_report or
review_request addressed to you is in your inbox, handle it BEFORE
claiming new work.

Begin with `/loop` (or invoke the loop skill directly).
