# v2.3.1 Execution Report

Patch release sweep covering three small follow-ups deferred from v2.2.0 and v2.3.0.

## Branch & commits

- **Branch:** `worktree-agent-a2f445fd9de5db188`
- **Fork point:** `d06c64c` (master tip past v2.3.0 tag `36ab9fd`)
- **Commits:** 3
  1. `8ccd4be` docs(orchestrate): document /consensus/evaluate endpoint, stalled-slot sidecar, sprint-N.md generation; regen adapters
  2. `3a88320` feat(orchestrate): planner now writes sprint-N.md alongside sprint-N.yaml
  3. `02cefba` fix(scripts): publish-vsce + publish-ovsx — explicit packagePath, --dry-run flag, clearer error reporting

## LOC delta (against fork point)

```
13 files changed, 263 insertions(+), 18 deletions(-)
```

Per-file breakdown:

| File | +/- |
|---|---|
| `skills/orchestrate/SKILL.md` | +5 |
| `adapters/*/orchestrate.*` (×8) | +5 each (40) |
| `src/orchestrate.ts` | +27 |
| `src/test/orchestrate.test.ts` | +51 |
| `scripts/publish-vsce.js` | +81 / −18 |
| `scripts/publish-ovsx.js` | +77 |

## Tests

- Was 224 passing on `d06c64c`.
- Now 226 passing — +2 unit tests in `src/test/orchestrate.test.ts`:
  - `writePlanArtifacts emits sprint-N.yaml + sprint-N.md for every sprint plus plan-summary.yaml`
  - `writePlanArtifacts regenerates sprint-N.md on every run (idempotent rewrite)`
- `npm run adapters:check` clean after Item 1.
- `npm run test:unit` green after each item.

---

## Item 1 — SKILL.md tweaks (+ regenerated adapters)

**Files touched:** 9 (1 source skill + 8 adapter copies)
**LOC:** +45 (only +5 on the SKILL.md source; the 40 lines on adapters are mechanical regenerations from the same source paragraphs).

Three small additions, total ≤8 lines on the skill:

1. **`plan` section** — one line stating the planner also writes a human-readable `sprint-N.md` alongside `sprint-N.yaml`, regenerated on every plan run.
2. **`assign` section** — three lines documenting the stalled-agent path: a slot whose mapped agent's heartbeat is older than `autoclaw.orchestrate.heartbeatStallSeconds` (default 300) is skipped and a `sprint-{N}-stalled.json` sidecar lands next to the sprint YAML. The skill now instructs the AI to surface this and suggest re-running `/orchestrate assign {N}` once the agent recovers.
3. **`review` section** — two lines noting that the OpenClaw HTTP bridge exposes `POST /api/v1/consensus/{task_id}/evaluate` as a parallel path for remote agents to trigger consensus evaluation programmatically. Local skill flow is unchanged.

Adapters regenerated via `npm run adapters:build`; `npm run adapters:check` reports `Adapters in sync with skills/.`.

## Item 2 — Wire `writeSprintArtifacts` into the planner

**Files touched:** 2 (`src/orchestrate.ts`, `src/test/orchestrate.test.ts`)
**LOC:** +27 source / +51 test

Investigation showed there is no JS code path in the extension that *itself* calls `planSprints()` and writes the sprint YAMLs to disk — those writes are driven by the AI through the host's file tools. The cleanest way to "wire the planner into writing artifacts" was therefore to add a higher-level helper that the AI (or any future code path) calls once after `generatePlan()`:

```ts
export async function writePlanArtifacts(
  sprintsDir: string,
  plan: PlanResult,
  projectName: string
): Promise<{
  sprintArtifacts: Array<{ yamlPath: string; mdPath: string }>;
  summaryPath: string;
}>
```

It iterates `plan.sprints`, calls the existing `writeSprintArtifacts()` for each (which writes both the `.yaml` and the `.md`), then writes `plan-summary.yaml`. `writeSprintArtifacts()` and `writeYAMLFile()` remain exported for callers that prefer to drive their own writes — backwards compatible.

