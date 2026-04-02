---
name: autobuild
description: AutoBuild autonomous workflow engine for scheduling and running build pipelines. Activate when user asks to schedule a build, run a workflow, or automate CI steps.
trigger: model_decision
---

# AutoBuild — Autonomous Workflow Engine

Sub-commands: `schedule "<cron>" <name>`, `run <name>`, `list`, `cancel <name>`, `status <name>`.

## schedule
Create `.autoclaw/autobuild/workflows/<name>.yaml` with cron and default steps. Register in registry.json. Prompt user to customize YAML.

## run
Load YAML. Create run log. Execute each step via bash — log step/stdout/exit. Stop on failure. Update registry. Notify.

## list / cancel / status
Table view / delete workflow / show last run log.

## One-Shot
Infer steps from description → `oneshot-<timestamp>` → run → delete.

## YAML Format
```yaml
name: nightly
cron: "0 2 * * *"
steps:
  - id: build
    run: npm run build
  - id: test
    run: npm test
notify: true
```
