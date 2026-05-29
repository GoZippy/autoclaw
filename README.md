# AutoClaw — Autonomous AI Agents

Persistent background agents, autonomous build workflows, multi-agent teams, and parallel sprint orchestration — all inside VS Code. Install once, zero configuration required.

Works with **GitHub Copilot, Claude Code, Cursor, Kiro, Windsurf, KiloCode, Cline, Continue, Antigravity**, and any Agent Skills compatible AI. Type `@autoclaw` in any chat to invoke skills without copy-pasting.

---

## License at a glance

- Free for personal, educational, and evaluation use.
- Commercial use requires a paid license — contact ZippyTechnologiesLLC.
- Full terms: see [LICENSE](LICENSE).

---

## Quick Start (5 minutes)

1. **Install** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ZippyTechnologiesLLC.autoclaw) or [Open VSX](https://open-vsx.org/extension/ZippyTechnologiesLLC/autoclaw).
2. **Open any workspace.** AutoClaw activates automatically and installs skill files for every AI extension it detects.
3. **Open any AI chat** and type:
   ```
   @autoclaw /kdream start
   ```
   Or on Claude Code/Copilot: `@kdream /kdream start`. KDream initialises its state, scans your workspace, and reports your first snapshot.
4. **Press `Ctrl+Alt+K`** (Mac: `Cmd+Alt+K`) to open the KDream Dashboard.
5. **Press `Ctrl+Alt+D`** (Mac: `Cmd+Alt+D`) to run the Doctor health check.

---

## What's Included

AutoClaw ships four skills and a native chat participant:

| Skill | What it does |
|---|---|
| **KDream** | Always-on background agent that monitors your workspace, surfaces TODOs, manages persistent memory, and can implement tasks |
| **AutoBuild** | Autonomous scheduled build and workflow pipelines with an in-process cron scheduler, cross-host lockfile, and per-workflow log rotation |
| **MAteam** | Multi-agent coordinator — Researcher → Coder → Reviewer → Verifier — with real parallel subagent dispatch on Claude Code |
| **Orchestrate** | Multi-agent sprint orchestrator — reads task manifests, builds dependency DAGs, generates sprint plans, assigns parallel agents with isolated scopes, and enforces consensus review gates |

Plus the `@autoclaw` **chat participant**: type `@autoclaw /kdream start` (or any skill command) directly in VS Code chat — no copy-pasting, no adapter file lookup required.

Extension-level features:

| Feature | Access |
|---|---|
| **@autoclaw Chat Participant** | Type `@autoclaw` in any VS Code chat |
| **KDream Dashboard** | Activity bar (lobster icon), or `Ctrl+Alt+K` |
| **Doctor health report** | `Ctrl+Alt+D`, or Command Palette → `AutoClaw: Doctor` |
| **Doctor JSON output** | Command Palette → `AutoClaw: Doctor (JSON output)` |
| **Export Health Snapshot** | Dashboard toolbar, or Command Palette → `AutoClaw: Export Health Snapshot` |
| **AutoBuild Run Now** | `Ctrl+Alt+B`, or Command Palette |
| **Orchestrate Plan** | `Ctrl+Alt+O`, or Command Palette |
| **Launch Skill** | `Ctrl+Alt+L` — quick-pick copies platform-aware prompt to clipboard |

---

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ZippyTechnologiesLLC.autoclaw) (VS Code, GitHub Codespaces) or from [Open VSX](https://open-vsx.org/extension/ZippyTechnologiesLLC/autoclaw) (VSCodium, Cursor, Windsurf, Antigravity, Theia).

On first activation AutoClaw automatically detects which AI extensions you have installed and copies the correct skill files. No manual setup needed.

To re-run adapter installation:
`Ctrl+Shift+P` → **AutoClaw: Install Adapters for Detected AI Extensions**

---

## Compatibility

| AI Tool | How skills load | Adapter files |
|---|---|---|
| **GitHub Copilot Chat** | `chatSkills` + `@autoclaw` participant | native |
| **Claude Code** | `SKILL.md` files in `~/.claude/skills/` + `@autoclaw` | `adapters/claude-code/` |
| **Kiro** | Steering files in `.kiro/steering/` — auto-loaded (`inclusion: auto`) | `adapters/kiro/` |
| **KiloCode** | Custom modes in `.kilocodemodes` + `.clinerules/` fallback | `adapters/kilocode/` |
| **Cline** | Rules in `.clinerules/` | `adapters/cline/` |
| **Windsurf** | Rules in `.windsurf/rules/` | `adapters/windsurf/` |
| **Cursor** | `.mdc` rules in `.cursor/rules/` | `adapters/cursor/` |
| **Continue** | `.prompt` files in `.continue/prompts/` | `adapters/continue/` |
| **Antigravity** | `.md` rules in `.agent/rules/` | `adapters/antigravity/` |

All adapter files are generated from a single source of truth (`skills/*/SKILL.md`) via `npm run adapters:build`. Run `npm run adapters:check` to detect drift.

**Note on Kiro:** All AutoClaw adapters use `inclusion: auto` in Kiro — they activate immediately without manual opt-in in the steering rules UI.

### Multi-IDE Support

AutoClaw can run simultaneously in multiple IDEs on the same machine without port conflicts. Each IDE (VS Code, Cursor, Kiro, Windsurf, Antigravity) gets a dedicated port block, and different workspaces within the same IDE get deterministic offsets via workspace-path hashing.

When the bridge starts, the IDE and workspace are registered in `~/.autoclaw/.port-registry.json`. On stop or deactivation, the entry is released. The cross-IDE agent registry (`~/.autoclaw/.agent-registry.json`) tracks all live bridge endpoints on the machine, enabling agents like Codex, Claude Code, OpenClaw, and Hermes to discover and connect to any running AutoClaw instance.

To disable the agent registry, set `autoclaw.workspaceRegistry.enabled` to `false`.

---

## Keyboard Shortcuts

| Shortcut | Mac | Command |
|---|---|---|
| `Ctrl+Alt+K` | `Cmd+Alt+K` | Open KDream Dashboard |
| `Ctrl+Alt+R` | `Cmd+Alt+R` | Refresh KDream Dashboard |
| `Ctrl+Alt+D` | `Cmd+Alt+D` | Doctor (Health Check) |
| `Ctrl+Alt+B` | `Cmd+Alt+B` | AutoBuild — Run Workflow Now |
| `Ctrl+Alt+O` | `Cmd+Alt+O` | Orchestrate — Plan Sprints |
| `Ctrl+Alt+L` | `Cmd+Alt+L` | Launch Skill (copy prompt to clipboard) |

All shortcuts are rebindable via `Preferences → Keyboard Shortcuts`.

---

## @autoclaw Chat Participant

The `@autoclaw` chat participant is the fastest way to invoke any skill. It loads the skill's full instruction set as context, injects live state where relevant, and streams the response — no copy-pasting, no file lookup.

```
@autoclaw /kdream start
@autoclaw /kdream ps
@autoclaw /autobuild schedule "0 2 * * *" nightly-build
@autoclaw /mateam launch "refactor the auth module"
@autoclaw /orchestrate plan
@autoclaw /orchestrate status
@autoclaw /inbox
```

**Available subcommands:**

| Subcommand | Skill invoked |
|---|---|
| `/kdream` | KDream background agent (start, ps, work, add, logs, dream) |
| `/autobuild` | AutoBuild workflow scheduler (schedule, run, list, status) |
| `/mateam` | MAteam multi-agent coordinator (launch) |
| `/orchestrate` | Sprint orchestrator (init, plan, assign, status, review, merge, next) |
| `/inbox` | Show cross-agent shared inbox messages |

**How it works:** The participant reads the SKILL.md for the requested skill, optionally appends the current `state.json` (for Orchestrate), and sends everything as the system prompt to the VS Code language model API. It falls back to the clipboard if no LM is available (Cursor, Windsurf, older VS Code builds).

---

## KDream — Persistent Background Agent

KDream monitors your workspace, tracks git status, scans for TODO/FIXME items, and consolidates activity into persistent memory. Unlike a one-shot prompt, KDream accumulates context across sessions — every tick reads previous memory so it understands the history of your project.

### Starting KDream

```
@autoclaw /kdream start
```

Or on specific tools:
- **GitHub Copilot / Claude Code via Copilot / Continue:** `@kdream /kdream start`
- **Claude Code CLI:** `/kdream start`
- **KiloCode:** Switch to **KDream** mode, then type `start`
- **Kiro / Cline / Cursor / Windsurf / Antigravity:** Describe it — "Start the KDream background agent"

### KDream Commands

| Command | What it does |
|---|---|
| `/kdream start` | Start the daemon, initialise state, run first tick |
| `/kdream ps` | Show status: running/stopped, tick count, open TODOs, open follow-ups |
| `/kdream logs` | View last 30 lines of today's activity log |
| `/kdream stop` | Gracefully shut down and save state |
| `/kdream dream` | Run memory consolidation immediately |
| `/kdream add <note>` | Append a task or reminder to `MEMORY.md` |
| `/kdream todo` | List all open TODO/FIXME items in the workspace |
| `/kdream work <item>` | Implement or resolve a specific item |

### Example session

```
You:    @autoclaw /kdream ps
KDream: Status: running | Tick #12 | 3 open TODOs | 2 open follow-ups
        TODOs: src/auth.ts:42 (add input validation), src/api.ts:87 (handle 429 retry)
        Follow-ups: "investigate memory leak", "update API docs before merge"

You:    @autoclaw /kdream work the 429 retry in src/api.ts
KDream: Reading src/api.ts… implementing exponential backoff…
        ✓ Done. Added retryWithBackoff(). Mark TODO resolved? [y/n]
```

### Adding tasks

**Via chat:** `/kdream add check if rate-limit tests cover the new backoff logic`

**Via TODO comments** (picked up automatically on the next tick):
```typescript
// TODO: add input validation here
// FIXME: crashes when array is empty
```

**Via MEMORY.md directly:**
```markdown
## Follow-ups
- [ ] Investigate the memory leak reported in issue #42
- [ ] Run load tests before the v2.0 release
```

### Where KDream stores data

```
.autoclaw/kdream/
├── state.json              ← status, tick count, lastDream
├── logs/YYYY-MM-DD.md      ← append-only daily activity log
└── memory/
    ├── MEMORY.md            ← live memory (< 200 lines)
    └── archive-YYYY-MM-DD.md
```

### KDream Dashboard

Open with `Ctrl+Alt+K`. Shows: KDream status, tasks and follow-ups, recent activity, adapter health, TODOs, export button. Auto-refreshes when `state.json` changes.

### Configuration

| Setting | Default | Description |
|---|---|---|
| `autoclaw.kdream.enableFileWatcher` | `true` | Auto-refresh dashboard when state changes |
| `autoclaw.kdream.notifyNewTodos` | `true` | Show notification when new TODOs are detected |
| `autoclaw.kdream.refreshInterval` | `30` | Dashboard refresh interval in seconds |
| `autoclaw.kdream.scanPatterns` | `["**/*.ts","**/*.js",...]` | Patterns to scan for TODOs/FIXMEs |
| `autoclaw.kdream.notificationLevel` | `"all"` | Verbosity: `"all"`, `"warnings"`, `"errors"`, `"none"` |
| `autoclaw.kdream.autoInstallAdapters` | `true` | Auto-install adapters on activation |
| `autoclaw.kdream.zippymeshUrl` | `"http://localhost:20128"` | ZippyMesh health-check URL |
| `autoclaw.kdream.zippymeshSearchPaths` | `[]` | Extra paths to search for a ZippyMesh installation |

---

## AutoBuild — Autonomous Workflow Engine

AutoBuild creates, schedules, and executes multi-step pipelines. Workflows are plain YAML — version-controllable and trivial to customise. A real in-process cron scheduler fires due workflows without any external daemon or cron tab.

### Creating a workflow

```
@autoclaw /autobuild schedule "0 2 * * *" nightly-build
```

Run immediately: `@autoclaw /autobuild run nightly-build` or `Ctrl+Alt+B`.

### AutoBuild Commands

| Command | What it does |
|---|---|
| `/autobuild schedule "<cron>" <name>` | Create a named scheduled workflow |
| `/autobuild run <name>` | Run immediately, bypassing schedule |
| `/autobuild list` | Show all workflows with last run status |
| `/autobuild cancel <name>` | Remove workflow from registry |
| `/autobuild status <name>` | Print most recent log output |

### Cron expression reference

| Expression | Meaning |
|---|---|
| `"0 2 * * *"` | Every day at 2 am |
| `"0 * * * *"` | Every hour on the hour |
| `"*/15 * * * *"` | Every 15 minutes |
| `"0 9 * * 1-5"` | Weekdays at 9 am |
| `"0 0 * * 0"` | Every Sunday at midnight |

### Workflow YAML format

```yaml
name: nightly-build
cron: "0 2 * * *"
notify: true
timeout: 300   # seconds per step

steps:
  - id: deps
    run: npm ci
  - id: build
    run: npm run build
  - id: test
    run: npm test
    timeout: 600
  - id: deploy
    run: npm run deploy:staging
    condition: "{{test.exit_code}} == 0"
```

### How the scheduler works

- Ticks every 30 seconds (configurable via `autoclaw.autobuild.tickIntervalSeconds`, min 10).
- Acquires a cross-host lockfile (`.autoclaw/autobuild/.lock`) — two VS Code windows on the same workspace cannot double-trigger a workflow.
- Stale locks from dead processes are taken over automatically.
- Logs over 1 MB are truncated. Keeps the 50 most recent logs per workflow.

### Configuration

| Setting | Default | Description |
|---|---|---|
| `autoclaw.autobuild.enabled` | `true` | Enable the in-process scheduler |
| `autoclaw.autobuild.tickIntervalSeconds` | `30` | Scheduler tick frequency (minimum 10) |

---

## MAteam — Multi-Agent Coordinator

MAteam decomposes a task and delegates each part to a specialised agent role. On **Claude Code**, each role is a real parallel subagent (`Agent` tool). On all other hosts, roles execute in-session sequentially.

### Launching a team

```
@autoclaw /mateam launch "refactor the authentication module to use JWT"
@autoclaw /mateam launch "audit the API layer for security issues"
```

### The agent roles

| Role | What it does |
|---|---|
| **Researcher** | Maps the codebase, identifies patterns. Writes `context.md`. |
| **Coder** | Implements changes from Researcher's findings. Writes `output.md`. |
| **Reviewer** | Audits output for correctness and security. Writes `review.md`. Can halt the pipeline. |
| **Verifier** | Runs tests, confirms nothing regressed. Writes `verify.md`. |

### MAteam Commands

| Command | What it does |
|---|---|
| `/mateam launch "<task>"` | Decompose and execute with a full agent team |
| `/mateam status` | Show all active sessions |
| `/mateam cancel` | Halt all active sessions |
| `/mateam result` | Show final output from the most recent session |

### Example output

```
@autoclaw /mateam launch "add retry logic to all HTTP calls in src/api.ts"

MAteam: Researcher → 4 HTTP call sites found, no retry handling
        Coder → retryWithBackoff() added, wired into fetchJson/postJson/patchJson/deleteJson
        Reviewer → LGTM; note: add jitter to avoid thundering herd
        Verifier → 47 tests passing, 0 failures
Result: PR-ready. Jitter note saved to MEMORY.md follow-ups.
```

---

## Orchestrate — Multi-Agent Sprint Orchestrator

Orchestrate turns a task manifest into a parallelised sprint plan, assigns work to multiple agents with isolated file scopes, and coordinates a consensus review gate before any sprint branch is merged. It is designed for large projects that benefit from multiple AI agents working simultaneously on non-overlapping parts of a codebase.

> **Coordinating a build across several AI agents?** Read
> [`docs/AGENT_WORKFLOW.md`](docs/AGENT_WORKFLOW.md) — three copy-paste
> prompt templates (bootstrap, coordinator, worker) that work with any
> AutoClaw-supported agent and replace the older "paste this giant blob"
> approach.

### How it works

```
Manifest YAML → DAG planner → Sprint plan → Assign to agents → Consensus review → Merge
```

1. **You write a task manifest** with tasks, dependencies, file scopes, and effort estimates.
2. **Orchestrate builds a DAG**, topologically sorts tasks, detects scope conflicts, and bin-packs tasks into sprint batches — maximising parallelism while preventing file collisions.
3. **Each sprint is assigned to N agents** (default 4). Each agent gets a scoped work package: task list, allowed file patterns, branch name.
4. **Agents work in parallel**, checking their mailbox at `.autoclaw/orchestrator/comms/inboxes/<agent>/` and writing `task_complete` messages when done.
5. **The extension watches the shared inbox** — when a `task_complete` arrives, it notifies you and prompts a consensus review.
6. **Consensus review** collects vote files from `comms/consensus/active/`, runs `evaluateConsensus()` (2/3 majority, security findings unanimous), and reports a per-task verdict. Only approved sprints can advance.

### Getting started

```
@autoclaw /orchestrate init
```

This creates `.autoclaw/orchestrator/` with `config.yaml`, `manifests/`, `sprints/`, and `reviews/`. If a Kiro spec `tasks.md` exists in your workspace, Orchestrate offers to generate a manifest from it automatically.

### Task manifest format

```yaml
project:
  name: my-project
  test_command: npm test
  build_command: npm run build

tasks:
  - id: task-1
    name: CLI foundation
    depends_on: []
    scope:
      - "src/cli/**"
    effort: M
    subtasks:
      - Implement argument parser
      - Add help command

  - id: task-2
    name: Auth system
    depends_on: [task-1]
    scope:
      - "src/auth/**"
    effort: L
    subtasks:
      - JWT token generation
      - Session middleware

  - id: task-3
    name: REST API
    depends_on: [task-1]
    scope:
      - "src/api/**"
    effort: L

constraints:
  mutual_exclusion:
    - [task-2, task-3]   # run these in separate sprints
  affinity:
    - [task-4, task-5]   # co-locate on the same agent
```

### Orchestrate Commands

| Command | What it does |
|---|---|
| `/orchestrate init` | Scaffold config, manifests, and sprint directories |
| `/orchestrate plan` | Build DAG, detect conflicts, generate sprint YAMLs |
| `/orchestrate assign` | Assign current sprint to agents, write assignment docs |
| `/orchestrate status` | Show sprint progress across all agents |
| `/orchestrate review` | Collect consensus votes and report verdict |
| `/orchestrate merge` | Merge an approved sprint branch to develop |
| `/orchestrate next` | Assign next sprint whose dependencies are satisfied |

### Sprint plan format

After `/orchestrate plan`, sprint files appear in `.autoclaw/orchestrator/sprints/`:

```yaml
sprint: 1
level: 0
status: pending
assignments:
  - agent: WA-1
    tasks: [{ id: task-1, name: CLI foundation }]
    scope: ["src/cli/**"]
    branch: feat/sprint-1-wa1-cli
  - agent: WA-2
    tasks: [{ id: task-3, name: REST API }]
    scope: ["src/api/**"]
    branch: feat/sprint-1-wa2-api
dependencies_met: true
estimated_days: 4
```

### Cross-agent communication

Agents coordinate via a filesystem mailbox at `.autoclaw/orchestrator/comms/`. No external service required.

- **Inboxes:** `.autoclaw/orchestrator/comms/inboxes/<agent-id>/` — each agent reads its inbox before and after every task.
- **Shared inbox:** `.autoclaw/orchestrator/comms/inboxes/shared/` — broadcast messages (task completions, findings).
- **Consensus votes:** `.autoclaw/orchestrator/comms/consensus/active/<task-id>-<agent>.json`

The extension watches the shared inbox in real time — when a `task_complete` message lands, you get an immediate VS Code notification with a "Run Consensus Review" button.

### Consensus review

Agents vote by writing files to `consensus/active/`. Vote structure:

```json
{
  "voter": "kiro",
  "task_id": "task-1",
  "vote": "approve",
  "confidence": 0.9,
  "findings": []
}
```

Valid votes: `approve`, `needs_changes`, `blocked`, `abstain`.

Running **AutoClaw: Orchestrate — Run Consensus Review** (or `@autoclaw /orchestrate review`) reads all vote files, calls the consensus engine, and reports:

```
✅ task-1: consensus_reached — verdict: approved (3 votes)
⏳ task-2: consensus_pending — verdict: needs_changes (2 votes, 1 pending)
   [major] security: Missing input validation in src/api/users.ts:47
```

Security findings require **unanimous** approval. Any `blocked` vote vetoes the sprint.

### Agent identity registry

When you run `/orchestrate assign`, AutoClaw detects which agent platforms are active (Kiro, KiloCode, Cline, etc.) and writes `.autoclaw/orchestrator/agents.json` mapping sprint agent IDs to platforms:

```json
{
  "agents": [
    { "id": "WA-1", "platform": "kiro",     "inbox": ".autoclaw/orchestrator/comms/inboxes/kiro/" },
    { "id": "WA-2", "platform": "kilocode", "inbox": ".autoclaw/orchestrator/comms/inboxes/kilocode/" }
  ]
}
```

### OpenClaw HTTP bridge (optional)

For remote agents on separate machines, start the HTTP bridge:

```
Command Palette → AutoClaw: Start OpenClaw Bridge Server
```

The bridge runs on `127.0.0.1:9876` (configurable). Remote agents authenticate with a Bearer token:

```
Command Palette → AutoClaw: Register Remote Agent (Generate Token)
```

REST endpoints: `POST /api/v1/messages`, `GET /api/v1/messages`, `POST /api/v1/heartbeat`, `GET /api/v1/status`, `POST /api/v1/consensus/vote`.

### Where Orchestrate stores data

```
.autoclaw/orchestrator/
├── config.yaml              ← planner settings (agents, gates, branch prefix)
├── agents.json              ← WA-N → platform identity registry
├── manifests/               ← your task YAML files (edit these)
├── sprints/
│   ├── plan-summary.yaml    ← overview: total tasks, sprints, critical path
│   ├── sprint-1.yaml        ← sprint plan with agent assignments
│   └── sprint-1-WA-1.md    ← rendered assignment doc for WA-1
├── reviews/                 ← sprint review reports
├── logs/                    ← execution logs
└── comms/
    ├── inboxes/             ← per-agent and shared message inboxes
    │   ├── shared/          ← broadcast messages (task_complete, findings)
    │   ├── kiro/            ← Kiro agent inbox
    │   └── kilocode/        ← KiloCode agent inbox
    └── consensus/
        └── active/          ← vote files awaiting evaluation
```

### Configuration

| Setting | Default | Description |
|---|---|---|
| `autoclaw.orchestrate.workAgents` | `4` | Number of parallel work agents |
| `autoclaw.orchestrate.maxTasksPerAgent` | `3` | Max tasks per agent per sprint |
| `autoclaw.orchestrate.maxSubtasksPerSprint` | `15` | Max subtasks across all agents per sprint |
| `autoclaw.orchestrate.branchPrefix` | `"feat/"` | Git branch prefix for sprint branches |
| `autoclaw.orchestrate.migrationRangeSize` | `4` | DB migration slots reserved per agent |
| `autoclaw.bridge.enabled` | `false` | Enable HTTP bridge for remote agents |
| `autoclaw.bridge.port` | `0` | Bridge server port. `0` = auto-allocate per IDE and workspace (conflict-free across VS Code, Kiro, Cursor, Windsurf, Antigravity). Set an explicit value to override. |
| `autoclaw.bridge.host` | `"127.0.0.1"` | Bridge server host (use `0.0.0.0` for external) |
| `autoclaw.kg.port` | `0` | KG daemon port. `0` = auto-allocate per IDE and workspace. Set an explicit value to override. |
| `autoclaw.workspaceRegistry.enabled` | `true` | Enable cross-IDE agent orchestration registry (`~/.autoclaw/.agent-registry.json`). When enabled, each IDE instance registers its bridge endpoint so other agents can discover it. |

---

## Doctor — Health Check

The Doctor command (`Ctrl+Alt+D`) runs a read-only health audit and renders a structured report in the `AutoClaw Doctor` Output Channel.

### What the Doctor checks

| Section | What it audits |
|---|---|
| **Workspace** | Root path, `.autoclaw/` directory existence |
| **Compilation freshness** | Compares `src/` vs `out/` modification times — flags stale compiled output |
| **KDream state** | `state.json` presence, tick count, last dream time |
| **MEMORY.md** | Required sections, open follow-up count |
| **Logs** | Today's log file presence and size |
| **Adapter drift** | Live adapter files vs `skills/*/SKILL.md` source |
| **Adapter schema** | Every adapter directory exposes all four skills (kdream/autobuild/mateam/orchestrate) |
| **Per-host install matrix** | All 9 hosts: installed / not installed |
| **Git Health** | Branch, upstream tracking, ahead/behind, uncommitted/untracked, hours since last commit |
| **ZippyMesh LLM Router** | HTTP reachability and identity check |
| **Skill source** | All four `skills/*/SKILL.md` files exist |
| **AutoBuild** | Scheduler enabled, registered workflows, last run status |

### JSON output

```
Command Palette → AutoClaw: Doctor (Health Check, JSON output)
```

Or from the repo: `npm run sample:doctor`

---

## Health Snapshot Export

Captures a point-in-time archive of your workspace's agent health.

```
Command Palette → AutoClaw: Export Health Snapshot
```

Or click **Export Snapshot** in the KDream Dashboard toolbar. The exported Markdown contains the full Doctor report, `state.json`, last 30 log lines, all open follow-ups, extension version, and timestamp. Saved to `.autoclaw/snapshots/`.

---

## Workspace State Layout

All AutoClaw state lives under `.autoclaw/` — no hidden global state:

```
.autoclaw/
├── kdream/
│   ├── state.json          ← daemon status and tick count
│   ├── logs/               ← daily activity logs (YYYY-MM-DD.md)
│   └── memory/
│       ├── MEMORY.md       ← live agent memory (< 200 lines)
│       └── archive-*.md    ← overflow archives
├── autobuild/
│   ├── .lock               ← cross-host lockfile (ephemeral)
│   ├── registry.json       ← workflow index and last-run status
│   ├── workflows/          ← YAML workflow definitions (edit these)
│   └── runs/               ← timestamped run logs (last 50 per workflow)
├── mateam/
│   └── scratch/            ← per-session agent scratchpads
├── orchestrator/
│   ├── config.yaml         ← planner settings
│   ├── agents.json         ← WA-N → platform identity registry
│   ├── manifests/          ← task YAML files (edit these)
│   ├── sprints/            ← generated sprint plans + assignment docs
│   ├── reviews/            ← sprint review reports
│   ├── logs/               ← execution logs
│   └── comms/              ← cross-agent mailboxes and consensus votes
└── snapshots/              ← exported health snapshots
```

**Team workflows:** Commit `.autoclaw/autobuild/workflows/` and `.autoclaw/orchestrator/manifests/` to share pipelines and task manifests. Keep `.autoclaw/kdream/`, `.autoclaw/mateam/scratch/`, and `.autoclaw/orchestrator/comms/` in `.gitignore`.

---

## Command Palette Reference

| Command | Shortcut | Description |
|---|---|---|
| **AutoClaw: Enable All Autonomous Features** | — | Confirms all skills are active |
| **AutoClaw: Start KDream Background Agent** | — | Opens chat and launches KDream |
| **AutoClaw: Install Adapters** | — | Re-run adapter detection and installation |
| **AutoClaw: Launch Skill (Copy Prompt to Clipboard)** | `Ctrl+Alt+L` | Quick-pick skill → copies platform-aware prompt |
| **AutoClaw: Doctor (Health Check)** | `Ctrl+Alt+D` | Full health report in Output Channel |
| **AutoClaw: Doctor (Health Check, JSON output)** | — | Same report as structured JSON |
| **AutoClaw: Export Health Snapshot** | — | Save timestamped Markdown health archive |
| **AutoClaw: AutoBuild — Run Workflow Now** | `Ctrl+Alt+B` | Pick and run a workflow immediately |
| **AutoClaw: AutoBuild — Tail Most Recent Run Log** | — | Open latest run log |
| **AutoClaw: Orchestrate — Plan Sprints from Manifest** | `Ctrl+Alt+O` | Load manifest and confirm planner config |
| **AutoClaw: Orchestrate — Show Sprint Status** | — | Show current orchestration state |
| **AutoClaw: Orchestrate — Assign Next Sprint** | — | Detect agents, write registry, assign sprint |
| **AutoClaw: Orchestrate — Run Consensus Review** | — | Read votes, evaluate consensus, report verdict |
| **AutoClaw: Start OpenClaw Bridge Server** | — | Start HTTP bridge for remote agents |
| **AutoClaw: Stop OpenClaw Bridge Server** | — | Stop bridge |
| **AutoClaw: Register Remote Agent (Generate Token)** | — | Generate auth token for a remote agent |
| **KDream: Show Dashboard** | `Ctrl+Alt+K` | Open the activity-bar dashboard |
| **KDream: Refresh Dashboard** | `Ctrl+Alt+R` | Manually refresh all sections |
| **KDream: Add Task** | — | Add a task to KDream memory via input prompt |

---

## Avoiding Rate Limits with ZippyMesh LLM Router

When running MAteam or long KDream sessions, you may hit rate limits from free-tier AI providers.

**ZippyMesh LLM Router** is a companion tool from Zippy Technologies that routes requests across multiple providers with intelligent failover.

1. Download ZippyMesh LLM Router from [zippymesh.com](https://zippymesh.com)
2. Start it: `node run.js` (runs on `http://localhost:20128`)
3. In your AI extension, set the base URL to `http://localhost:20128/v1`
4. AutoClaw's Doctor and Dashboard show ZippyMesh connection status automatically.

---

## What's Next / Roadmap

| Feature | Description |
|---|---|
| **Publish v2.1.0** | Release to VS Code Marketplace and Open VSX |
| **ZippyPanel integration** | Use Orchestrate to drive ZippyPanel's 9-sprint parallel development plan |
| **Orchestrate Dashboard panel** | Live sidebar view of sprint progress, agent statuses, and comms timeline |
| **OpenClaw client SDK** | Client library for remote agents using the HTTP bridge |
| **Agent ID ↔ platform mapping** | Configurable in `config.yaml` rather than auto-detected at assign time |
| **evaluateConsensus in review flow** | Wire TypeScript consensus engine into `/orchestrate review` SKILL.md |
| **AutoBuild YAML IntelliSense** | JSON Schema for workflow files — autocomplete in the editor |
| **Status bar item** | KDream running/stopped indicator in the VS Code status bar |
| **VS Code walkthrough** | Guided first-run walkthrough in the Welcome tab |
| **Real-time collaboration** | Shared task boards, team memory sync, multi-user notifications |

---

## Source & Issues

- GitHub: [GoZippy/autoclaw](https://github.com/GoZippy/autoclaw)
- VS Code Marketplace: [ZippyTechnologiesLLC.autoclaw](https://marketplace.visualstudio.com/items?itemName=ZippyTechnologiesLLC.autoclaw)
- Open VSX: [ZippyTechnologiesLLC/autoclaw](https://open-vsx.org/extension/ZippyTechnologiesLLC/autoclaw)
- Report bugs or request features via [GitHub Issues](https://github.com/GoZippy/autoclaw/issues)
- Changelog: [CHANGELOG.md](https://github.com/GoZippy/autoclaw/blob/master/CHANGELOG.md)

### Publishing (maintainers)

Credentials live in a local, never-committed `.env` file (template: `.env.example`). Setup:

1. `cp .env.example .env`
2. Fill in `VSCE_PAT` (Azure DevOps PAT with **Marketplace > Manage** scope) and `OVSX_TOKEN` (from https://open-vsx.org/user-settings/tokens).

Release:

```bash
npm version patch              # or minor / major
npm run package                # build the VSIX
npm run publish:all            # push to both Marketplace and Open VSX
```

---

## License

AutoClaw is distributed under the **Zippy Technologies Source-Available Commercial License v1.3**. Personal, educational, and evaluation use is free of charge. Commercial use requires a paid license from ZippyTechnologiesLLC. See [LICENSE](LICENSE) for the full terms.