**Tests added:**
- End-to-end multi-sprint planner run: a 2-level DAG generates ≥2 sprints; both `sprint-N.yaml` and `sprint-N.md` exist for every sprint; `plan-summary.yaml` exists and contains `total_sprints:` and the project name.
- Idempotent rerun: a second `writePlanArtifacts()` call into the same directory does not duplicate the GENERATED header in the `.md`.

## Item 3 — Harden `publish:all`

**Files touched:** 2 (`scripts/publish-vsce.js`, `scripts/publish-ovsx.js`)
**LOC:** +158 / −18

### Root cause of the v2.3.0 silent-stop

The v2.3.0 release ran `npm run publish:all` → `npm run package` (success) → `npm run publish:vscode` → `node scripts/publish-vsce.js`. The script printed nothing and the npm chain stopped (next step `publish:ovsx` never ran). Direct `npx vsce publish --packagePath autoclaw-2.3.0.vsix` worked first try.

The previous `scripts/publish-vsce.js` was a 43-line wrapper that:
- did not pass `--packagePath` (vsce decided to repackage itself, opening a second failure surface);
- emitted **zero diagnostic output** before or after the spawn — every line came from `vsce` via inherited stdio;
- forwarded `result.status ?? 1` without any error message, so a failed launch (e.g., `npx` not found) and a normal non-zero exit were indistinguishable;
- did not warn when neither `.env`'s `VSCE_PAT` nor `process.env.VSCE_PAT` was set, leaving vsce to fall back to its stored credentials silently.

Under the harness's non-interactive stdio, `vsce` likely hit a no-PAT path that needed an interactive prompt, got EOF, and exited non-zero with no buffered output reaching the operator. The npm chain's `&&` saw the non-zero status and stopped — exactly as observed. The script's silence was the root issue: any vsce failure mode that did not flush stdout/stderr before exit was invisible.

### Hardening applied (both scripts)

- **Pre-spawn status block** (always, before any conditional): publisher / version / VSIX / PAT-source / planned command. Prints to `console.log` so it is never lost to stdio buffering.
- **`--packagePath autoclaw-<version>.vsix`** is now passed explicitly to `vsce publish`. The script no longer relies on vsce's own packaging behaviour.
- **PAT/token source resolution is logged** — `from .env`, `from environment`, `vsce stored credentials`, or `MISSING`. The "no PAT, vsce will fall back" case prints a `WARNING` line with the exact `npx vsce login <publisher>` command to run.
- **`spawnSync.error` is forwarded** — if the binary fails to launch, the error message is printed and the script exits 1.
- **Non-zero status produces a diagnostic line** before `process.exit(status)`. Successful runs end with `[publish-vsce] OK.` / `[publish-ovsx] OK.`.
- **`--dry-run` flag** prints the planned command (PAT redacted to `<redacted>`) and exits 0 without invoking the publishers.

### Manual verification steps

The release operator should run, from the repo root:

```bash
# After `npm run package` produces autoclaw-<ver>.vsix
node scripts/publish-vsce.js --dry-run
node scripts/publish-ovsx.js --dry-run
```

Expected output (vsce, with .env present and `VSCE_PAT` set):

```
[publish-vsce] Publisher: ZippyTechnologiesLLC
[publish-vsce] Version:   2.3.1
[publish-vsce] VSIX:      autoclaw-2.3.1.vsix (present)
[publish-vsce] PAT:       from .env
[publish-vsce] Command:   npx.cmd vsce publish --packagePath ...autoclaw-2.3.1.vsix  (VSCE_PAT: from .env)
[publish-vsce] --dry-run set; not invoking vsce. Exit 0.
```

Expected output (ovsx, no token configured):

```
[publish-ovsx] Version: 2.3.1
[publish-ovsx] VSIX:    autoclaw-2.3.1.vsix (present)
[publish-ovsx] Token:   MISSING
[publish-ovsx] Command: npx.cmd ovsx publish ...autoclaw-2.3.1.vsix --pat <redacted>
[publish-ovsx] --dry-run set; not invoking ovsx. Exit 0.
```

> Note: this worktree is sandboxed and does not have `node`-execution permission for these scripts, so the dry-run was not exercised here. Syntax was checked by manual review; the changes use only Node built-ins (`node:fs`, `node:path`, `node:child_process`).

