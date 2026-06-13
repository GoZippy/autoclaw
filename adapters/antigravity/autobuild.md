> Autonomous scheduled build workflows and pipelines. Trigger on "/autobuild schedule", "run workflow", "automate build", or "schedule task".

# AutoBuild — Autonomous Workflow Engine

## Operating Rules (read first)

1. **Use file tools, not shell, for files and directories.** Create `.autoclaw/autobuild/...` paths with the host's file/write tool. Do NOT use `mkdir -p`, `touch`, or `New-Item` — they break across Bash/PowerShell/cmd.
2. **Forward slashes in paths.** Always.
3. **Idempotency.** `schedule` with an existing `<name>` updates the workflow in place — do not duplicate registry entries. `cancel` on a missing name reports "no such workflow" and exits cleanly.
4. **Step commands are platform-aware.** Default templates use cross-platform npm scripts (`npm run build`, `npm test`). If a step needs a shell builtin, prefer Node/npm scripts in `package.json` over raw shell so it works on every host.
5. **Output discipline.** Confirm in ≤3 lines: what changed, file path, next action. No reasoning narration.

## On Invocation

Determine the sub-command from the user's message:

- `schedule "<cron>" <name>` → **Schedule a workflow**
- `run <name>` → **Run a workflow immediately**
- `list` → **List all workflows**
- `cancel <name>` / `delete <name>` → **Remove a workflow**
- `status <name>` → **Show last run result**
- No sub-command + task description → **Create and run a one-shot workflow**

---

## schedule — Create a Scheduled Workflow

1. Parse the cron expression and workflow name from the user's input.
2. Create `.autoclaw/autobuild/workflows/<name>.yaml` with this structure:
   ```yaml
   name: <name>
   cron: "<expression>"
   created: <ISO timestamp>
   steps:
     - id: plan
       run: echo "Planning step — customize me"
     - id: build
       run: npm run build
     - id: test
       run: npm test
   notify: true
   ```
3. Register it in `.autoclaw/autobuild/registry.json` (create if missing):
   ```json
   { "workflows": [{ "name": "<name>", "cron": "<expr>", "lastRun": null, "status": "scheduled" }] }
   ```
4. Confirm: "Workflow `<name>` scheduled (`<cron>`). Edit `.autoclaw/autobuild/workflows/<name>.yaml` to customize the steps."

## run — Execute a Workflow

1. Load `.autoclaw/autobuild/workflows/<name>.yaml`.
2. Create a run log at `.autoclaw/autobuild/runs/<name>-<ISO timestamp>.log`.
3. Execute each step in order:
   - Log `[STEP: <id>]` before running.
   - Run the command via bash.
   - Log stdout/stderr and exit code.
   - On non-zero exit: log `[FAILED: <id>]`, skip remaining steps, set status to `failed`.
   - On success: log `[OK: <id>]`.
4. Write final status (`passed` / `failed`) to the run log and update `registry.json`.
5. Notify user: "Workflow `<name>` — `<passed|failed>`. Check `.autoclaw/autobuild/runs/` for full log."

## list — Show All Workflows

Read `registry.json` and display a table:
```
Name           Cron            Last Run             Status
───────────────────────────────────────────────────────────
nightly-build  0 2 * * *       2026-04-01 02:00     passed
```

## cancel — Remove a Workflow

1. Delete `.autoclaw/autobuild/workflows/<name>.yaml`.
2. Remove entry from `registry.json`.
3. Confirm removal.

## status — Show Last Run

Read the most recent log file matching `.autoclaw/autobuild/runs/<name>-*.log` and display the last 20 lines plus overall pass/fail.

---

## One-Shot Workflow (no sub-command)

If the user describes a task without a sub-command (e.g. "autobuild run my tests and deploy"):
1. Infer steps from the description.
2. Create a temporary workflow named `oneshot-<timestamp>`.
3. Run it immediately via the **run** flow above.
4. Delete the workflow file after completion.

---

## Workflow YAML Reference

```yaml
name: my-workflow
cron: "0 2 * * *"        # standard 5-field cron
created: 2026-04-01T00:00:00Z
steps:
  - id: install
    run: npm ci
  - id: build
    run: npm run build
  - id: test
    run: npm test
  - id: deploy
    run: npm run deploy
    condition: "{{test.exit_code}} == 0"   # optional gate
notify: true              # VS Code notification on completion
timeout: 600              # seconds per step, default 120
```

---

## Guarded Fix Mode (AB-2+)

Steps can opt into `fix` mode with a `guard` block that enforces safety constraints before and after execution:

```yaml
steps:
  - id: auto-fix
    run: npm run lint -- --fix
    mode: fix
    guard:
      scope_globs: ["src/**", "test/**"]   # files the step may touch
      max_files: 10                         # hard cap on files changed
      require_clean_git: true              # reject if dirty working tree
      rollback_on: test_fail               # rollback on test failure (or "never")
    verify: npm test                       # command to verify fix succeeded
```

**Guard enforcement order:**
1. `require_clean_git` — if true, rejects the step before execution if `git status --porcelain` is non-empty. Verdict: `rejected_dirty`.
2. Pre-image capture — records `git diff --name-only` + untracked files before execution (for rollback).
3. Step executes.
4. `files_changed` — computed from `git diff --name-only` + untracked files after execution.
5. `max_files` — if `files_changed.length > max_files`, rejects. Verdict: `rejected_cap`.
6. `scope_globs` — if any changed file doesn't match a glob pattern, rejects. Verdict: `rejected_scope`.
7. `rollback_on: test_fail` — if verify command fails, runs `git checkout -- <pre-image files>` to restore working tree.

**Guard verdicts:** `applied` (passed), `rejected_dirty`, `rejected_cap`, `rejected_scope`, `rolled_back`, `na` (not applicable / report mode).

**Step results now include:** `mode`, `files_changed[]`, `guard_verdict`.

**Run results now include:** `guardBlockRejected` (count), `guardRolledBack` (count).

---

## Self-Heal Workflow Templates

When creating workflows that should recover from common failures, use these patterns:

### Pattern: Fix + Verify + Rollback

```yaml
name: self-heal-lint
cron: "0 4 * * *"
steps:
  - id: lint-fix
    run: npm run lint -- --fix
    mode: fix
    guard:
      scope_globs: ["src/**"]
      max_files: 20
      require_clean_git: true
      rollback_on: test_fail
    verify: npm run lint
  - id: test-after-fix
    run: npm test
```

### Pattern: Report-Only (Safe Default)

```yaml
name: health-check
cron: "*/30 * * * *"
steps:
  - id: check
    run: npm run doctor
    mode: report    # never modifies files, guard not needed
```

**Rule of thumb:** Use `mode: report` unless the step intentionally mutates files. Use `mode: fix` with a `guard` when the step should change code and you want automatic rollback on failure.
