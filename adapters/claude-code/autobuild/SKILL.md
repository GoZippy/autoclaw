---
name: autobuild
description: Autonomous scheduled build workflows and pipelines. Trigger on "/autobuild schedule", "run workflow", "automate build", or "schedule task".
user-invocable: true
allowed-tools: Read, Write, Bash, Glob
context: fork
---

# AutoBuild — Autonomous Workflow Engine

## On Invocation

Determine the sub-command from the user's message:

- `schedule "<cron>" <name>` → **Schedule a workflow**
- `run <name>` → **Run a workflow immediately**
- `list` → **List all workflows**
- `cancel <name>` → **Remove a workflow**
- `status <name>` → **Show last run result**
- No sub-command + task description → **Create and run a one-shot workflow**

---

## schedule — Create a Scheduled Workflow

1. Parse cron expression and workflow name from input.
2. Create `.autoclaw/autobuild/workflows/<name>.yaml`:
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
3. Register in `.autoclaw/autobuild/registry.json`.
4. Confirm with instructions to customize the YAML.

## run — Execute a Workflow

1. Load the workflow YAML.
2. Create a run log at `.autoclaw/autobuild/runs/<name>-<ISO timestamp>.log`.
3. Execute each step: log `[STEP: id]`, run via bash, log stdout/stderr/exit code.
4. On failure: log `[FAILED: id]`, skip remaining steps.
5. Update registry and notify user of pass/fail.

## list / cancel / status

- **list**: Read `registry.json`, display name/cron/last-run/status table.
- **cancel**: Delete workflow YAML, remove from registry.
- **status**: Show last 20 lines of most recent run log.

## One-Shot Workflow

Infer steps from description, create `oneshot-<timestamp>`, run, then delete.

---

## Workflow YAML Reference

```yaml
name: my-workflow
cron: "0 2 * * *"
steps:
  - id: install
    run: npm ci
  - id: build
    run: npm run build
  - id: test
    run: npm test
  - id: deploy
    run: npm run deploy
    condition: "{{test.exit_code}} == 0"
notify: true
timeout: 600
```
