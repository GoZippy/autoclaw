# AutoClaw App-Completion Goal — Phased Plan & Loop

Owner: claude-code (orchestrating) · Started: 2026-06-27 · Status: ACTIVE

Standing directive: finish coding + testing every component/tool/feature/system,
then critique → improve → re-test until complete; build a single canonical
feature/user-story status spreadsheet; then loop-test every user story, document
errors, fix logistical/UX errors, and re-test. Coordinate multi-agent work over
the AutoClaw comms bus and via /mateam · /orchestrate · Workflow.

## Canonical artifacts (single source of truth)

- `FEATURE-STATUS.csv` — every feature: area, user story, expected behavior,
  entry points, code refs, status, tests, gaps. THE tracking spreadsheet.
- `GAP-ANALYSIS.md` — missing/partial/stub components → prioritized build backlog.
- `USER-STORY-TESTS.csv` — (Phase D) per-user-story test result + errors found.
- `GOAL-LOG.md` — running log of phases, agents launched, increments landed.

## Phases (looped, not strictly linear)

| Phase | Goal | Mechanism | Exit |
|---|---|---|---|
| A. Inventory | Survey all subsystems → feature rows + user stories + status | Workflow fan-out (read-only) | FEATURE-STATUS.csv populated |
| B. Gap → Backlog | Identify missing/partial/stub; prioritize | Workflow synthesis + manifest | GAP-ANALYSIS.md + orchestrate manifest |
| C. Build-out | Implement missing/partial components | /orchestrate sprints in **git worktrees** (scope-isolated) | all features `complete`, build green |
| D. Critique/Improve | Adversarial review + simplify each new area | /code-review + Workflow verify | findings resolved |
| E. User-story testing | Execute every user story; document errors | Workflow test agents | USER-STORY-TESTS.csv populated |
| F. Fix logistical/UX | Fix every logistical + UX error found | scoped agents in worktrees | errors cleared |
| G. Re-test | Re-run every user-story test post-fix | Workflow | all stories pass |

## Hard rules (learned this session — non-negotiable)

1. **Isolate build work in git worktrees.** Multiple sessions on the master
   working tree caused repeated collisions + transient red builds. Survey is
   read-only (safe on master); all WRITE sprints go in worktrees with explicit
   scope leases.
2. **Coordinate over the comms bus.** Announce, claim, lease, handoff, finding —
   never edit a peer's actively-leased file.
3. **Land verified increments.** Compile + targeted tests green before REPORT.
4. **One canonical spreadsheet.** Update FEATURE-STATUS.csv as status changes;
   never fork divergent copies.

## Current cycle

- Phase A in progress: survey Workflow launched across ~15 subsystem lanes.
