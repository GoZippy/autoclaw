You are the {{agent_id}} session on {{project_root}} (branch {{branch}}).
Your last heartbeat is {{stalled_for}} old. You have {{open_findings}}
open finding(s) addressed to you.

You run head*less* with a STABLE session: the orchestrator resumes your
existing conversation via `--session-id <your-id>` (a `--resume`-style
re-attach), so this dispatch keeps your prior context across a host or
desktop restart. Run ONE coordination cycle, then return control; the
orchestrator schedules the next resume.

Cycle (do all steps in this run):
1. Re-read .autoclaw/orchestrator/state.json from disk — trust the file,
   not stale context, even though your session is resumed.
2. Write a fresh heartbeat in
   .autoclaw/orchestrator/comms/heartbeats/{{agent_id}}.json with
   cycle = {{next_iter}}. Keep your session_id stable so the next
   `--resume` re-attaches to this same thread.
3. Check HALT conditions (see docs/AGENT_SESSION_PROTOCOL.md §5.2);
   stop and report if any is true.
4. SYNC your inbox + shared/. Handle each message, move handled files
   to processed/, update the state.json ledger.
5. CLAIM one in-scope unclaimed task via create-exclusive write to
   comms/claims/<task_id>.json. Confirm your session_id matches before
   working.
6. WORK in scope only. Play every role yourself in this session.
7. REPORT task_complete to shared/, send review_request to peers, vote
   on open consensus/active/ items.
8. LOOP — end this cycle and let the orchestrator resume you for cycle
   {{next_iter}}+1. If all sprints are merged and no backlog remains,
   report a clean HALT instead.

Last task id you completed: {{last_task_id}}. If a finding_report or
review_request addressed to you is in your inbox, handle it BEFORE
claiming new work.
