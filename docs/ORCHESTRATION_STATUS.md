# Orchestration Status — single source of truth

> Human-readable board for who-owns-what and what-merges-next.
> The filesystem claim mailbox (`.autoclaw/orchestrator/comms/claims/`) has decayed
> (last real claim 2026-06-01); since then all work moved to **git branches + GitHub PRs + CI**.
> Treat **GitHub PRs against `dev-beta` + the CI gate** as the real coordination plane.
> Update this file whenever a branch changes hands or state.

Last updated: 2026-06-15 by claude-code (VS Code session) — **consolidation pass complete**

## Trunk model

- `master` — released, published (v3.4.0 LIVE). Only release PRs land here.
- `dev-beta` — integration trunk. **Now 23 ahead of master, 0 behind.** Everything merges here first, behind CI.
- `feat/*` — one owner each. Open a PR → `dev-beta`. CI green = mergeable.

## Branch ledger (post-consolidation)

| Branch | Owner (session) | vs dev-beta | PR | State |
|---|---|---|---|---|
| `feat/wave-b` | Kiro (kilo-main-2026-05-21) | merged | **#8 MERGED** ✅ | wave-b in dev-beta; CI was green; lockfile fear unfounded (touched 0 lock lines) |
| `feat/support-monetization` | Claude Code | merged | **#9 MERGED** ✅ | support/licensing in dev-beta |
| `feat/multi-project-orchestration` | Claude Code (this session) | merged | **#10 MERGED** ✅ | MP-2/MP-3 in dev-beta (package.json/CHANGELOG conflicts resolved by union/theirs) |
| `feat/intelligence-sources-tier3` | Claude Code (this session) | +1 (NOT merged) | none | **PRESERVED WIP** — Cline-Roo/Continue/Kilo Code adapters rescued from untracked working tree; not yet registry-wired or tested |
| `feat/wave-a` | — | merged via #6 | merged | STALE — delete when ready |
| `fix/integration-ci-baseline` | — | merged via #7 | merged | STALE — delete when ready |
| `feat/intelligence-core-loop` | — | merged via #5 | merged | STALE — delete when ready |
| `feat/v3.1*`, `radical-bakery`, `feat/sprint-*`, `feat/integrate-automate-v3.2`, `feat/voidspec-sync-command` | — | pre-v3.4 | shipped | STALE — prune after confirming each is in master |

## Done in this pass (2026-06-15)

1. ✅ Merged PR #8 (wave-b), #9 (monetization), #10 (multi-project) into dev-beta — all CI-green.
2. ✅ Rescued 3 orphan Tier-3 intelligence source adapters (untracked, on no branch) → `feat/intelligence-sources-tier3`, **wired into the registry + fixture tests, merged as PR #11** (CI-green; fixed a brittle existing id-list assertion along the way).
3. ✅ **Release-prepped v3.5.0 on dev-beta** (commit `d93444c`): version bump (3.4.1→3.5.0) + curated CHANGELOG (reconciled `[Unreleased]`→`[3.4.0]` to match master; team-view fixes folded into 3.5.0). **NOT promoted to master. NOT published** (per maintainer: hold publish until the intelligence layer is dogfooded).

`origin/dev-beta` is now **27 ahead of master, v3.5.0, one command from shipping.**

## Next (held — needs maintainer go)

1. **Publish v3.5.0** when ready: promote `dev-beta`→`master`, tag `v3.5.0`, build a CLEAN vsix from a worktree (`git worktree add ... <committed-HEAD>` → `npm ci` → verify `tar -tf <vsix>` is sane), then `NODE_OPTIONS=--use-system-ca npm run publish:all`. **Irreversible — explicit go required.**
2. **Dogfood the intelligence layer** first — this session saw `vector backend unavailable → no-RAG mode`; confirm that's the intended graceful fallback before publishing it as a headline feature.
3. **Prune** stale branches (user deferred deletion) and close/archive merged chat sessions (wave-a, intelligence-core-loop, and the Kiro wave-b session in worktree `<scratch>/autoclaw-wave-b`).

## Stray working-tree artifacts (this window, untracked — safe to ignore/gitignore)

`adapters_out.txt`, `compile_out.txt`, `repro_out.txt`, `testunit_out.txt` (command-output dumps), `.agents/` (19 files), `semantic-review/` (1 file). Candidates for `.gitignore`.

## Chat-session retirement

A chat session is safe to close once its branch is merged and deleted:
- wave-a session → closeable (merged).
- intelligence-core-loop session → closeable (merged).
- Kiro wave-b session → closeable after #8 merges.
- Keep the multi-project + monetization sessions until their PRs land.

## Why "who owns wave-b" was invisible

PR #8 was pushed via the `GoZippy` GitHub account from the **Kiro** session, but Kiro
wrote **no claim file** and its heartbeat `current_task` was `null`. With the mailbox
protocol decayed, ownership only existed inside the Kiro chat window. This board fixes that.
