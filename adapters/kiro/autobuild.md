---
inclusion: manual
name: autobuild
description: AutoBuild autonomous workflow engine. Reference with #autobuild when scheduling builds, running workflows, or automating CI steps.
---

# AutoBuild — Autonomous Workflow Engine

Sub-commands: `schedule "<cron>" <name>`, `run <name>`, `list`, `cancel <name>`, `status <name>`, or infer one-shot from description.

## schedule
Create `.autoclaw/autobuild/workflows/<name>.yaml` with cron expression and default steps (install/build/test). Register in `.autoclaw/autobuild/registry.json`. Confirm and prompt user to customize YAML.

## run
Load workflow YAML. Create run log at `.autoclaw/autobuild/runs/<name>-<timestamp>.log`. Execute each step via bash — log step ID, stdout/stderr, exit code. Stop on failure. Update registry. Notify pass/fail.

## list / cancel / status
- **list**: registry table with name/cron/last-run/status.
- **cancel**: delete YAML and registry entry.
- **status**: last 20 lines of most recent run log.

## One-Shot
Infer steps from user's description → create `oneshot-<timestamp>` → run → delete.

## Workflow YAML Format
```yaml
name: my-workflow
cron: "0 2 * * *"
steps:
  - id: build
    run: npm run build
  - id: test
    run: npm test
notify: true
timeout: 600
```
