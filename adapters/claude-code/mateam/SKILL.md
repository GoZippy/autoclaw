---
name: mateam
description: Multi-agent coordinator that spawns specialized sub-agents in parallel. Trigger on "/mateam launch", "spawn agents", "multi-agent", or "coordinate team".
user-invocable: true
allowed-tools: Read, Write, Bash, Glob, Grep, Agent
context: fork
---

# MAteam — Multi-Agent Coordinator

## On Invocation

- `launch "<task>"` / no sub-command + task → **Spawn a team**
- `status` → **Show active agents**
- `list-peers` → **List all agents**
- `cancel` → **Halt all agents**
- `result` / `merge` → **Collect outputs**

---

## launch — Spawn Agent Team

### Step 1 — Decompose
Break the task into workstreams. Standard roles:

| Role | Responsibility |
|---|---|
| **Researcher** | Reads files, searches codebase, identifies dependencies |
| **Coder** | Implements based on Researcher's findings |
| **Reviewer** | Audits output for correctness, security, style |
| **Verifier** | Runs tests, confirms acceptance criteria |

### Step 2 — Create Scratchpad
Create `.autoclaw/mateam/scratch/<session-id>/`:
- `plan.md` — task decomposition and role assignments
- `context.md` — Researcher writes findings here
- `output.md` — Coder's deliverables
- `review.md` — Reviewer's notes
- `verify.md` — Verifier's results

Session ID format: `YYYY-MM-DD-<task-slug>`

### Step 3 — Execute in Order

**Researcher** → read `plan.md`, search codebase, write findings to `context.md`.

**Coder** → read `plan.md` + `context.md`, implement changes, write summary to `output.md`.

**Reviewer** → read `output.md` + changed files, check for errors/security issues, write to `review.md`.

**Verifier** → read `review.md`, if blockers exist halt and report; otherwise run tests, write results to `verify.md`.

### Step 4 — Report
Summarize all role outputs to the user: what was done, any concerns, test result.

---

## Other Commands

- **status**: List active sessions with current phase and last update.
- **list-peers**: List each role, assigned task, and state.
- **cancel**: Write `cancelled: true` to scratchpad, confirm.
- **result/merge**: Present `output.md` from most recent session.
