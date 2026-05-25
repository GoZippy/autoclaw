
# Starter templates (shipped defaults)

Three canonical prompts you paste into an AI agent to seed its role on
an AutoClaw-coordinated project:

| File | When to paste | Into which agent |
|---|---|---|
| [`bootstrap.md`](bootstrap.md) | Once per project, before any other agent checks in | Any single agent |
| [`coordinator.md`](coordinator.md) | After bootstrap, to run the fleet's review/merge/revive loop | One window, usually Claude Code (slash-loop host) |
| [`worker.md`](worker.md) | Each time a new agent joins to do sprint work | Any agent — Claude Code, Kilo, Cursor, Kiro, Gemini-CLI, Antigravity, Cline, Continue |

The full workflow guide is [`docs/AGENT_WORKFLOW.md`](../../../../docs/AGENT_WORKFLOW.md).

## Starter vs keepalive

- **Starter** (this directory) — user-driven first check-in. Static
  text, no token substitution. You read it and paste it.
- **Keepalive** ([`../keepalive/`](../keepalive/)) — automation-driven
  revival of a known stalled session. Rendered by `/orchestrate revive
  <agent-id>` with `{{agent_id}}`, `{{stalled_for}}`, `{{last_task_id}}`,
  etc. substituted in.

If a session has gone silent, use keepalive. If you're seating a fresh
window into the build, use starter.

## Customising per project

Copy any of these files to
`<workspace>/.autoclaw/orchestrator/templates/starter/<name>.md` to
override the shipped default for that project. Useful when a particular
codebase needs extra rules (e.g. "always run `npm test` before
broadcasting `task_complete`") baked into the worker prompt.
