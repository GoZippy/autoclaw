# Phase 0 Execution Report — Distributed Agent Fabric Activation

_Authored 2026-05-09. Worktree: `.claude/worktrees/agent-ac6b45f2597da4b6f`._

## Branch

- Branch name: `worktree-agent-ac6b45f2597da4b6f`
- Fork point (merge-base with `master`): `8a44446` ("chore: remove IDE
  agent rule dirs from tracking")
- Current `master` HEAD on disk: `a8ac62c` (one commit ahead of the
  fork point — see "Pre-existing worktree state" below)
- Six new commits, none pushed.

## Per-Item Summary

### Item 6 — `bridge.test.ts` + `comms.test.ts`

- Commit: `7ae62a7` — `test(comms,bridge): add unit suites covering existing behavior`
- Files touched: `src/test/bridge.test.ts` (new), `src/test/comms.test.ts` (new), `package.json`
- LOC: +389 / -1
- New tests: 25 (12 in `bridge.test.ts`, 13 in `comms.test.ts`)
- Test result: **PASS** (178 total = 153 existing + 25 new)
- Notes: Tests use Mocha TDD interface (`teardown` not `afterEach`).
  Bridge endpoint suite picks a random port in 9876–10876 per test
  and stops the server in `teardown()` so ports are released between
  tests. No production code changes.

### Item 2 — `resolveAgentId()` in `planSprints()`, persist platform/inbox

- Commit: `7deb45d` — `feat(orchestrate): persist resolved platform/inbox in SprintAssignment`
- Files touched: `src/orchestrate.ts`, `src/test/orchestrate.test.ts`
- LOC: +95 / -5
- New tests: 4
- Test result: **PASS** (182 total)
- Notes: `SprintAssignment` gains optional `platform?: string` and
  `inbox?: string`. `planSprints()` accepts a 4th positional argument
  `agents: AgentRegistryEntry[] = []`; `generatePlan()` accepts a 3rd.
  Both backwards compatible. New keys are only set when the registry
  resolves to a non-WA-N platform — assignments without a registry
  entry stay shape-identical to v2.1.0.

### Item 5 — `mergeFindings()` inside `evaluateConsensus()`

- Commit: `64bc7ab` — `feat(orchestrate): wire mergeFindings into evaluateConsensus`
- Files touched: `src/orchestrate.ts`, `src/test/orchestrate.test.ts`
- LOC: +56 / -1
- New tests: 2
- Test result: **PASS** (184 total)
- Notes: `evaluateConsensus()` now derives `allFindings` from
  `mergeFindings(votes).unique` rather than `votes.flatMap(...)`.
  Also adds an optional `merged_findings: ValidationFinding[]` field
  on `ConsensusResult` so consumers can read the deduplicated set
  without re-running the merge. Existing 10 consensus tests still
  pass — the dedup only collapses _identical_ keys, so distinct
  findings continue to flow through unchanged.

### Item 1 — Auto-start bridge when manifest exists

- Commit: `7be7245` — `feat(bridge): auto-start on 127.0.0.1 when manifest exists`
- Files touched: `src/extension.ts`, `src/manifest-probe.ts` (new), `src/test/manifest-probe.test.ts` (new), `package.json`
- LOC: +94 / -4
- New tests: 5
- Test result: **PASS** (189 total)
- Notes: New setting `autoclaw.bridge.autoStart` (default `true`).
  Activation gate: `enabled` override → start; else `autoStart` AND
  manifest probe → start. The probe (`hasOrchestratorManifest`)
  lives in a new `src/manifest-probe.ts` module so it can be unit
  tested without booting the vscode test harness.
- **Deviation:** the original plan recommended exporting the helper
  from `extension.ts` and importing it into `extension.test.ts`. That
  would require the test harness to load `extension.ts`, which
  `require('vscode')`s at module load — not viable in plain Mocha.
  The new module is functionally equivalent and pulled in via the
  same import.

### Item 3 — `evaluateConsensus()` bridge endpoint + review broadcast

- Commit: `ab08919` — `feat(bridge): add POST /api/v1/consensus/{tid}/evaluate; broadcast result`
- Files touched: `src/bridge.ts`, `src/extension.ts`, `src/test/bridge.test.ts`
- LOC: +115 / -1
- New tests: 4
- Test result: **PASS** (193 total)
- Notes: New endpoint reads `consensus/active/{tid}-*.json`, calls
  `evaluateConsensus()`, returns the `ConsensusResult`, and appends
  a `consensus_result` entry to `comms-log.jsonl`. Idempotent — vote
  files are not moved. The existing `orchestrateReviewCommand()` now
  also broadcasts each result as a `consensus_result` message into
  `inboxes/shared/`.

### Item 4 — Heartbeat-aware planning

- Commit: `6f6cf24` — `feat(orchestrate): heartbeat-aware sprint assignment`
- Files touched: `src/orchestrate.ts`, `src/extension.ts`, `src/test/orchestrate.test.ts`, `package.json`
- LOC: +133 / -3
- New tests: 3
- Test result: **PASS** (196 total)
- Notes: New setting `autoclaw.orchestrate.heartbeatStallSeconds`
  (default 300, min 30). `orchestrateAssignNextCommand()` now reads
  `getAgentStatuses()`, identifies stalled / offline / never-beat
  WA-N slots, logs a warning, and writes a sidecar
  `.autoclaw/orchestrator/sprint-{n|next}-stalled.json`. Skill-side
  `/orchestrate next` can pass the stalled IDs as `excludedSlots` to
  `planSprints()`.
- `planSprints()` and `generatePlan()` gain an optional 5th/4th
  argument `excludedSlots: Set<string> = new Set()`. Excluded slots
  are skipped during bin-packing. **Latent bug fix:** added a
  defensive break-if-no-progress guard on the outer `while` loop
  inside `planSprints()`. Without it, calling the planner with every
  slot excluded (a real Phase-0 case) entered an infinite loop. The
  guard is also a hardening for the previously unreported scope-
  conflict-only-one-agent case.

## Totals

| Metric | Value |
|---|---|
| Commits | 6 |
| Files added | 4 (`manifest-probe.ts`, three test files) |
| Files modified | 5 (`bridge.ts`, `comms.ts`*, `extension.ts`, `orchestrate.ts`, `package.json`) |
| LOC added | +878 |
| LOC removed | -11 |
| Tests added | 43 (25 + 4 + 2 + 5 + 4 + 3) |
| Tests passing | 196 / 196 (was 153) |
| Tests failing | 0 |
| New npm dependencies | 0 |

\* `comms.ts` shows `+8 -3` in the cumulative diff but is **not**
modified by any of the six Phase-0 commits — that delta belongs to
the commit `a8ac62c` that exists on `master` but not on this branch
(see "Pre-existing worktree state" below). The merge-base diff makes
this look like our work; commit-by-commit diff shows we never touched
`comms.ts`.

## Deviations From The Plan

1. **Item 1 — helper extracted to its own module.** Plan asked for
   `hasOrchestratorManifest` to be exported from `extension.ts` and
   tested in `extension.test.ts`. `extension.ts` requires `vscode` at
   module load, which crashes plain Mocha. Created
   `src/manifest-probe.ts` instead — same behavior, testable.
2. **Item 3 — endpoint signature.** Plan diff claimed
   `result.task_id = tid;` mutated the typed `ConsensusResult` field.
   That works because `task_id` is already declared on the type — no
   change needed. Round-number parsing tolerates a missing or
   non-numeric `round` field, falling back to `1`.
3. **Item 4 — added a defensive `break` to `planSprints()`.** Not in
   the plan but required: the plan's `continue` for excluded slots
   leaves `remaining` unchanged when every slot is excluded, causing
   an infinite outer-while loop. Added a "no progress made this
   iteration" guard so `excludedSlots = {WA-1, WA-2}` cleanly emits
   zero sprints rather than hanging.
4. **Item 4 — sidecar file naming.** Plan suggested
   `stalled-slots.json` (singular). Used
   `sprint-{n|next}-stalled.json` instead so multiple sprints can
   coexist on disk without overwriting each other.
5. **Skill prompt update (Item 2).** The plan recommends adding a
   sentence to `skills/orchestrate/SKILL.md` so the skill prompt
   loads `agents.json` and passes it to `generatePlan`. **Skipped**
   per the worktree mission's "Default: don't touch skills" guidance
   — the source-side change is in place, the skill prompt update is
   a separate small commit the user can land in master directly.

## Unresolved Issues / TODO Carve-Outs

- **Skill prompts not updated.** Items 2 and 4 expose new optional
  parameters to `planSprints` / `generatePlan` and a new sidecar
  JSON file. Until the orchestrate skill prompt is updated to load
  `.autoclaw/orchestrator/agents.json` and the new
  `sprint-*-stalled.json`, those features remain dormant. Recommend
  a follow-up commit on master that touches only
  `skills/orchestrate/SKILL.md` and runs `npm run adapters:build`.
- **Bridge port fallback.** Plan called this "out of Phase 0".
  Auto-start still hard-fails on EADDRINUSE — the catch swallows the
  error so the extension survives, but no retry on 9877..9880.
- **`mergeFindings` mutates input findings' severity.** Documented
  as known-acceptable in the plan; should be cloned in a future
  hardening pass to avoid surprising callers that read `.votes` after
  `evaluateConsensus()`.
- **Pre-existing infinite-loop risk in `planSprints()`.** The
  "every-task-scope-conflicts-with-itself" path was unreachable
  before Phase 0 (no exclusion mechanism existed) but the underlying
  bug was always there. The defensive guard added in Item 4 also
  closes that hole; worth noting in the changelog so reviewers know
  the fix isn't strictly Phase-0 scope.

## Pre-existing Worktree State

The worktree was created from commit `8a44446`, which is one commit
behind `master`'s HEAD (`a8ac62c`, "fix(comms): strip UTF-8 BOM..."
plus `scripts/run-tests.js`). This is **not** something Phase 0
changed — the file `scripts/run-tests.js` simply never existed in
this branch. When the user fast-forwards to merge, they should rebase
this branch onto `a8ac62c` (or pick the six commits onto a fresh
branch off master) so that the BOM-strip fix and the
`scripts/run-tests.js` runner are preserved. Mechanically:

