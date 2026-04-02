# AutoBuild — Autonomous Workflow Engine

When the user asks to schedule a build, run a workflow, automate CI, or set up recurring tasks, follow these instructions.

## Sub-commands
Determine intent: `schedule "<cron>" <name>`, `run <name>`, `list`, `cancel <name>`, `status <name>`, or infer one-shot from description.

## schedule
1. Parse cron expression and workflow name.
2. Create `.autoclaw/autobuild/workflows/<name>.yaml`:
   ```yaml
   name: <name>
   cron: "<expr>"
   created: <ISO>
   steps:
     - id: build
       run: npm run build
     - id: test
       run: npm test
   notify: true
   ```
3. Add entry to `.autoclaw/autobuild/registry.json` (create if missing).
4. Confirm: "Workflow `<name>` scheduled. Edit `.autoclaw/autobuild/workflows/<name>.yaml` to customize steps."

## run
1. Load `.autoclaw/autobuild/workflows/<name>.yaml`.
2. Create `.autoclaw/autobuild/runs/<name>-<ISO>.log`.
3. For each step: log `[STEP: id]`, run command via bash, log stdout/stderr/exit code.
4. On non-zero exit: log `[FAILED: id]`, stop, set status=failed.
5. Update registry entry. Notify user: "Workflow `<name>` — passed/failed."

## list / cancel / status
- `list`: read registry.json, show name/cron/lastRun/status table.
- `cancel`: delete workflow YAML, remove from registry, confirm.
- `status`: read most recent `.autoclaw/autobuild/runs/<name>-*.log`, show last 20 lines + result.

## One-Shot
Infer steps from user description. Create `oneshot-<timestamp>` workflow. Run immediately. Delete workflow file after completion.
