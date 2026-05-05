---
name: orchestrate
description: Multi-agent parallel development orchestrator. Reads task manifests, builds dependency DAGs, generates sprint plans, assigns scoped work to parallel agents, and coordinates review gates. Trigger on "/orchestrate", "plan sprints", "parallel agents", "assign sprint", or "orchestrate tasks".
---

# Orchestrate — Multi-Agent Parallel Development

## Operating Rules (read first)

1. **Use file tools, not shell, for directories and files.** Create `.autoclaw/orchestrator/...` paths with the host's file/write tool. Do NOT use `mkdir -p`, `touch`, or `New-Item`.
2. **Forward slashes in paths.** Always.
3. **Idempotency.** `plan` with an existing manifest re-generates sprints in place. `assign` on an already-assigned sprint updates the assignment.
4. **Scope isolation is sacred.** Never assign overlapping file scopes to parallel agents in the same sprint. The planner MUST detect and prevent conflicts.
5. **Output discipline.** Confirm in ≤5 lines: what changed, sprint count, agent assignments, next action. No reasoning narration.
6. **Resolve WA-N → real agent IDs.** Before sending any message or writing any heartbeat, read `agents.json` and call `resolveAgentId(waSlot, agents)` to get the real platform ID (e.g. `claude-code`, `kilocode`). Never route to a WA-N slot directly.

## On Invocation

Determine the sub-command from the user's message:

- `init` → **Initialize orchestrator config and manifest**
- `plan` / `plan --manifest <path>` → **Generate sprint plans from manifest**
- `assign` / `assign <sprint>` → **Assign a sprint to agents**
- `status` → **Show orchestration progress**
- `review <sprint>` → **Trigger review for a completed sprint**
- `merge <sprint>` → **Merge an approved sprint branch**
- `next` → **Assign the next available sprint**
- No sub-command + task description → **Quick plan: infer manifest from description**

---

## init — Initialize Orchestrator

1. Read `.autoclaw/orchestrator/config.yaml`. If it exists, report current config and skip creation.
2. If missing, create the default config structure:
   - `.autoclaw/orchestrator/config.yaml` — global settings (agents, git, planning, gates, review, scope, logging)
   - `.autoclaw/orchestrator/manifests/` — directory for task manifests
   - `.autoclaw/orchestrator/sprints/` — directory for generated sprint plans
   - `.autoclaw/orchestrator/reviews/` — directory for review reports
   - `.autoclaw/orchestrator/logs/` — directory for execution logs
3. **Always** create the full comms directory tree (these are required for messaging to work):
   - `.autoclaw/orchestrator/comms/inboxes/shared/`
   - `.autoclaw/orchestrator/comms/inboxes/claude-code/`
   - `.autoclaw/orchestrator/comms/inboxes/kilocode/`
   - `.autoclaw/orchestrator/comms/heartbeats/`
   - `.autoclaw/orchestrator/comms/consensus/active/`
   If `agents.json` exists, create an inbox for each `platform` value in its `agents` array instead of the hard-coded defaults.
4. Auto-detect quality gates from the workspace root and write to `config.yaml`:
   - `Cargo.toml` present → `build: "cargo check --workspace"`, `test: "cargo test --workspace"`, `lint: "cargo clippy --workspace -- -D warnings"`
   - `go.mod` present → `build: "go build ./..."`, `test: "go test ./..."`, `lint: "go vet ./..."`
   - `package.json` present → `build: "npm run build"`, `test: "npm test"`, `lint: "npm run lint"`
   - None detected → leave fields empty, note in config that manual setup is required
5. If a spec `tasks.md` exists (e.g., `.kiro/specs/*/tasks.md`), offer to generate a manifest from it.
6. Confirm: "Orchestrator initialized. Create a manifest in `.autoclaw/orchestrator/manifests/` or run `/orchestrate plan` to generate sprints."

---

## plan — Generate Sprint Plans

### Input
Read the manifest YAML from the specified path (default: first `.yaml` in `manifests/`).

### Algorithm

**Phase 1: Parse & Validate**
- Parse manifest YAML into task list with `id`, `name`, `depends_on`, `scope`, `effort`, `subtasks`.
- Validate: no duplicate IDs, all `depends_on` references exist, no empty scopes.

**Phase 2: Build Dependency Graph (DAG)**
- Nodes = tasks, Edges = `depends_on` relationships.
- Detect cycles using Kahn's algorithm. If cycle found, report error with the cycle path.

**Phase 3: Level Assignment (Topological Sort)**
- Level 0: tasks with no dependencies (in-degree 0).
- Level N: tasks whose dependencies are all in levels < N.
- Tasks at the same level CAN execute in parallel.

**Phase 4: Scope Conflict Detection**
- For each pair of tasks at the same level, check if their `scope` glob patterns can match overlapping files.
- Conflicting tasks at the same level must be separated into different sprints or assigned to different agents with explicit merge ordering.

