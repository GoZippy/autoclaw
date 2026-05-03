# MAteam Execution Plan — AutoClaw v1.2.4 → v1.3.0

Generated 2026-04-30. Drives `/mateam launch` + `/loop` until all KDream follow-ups
in `.autoclaw/kdream/memory/MEMORY.md` are `- [x]` and CI is green.

## Goals (definition of done)

1. `npm run adapters:check` passes (no drift between `skills/` and `adapters/`).
2. `npm test` is green and covers `extension.ts` analytics + helpers + skill smoke.
3. `autoclaw.doctor` reports all-healthy on a fresh clone.
4. KDream `start` succeeds first-try under bash, PowerShell, and cmd on Win/macOS/Linux.
5. AutoBuild `cron` field is either honored by a real scheduler or removed.
6. MAteam invokes real subagents on Claude Code; degrades gracefully elsewhere.
7. CHANGELOG bumped to 1.3.0 with each phase as a sub-section.

## Roles (per `/mateam launch`)

- **Researcher** — reads code, identifies all callers, writes findings to
  `.autoclaw/mateam/scratch/<session>/context.md`.
- **Coder** — edits files, writes diff summary to `output.md`.
- **Reviewer** — audits Coder output for correctness + security + style; flags
  blockers in `review.md`.
- **Verifier** — runs `npm test`, `npm run adapters:check`, manual VS Code
  reload smoke; writes results to `verify.md`.
- **Critic** (loop only) — re-reads everything after Verifier, asks "would a
  senior reviewer ship this?", and if no, kicks the task back to Coder with
  specific objections. Limit 3 critic passes per task before escalating to user.

## Phase DAG (parallelization map)

```
                       ┌──────────────────┐
                       │ F2 test harness  │ (blocks Phase 1 verify)
                       └────────┬─────────┘
                                │
         ┌──────────────────────┼─────────────────────────┐
         │                      │                         │
┌────────▼────────┐    ┌────────▼─────────┐    ┌──────────▼──────────┐
│ F1 adapter gen  │    │ F3 doctor cmd    │    │ Phase 1 bug fixes   │
│ (parallel-safe) │    │ (after F1)       │    │ B1..B8 in parallel  │
└────────┬────────┘    └────────┬─────────┘    │ (one PR per bug)    │
         │                      │              └──────────┬──────────┘
         │                      │                         │
         └──────────┬───────────┘                         │
                    │                                     │
            ┌───────▼────────┐                            │
            │ Phase 2 A1..A3 │                            │
            │ adapter parity │                            │
            └───────┬────────┘                            │
                    │                                     │
        ┌───────────┴────────────┐                        │
        │                        │                        │
┌───────▼──────┐         ┌───────▼──────┐                 │
│ Phase 3      │         │ Phase 4      │                 │
│ S1..S3 skill │∥ │ U1..U4 UX    │                 │
│ correctness  │         │ polish       │                 │
└───────┬──────┘         └───────┬──────┘                 │
        │                        │                        │
        └────────────┬───────────┘                        │
                     │                                    │
                     └────────────────┬───────────────────┘
                                      │
                            ┌─────────▼──────────┐
                            │ Phase 5 roadmap    │
                            │ R1..R7 sequential, │
                            │ each its own       │
                            │ /mateam launch     │
                            └────────────────────┘
```

## Per-task `/mateam launch` template

```
/mateam launch "Task <ID>: <one-line title>"
  context_seed:
    - .autoclaw/kdream/memory/MEMORY.md ## Follow-ups (find <ID>)
    - this plan
  acceptance:
    - <specific assertion, e.g. "git diff --shortstat HEAD..HEAD~30 returns
      aggregate matching new code">
    - npm test green
    - adapters:check green
  loop_until: critic_passes OR retry_count >= 3
```

## `/loop` driver

```
/loop dynamic
  for task in pending(MEMORY.md ## Follow-ups):
    if task.phase blocked: skip
    /mateam launch "<task.id>: <task.title>"
    if verify.md == pass and critic == approve:
        mark - [x]
        commit "<id>: <title>"
        continue
    else:
        record blocker in review.md, raise to user, halt
```

## Parallelization rules

- **Safe to run in parallel**: edits to disjoint files (B1+B3+B4 all touch
  different lines but same file → serialize), edits to disjoint adapters
  (A1 across 6 adapter files → can fan out; coordinator merges).
- **Must serialize**: anything that edits `package.json` (version bumps),
  `CHANGELOG.md`, or shared state in `extension.ts` if line ranges overlap.
- **Lock file**: each running session writes `.autoclaw/mateam/locks/<file>.lock`
  with its session id; another session blocks if the lock exists.

## Phase-by-phase notes

### Phase 0 — Foundation (do first)
- F1, F2 concurrent. F3 waits for F1 (doctor depends on generator's drift check).
- Verifier gate: `npm run build` + `npm run adapters:check` clean before any
  Phase 1 task starts.

### Phase 1 — Bug fixes (8 tasks, one PR each)
- All touch `src/extension.ts` so coder phase serializes; researcher + reviewer
  + verifier can pipeline.
- Order by risk: B4 (dead code, safest) → B3 (guard) → B7 (config) → B6 (cache)
  → B5 (async refactor, riskiest) → B1, B2 (math correctness, need tests from F2)
  → B8 (upgrade path).

### Phase 2 — Adapter parity (depends on F1)
- Once generator exists, A1/A2/A3 collapse to source-skill edits + regen.
- Verifier: `npm run adapters:check` + manual diff across all 8 adapter dirs.

### Phase 3 — Skill correctness
- S1 needs design decision before code (cron path vs VS Code Tasks vs relabel).
  Researcher delivers options doc; user picks; Coder implements.
- S2 + S3 wait for S1 because they share the host-detection helper.

### Phase 4 — Product polish (parallel with Phase 3)
- U1 (export) is webview work; U2 (test math) gates on Phase 1 bug fixes; U3
  (README) and U4 (marketplace soak) are doc-only.

### Phase 5 — Roadmap features (one /mateam launch per item)
- R1..R7 are independent — each is its own session, its own PR, its own
  CHANGELOG entry. Critic enforces "do not start R<n+1> until R<n> verified".

## Stop conditions

- Hard stop: any task fails critic 3× in a row → halt, raise to user with
  diagnostic bundle in `verify.md`.
- Soft stop: end of phase → user review checkpoint before next phase opens.
- Emergency stop: user types `/mateam cancel` → all sessions write
  `cancelled: true`, no further commits.
