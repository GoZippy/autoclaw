---
name: mateam
description: Multi-agent coordinator that spawns specialized sub-agents working in parallel. Trigger on "/mateam launch", "spawn agents", "multi-agent", or "coordinate team".
---

# MAteam — Multi-Agent Coordinator

## On Invocation

Determine the sub-command from the user's message:

- `launch "<task>"` / no sub-command + task → **Spawn a team**
- `status` → **Show active agents**
- `list-peers` → **List all agents in session**
- `cancel` / `stop` → **Halt all agents**
- `result` / `merge` → **Collect and merge outputs**

---

## launch — Spawn Agent Team

### Step 1 — Decompose the Task
Break the user's task into parallel workstreams. Standard roles:

| Role | Responsibility |
|---|---|
| **Researcher** | Gathers context: reads relevant files, searches codebase, identifies dependencies |
| **Coder** | Implements changes based on Researcher's findings |
| **Reviewer** | Audits Coder's output for correctness, security, and style |
| **Verifier** | Runs tests, checks build, confirms acceptance criteria are met |

Assign only the roles the task requires. Small tasks may need only Researcher + Coder.

### Step 2 — Create Scratchpad
Create `.autoclaw/mateam/scratch/<session-id>/` with:
- `plan.md` — task decomposition and role assignments
- `context.md` — shared findings (Researcher writes here)
- `output.md` — Coder's deliverables
- `review.md` — Reviewer's notes
- `verify.md` — Verifier's results

Write the task and role breakdown to `plan.md`.

### Step 3 — Execute Roles in Order

**Researcher:**
- Read `plan.md` to understand scope.
- Search the codebase for relevant files, functions, and patterns.
- Write findings to `context.md`: file paths, key functions, existing patterns, potential conflicts.

**Coder:**
- Read `plan.md` and `context.md`.
- Implement the required changes.
- Write a summary of changes made (files modified, functions added/changed) to `output.md`.

**Reviewer:**
- Read `output.md` and the actual changed files.
- Check for: logic errors, security issues, style inconsistencies, missing edge cases.
- Write findings to `review.md`. If blockers found, flag them clearly.

**Verifier:**
- Read `review.md`. If blockers exist, halt and report to user.
- Run the project's test suite and/or build command.
- Write results (pass/fail, test output summary) to `verify.md`.

### Step 4 — Report
Summarize all four role outputs to the user:
- What was done (from `output.md`)
- Any review concerns (from `review.md`)
- Test/build result (from `verify.md`)
- Location of full scratchpad for inspection

---

## status — Show Active Agents

Read `.autoclaw/mateam/scratch/` and list all active sessions with their current phase and last update time.

## list-peers — List All Agents

List each role active in the current session, their assigned task segment, and current state (pending / running / done / blocked).

## cancel — Halt All Agents

1. Write `{ "cancelled": true }` to each session's scratchpad.
2. Append cancellation notice to `plan.md`.
3. Confirm to user.

## result / merge — Collect Outputs

Read `output.md` from the most recent session and present the final merged result to the user.

---

## Parallel Execution Note

When running multiple independent sub-tasks, execute Researcher and any non-dependent Coder segments in parallel by issuing simultaneous tool calls. Sequential dependencies (Reviewer must wait for Coder) must be respected. Always document handoff points in `plan.md`.

---

## Session ID Format

Use `<YYYY-MM-DD>-<task-slug>` as the session ID, e.g. `2026-04-01-refactor-auth`.
