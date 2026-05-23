# Keepalive templates (shipped defaults)

These ship with the AutoClaw extension. The `/orchestrate revive
<agent-id>` flow looks up `registry.json`'s `keepalive_template` field
and reads, in order:

1. `<workspace>/.autoclaw/orchestrator/templates/keepalive/<agent-id>.md`
   — per-project override, if the user has customised it.
2. `<extension-root>/skills/orchestrate/templates/keepalive/<agent-id>.md`
   — the shipped default (this directory).

To customise for one project: copy the file from here to the
workspace's `.autoclaw/orchestrator/templates/keepalive/` and edit.

## Parameters substituted at render time

| Token | Meaning |
|---|---|
| `{{agent_id}}` | Target agent id (e.g. `kilocode`, `claude-code`) |
| `{{project_root}}` | Absolute path of the workspace root |
| `{{branch}}` | Current branch |
| `{{last_task_id}}` | Last task this agent completed (from `state.json`) |
| `{{next_iter}}` | Next-iteration counter |
| `{{stalled_for}}` | Human-readable stall duration |
| `{{open_findings}}` | Count of open findings addressed to this agent |

Unsubstituted tokens are left in place; a warning is logged.

## Known `loop_mechanism` values

- `slash-loop` — host has a `/loop` skill (Claude Code).
- `plain-message` — chat-only; user (or bridge) hits send (Kilo, Continue, Cline).
- `cli-headless` — headless subprocess; runner re-dispatches (Cursor, Kiro, Gemini CLI).
- `bridge-relayed` — like `plain-message` but a companion extension auto-submits.

Add a new agent: drop `<id>.md` here (and optionally an override in
`.autoclaw/orchestrator/templates/keepalive/`), then add the registry
entry. `/orchestrate revive` picks it up.
