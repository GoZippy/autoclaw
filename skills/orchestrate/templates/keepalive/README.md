# Keepalive templates (shipped defaults)

> **Starter vs keepalive — pick the right one.**
> - **Starter** templates ([`../starter/`](../starter/)) are for the
>   *first* check-in of an agent on a project: bootstrap, coordinator,
>   or worker role. The user pastes them directly.
> - **Keepalive** templates (this directory) are for reviving a *known
>   stalled* session — `/orchestrate revive <agent-id>` renders them
>   automatically with the agent's last task, cycle counter, and stall
>   duration substituted in.
>
> Full workflow guide: [`docs/AGENT_WORKFLOW.md`](../../../../docs/AGENT_WORKFLOW.md).

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
- `cli-headless` — headless subprocess; runner re-dispatches (Claude Desktop,
  Codex, Cursor, Kiro, Gemini CLI).
- `bridge-relayed` — a REST service / companion auto-submits (Hermes, OpenClaw,
  AutoGPT).

## Shipped templates

| Template | loop_mechanism | Revive delivery |
|---|---|---|
| `claude-code.md` | `slash-loop` | host `/loop` |
| `kilocode.md` | `plain-message` | user/bridge hits send |
| `claude-desktop.md` | `cli-headless` | `--session-id`/`--resume` re-attach |
| `codex.md` | `cli-headless` | fresh `codex -q` re-dispatch (no resume) |
| `cursor.md` | `cli-headless` | `cursor-agent --no-interactive` re-dispatch |
| `kiro.md` | `cli-headless` | `--resume-id` re-dispatch |
| `gemini-cli.md` | `cli-headless` | fresh subprocess re-dispatch |
| `hermes.md` | `bridge-relayed` | REST `POST /tasks` |
| `openclaw.md` | `bridge-relayed` | hybrid REST/CLI submit |
| `autogpt.md` | `bridge-relayed` | REST service submit |

The chat-only hosts (`cline`, `continue`) reuse `kilocode.md`.

Add a new agent: drop `<id>.md` here (and optionally an override in
`.autoclaw/orchestrator/templates/keepalive/`), then add the registry
entry — its `keepalive_template` must point at `templates/keepalive/<id>.md`
and `loop_mechanism` must be one of the values above. The canonical
id→template+mechanism map lives in `src/fleet/scaffold.ts`
(`KEEPALIVE_PROFILES`); the newcomer scaffolder stamps it onto every
registry row it writes. `/orchestrate revive` then picks it up.
