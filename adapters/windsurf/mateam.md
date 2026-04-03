---
name: mateam
description: MAteam multi-agent coordinator that spawns specialized sub-agents. Activate when user asks to coordinate a team of agents or distribute a complex task.
trigger: model_decision
---

# MAteam — Multi-Agent Coordinator

Sub-commands: `launch "<task>"`, `status`, `list-peers`, `cancel`, `result`.

## Routing (before launch)
ZMLR check `HEAD http://localhost:20128`. Tiers: Researcher=free, Coder=mid, Reviewer=mid/sota, Verifier=low-cost. Max 3 concurrent on free (30s batch gaps). On fetch/429 → `[RATE_LIMIT: <model>]` in reroute.md → ZMLR `model:"auto"`. Critique loop for free Coder (3 self-reviews, score <6 → revise). SOTA review for security tasks.

## launch
1. Decompose into roles: Researcher → Coder → Reviewer → Verifier.
2. Create `.autoclaw/mateam/scratch/YYYY-MM-DD-<slug>/` with plan/context/output/review/verify files.
3. Researcher → context.md. Coder → output.md. Reviewer → review.md. Verifier → verify.md (halt if blockers).
4. Report summary.

## Other
- `status`: active sessions/phases. `list-peers`: roles+states. `cancel`: halt all. `result`: present output.
