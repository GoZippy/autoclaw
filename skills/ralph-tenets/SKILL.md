---
name: ralph-tenets
description: Six-tenet overlay for autonomous-loop discipline. One page, loaded into any agent's context at the start of a perpetual-loop or watch-mode cycle. Trigger when an agent is about to enter a /loop or when an orchestrator is dispatching to a perpetual worker like orchestratorLoop.ts. Adapted from ralph-orchestrator/CLAUDE.md.
trigger: /loop, /sprint, /work, perpetual loop, watch mode, "ralph"
---

# Ralph's Six Tenets — Loop Discipline Overlay

Borrowed (with attribution) from [`GoZippy/ralph-orchestrator`](https://github.com/GoZippy/ralph-orchestrator)
via the [2026-05-22 cross-project survey](../../docs/research/2026-05-22-cross-project-survey.md) §2.1.
Six rules that fit in any agent's context window, applied at the **start
of every loop cycle and every watch-mode tick**. Each rule one sentence.

## 1. Fresh Context Is Reliability
Re-read state from disk every cycle — never trust in-memory continuity
between dispatches. A runner that resumes assumes nothing.

## 2. Backpressure Over Prescription
Don't tell the loop *what* to do every tick. Show it the state of the
world (heartbeats, claims, inbox depth) and let it choose. Prescription
breaks when reality diverges; backpressure adapts.

## 3. Plan Is Disposable
A plan exists to be re-evaluated against current state. If the inbox or
the dependency graph changed since the plan was written, re-plan — don't
march forward on a stale roadmap.

## 4. Disk Is State, Git Is Memory
`.autoclaw/orchestrator/` is the truth. In-memory caches are a
performance hint, never an authority. Anything you need to survive a
restart goes through the filesystem (or git for history).

## 5. Steer With Signals Not Scripts
A long branching script trying to handle every case ages badly. Emit
typed signals (`heartbeat`, `task_complete`, `finding_report`,
`scope_violation`) and let consumers react. The orchestrator is a
reactor, not a state machine that does everything itself.

## 6. Let Ralph Ralph
Give the loop the smallest possible reason to be wrong, then trust it to
run. Over-supervising a perpetual loop defeats the point. If you're
auditing every cycle, you've built a one-shot script and called it a
loop — fix the loop's signals instead.

---

## How AutoClaw uses these
- **`src/orchestratorLoop.ts` health→work→dispatch→log** is a Ralph loop.
- **`/loop` skill watch mode** invokes "fresh context" by re-reading
  state.json each tick.
- **Personas** that run inside a loop (see
  [specialized-agents.md](../../docs/rfc/specialized-agents.md))
  cite this skill in their `## When invoked` section.
- **Anti-pattern guard**: if a runner subprocess holds in-memory state
  across dispatches, raise a `finding_report` against it. Reference
  Tenet 1.
