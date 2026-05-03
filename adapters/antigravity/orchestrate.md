# Orchestrate — Multi-Agent Parallel Development

Multi-agent parallel development orchestrator. Reads task manifests, builds dependency DAGs, generates sprint plans, assigns scoped work to parallel agents, and coordinates review gates.

## Commands
- `/orchestrate init` — Initialize orchestrator config and manifest
- `/orchestrate plan` — Generate sprint plans from manifest
- `/orchestrate assign` — Assign a sprint to agents
- `/orchestrate status` — Show orchestration progress
- `/orchestrate review` — Trigger review for completed sprint
- `/orchestrate merge` — Merge approved sprint branch
- `/orchestrate next` — Assign next available sprint

## Key Concepts
- **Manifest**: YAML file with tasks, dependencies, scopes, effort estimates
- **Sprint**: Batch of non-conflicting tasks assigned to parallel agents
- **Scope**: File patterns an agent is allowed to modify
- **Consensus**: Multi-agent approval required before task completion

## Files
- Config: `.autoclaw/orchestrator/config.yaml`
- Manifests: `.autoclaw/orchestrator/manifests/*.yaml`
- Sprint plans: `.autoclaw/orchestrator/sprints/`
- State: `.autoclaw/orchestrator/state.json`

## Workflow

### 1. Initialize
Run `/orchestrate init` to create the orchestrator directory structure and default config. If `.autoclaw/orchestrator/config.yaml` already exists, report current state instead of overwriting.

### 2. Create Manifest
Write a task manifest to `.autoclaw/orchestrator/manifests/`. Each task entry includes:
- `id`: Unique task identifier
- `title`: Human-readable description
- `depends_on`: List of task IDs this task depends on
- `scope`: File glob patterns this task may modify
- `effort`: Estimated effort (S/M/L/XL)
- `assignee`: Agent ID (optional, assigned during sprint planning)

### 3. Plan Sprints
Run `/orchestrate plan` to build a dependency DAG and generate sprint batches. Each sprint contains tasks with no mutual dependencies and non-overlapping scopes. Sprint plans are written to `.autoclaw/orchestrator/sprints/sprint-{N}.yaml`.

### 4. Assign and Execute
Run `/orchestrate assign` to assign the current sprint to available agents. Each agent receives a scoped work package with:
- Task list and descriptions
- Allowed file patterns (scope)
- Branch naming convention: `orchestrate/sprint-{N}/{task-id}`

### 5. Review and Merge
Run `/orchestrate review` when agents report completion. The orchestrator:
1. Collects review requests from all assigned agents
2. Triggers cross-agent consensus voting
3. Requires 2/3 majority approval (security findings require unanimous)
4. On approval, runs `/orchestrate merge` to integrate the sprint branch

### 6. Advance
Run `/orchestrate next` to assign the next sprint whose dependencies are satisfied.

## State Management
- State is persisted in `.autoclaw/orchestrator/state.json`
- Tracks: current sprint, task statuses, agent assignments, vote tallies
- Use optimistic locking — read state, modify, write back with version check