**Phase 5: Sprint Assignment (Bin Packing)**
- Read `agents.work_agents` from config (default: 4).
- Read `planning.max_tasks_per_agent` and `planning.max_subtasks_per_sprint` from config.
- For each level, assign tasks to agents respecting:
  - Scope isolation (no overlap within same sprint)
  - Effort capacity per agent per sprint
  - `constraints.mutual_exclusion` from manifest
  - `constraints.affinity` from manifest (co-locate related tasks on same agent)
- Priority heuristics:
  1. Critical path length (longest downstream chain first)
  2. Downstream dependents (unblocks most tasks)
  3. Effort (larger tasks start early to avoid tail latency)
  4. Affinity (co-locate related tasks)

**Phase 6: Migration Range Allocation**
- If tasks include database migrations, allocate sequential non-overlapping ranges per agent per sprint.
- Range size from `git.conflict_prevention.migration_range_size` config.

**Phase 7: Output**
- Write sprint plan YAML to `.autoclaw/orchestrator/sprints/sprint-{N}.yaml` for each sprint.
- Write summary to `.autoclaw/orchestrator/sprints/plan-summary.yaml`.
- **Write `state.json`** to `.autoclaw/orchestrator/state.json`:
  ```json
  {
    "project": "<manifest.project.name>",
    "current_sprint": null,
    "total_sprints": <N>,
    "tasks_complete": 0,
    "tasks_total": <M>,
    "agents": {
      "WA-1": { "status": "idle", "sprint": null, "tasks": [] },
      "WA-2": { "status": "idle", "sprint": null, "tasks": [] }
    },
    "last_updated": "<iso timestamp>"
  }
  ```

### Sprint YAML Format
```yaml
sprint: 1
level: 0
status: pending  # pending, assigned, in_progress, review, approved, merged
assignments:
  - agent: WA-1
    tasks:
      - id: "task-11"
        name: "zippyctl CLI foundation"
        subtasks: [...]
    scope:
      - "cmd/zippyctl/**"
      - "internal/cli/**"
    branch: "feat/sprint-1-wa1-zippyctl"
    migration_range: null
  - agent: WA-2
    tasks:
      - id: "task-13"
        name: "Secrets vault integration"
        subtasks: [...]
    scope:
      - "internal/secrets/**"
    branch: "feat/sprint-1-wa2-secrets"
    migration_range: null
dependencies_met: true
estimated_days: 4
```

### Plan Summary Format
```yaml
project: "zippypanel"
total_tasks: 75
total_sprints: 9
total_agents: 4
critical_path_length: 5
estimated_total_days: 36
sprints:
  - number: 1
    level: 0
    tasks: 4
    agents: [WA-1, WA-2, WA-3, WA-4]
    status: pending
```

Confirm: "Generated {N} sprints for {M} tasks across {A} agents. Critical path: {P} sprints. Run `/orchestrate assign 1` to start Sprint 1."

---

## assign — Assign Sprint to Agents

1. Read the sprint YAML from `sprints/sprint-{N}.yaml`.
2. Read `agents.json` to resolve WA-N slots → real agent IDs (`resolveAgentId`).
3. **Dependency check:** verify all dependency sprints are in `merged` status. If not:
   - Identify which sprints are blocking (status not `merged`).
   - Write an `answer` message to the requesting agent's inbox:
     ```json
     {
       "type": "answer",
       "from": "orchestrator",
       "to": "<requestingAgentId>",
       "timestamp": "<iso>",
       "sprint": <N>,
       "payload": { "body": "Sprint N blocked. Waiting for Sprint(s) X to reach merged status." },
       "requires_response": false
     }
     ```
   - Stop — do not proceed with assignment.
4. For each agent assignment in the sprint:
   a. Resolve WA-N → real agent ID (e.g. `WA-1` → `claude-code`).
   b. Render the sprint assignment from `templates/sprint-assignment.md` with the agent's tasks, scope, branch name, and migration range.
   c. Write the rendered assignment to `.autoclaw/orchestrator/sprints/sprint-{N}-{realAgentId}.md`
      (e.g. `sprint-1-claude-code.md`, NOT `sprint-1-WA-1.md`).
   d. Send a `task_assignment` message to that agent's inbox:
      ```json
      {
        "type": "task_assignment",
        "from": "orchestrator",
        "to": "<realAgentId>",
        "timestamp": "<iso>",
        "sprint": <N>,
        "task_id": "<comma-separated task IDs>",
        "payload": {
          "assignment_file": "sprint-{N}-{realAgentId}.md",
          "branch": "<branch-name>",
          "scope": ["<glob1>", "<glob2>"]
        },
        "requires_response": false
      }
      ```
      Write to `.autoclaw/orchestrator/comms/inboxes/<realAgentId>/<timestamp>-task_assignment-orchestrator.json`.
   e. Update `state.json` `agents` entry for the real agent ID:
      ```json
      { "status": "working", "sprint": <N>, "tasks": ["<task-id>", ...] }
      ```
5. Update sprint status to `assigned` in the sprint YAML.
6. Update `state.json` `current_sprint` to `<N>`.
7. Confirm: "Sprint {N} assigned. Assignment files written for: {agent1}, {agent2}. Each agent should read their assignment file and begin work."

---

## status — Show Progress

Read all sprint YAMLs and the plan summary. Display:

