---
name: loop-discipline
description: Six short rules for running an autonomous loop well. Loaded at the start of any perpetual loop, watch-mode tick, or /loop dispatch. Keeps the loop's signals clean and prevents over-supervision.
trigger: /loop, /sprint, /work, perpetual loop, watch mode
---

# Loop Discipline — Six Rules

Short rules that fit in any agent's context, applied at the **start of
every loop cycle and every watch-mode tick**. Each one a single
sentence.

## 1. Read state from disk every cycle.

Don't trust what was in memory last tick — a runner may have restarted.
The bus is the truth.

## 2. Show the loop the world; let it decide.

Don't script every tick. Surface the current heartbeats, claims, inbox
depth, and pending findings; the loop picks the next move from that.

## 3. Plans expire.

If the inbox or the dependency graph moved since the plan was written,
re-plan before acting on it. A stale plan misguides quietly.

## 4. Disk holds state; git holds history.

Anything that must survive a restart goes through the filesystem.
Anything that must survive a rewrite goes through a commit. In-memory
caches are speed, not truth.

## 5. Communicate with named signals, not branching scripts.

Emit typed events (`heartbeat`, `task_complete`, `finding_report`,
`scope_violation`) and let listeners react. Long if/else chains age
badly.

## 6. Once the signals are good, trust the loop.

If you're auditing every cycle, you've built a script and called it a
loop. Tighten the signals; let the loop run.

---

## How AutoClaw uses these

- **`src/orchestratorLoop.ts`** (the perpetual health → work → dispatch
  → log loop) is governed by these rules.
- **`/loop` skill watch mode** re-reads `state.json` each tick per rule
  1.
- **Personas** that run inside a loop (see
  [docs/rfc/specialized-agents.md](../../docs/rfc/specialized-agents.md))
  cite this skill from their `## When invoked` section.
- **Anti-pattern guard**: if a runner holds in-memory state across
  dispatches, raise a `finding_report` against it. Reference rule 1.

## Background

These rules summarize patterns we've seen across several autonomous-loop
projects (logged in
[docs/research/2026-05-22-cross-project-survey.md §2.1](../../docs/research/2026-05-22-cross-project-survey.md)).
Adopt the ideas, not the borrowed vocabulary.
