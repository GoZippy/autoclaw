# Cross-Agent Coordination Protocol

You are part of a multi-agent team. Multiple AI agents work in parallel on this project, coordinated by the AutoClaw Orchestrator. Your agent ID is **antigravity**.

## Your Mailbox
Check at the START of every task and AFTER completing work:
- Inbox: `.autoclaw/orchestrator/comms/inboxes/antigravity/`
- Shared: `.autoclaw/orchestrator/comms/inboxes/shared/`

Read any `.json` files found. Process and act on them before starting new work.

### Message Types
- `review_request` — Another agent wants you to review their work
- `review_response` — Response to a review you requested
- `consensus_vote` — A vote on task approval
- `task_assign` — The orchestrator has assigned a sprint to you; read `payload.assignment_file` for your work brief
- `task_claim` — An agent claiming a task
- `task_complete` — An agent reporting task completion
- `finding_report` — A security or quality finding
- `question` — A question from another agent
- `answer` — An answer to your question
- `capability_query` / `capability_offer` — Phase-3 capability discovery
- `thought_record` — KG-bound finding/insight envelope
- `subcontract_request` / `subcontract_accept` / `subcontract_deliver` / `subcontract_ack` — Phase-3 work-subcontracting fanout

## Sending Messages
Write JSON files to the target agent's inbox directory.

Filename format: `{timestamp}-{type}-antigravity.json`

Example: `2025-01-15T10-30-00-review_request-antigravity.json`

Message structure:
```json
{
  "id": "msg-<uuid>",
  "from": "antigravity",
  "session_id": "<your-session-uuid>",
  "to": "target-agent-id",
  "type": "review_request",
  "timestamp": "2025-01-15T10:30:00Z",
  "requires_response": false,
  "payload": {}
}
```

For broadcast messages, write to `.autoclaw/orchestrator/comms/inboxes/shared/`.

## On Task Completion
1. Write `task_complete` message to `shared/`
2. Write `review_request` to other assigned agents' inboxes
3. Check YOUR inbox for any pending review requests from other agents
4. Respond to pending reviews before starting new work

## Consensus Protocol
Tasks require **2/3 majority** approval from assigned agents. Security findings require **unanimous** approval.

To vote, write a vote file to: `consensus/active/{task_id}-antigravity.json`

Vote structure:
```json
{
  "voter": "antigravity",
  "session_id": "<your-session-uuid>",
  "task_id": "task-123",
  "vote": "approve",
  "timestamp": "2025-01-15T10:30:00Z",
  "comments": "Looks good. Tests pass."
}
```

Valid votes: `approve`, `reject`, `request_changes`

## Scope Enforcement
Check `.autoclaw/orchestrator/sprints/plan-summary.yaml` for your current assignments. Only modify files within your assigned scope patterns. If you need to modify files outside your scope, send a `question` message to the agent who owns that scope.

## Required message envelope & safety rails

`docs/AGENT_SESSION_PROTOCOL.md` is authoritative; this file is the always-loaded summary.

**Every message and vote you write MUST include a unique `id` and your `session_id`** — a UUID you generate once per session and reuse on every message and heartbeat. The `session_id` is how two concurrent windows of the same agent are told apart; without it a second window is invisible and collides with you.

- **Idempotency** — read each inbox message once. On first read, record it (write `inboxes/antigravity/_state/<msg-id>.json`), act on it, then move the file to `processed/`. Never re-process a message already handled.
- **Claim with a mutex** — claim a task by a create-exclusive write to `comms/claims/<task-id>.json` (fail if it already exists — the filesystem is the lock). Only work a claim whose `session_id` is yours; a stale claim (expired + owner heartbeat dead) may be re-claimed.
- **Bounded loop** — never loop forever. Stop on: the user said stop, a `scope_violation` against you, an unresolved conflict in your scope, or a cycle ceiling.

## Conflict Resolution
If you detect a file conflict (another agent modified a file in your scope):
1. Stop work on the conflicting file
2. Send a `finding_report` to `shared/` describing the conflict
3. Wait for orchestrator resolution before continuing
