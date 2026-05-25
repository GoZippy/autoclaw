# AutoClaw multi-agent workflow

How to coordinate a build across several AI agents working in parallel on the same project.

There are exactly **three prompt archetypes**, one per role. Pick the right one for the agent in front of you; the rest of the system is the same.

| Role | When to use | Canonical template |
|---|---|---|
| **Bootstrap** | First time on a project — sprints don't exist yet | [`templates/starter/bootstrap.md`](../skills/orchestrate/templates/starter/bootstrap.md) |
| **Coordinator** | One agent runs the orchestrator role for the whole fleet | [`templates/starter/coordinator.md`](../skills/orchestrate/templates/starter/coordinator.md) |
| **Worker** | Any agent that walks up and asks for work to do | [`templates/starter/worker.md`](../skills/orchestrate/templates/starter/worker.md) |

If an agent has gone silent and you want to revive that specific session, use [`templates/keepalive/`](../skills/orchestrate/templates/keepalive/) (rendered automatically by `/orchestrate revive <agent-id>`). Keepalive = revival of a known stalled session; starter = first check-in.

To customise any of these for a single project, copy the file from `skills/orchestrate/templates/starter/` (shipped default) to `.autoclaw/orchestrator/templates/starter/` (per-project override) and edit there.

---

## The workflow in one paragraph

One agent runs **bootstrap** once (`/orchestrate init && /orchestrate plan`) to turn the project's task manifest into sprint YAMLs. From then on, every agent that joins the project pastes the **worker** prompt and self-paces a cycle of: read the cross-agent protocol, drain its inbox, claim the next ready sprint via `/orchestrate next`, work strictly within scope, broadcast `task_complete` + `review_request` when done, vote on peers' work, repeat. One agent (usually the most reliable host) runs the **coordinator** prompt in parallel — it doesn't claim tasks; it watches the comms log, unblocks stalls, runs `/orchestrate review` on completed sprints, and runs `/orchestrate merge` once consensus lands. Workers HALT on the protocol's halt conditions (cycle ≥ 25, scope violation, all merged); the coordinator runs forever until you stop it.

---

## Step-by-step

### 1. Bootstrap (once per project)

Paste into any single agent — host doesn't matter:

```
/orchestrate init && /orchestrate plan
```

That writes `.autoclaw/orchestrator/config.yaml`, generates sprint YAMLs from your manifest, and produces `plan-summary.yaml`. Idempotent — re-running `plan` regenerates in place.

If you don't have a manifest yet but you do have a Kiro spec at `.kiro/specs/*/tasks.md`, `/orchestrate init` will offer to generate one.

### 2. Start a coordinator (one window, runs forever)

Pick one agent — usually a Claude Code window with `/loop`, since that gives you self-pacing. Paste the **coordinator** prompt. This window will:

- check `comms-log` and every agent's inbox each cycle
- assign next sprints via `/orchestrate next`
- run `/orchestrate review` on sprints where every assigned agent has filed `task_complete`
- run `/orchestrate merge` on `APPROVED` sprints
- escalate stalled agents via `/orchestrate revive <agent-id>`

The coordinator does **not** claim tasks — that's the workers' job. Keeping the roles separate is what makes the build actually progress instead of every window fighting for the same claim file.

### 3. Add workers (one window per parallel slot)

For each parallel slot (default 4), open a fresh agent window — any host AutoClaw supports — and paste the **worker** prompt. The worker self-paces a coordination cycle and stops cleanly when its HALT conditions trip.

Workers are interchangeable. You can spin up Claude Code, Kilo, Cursor, Kiro, and Gemini-CLI all on the same project; the orchestrator routes work via the agent registry and capability tags.

### 4. Watch from VS Code (optional)

`Ctrl+Alt+O` opens **Orchestrate Plan**. The KDream Dashboard (`Ctrl+Alt+K`) shows live heartbeats. `autoclaw.fleet.metrics` in the command palette shows p50/p95/p99 task latency. None of these are required — the file-system protocol is the source of truth.

---

## Why this beats a single long prompt

The old "paste this giant blob into every agent" approach has three failure modes:

1. **Bootstrap leaks into the loop.** `init` and `plan` are one-shots. Re-running them every cycle is wasted work and confuses the agent about whether it's setting up or working.
2. **Host-specific rules paths break portability.** `.clinerules/cross-agent.md` only exists for Kilo. Claude Code reads `.claude/rules/`; others read `AGENTS.md`. The worker template uses an `if-exists` chain instead.
3. **No HALT clause = infinite spin.** Workers without halt conditions waste tokens after all sprints merge. The protocol's halt list (cycle ≥ 25, scope violation, all merged) is now baked into the template.

The three-template split also lets `/orchestrate revive` render *the right prompt for the right role* automatically — you don't have to remember which window was coordinator vs worker.

---

## Skills involved

The workflow leans on five skills, listed by how central they are:

1. **`/orchestrate`** — the planner, assigner, reviewer, merger. The whole workflow is built on this.
2. **`/loop`** — built-in Claude Code skill that self-paces the next cycle. Required for the worker and coordinator templates on slash-loop hosts.
3. **Cross-agent protocol file** (`.claude/rules/cross-agent-protocol.md`, `.clinerules/cross-agent.md`, or `AGENTS.md`) — always-loaded rules the worker re-reads each cycle. Authoritative spec: [`docs/AGENT_SESSION_PROTOCOL.md`](AGENT_SESSION_PROTOCOL.md).
4. **`/orchestrate revive <agent-id>`** — for waking a stalled peer. Reads `templates/keepalive/<agent-id>.md` and substitutes the parameters.
5. **`/kdream`** (optional) — persistent memory between cycles. Useful for the coordinator window; not required for workers.

---

## Troubleshooting

- **Two workers claimed the same task.** Should be impossible — claim files are create-exclusive writes. If it happens, one of the agents skipped the `session_id` confirmation step. Re-read the protocol's "Claiming work" section.
- **A worker is editing files outside its scope.** That's a `scope_violation`. The coordinator should detect this in the comms-log; the offending worker HALTs. Fix: tighten the scope globs in the sprint YAML or split the task.
- **Heartbeats are fresh but no tasks complete.** Inbox idempotency is broken — the worker is re-processing `processed/` messages. Check `state.json`'s `message_ledger`.
- **Coordinator says "all sprints merged" but you still have manifest tasks left.** Re-run `/orchestrate plan` — manifests changed mid-build, plan is stale.

For deeper protocol detail (six-phase cycle, mailbox idempotency, claim semantics, consensus voting), read [`docs/AGENT_SESSION_PROTOCOL.md`](AGENT_SESSION_PROTOCOL.md). The workflow above is the practical wrapper; the protocol is the contract.