```
Orchestration Status — {project}
═══════════════════════════════
Sprint 1: ██████████ merged (4/4 tasks)
Sprint 2: ████████░░ in_progress (WA-1: done, WA-2: review, WA-3: working, WA-4: working)
Sprint 3: ░░░░░░░░░░ pending (blocked by Sprint 2)
...
Progress: 12/75 tasks complete (16%)
Critical path: Sprint 5 of 9
```

---

## review — Trigger Review

1. Read the sprint YAML. Verify status is `in_progress` or all agents have signaled completion.
2. Read quality gates from `config.yaml` (`project.build_command`, `project.test_command`, `project.lint_command`).
   If not set, auto-detect from workspace root:
   - `Cargo.toml` → `cargo check --workspace`, `cargo clippy --workspace -- -D warnings`, `cargo test --workspace`
   - `go.mod` → `go build ./...`, `go vet ./...`, `go test ./...`
   - `package.json` → `npm run build`, `npm run lint`, `npm test`
3. For each agent's completed work:
   - Run configured quality gates. Report pass/fail per gate.
   - Render the review checklist from `templates/review-checklist.md`.
   - Write gate results to the review file.
4. Write review report to `.autoclaw/orchestrator/reviews/sprint-{N}-review.md`.
5. Set verdict: `APPROVED`, `MINOR_ISSUES`, or `CRITICAL_ISSUES`.
6. If `CRITICAL_ISSUES`: update sprint status to `review` and list required fixes.
7. If `APPROVED` or `MINOR_ISSUES`: update sprint status to `approved`.
8. Confirm: "Sprint {N} review complete. Verdict: {verdict}. {details}"

---

## merge — Merge Approved Sprint

1. Verify sprint status is `approved`.
2. For each agent's branch (in dependency order):
   - Merge to develop branch using `--no-ff`.
   - If the project is Go: run `go mod tidy`. If Rust: run `cargo check --workspace`.
   - Run full test suite (from config quality gates).
3. Update sprint status to `merged`.
4. Check if next sprint's dependencies are now met; update `dependencies_met: true` in those sprint YAMLs.
5. Confirm: "Sprint {N} merged. Sprint {N+1} is now unblocked. Run `/orchestrate assign {N+1}` to continue."

---

## next — Assign Next Available Sprint

1. Find the first sprint with status `pending` whose dependencies are all `merged`.
2. Run the `assign` flow for that sprint.
3. If no sprint is available, report: "All sprints assigned or blocked. Run `/orchestrate status` for details."

---

## Quick Plan (no sub-command)

If the user describes tasks without a sub-command:
1. Infer task structure from the description.
2. Generate a temporary manifest.
3. Run the `plan` flow.
4. Offer to save the manifest for future use.

---

## State Tracking

The orchestrator maintains state in sprint YAML files (status field) and in `.autoclaw/orchestrator/state.json`.
The `state.json` file uses real agent IDs (not WA-N slots) in the `agents` map:

```json
{
  "project": "zippycoin-core",
  "current_sprint": 2,
  "total_sprints": 9,
  "tasks_complete": 12,
  "tasks_total": 75,
  "agents": {
    "claude-code": { "status": "working", "sprint": 2, "tasks": ["task-19"] },
    "kilocode":    { "status": "review",  "sprint": 2, "tasks": ["task-20"] }
  },
  "last_updated": "2026-05-03T12:00:00Z"
}
```

After each `plan`, `assign`, or sprint status transition, update `state.json` accordingly.

---

## On Task Completion (agent signal)

When you finish your assigned sprint work:
1. Broadcast `task_complete` to `.autoclaw/orchestrator/comms/inboxes/shared/`:
   ```json
   {
     "type": "task_complete",
     "from": "<your-agent-id>",
     "to": "shared",
     "sprint": <N>,
     "task_id": "<task-ids>",
     "payload": { "branch": "<branch>", "summary": "<one-line summary>" },
     "requires_response": false
   }
   ```
2. Write `review_request` to each peer agent's inbox.
3. Update your heartbeat: `current_task: null, sprint: <N>, status: idle`.

---

## Error Handling

- **Cycle detected**: Report the cycle path and refuse to plan. User must fix manifest.
- **Scope conflict**: Report conflicting tasks and their overlapping patterns. Suggest splitting or sequencing.
- **Missing dependency**: Report which `depends_on` ID doesn't exist in the manifest.
- **Gate failure**: Report which gate failed, with command output. Do not auto-merge.
- **Agent timeout / stall**: If an agent hasn't updated their heartbeat within `estimated_days * 2` days,
  their status will appear as `stalled` in the dashboard. Send an `escalation` to `shared/` inbox.
- **Dependency not met**: Send `answer` message to requesting agent, list blocking sprints, stop.

---

## Integration with Other Skills

- **KDream**: Orchestrator progress is logged to KDream's memory. KDream ticks can check for stalled sprints.
- **AutoBuild**: Quality gates can be defined as AutoBuild workflows.
- **MAteam**: Individual sprint assignments can be executed by MAteam's Researcher → Coder → Reviewer → Verifier pipeline.