```
git fetch
git rebase master worktree-agent-ac6b45f2597da4b6f
```

Or, if a merge-commit history is preferred:

```
git checkout master
git merge --no-ff worktree-agent-ac6b45f2597da4b6f
```

A 3-way merge of `comms.ts` is trivial — the BOM-strip change in
`a8ac62c` does not collide with anything in this branch.

## How To Review

`git log --oneline 8a44446..HEAD` (in chronological order — earliest
first):

```
7ae62a7 test(comms,bridge): add unit suites covering existing behavior
7deb45d feat(orchestrate): persist resolved platform/inbox in SprintAssignment
64bc7ab feat(orchestrate): wire mergeFindings into evaluateConsensus
7be7245 feat(bridge): auto-start on 127.0.0.1 when manifest exists
ab08919 feat(bridge): add POST /api/v1/consensus/{tid}/evaluate; broadcast result
6f6cf24 feat(orchestrate): heartbeat-aware sprint assignment
```

### Recommended review order

1. **`7ae62a7`** — pure tests, no production code. Read the test
   files top-down; they document the existing comms / bridge
   behaviors.
2. **`7deb45d`** — single-file orchestrate change. The interface
   shape is the load-bearing decision: optional fields keep YAML
   readers (regex) and JSON consumers (schemaless) backward
   compatible.
