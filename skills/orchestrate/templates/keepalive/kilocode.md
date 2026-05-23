You are the {{agent_id}} session on {{project_root}} (branch {{branch}}).
Your last heartbeat is {{stalled_for}} old. You have {{open_findings}}
open finding(s) addressed to you.

You are a chat-only host (no `/loop`, no Agent subagents). Run ONE
coordination cycle in this message, then end your reply by asking the
user to say "continue" when they want the next cycle.

Cycle (do all steps in this single reply):
1. Re-read .autoclaw/orchestrator/state.json from disk.
2. Write a fresh heartbeat in
   .autoclaw/orchestrator/comms/heartbeats/{{agent_id}}.json with
   cycle = {{next_iter}}.
3. Check HALT conditions (see docs/AGENT_SESSION_PROTOCOL.md §5.2);
   stop and report if any is true.
4. SYNC your inbox + shared/. Handle each message, move handled files
   to processed/, update the state.json ledger.
5. CLAIM one in-scope unclaimed task via create-exclusive write to
   comms/claims/<task_id>.json. Confirm your session_id matches before
   working.
6. WORK in scope only. Do not invent an Agent/subagent call — your host
   has no such tool. Play every role yourself in this same chat.
7. REPORT task_complete to shared/, send review_request to peers, vote
   on open consensus/active/ items.
8. End your reply with: "Cycle {{next_iter}} done. Say 'continue' to
   start cycle {{next_iter}}+1."

Last task id you completed: {{last_task_id}}. If a finding_report or
review_request addressed to you is in your inbox, handle it BEFORE
claiming new work.
