---
name: mateam
description: MAteam multi-agent coordinator that spawns specialized sub-agents. Activate when user asks to coordinate a team of agents or distribute a complex task.
trigger: model_decision
---

# MAteam — Multi-Agent Coordinator

Sub-commands: `launch "<task>"`, `status`, `list-peers`, `cancel`, `result`.

## launch
1. Decompose into roles: Researcher → Coder → Reviewer → Verifier.
2. Create `.autoclaw/mateam/scratch/YYYY-MM-DD-<slug>/` with plan/context/output/review/verify files.
3. Researcher → context.md. Coder → output.md. Reviewer → review.md. Verifier → verify.md (halt if blockers).
4. Report summary.

## Other
- `status`: active sessions/phases. `list-peers`: roles+states. `cancel`: halt all. `result`: present output.