3. **`64bc7ab`** — three-line substitution at the top of
   `evaluateConsensus()` plus the new optional `merged_findings`
   field at every return. Verify the existing 10 consensus tests
   still cover the intended semantics (they do).
4. **`7be7245`** — extension activation hunk + new module. The hot
   spot is the activation gate: confirm `enabled` still works as a
   manual override.
5. **`ab08919`** — bridge.ts new route placement (BEFORE the GET
   regex), and the broadcast in `orchestrateReviewCommand`. Hot
   spot: the regex `^/api/v1/consensus/([^/]+)/evaluate$` correctly
   excludes `/` in `tid`.
6. **`6f6cf24`** — extension hunk (heartbeat probe), package.json
   setting, and the planSprints `excludedSlots` parameter. Hot spot:
   the `everySlotExcluded` early-`continue` plus the
   "no-progress-break" defensive guard in `planSprints()`.

### Hot spots to focus on

- `src/extension.ts` activation gate (lines around the `bridgeAutoStart`
  / `bridgeEnabledOverride` block). Make sure `enabled = true` still
  starts the bridge even with no manifest.
- `src/orchestrate.ts` `planSprints()` outer `while`. The new
  `everySlotExcluded` and `remainingBefore` guards must not regress
  the existing planner behavior — verified by the
  "empty excludedSlots is identical to default behaviour" test.
- `src/bridge.ts` route ordering. POST `/evaluate` must be matched
  before the catch-all GET `/consensus/(.+)`.
- `src/test/bridge.test.ts` Mocha `teardown` (not `afterEach`).

## Merge Checklist

- [ ] Branch rebased onto current `master` (`a8ac62c` or newer); no
      conflicts with `comms.ts` BOM-strip fix.
- [ ] `npm run test:unit` green (expect 196 passing).
- [ ] `npm run adapters:check` green (no skill content changed in
      this branch — should be unaffected).
- [ ] `npm run compile` green.
- [ ] Manual smoke test: open a workspace with at least one
      `.autoclaw/orchestrator/manifests/*.yaml`, reload window,
      confirm "AutoClaw bridge on 127.0.0.1:9876" log line.
- [ ] Manual smoke test: `curl http://127.0.0.1:9876/health` →
      `{"status":"ok",…}`.
- [ ] Skill prompt follow-up filed: update
      `skills/orchestrate/SKILL.md` to load `agents.json` and
      `sprint-*-stalled.json`, then run `npm run adapters:build`.
- [ ] CHANGELOG entry added under an unreleased "2.2.0" section
      describing the six items + the latent planner-loop fix.
