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
- `routing` → **Show routing health for all sessions**

---

## Routing Context (read before spawning)

Before spawning any agents:

1. Check ZMLR availability: `HEAD http://localhost:20128` (2s timeout).
2. If ZMLR is online, all agents MUST route through it for resilience.
3. Assign each role a **model tier** based on task complexity (see Model Assignment below).
4. Write the routing configuration to `plan.md` under a `## Routing` section.
5. If ZMLR is offline, use the direct provider order: mid-tier first, fall back to free.

**Rate limit awareness:** Never spawn more than 3 agents simultaneously if using free-tier models.
If 4+ agents are needed and only free-tier is available, run them in batches of 3 with 30s gaps.

---

## launch — Spawn Agent Team

### Step 1 — Decompose
Break the task into workstreams. Standard roles with model tier assignments:

| Role | Responsibility | Recommended Tier | Reasoning |
|---|---|---|---|
| **Researcher** | Reads files, searches codebase, identifies dependencies | `free` or `low-cost` | Mostly I/O — model capability less critical |
| **Coder** | Implements based on Researcher's findings | `mid` | Needs solid reasoning + code quality |
| **Reviewer** | Audits output for correctness, security, style | `mid` or `sota` | Security review benefits from top models |
| **Verifier** | Runs tests, confirms acceptance criteria | `low-cost` | Structured verification, pattern matching |
| **Final Reviewer** | Optional SOTA pass for critical output | `sota` | Only for high-risk or production changes |

### Step 2 — Create Scratchpad
Create `.autoclaw/mateam/scratch/<session-id>/`:
- `plan.md` — task decomposition, role assignments, **routing config**
- `context.md` — Researcher writes findings here
- `output.md` — Coder's deliverables
- `review.md` — Reviewer's notes
- `verify.md` — Verifier's results
- `reroute.md` — Created automatically if a session fails; agents must read this

Session ID format: `YYYY-MM-DD-<task-slug>`

### Step 3 — Write Routing Config into plan.md

Append this section to `plan.md`:
```markdown
## Routing
- ZMLR: <online|offline> at http://localhost:20128
- Researcher model: <model-id>
- Coder model: <model-id>
- Reviewer model: <model-id>
- Verifier model: <model-id>
- Failover: auto (ZMLR) → mid-tier → low-cost
- Batch mode: <yes|no> (yes if free-tier and >3 agents)
- On error: append [RATE_LIMIT: <model_id>] to reroute.md and wait 30s
```

### Step 4 — Execute in Order

**Researcher** → read `plan.md` (especially `## Routing`), search codebase, write findings to `context.md`.
- If fetch/rate-limit error: append `[RATE_LIMIT: <model>]` to `reroute.md` and retry via ZMLR with model `auto`.

**Coder** → read `plan.md` + `context.md`, implement changes, write summary to `output.md`.
- If using `free` or `local` tier: apply **Critique Loop** (see below).
- If fetch/rate-limit error: check `reroute.md` for updated model, then retry.

**Reviewer** → read `output.md` + changed files, check for errors/security issues, write to `review.md`.
- Preferred tier: `mid` or higher for security-sensitive changes.
- Score the output: correctness (0-3), security (0-3), style (0-2). Record scores in `review.md`.

**Verifier** → read `review.md`, if blockers exist halt and report; otherwise run tests, write results to `verify.md`.

### Step 5 — Critique Loop (for free/local tier agents)

When a Coder or Researcher agent runs on `free` or `local` tier:

**Loop (max 3 iterations):**
1. Generate initial output.
2. Self-review against: correctness, edge cases, security, simplicity.
3. Score each 0-2. If total < 6 → revise. Else → accept.
4. Append iteration count to output: `<!-- iterations: N -->`

This loop compensates for lower model capability without requiring a higher-tier model.

### Step 6 — SOTA Final Review Gate

Trigger a SOTA final review when ANY of:
- The task involves auth, payments, cryptography, or data migration
- The Reviewer scored correctness < 2 or security < 2
- The user explicitly requests `[quality: high]`

SOTA review process:
1. Summarize all role outputs into a single prompt.
2. Route to ZMLR with model preference `openrouter/anthropic/claude-opus-4-6` or `openrouter/google/gemini-2.5-pro-preview-03-25`.
3. Ask: "Review this implementation for correctness, security, and completeness. List any issues and rate overall quality 1-10."
4. Write SOTA verdict to `verify.md` under `## SOTA Review`.
5. If score < 7 or blockers found: create follow-up tasks and do NOT mark session complete.

### Step 7 — Report
Summarize all role outputs to the user: what was done, any concerns, test result, SOTA review verdict if applicable.

---

## Other Commands

- **status**: List active sessions with current phase, last update, and routing model.
- **list-peers**: List each role, assigned task, model tier, and state.
- **cancel**: Write `cancelled: true` to scratchpad, confirm.
- **result/merge**: Present `output.md` from most recent session.
- **routing**: Show ZMLR status, per-session model assignments, rate-limit events.

---

## Concurrency Rules (prevent rate-limit storms)

| Model Tier | Max Concurrent Agents | Spawn Delay |
|---|---|---|
| `sota` | 2 | 5s between spawns |
| `mid` | 4 | 2s between spawns |
| `low-cost` | 6 | 1s between spawns |
| `free` | 3 | 30s between spawns |
| `local` | unlimited | none |

If the plan requires more agents than the concurrency limit allows, run in batches.
Log batch boundaries: `[BATCH 1/2 started]` in plan.md.

---

## Self-Healing on Fetch Failures

If any agent reports a fetch/network error:
1. Create or append to `reroute.md`:
   ```
   [ROUTE_FAIL] <role> failed with: <error> at <timestamp>
   Suggested fallback: route via ZMLR http://localhost:20128 with model auto
   ```
2. The coordinator (this agent) reads `reroute.md` on the next check.
3. Re-spawn the failed agent with ZMLR routing and `model: "auto"`.
4. If ZMLR also fails: downgrade to local model if available, else pause and notify user.
5. Log all reroutes in `plan.md` under `## Routing Events`.

---

## Context Compression for Model Migration

When switching from a high-context model to a lower-context model mid-session:
1. Summarize `context.md` to key facts only (bullet list, max 50 lines).
2. Write compressed context to `context-compressed.md`.
3. Instruct the new agent to read `context-compressed.md` instead of `context.md`.
4. Note the compression in `plan.md`: `[CONTEXT COMPRESSED at tick N due to model migration]`.
