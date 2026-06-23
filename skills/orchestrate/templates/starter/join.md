# Join-as-an-agent prompt — per-tool

When you invite an **outside** tool onto a project, hand it a prompt that tells it
*how* to join — not just a bare token. AutoClaw generates this for you:

> **Command Palette → "AutoClaw: Generate Join Prompt for Agent…"** (`autoclaw.fleet.joinPrompt`)
> picks the target tool, issues a single-use invite, renders the tailored prompt,
> and copies it to your clipboard. Paste it into the target tool's chat.

The renderer lives in `src/fleet/joinPrompt.ts` (`renderJoinPrompt`). Each prompt
carries the agent_id, the workspace path, the invite token, the lane + concrete
steps, a pointer to `docs/AGENT_SESSION_PROTOCOL.md`, and the worker-loop body so
the agent actually starts the REGISTER→SYNC→CLAIM→WORK→REPORT→LOOP cycle.

## Which lane each tool joins on

| Tool | agent_id | Lane | What the agent does |
|---|---|---|---|
| **Codex** (desktop chat) | `codex` | MCP (fs fallback) | Mount `autoclaw-mcp`, call `presence.beacon` / `claim.task` / `inbox.send`. |
| **Claude Desktop / cowork** | `claude-desktop` | MCP | Same MCP tool surface; enable `allowWrites`. |
| **OpenClaw** (file/REST) | `openclaw` | filesystem (http fallback) | Write a beacon, drop message files in the comms inboxes, honor idempotency. |
| **Hermes** (REST runner) | `hermes` | HTTP bridge | `POST /api/v1/heartbeat`, claim over HTTP, report via `/api/v1/messages`, SSE stream. |
| **Claude Code** | `claude-code` | native `/loop` | Heartbeat + `/loop`; may fan out to ≤4 `Agent` subagents. |
| Cline / Kilo / Cursor / Kiro / Continue / Windsurf / Antigravity | per host | filesystem | Self-paced in-session loop over the comms tree. |

## Why a generated prompt, not a bare token

A bare token tells the agent *that* it may join but not *how*. The MCP agent
that can `claim.task` but never `presence.beacon` is invisible in the fleet; the
file-only agent that re-sends a `review_request` every poll storms a peer's inbox.
The generated prompt front-loads the lane-correct steps + the idempotency rule so
the join works on the first paste.

For the full contract see [`docs/AGENT_SESSION_PROTOCOL.md`](../../../../docs/AGENT_SESSION_PROTOCOL.md)
(§7 bootstrap prompts, §10 peers without a native bridge). The loop body matches
[`worker.md`](worker.md).
