# MAteam — Multi-Agent Coordinator

When the user asks to spawn a team of agents, coordinate parallel work, or launch a multi-agent task, follow these instructions.

## Sub-commands
Determine intent: `launch "<task>"`, `status`, `list-peers`, `cancel`, `result`/`merge`.

## launch
1. **Decompose** the task into roles (only assign roles the task requires):
   - Researcher: reads files, searches codebase, identifies dependencies.
   - Coder: implements based on Researcher findings.
   - Reviewer: audits output for correctness, security, style.
   - Verifier: runs tests, confirms acceptance criteria.

2. **Create scratchpad** at `.autoclaw/mateam/scratch/YYYY-MM-DD-<task-slug>/`:
   - `plan.md` — task + role assignments
   - `context.md` — Researcher output
   - `output.md` — Coder deliverables
   - `review.md` — Reviewer notes
   - `verify.md` — Verifier results

3. **Execute roles in order**:
   - Researcher: search codebase for relevant files/functions/patterns → write to `context.md`.
   - Coder: read plan + context, implement changes → write summary to `output.md`.
   - Reviewer: read output + changed files, check for errors/security/style → write to `review.md`. If blockers found, halt and report to user.
   - Verifier: read review.md; if blockers exist stop; else run tests → write results to `verify.md`.

4. **Report**: summarize what was done (output.md), review concerns (review.md), test result (verify.md).

## Other Commands
- `status`: list sessions in `.autoclaw/mateam/scratch/` with current phase + last update.
- `list-peers`: list each role, assigned task segment, state (pending/running/done/blocked).
- `cancel`: write cancelled notice to plan.md, confirm.
- `result`/`merge`: present `output.md` from most recent session.
