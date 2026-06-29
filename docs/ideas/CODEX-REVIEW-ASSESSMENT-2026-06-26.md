# Codex Review Assessment — AutoClaw Self-Improvement Items

**Date:** 2026-06-26
**Source:** Codex dogfood review of AutoClaw against PersistentWorldStudio (PWS)
**Validator:** Kilo (fresh read of the actual AutoClaw codebase)

---

## Verdict Summary

| # | Codex Claim | Reality in AutoClaw | Verdict |
|---|---|---|---|
| 1 | Reconcile must validate YAML parseability | `parseSprintYamlTasks` is a regex scanner with NO YAML parser; invalid YAML silently yields zero tasks | **AGREE — real gap** |
| 2 | Board refresh too dependent on state.tasks | `taskCatalogIngest` already exists and `writeBoard` reads sprints dir; but ingest is NOT called on every board write — board only sees what's in `state.json` | **AGREE — partial gap** |
| 3 | Plan-summary/config drift needs first-class detection | No code compares `total_sprints` vs actual `sprint-*.yaml` files, nor checks `git.enabled` vs reality | **AGREE — real gap** |
| 4 | task-ledger.jsonl ingestion incomplete | `taskLedger.ts` exists and `workforceIngest.ts` handles `task_complete`; but ledger entries are thin (no `tests_run`, `gates`, `summary`, `tasks[]`) | **AGREE — partial gap** |
| 5 | Gate results need "weak green" reporting | Gate system exists but `gates_passed` is boolean — no distinction between a real pass and a no-op/skipped gate | **AGREE — real gap** |
| 6 | Runtime files dirtying git constantly | `.gitignore` already excludes `.autoclaw/`, heartbeats, loop-state, lock files | **DISAGREE — already handled** |
| 7 | Reconcile reports must become actionable backlog | Reconcile writes report + broadcasts system messages, but no auto-creation of claimable ops tasks | **AGREE — real gap** |
| 8 | Intelligence source reporting should be workspace-aware | `sessionInWorkspace` already exists in `claudeCode.ts`; dashboard does NOT expose which sources matched vs ignored | **PARTIAL — backend exists, UI gap** |

---

## Detailed Assessment

### Item 1 — YAML parseability validation
**File:** `src/orchestrator/reconcile.ts:90-109`

The `parseSprintYamlTasks` function uses a hand-rolled regex to extract task blocks. It does NOT use a YAML parser. If a sprint YAML has a syntax error (broken indentation, unclosed quote, tab characters), the regex simply fails to match and the file appears empty. No error is surfaced.

This is exactly what Codex observed: PWS had an invalid `component-registry.yaml` and AutoClaw's reconcile never flagged it.

**Fix:** Add a strict YAML parse step using `js-yaml`. Parse failures become `yaml_parse_error` drifts in the reconcile report and broadcast to shared inbox.

### Item 2 — Board refresh dependency on state.tasks
**Files:** `src/orchestrator/boardWriter.ts:129-186`, `src/orchestrator/taskCatalogIngest.ts`

`taskCatalogIngest` exists and is well-implemented — it reads sprint YAMLs + spec tasks.md, normalizes, and writes `state.json`. But `writeBoard` does NOT call `ingestTaskCatalog`. It only reads whatever is already in `state.json`. If the catalog ingest hasn't run recently, the board shows stale data.

The board refresh watcher (`boardRefresh.ts`) reacts to `state.json` changes, but only re-reads — it doesn't re-ingest.

**Fix:** `writeBoard` should call `ingestTaskCatalog` before reading tasks, or the orchestrator loop should run catalog ingest before each board write.

### Item 3 — Plan-summary/config drift
**Files:** `src/orchestrate.ts` (total_sprints), no git config checks

`total_sprints` is set by the planner (`orchestrate.ts:944`) but never validated against the actual count of `sprint-*.yaml` files on disk. No code checks `git.enabled` vs actual git repo presence, nor `base_branch` vs actual branches.

**Fix:** Add a `runDoctorChecks()` function that:
- Counts `sprint-*.yaml` files and compares to `state.total_sprints`
- Checks if `.git` exists when `git.enabled=false`
- Checks if `base_branch` actually exists as a branch
- Returns drift records that surface in board health

### Item 4 — task-ledger.jsonl enrichment
**File:** `src/taskLedger.ts:29-46`

The ledger entry type only has: `task_id`, `agent_id`, `session_id`, `completed_at`, `sprint`, `title`, `review_status`, `branch`. It does NOT carry `tests_run`, `gates`, `summary`, or `tasks[]` (for multi-task completions).

The `workforceIngest.ts` mapper only captures `task_complete` and `scope_violation` — it doesn't extract gate/test data from the completion message payload.

**Fix:** Extend `TaskLedgerEntry` with optional `tests_run`, `gates`, `summary`, `task_ids` fields. Update the `extension.ts` call site to extract these from the message payload when present.

### Item 5 — Weak green gate reporting
**Status:** Gate system exists but `gates_passed` is a boolean.

The PWS observation was about `contract-verify` being a no-op when the verifier is absent. AutoClaw's gate system (`GateCheckResult`) has a `passed: boolean` but no way to distinguish "gate ran and passed" from "gate was skipped/no-op".

**Fix:** Add a `verdict?: 'pass' | 'weak-pass' | 'fail'` field to `GateCheckResult`. Derive `gates_weak` count on the capsule. Board renders weak-pass as "✓ (N weak)".

### Item 6 — Runtime files dirtying git
**File:** `.gitignore`

Already handled. `.gitignore` excludes:
- `.autoclaw/` (all runtime data)
- `.agents/` (task coordination runtime)
- Heartbeats, loop-state, lock files, sidecars (all under `.autoclaw/`)