### What this prevents next time

- A vsce/ovsx silent failure now produces at least 5 lines of context plus a `FAILED with exit N` diagnostic, regardless of stdio buffering.
- The packagePath explicit-pass eliminates the "vsce repackages and fails" branch as a hidden cause.
- The PAT/token source line tells the operator at a glance whether `.env` was actually picked up by the script.

---

## Suggested CHANGELOG entry (v2.3.1 — patch)

```markdown
## [2.3.1] - 2026-05-09

Patch release that closes the v2.2.0 / v2.3.0 follow-ups deferred to v2.3.1: the
SKILL.md mention of the consensus evaluate endpoint and the stalled-slot
sidecar, the planner-side wiring of `sprint-N.md` generation, and a hardening
pass on the `publish:all` script chain. Net: +263/-18 LOC across 13 files,
+2 unit tests (226 total passing, was 224), zero regressions, zero new npm
dependencies.

### Added
- **`writePlanArtifacts(sprintsDir, plan, projectName)`** — single entry point
  the `/orchestrate plan` flow calls after `generatePlan()` to emit every
  `sprint-N.yaml` + sibling `sprint-N.md` plus `plan-summary.yaml`. The
  Markdown view now stays in lock-step with the authoritative YAML on every
  plan regeneration. `writeSprintArtifacts()` and `writeYAMLFile()` remain
  exported for callers that prefer to drive the writes themselves.
- **SKILL.md documentation** — `skills/orchestrate/SKILL.md` now mentions
  (a) the parallel-path `POST /api/v1/consensus/{task_id}/evaluate` bridge
  endpoint for remote agents (carried over from the v2.2.1 deferral); (b) the
  stalled-slot `sprint-{N}-stalled.json` sidecar emitted by `/orchestrate
  assign` when an agent's heartbeat is older than
  `autoclaw.orchestrate.heartbeatStallSeconds`; (c) the planner-side
  `sprint-N.md` generation. All 8 adapter copies regenerated.
- **`--dry-run` flag** on `scripts/publish-vsce.js` and `scripts/publish-ovsx.js`.
  Prints the planned command line (PAT/token redacted) and exits 0 without
  invoking the publishers.

### Fixed
- **`publish:all` silent-stop** — `scripts/publish-vsce.js` now passes
  `--packagePath autoclaw-<version>.vsix` explicitly to `vsce publish`, logs
  publisher/version/VSIX/PAT-source/planned-command before the spawn, forwards
  `spawnSync.error` if the binary fails to launch, and prints a one-line
  diagnostic on non-zero exit. `scripts/publish-ovsx.js` got the same
  treatment for `OVSX_TOKEN`. Eliminates the v2.3.0 release symptom in which
  the npm chain stopped after `publish-vsce` exited non-zero with no buffered
  output reaching the operator.
```

---

## Risks / unresolved issues

- **Worktree could not exercise the `--dry-run` paths.** The harness denies
  `node scripts/publish-vsce.js --dry-run` (and the equivalent PowerShell call)
  in this sandbox. Syntax was checked by manual review and the scripts use
  only Node built-ins, but the release operator should run the dry-run once
  from a real shell before the v2.3.1 publish to confirm the resolved-PAT
  banner reflects their `.env` correctly.
- **Item 2 wires the planner from the AI side, not from `extension.ts`.** No
  TypeScript code in the extension currently invokes `planSprints()` /
  `generatePlan()` itself — the AI does that through the skill prompt. The
  new `writePlanArtifacts()` helper is the single call the skill-side flow
  should make after generating a plan; if a future release adds an in-process
  TS planner runner, it should call this same helper.
- **No new tests cover the publish scripts.** They are wrappers around third-
  party CLIs (`vsce`, `ovsx`) that we do not want to actually invoke from a
  unit test. The `--dry-run` flag is the manual verification surface.
- **CRLF warnings on Windows commit.** Adapters and scripts have `LF` in the
  index but `core.autocrlf` rewrites them to CRLF on checkout. Pre-existing
  repo behaviour; no action taken.
