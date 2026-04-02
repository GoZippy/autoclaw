---
inclusion: manual
name: mateam
description: MAteam multi-agent coordinator. Reference with #mateam when spawning agent teams, coordinating parallel work, or distributing tasks across roles.
---

# MAteam — Multi-Agent Coordinator

Sub-commands: `launch "<task>"`, `status`, `list-peers`, `cancel`, `result`.

## launch
1. Decompose task into roles (use only what's needed): Researcher → Coder → Reviewer → Verifier.
2. Create scratchpad at `.autoclaw/mateam/scratch/YYYY-MM-DD-<slug>/` with plan.md, context.md, output.md, review.md, verify.md.
3. Execute roles in sequence:
   - **Researcher**: search codebase, write findings to `context.md`.
   - **Coder**: implement using context, write summary to `output.md`.
   - **Reviewer**: audit output, write issues to `review.md`.
   - **Verifier**: if blockers exist halt+report; else run tests, write to `verify.md`.
4. Report summary of all outputs.

## Other Commands
- `status`: active sessions, current phase, last update.
- `list-peers`: roles, tasks, states.
- `cancel`: mark cancelled.
- `result`: present `output.md` from most recent session.