The board refresh watcher's allow-list (`boardRefresh.ts:51-85`) also prevents board writes from re-triggering watches.

**No action needed.** Codex was looking at PWS, which may not have had these rules, but AutoClaw does.

### Item 7 — Reconcile reports → actionable backlog
**File:** `src/orchestrator/reconcile.ts:296-315`

Drifts are written to `reconcile-report.json` and broadcast as `system` messages to the shared inbox. But no code converts drifts into claimable tasks or ops items. The board shows drifts as system messages, but there's no mechanism for an agent to "claim and fix" a reconcile drift.

**Fix:** Add an `ops` task type to the board. When reconcile detects a drift, create a claimable ops task (e.g., `ops-reconcile-yaml-parse`) with a suggested owner and a one-line fix description. This closes the loop from detection to action.

### Item 8 — Intelligence source workspace awareness
**File:** `src/intelligence/sources/claudeCode.ts:367-380`

The `sessionInWorkspace` function already exists and is used to scope `/learn` to the open workspace. The intelligence backend correctly filters out unrelated sessions.

However, the `intelligenceDashboard.ts` does NOT report which sources were matched vs ignored. A user looking at the dashboard sees the aggregated result but not "Claude Code: 3 sessions matched, 2 ignored (different workspace)".

**Fix:** Add a `workspaceScope` field to `SourceRow` that reports matched/ignored counts. Surface this in the dashboard and the `/sources` report.

---

## Implementation Plan

### Phase 1 — Truth & Health (Items 1, 2, 3)

**1.1 YAML parseability validation in reconcile**
- Add `js-yaml` as a direct dependency
- In `loadSprintYamlTasks`, attempt `yaml.load()` first; on catch, return a `yaml_parse_error` drift
- Add drift type `yaml_parse_error` to `DriftType`
- Add test: malformed YAML → drift surfaced

**1.2 Board refresh wires catalog ingest**
- In `writeBoard`, call `ingestTaskCatalog` before `readTasks`
- Make it digest-gated (no-op when catalog unchanged) to avoid churn
- Add test: sprint YAML added without state.json task → board shows it

**1.3 Doctor checks for plan/config drift**
- New file: `src/orchestrator/doctor.ts`
- Export `runDoctorChecks(workspaceRoot): DoctorFinding[]`
- Checks: total_sprints vs actual files, git.enabled vs .git, base_branch vs branches
- Wire into reconcile sweep (runs every 5 min, findings broadcast as drifts)
- Add test: mismatched total_sprints → finding

### Phase 2 — Durable Ledger & Ops (Items 4, 7)

**2.1 task-ledger.jsonl enrichment**
- Extend `TaskLedgerEntry` with `tests_run?: number`, `gates?: string[]`, `summary?: string`, `task_ids?: string[]`
- Update `extension.ts` call site to extract from payload
- Add test: task_complete with gates → ledger carries them

**2.2 Reconcile drifts → ops tasks**
- New file: `src/orchestrator/opsTasks.ts`
- Convert drifts + findings to claimable ops tasks (id prefix `ops:`)
- Write to `.autoclaw/orchestrator/ops-tasks.json`
- Board merges ops tasks into claimable lane
- Add test: yaml_parse_error → ops task created with suggested owner

### Phase 3 — Evidence & Reporting (Items 5, 8)

**3.1 Gate result taxonomy**
- Add `verdict?: GateVerdict` to `GateCheckResult`
- Derive `gates_weak` count on capsule
- Board renders weak-pass as "✓ (N weak)"
- Add test: weak-pass gate → gates_passed true + gates_weak counted

**3.2 Intelligence source provenance**
- Add `countWorkspaceSessions()` to Claude Code adapter
- Add `workspaceScope` to `SourceRow`
- Report renders "N matched / M ignored"
- Add test: workspace mismatch → provenance reports ignored

### Phase 4 — Repo Boundary & Monetization

**4.1 Repo Boundary Contract test**
- Add CI test that verifies the public build contains NO static imports from `@autoclaw/premium`
- Verify forbidden paths don't exist (`premium-impl/`, `packages/premium/`, etc.)
- Verify the sanctioned indirect-require seam exists in `src/premium/index.ts`

**4.2 Enterprise packaging scaffold**
- Document the `AUTOCLAW_EDITION=enterprise` build path in CI
- Add a `build:enterprise` script that produces a separate VSIX with premium stubs swapped

---

## Priority Order

1. **Item 1 (YAML validation)** — highest impact, prevents silent data loss
2. **Item 2 (Board ingest wiring)** — fixes the "empty board" symptom
3. **Item 3 (Doctor checks)** — cheap to add, surfaces config drift
4. **Item 7 (Ops tasks)** — closes the reconcile loop
5. **Item 4 (Ledger enrichment)** — improves durable history
6. **Item 8 (Source provenance)** — UX improvement, not correctness
7. **Item 5 (Weak green)** — design for future evidence engine
8. **Item 6 (Gitignore)** — already done, no action

---

## Implementation Status (2026-06-27)

All items implemented and tested:
- 2559 tests passing, 0 failing
- `npm run secrets:check` clean (750 files scanned)
- New files: `doctor.ts`, `opsTasks.ts`, `orchestratorReconcile.test.ts`, `doctor.test.ts`, `opsTasks.test.ts`, `intelligence-sourceProvenance.test.ts`, `repoBoundary.test.ts`
- Modified: `reconcile.ts`, `orchestrator/reconcile.ts`, `boardWriter.ts`, `taskLedger.ts`, `extension.ts`, `orchestrate.ts`, `evidence/capsule.ts`, `orchestrator/board.ts`, `intelligence/sources/claudeCode.ts`, `intelligence/sourcesCommand.ts`, `intelligence/types.ts`
