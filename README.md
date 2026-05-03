# AutoClaw — Autonomous AI Agents

Persistent background agents, autonomous build workflows, and multi-agent teams — all inside VS Code. Install once, zero configuration required.

Works with **GitHub Copilot, Claude Code, Cursor, Kiro, Windsurf, KiloCode, Cline, Continue, Antigravity**, and any Agent Skills compatible AI.

---

## License at a glance

- Free for personal, educational, and evaluation use.
- Commercial use requires a paid license — contact ZippyTechnologiesLLC.
- Full terms: see [LICENSE](LICENSE).

---

## Quick Start (5 minutes)

1. **Install** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ZippyTechnologiesLLC.autoclaw) or [Open VSX](https://open-vsx.org/extension/ZippyTechnologiesLLC/autoclaw).
2. **Open any workspace.** AutoClaw activates automatically and installs skill files for every AI extension it detects.
3. **Open GitHub Copilot Chat** (or whichever AI tool you use) and type:
   ```
   @kdream /kdream start
   ```
   KDream initialises its state, scans your workspace, and reports your first snapshot: uncommitted changes, open TODOs, and any follow-ups from previous sessions.
4. **Press `Ctrl+Alt+K`** (Mac: `Cmd+Alt+K`) to open the KDream Dashboard and see everything at a glance.
5. **Press `Ctrl+Alt+D`** (Mac: `Cmd+Alt+D`) to run the Doctor health check — it surfaces any configuration or adapter issues in one read-only report.

That's it. KDream is running. Come back to any AI chat window and type `/kdream ps` to check in.

---

## What's Included

AutoClaw ships three skills:

| Skill | What it does |
|---|---|
| **KDream** | Always-on background agent that monitors your workspace, surfaces TODOs, manages persistent memory, and can implement tasks for you |
| **AutoBuild** | Autonomous scheduled build and workflow pipelines with an in-process cron scheduler, cross-host lockfile, and per-workflow log rotation |
| **MAteam** | Multi-agent coordinator — Researcher → Coder → Reviewer → Verifier — with real parallel subagent dispatch on Claude Code and graceful in-session fallback elsewhere |

Plus extension-level commands and dashboard:

| Feature | Access |
|---|---|
| **KDream Dashboard** | Activity bar (lobster icon), or `Ctrl+Alt+K` |
| **Doctor health report** | `Ctrl+Alt+D`, or Command Palette → `AutoClaw: Doctor` |
| **Doctor JSON output** | Command Palette → `AutoClaw: Doctor (JSON output)` |
| **Export Health Snapshot** | Dashboard toolbar, or Command Palette → `AutoClaw: Export Health Snapshot` |
| **AutoBuild Run Now** | `Ctrl+Alt+B`, or Command Palette → `AutoClaw: AutoBuild — Run Workflow Now` |

---

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ZippyTechnologiesLLC.autoclaw) (VS Code, GitHub Codespaces) or from [Open VSX](https://open-vsx.org/extension/ZippyTechnologiesLLC/autoclaw) (VSCodium, Cursor, Windsurf, Antigravity, Theia, and other Eclipse-Open-VSX clients).

On first activation AutoClaw automatically detects which AI extensions you have installed and copies the correct skill files to each tool's expected location. No manual setup needed.

To re-run adapter installation at any time:
`Ctrl+Shift+P` → **AutoClaw: Install Adapters for Detected AI Extensions**

---

## Compatibility

| AI Tool | How skills load | Adapter files |
|---|---|---|
| **GitHub Copilot Chat** | Built-in via VS Code `chatSkills` | none (native) |
| **Claude Code** | `SKILL.md` files in `~/.claude/skills/` | `adapters/claude-code/` |
| **Antigravity** | `.md` rules in `.agent/rules/` (workspace) | `adapters/antigravity/` |
| **Cursor** | `.mdc` rules in `.cursor/rules/` (workspace) | `adapters/cursor/` |
| **Kiro** | Steering files in `.kiro/steering/` (workspace) | `adapters/kiro/` |
| **Windsurf** | Rules in `.windsurf/rules/` (workspace) | `adapters/windsurf/` |
| **KiloCode** | Custom modes merged into `.kilocodemodes` (workspace) | `adapters/kilocode/` |
| **Cline** | Rules in `.clinerules/` (workspace) | `adapters/cline/` |
| **Continue** | `.prompt` files in `.continue/prompts/` (workspace) | `adapters/continue/` |

All adapter files are generated from a single source of truth (`skills/*/SKILL.md`) using `npm run adapters:build`. If you ever suspect adapter drift, run `npm run adapters:check` — it exits non-zero and prints a diff if any adapter is out of sync.

---

## Keyboard Shortcuts

| Shortcut | Mac | Command |
|---|---|---|
| `Ctrl+Alt+K` | `Cmd+Alt+K` | Open KDream Dashboard |
| `Ctrl+Alt+R` | `Cmd+Alt+R` | Refresh KDream Dashboard |
| `Ctrl+Alt+D` | `Cmd+Alt+D` | Doctor (Health Check) |
| `Ctrl+Alt+B` | `Cmd+Alt+B` | AutoBuild — Run Workflow Now |

All shortcuts are rebindable via `Preferences → Keyboard Shortcuts`.

---

## KDream — Persistent Background Agent

KDream monitors your workspace in the background, tracks git status, scans for TODO/FIXME items, and consolidates activity into persistent memory. Unlike a one-shot prompt, KDream accumulates context across sessions — every tick reads previous memory so it understands the history of your project, not just the current question.

### Starting KDream

**GitHub Copilot Chat / Claude Code (via Copilot) / Continue:**
```
@kdream /kdream start
```

**Claude Code CLI:**
```
/kdream start
```

**KiloCode:** Switch to **KDream** mode in the mode selector, then type `start`.

**Cursor / Windsurf / Kiro / Cline / Antigravity:** Describe what you want — the rule activates automatically. For example: "Start the KDream background agent."

### KDream Commands

| Command | What it does |
|---|---|
| `/kdream start` | Start the background agent, initialise state, run first tick |
| `/kdream ps` | Show status: running/stopped, tick count, open TODOs, open follow-ups |
| `/kdream logs` | View last 30 lines of today's activity log |
| `/kdream stop` | Gracefully shut down and save state |
| `/kdream dream` | Run memory consolidation immediately (normally happens every 20 ticks) |
| `/kdream add <note>` | Append a task or reminder to `MEMORY.md` under `## Follow-ups` |
| `/kdream todo` | List all open TODO/FIXME items currently found in the workspace |
| `/kdream work <item>` | Implement or resolve an item — KDream reads relevant files and acts |

### Example session

```
You:    /kdream ps
KDream: Status: running | Tick #12 | 3 open TODOs | 2 open follow-ups
        TODOs: src/auth.ts:42 (add input validation), src/api.ts:87 (handle 429 retry)
        Follow-ups: "investigate memory leak", "update API docs before merge"

You:    /kdream work the 429 retry in src/api.ts
KDream: Reading src/api.ts… implementing exponential backoff for 429 responses…
        ✓ Done. Added retryWithBackoff() helper, wired into fetchWithAuth(). Mark TODO resolved? [y/n]

You:    /kdream add check if rate-limit tests cover the new backoff logic
KDream: Added to MEMORY.md follow-ups. Will surface on next tick.
```

### How to give KDream work

There are three ways to assign tasks:

#### 1. TODO/FIXME comments in your code (automatic)

KDream scans every source file on each tick. Any of these markers are picked up automatically:

```typescript
// TODO: add input validation here
// FIXME: this crashes when array is empty
// HACK: temporary workaround, needs proper fix
// BUG: race condition when two users submit simultaneously
// XXX: revisit this before 2.0
```

On the next tick KDream surfaces new items and asks if you want it to work on them. When the comment is removed (because the issue is fixed), KDream logs it as completed automatically.

#### 2. Quick-add via chat

```
/kdream add remind me to update the API docs after merging this branch
/kdream add check if the nightly build is passing after the CI change
/kdream add the login flow needs error handling for expired tokens
```

Items are appended to `MEMORY.md` under `## Follow-ups`. KDream picks them up on the next tick.

#### 3. Edit MEMORY.md directly

Open `.autoclaw/kdream/memory/MEMORY.md` and add items under `## Follow-ups`:

```markdown
## Follow-ups
- [ ] Investigate the memory leak reported in issue #42
- [ ] Run load tests before the v2.0 release
- [ ] Review the database migration script with the team
- [ ] Check if dependency X has a security patch available
```

Use `- [ ]` for open items and `- [x]` for completed ones. KDream moves completed items to `## Observations` during the next autoDream cycle.

### What KDream does on each tick

Each time you invoke KDream in chat, it runs one tick:

1. **Git check** — runs `git status` and flags uncommitted changes older than 1 hour
2. **TODO scan** — globs all source files for `TODO`, `FIXME`, `HACK`, `XXX`, `BUG` markers; reports new ones, marks resolved ones as done
3. **Follow-up review** — reads `## Follow-ups` in `MEMORY.md`; reports any open `- [ ]` items
4. **Act or stay silent** — if anything needs attention, surfaces a compact summary; otherwise logs a silent heartbeat

### The autoDream cycle

After 20 ticks or 24 hours KDream consolidates everything it has observed:

1. **Orient** — lists all memory files and archives
2. **Gather** — reads last 7 days of logs, extracts new TODOs, resolved items, warnings
3. **Consolidate** — merges into `MEMORY.md`, deduplicates, converts relative dates to ISO, moves completed follow-ups to `## Observations`
4. **Prune** — if `MEMORY.md` exceeds 200 lines or 25 KB, archives the oldest 20% to `archive-YYYY-MM-DD.md`
5. **Finalize** — updates `lastDream` timestamp in `state.json`

Run it on-demand any time with `/kdream dream`.

### MEMORY.md structure

```markdown
# KDream Memory

## Follow-ups
<!-- KDream checks this section on every tick. Add tasks here. -->
- [ ] Open item KDream will watch and act on
- [x] Completed item (moved to Observations on next dream)

## Facts
<!-- Consolidated knowledge about this workspace. -->
- Project uses npm workspaces with 3 packages
- Main branch is protected, PRs required, squash merges preferred

## Observations
<!-- Notable events and patterns observed over time. -->
- 2026-04-01: Resolved login flow error handling TODO in src/auth.ts
- 2026-04-15: Nightly build failing after dependency update — fixed by pinning lodash@4.17.21
```

### Where KDream stores data

```
.autoclaw/kdream/
├── state.json              ← status, tick count, lastDream, todoSnapshot
├── logs/
│   └── YYYY-MM-DD.md       ← append-only daily activity log
└── memory/
    ├── MEMORY.md            ← live memory (< 200 lines)
    └── archive-YYYY-MM-DD.md  ← overflow archives
```

### KDream Dashboard

The KDream Dashboard provides a visual real-time overview of your background agent.

**Opening:** Click the lobster icon in the activity bar, or press `Ctrl+Alt+K` / `Cmd+Alt+K`.

| Section | What it shows |
|---|---|
| **Status** | KDream state (running/stopped), tick count, last dream time |
| **Tasks & Follow-ups** | All items from `MEMORY.md ## Follow-ups` |
| **Recent Activity** | Last 10 lines from today's activity log |
| **Adapter Health** | Live status of all detected AI extension integrations |
| **TODOs** | All `TODO`/`FIXME` markers found in workspace source files |
| **Export Snapshot** | Button to capture a point-in-time health report |

**Auto-refresh:** The dashboard watches `.autoclaw/kdream/state.json` for changes — it updates live when KDream writes a new tick without you having to press refresh.

### Configuration

| Setting | Default | Description |
|---|---|---|
| `autoclaw.kdream.enableFileWatcher` | `true` | Auto-refresh dashboard when state changes |
| `autoclaw.kdream.notifyNewTodos` | `true` | Show notification when new TODOs are detected |
| `autoclaw.kdream.refreshInterval` | `30` | Dashboard refresh interval in seconds |
| `autoclaw.kdream.scanPatterns` | `["**/*.ts","**/*.js","**/*.tsx","**/*.jsx","**/*.py","**/*.md"]` | Patterns to scan for TODOs/FIXMEs |
| `autoclaw.kdream.notificationLevel` | `"all"` | Verbosity: `"all"`, `"warnings"`, `"errors"`, or `"none"` |
| `autoclaw.kdream.autoInstallAdapters` | `true` | Auto-install adapters on activation |
| `autoclaw.kdream.adapters` | _(see below)_ | AI adapters to monitor (name + extension ID pairs) |
| `autoclaw.kdream.zippymeshUrl` | `"http://localhost:20128"` | ZippyMesh health-check URL |
| `autoclaw.kdream.zippymeshSearchPaths` | `[]` | Extra paths to search for a ZippyMesh installation |

---

## AutoBuild — Autonomous Workflow Engine

AutoBuild creates, schedules, and executes multi-step pipelines. Workflows are plain YAML — readable, version-controllable, and trivial to customise. A real in-process cron scheduler (30-second tick, configurable) fires due workflows without any external daemon, cron tab, or task runner.

### Creating a workflow

**Via chat (generates YAML for you):**
```
/autobuild schedule "0 2 * * *" nightly-build
```

**Run an existing workflow immediately:**
```
/autobuild run nightly-build
```
Or press `Ctrl+Alt+B` / `Cmd+Alt+B` and pick from the list.

**Tail the most recent log:**
```
/autobuild status nightly-build
```
Or: Command Palette → `AutoClaw: AutoBuild — Tail Most Recent Run Log`.

### AutoBuild Commands

| Command | What it does |
|---|---|
| `/autobuild schedule "<cron>" <name>` | Create a named scheduled workflow |
| `/autobuild run <name>` | Run a named workflow immediately, bypassing its schedule |
| `/autobuild list` | Show all workflows with last run status and next scheduled run |
| `/autobuild cancel <name>` | Delete a workflow from the registry |
| `/autobuild status <name>` | Print the most recent log output for a workflow |

### Cron expression reference

AutoBuild supports standard 5-field cron expressions (minute hour day month weekday):

| Expression | Meaning |
|---|---|
| `"0 2 * * *"` | Every day at 2 am |
| `"0 * * * *"` | Every hour on the hour |
| `"*/15 * * * *"` | Every 15 minutes |
| `"0 9 * * 1-5"` | Weekdays at 9 am |
| `"0 0 * * 0"` | Every Sunday at midnight |
| `"30 8 1 * *"` | 8:30 am on the 1st of each month |

### Workflow YAML format

Workflows live in `.autoclaw/autobuild/workflows/<name>.yaml`. Full example:

```yaml
name: nightly-build
cron: "0 2 * * *"
notify: true          # VS Code notification on completion/failure
timeout: 300          # seconds per step (default 120, max 1 MB log per step)

steps:
  - id: deps
    run: npm ci

  - id: lint
    run: npm run lint

  - id: build
    run: npm run build

  - id: test
    run: npm test
    timeout: 600       # override per-step timeout

  - id: deploy-staging
    run: npm run deploy:staging
    condition: "{{test.exit_code}} == 0"   # gate on test success

  - id: notify-team
    run: curl -s -X POST "$SLACK_WEBHOOK" -d '{"text":"Nightly build passed ✓"}'
    condition: "{{deploy-staging.exit_code}} == 0"
```

**Practical patterns:**

```yaml
# Lint + typecheck on every push (triggered manually or on /autobuild run)
name: pre-commit-checks
cron: "*/30 * * * *"   # every 30 minutes during active hours
steps:
  - id: typecheck
    run: npx tsc --noEmit
  - id: lint
    run: npx eslint src --max-warnings 0
  - id: test-unit
    run: npm run test:unit

# Weekly dependency audit
name: dep-audit
cron: "0 8 * * 1"     # Monday 8am
steps:
  - id: audit
    run: npm audit --audit-level=high
  - id: outdated
    run: npm outdated || true

# Database backup
name: db-backup
cron: "0 3 * * *"
steps:
  - id: dump
    run: pg_dump $DATABASE_URL > backups/$(date +%Y-%m-%d).sql
  - id: compress
    run: gzip backups/$(date +%Y-%m-%d).sql
  - id: upload
    run: aws s3 cp backups/$(date +%Y-%m-%d).sql.gz s3://my-bucket/backups/
    condition: "{{compress.exit_code}} == 0"
```

### How the scheduler works

The AutoBuild scheduler runs in the VS Code extension host process — no separate process, cron tab, or system service required.

- Ticks every 30 seconds (configurable via `autoclaw.autobuild.tickIntervalSeconds`, minimum 10).
- Acquires a cross-host lockfile (`.autoclaw/autobuild/.lock`) before firing, so two VS Code windows on the same workspace directory cannot double-trigger the same workflow.
- Stale locks from dead processes (PID not alive, or lock older than 30 seconds) are taken over automatically.
- Each workflow run streams stdout/stderr to a timestamped log file in `.autoclaw/autobuild/runs/`. Logs over 1 MB are truncated with a `[truncated]` marker.
- After each run the scheduler keeps the most recent 50 logs per workflow and deletes older ones automatically.

### Where AutoBuild stores data

```
.autoclaw/autobuild/
├── .lock                   ← cross-host lockfile (ephemeral)
├── registry.json           ← index: all workflows + last run status
├── workflows/
│   ├── nightly-build.yaml  ← workflow definitions (edit these directly)
│   └── dep-audit.yaml
└── runs/
    ├── nightly-build-2026-04-01T02-00-00.log
    └── dep-audit-2026-04-07T08-00-00.log
```

### Configuration

| Setting | Default | Description |
|---|---|---|
| `autoclaw.autobuild.enabled` | `true` | Enable the in-process scheduler |
| `autoclaw.autobuild.tickIntervalSeconds` | `30` | Scheduler tick frequency (minimum 10) |

---

## MAteam — Multi-Agent Coordinator

MAteam decomposes a complex task and delegates each part to a specialised agent role. On **Claude Code**, each role is dispatched as a real parallel subagent call (`Agent` tool). On all other hosts (Copilot, KiloCode, Cursor, etc.) the roles execute in-session sequentially with the same scratchpad protocol.

### Launching a team

```
/mateam launch "refactor the authentication module to use JWT"
/mateam launch "audit the API layer for security issues and propose fixes"
/mateam launch "write integration tests for the payment service"
```

MAteam assigns only the roles the task actually requires — a pure research question won't spin up a Coder.

### The agent roles

| Role | What it does |
|---|---|
| **Researcher** | Reads relevant files, greps for symbols, maps the call graph, identifies patterns and constraints. Writes findings to `context.md`. |
| **Coder** | Implements changes based on the Researcher's `context.md`. Writes deliverables to `output.md`. |
| **Reviewer** | Audits `output.md` for correctness, security, style, and test coverage. Writes blockers to `review.md`. **Can halt the pipeline before anything is committed.** |
| **Verifier** | Runs test commands, checks acceptance criteria, confirms nothing regressed. Writes results to `verify.md`. |

### MAteam Commands

| Command | What it does |
|---|---|
| `/mateam launch "<task>"` | Decompose and execute a task with a full agent team |
| `/mateam status` | Show all active sessions: current phase and last update |
| `/mateam list-peers` | List each role, its assigned task, and current state |
| `/mateam cancel` | Halt all active agent sessions |
| `/mateam result` | Show final output from the most recent session |

### Controlling which roles run

```
/mateam launch "review my last commit for security issues" --roles Researcher,Reviewer
/mateam launch "add JSDoc to all exported functions in src/api.ts" --roles Coder
```

### Example output

```
/mateam launch "add retry logic to all HTTP calls in src/api.ts"

MAteam: Decomposing task…
  → Researcher: mapping HTTP call sites in src/api.ts
  → Coder: implementing retryWithBackoff wrapper
  → Reviewer: checking for race conditions and missing error types
  → Verifier: running npm test to confirm no regressions

Session: .autoclaw/mateam/scratch/2026-05-01-add-retry-logic/
  context.md  — 4 HTTP call sites found, currently no retry handling
  output.md   — retryWithBackoff() added, wired into fetchJson, postJson, patchJson, deleteJson
  review.md   — LGTM; note: add jitter to backoff to avoid thundering herd
  verify.md   — 47 tests passing, 0 failures, 0 regressions

Result: PR-ready. Review note about jitter saved to MEMORY.md follow-ups.
```

### Where MAteam stores data

```
.autoclaw/mateam/scratch/
└── 2026-05-01-add-retry-logic/
    ├── plan.md      ← task breakdown and role assignments
    ├── context.md   ← Researcher findings
    ├── output.md    ← Coder deliverables
    ├── review.md    ← Reviewer notes and blockers
    └── verify.md    ← Verifier test results
```

All scratchpad files are plain Markdown — read, edit, or annotate them any time during execution.

---

## Doctor — Health Check

The Doctor command (`Ctrl+Alt+D`) runs a read-only health audit of your AutoClaw installation and workspace. It renders a structured report in a dedicated `AutoClaw Doctor` Output Channel.

```
Command Palette → AutoClaw: Doctor (Health Check)
```

### What the Doctor checks

| Section | What it audits |
|---|---|
| **Workspace** | Root path, whether a `.autoclaw/` directory exists |
| **Compilation freshness** | Compares `src/` modification times against `out/` — flags stale compiled output so you know to recompile before testing |
| **KDream state** | `state.json` presence, tick count, last dream time, running/stopped status |
| **MEMORY.md** | File presence, required sections (`## Follow-ups`, `## Facts`, `## Observations`), open follow-up count |
| **Logs** | Whether today's log file exists, byte size |
| **Adapter drift** | Compares live adapter files against `skills/*/SKILL.md` source — surfaces any content drift |
| **Adapter schema** | Verifies every per-host adapter directory exposes all three skills (kdream / autobuild / mateam). KiloCode and ZippyMesh are exempt (custom layouts). |
| **Per-host install matrix** | Checks each of the 9 supported hosts and reports installed / not installed |
| **Git Health** | Branch name, upstream tracking status, ahead/behind counts vs remote, uncommitted files, untracked files, hours since last commit |
| **ZippyMesh LLM Router** | HTTP reachability check against the configured URL — distinguishes "healthy" (ZippyMesh-identifying response) from "reachable but unidentified" vs "unreachable" |
| **Skill source** | Confirms `skills/kdream/SKILL.md`, `skills/autobuild/SKILL.md`, `skills/mateam/SKILL.md` all exist |
| **AutoBuild** | Whether the scheduler is enabled, lists all registered workflows with last run status |

### JSON output

For scripting or grep workflows:

```
Command Palette → AutoClaw: Doctor (Health Check, JSON output)
```

This emits the full `DoctorReport` object as pretty-printed JSON to the same Output Channel. Pipe it with the VS Code terminal, or capture it from the extension host log. Example:

```bash
# Run sample:doctor from the repo to see the full JSON schema:
npm run sample:doctor
```

---

## Health Snapshot Export

The snapshot command captures a point-in-time archive of your workspace's agent health — useful for sharing with teammates, filing bug reports, or keeping a release audit trail.

```
Command Palette → AutoClaw: Export Health Snapshot
```

Or click **Export Snapshot** in the KDream Dashboard toolbar.

### What's in a snapshot

The exported Markdown file contains:
- Full Doctor report (all 11 sections, same as `Ctrl+Alt+D`)
- `state.json` contents
- Last 30 lines from today's KDream activity log
- All open follow-ups from `MEMORY.md`
- Extension version and export timestamp

Snapshots are saved to `.autoclaw/snapshots/snapshot-YYYY-MM-DDTHH-mm-ss.md`.

---

## Workspace State Layout

All AutoClaw state lives under `.autoclaw/` in your workspace root — no hidden global state:

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
└── snapshots/              ← exported health snapshots
```

**Team workflows:** Commit `.autoclaw/autobuild/workflows/` to share build pipelines with your team. Add `.autoclaw/kdream/` and `.autoclaw/mateam/scratch/` to `.gitignore` to keep agent state local.

---

## Command Palette Reference

| Command | Shortcut | Description |
|---|---|---|
| **AutoClaw: Enable All Autonomous Features** | — | Confirms all skills are active and adapters installed |
| **AutoClaw: Start KDream Background Agent** | — | Opens chat context and launches KDream |
| **AutoClaw: Install Adapters for Detected AI Extensions** | — | Re-runs adapter detection and file installation |
| **AutoClaw: Doctor (Health Check)** | `Ctrl+Alt+D` | Full workspace health report in Output Channel |
| **AutoClaw: Doctor (Health Check, JSON output)** | — | Same report as structured JSON |
| **AutoClaw: Export Health Snapshot** | — | Save timestamped Markdown health archive |
| **AutoClaw: AutoBuild — Run Workflow Now** | `Ctrl+Alt+B` | Pick a workflow from the registry and run it immediately |
| **AutoClaw: AutoBuild — Tail Most Recent Run Log** | — | Open the latest run log in the Output Channel |
| **KDream: Show Dashboard** | `Ctrl+Alt+K` | Open the activity-bar dashboard |
| **KDream: Refresh Dashboard** | `Ctrl+Alt+R` | Manually refresh all dashboard sections |
| **KDream: Add Task** | — | Add a task to KDream memory via input prompt |

---

## Avoiding Rate Limits with ZippyMesh LLM Router

When running MAteam or long KDream sessions, you may hit rate limits from free-tier AI providers (e.g., "fetch failed" errors in KiloCode with Qwen3, Groq, or Gemini free tiers).

**ZippyMesh LLM Router** is a companion tool from Zippy Technologies that solves this by acting as a local proxy that automatically routes requests across multiple providers with intelligent failover.

### Quick Setup

1. Download ZippyMesh LLM Router from [zippymesh.com](https://zippymesh.com)
2. Start it: `node run.js` (runs on `http://localhost:20128`)
3. In your AI extension (KiloCode, Cursor, Continue), set the base URL to:
   ```
   http://localhost:20128/v1
   ```
4. AutoClaw's Doctor and Dashboard will show ZippyMesh connection status in the **Adapter Health** section automatically.

### For MAteam: Parallel Burst Mode

When running `/mateam launch` for multi-agent tasks, ZippyMesh distributes each role's calls across different free providers instead of hammering one:

```
X-Session-Parallel: true
X-Intent: multi-agent
```

### Supported Providers (Free Tier)

- Groq (fastest free tier)
- Google Gemini Flash (free tier)
- GitHub Models (free with GitHub account)
- Cerebras (free tier)
- Ollama (fully local, unlimited)

---

## What's Next / Roadmap

The following capabilities are planned for future releases:

| Feature | Description |
|---|---|
| **Real-time collaboration** | Shared task boards, team memory sync, multi-user notifications |
| **Workspace intelligence** | Automated code analysis, dependency health, security scanning |
| **Adapter marketplace** | Community-contributed adapter packs and a custom adapter builder |
| **Productivity tools** | Code review assistant, automated test generation, refactoring suggestions |
| **Git enhancements** | Branch health visualisation, commit pattern analysis, merge conflict prediction |
| **Compliance + privacy** | Local-only processing mode, data export, audit logging |
| **AutoBuild YAML IntelliSense** | JSON Schema for workflow files so you get autocomplete in the editor |
| **Status bar item** | KDream running/stopped indicator always visible in the VS Code status bar |
| **VS Code walkthrough** | Guided first-run walkthrough in the Welcome tab |

---

## Source & Issues

- GitHub: [GoZippy/autoclaw](https://github.com/GoZippy/autoclaw)
- VS Code Marketplace: [ZippyTechnologiesLLC.autoclaw](https://marketplace.visualstudio.com/items?itemName=ZippyTechnologiesLLC.autoclaw)
- Open VSX: [ZippyTechnologiesLLC/autoclaw](https://open-vsx.org/extension/ZippyTechnologiesLLC/autoclaw)
- Report bugs or request features via [GitHub Issues](https://github.com/GoZippy/autoclaw/issues)
- Changelog: [CHANGELOG.md](https://github.com/GoZippy/autoclaw/blob/master/CHANGELOG.md)

### Publishing (maintainers)

Credentials live in a local, never-committed `.env` file (template: `.env.example`). One-time setup:

1. `cp .env.example .env`
2. Fill in `VSCE_PAT` (Azure DevOps PAT with **Marketplace > Manage** scope) and `OVSX_TOKEN` (from https://open-vsx.org/user-settings/tokens).

Then a release is:

```bash
npm version patch              # or minor / major — updates package.json + git tag
npm run package                # build the VSIX
npm run publish:all            # package + push to both Marketplace and Open VSX
```

The `publish:vscode` and `publish:ovsx` scripts read tokens from `.env` and work cross-platform (bash, PowerShell, cmd). `.env` is gitignored.

---

## License

AutoClaw is distributed under the **Zippy Technologies Source-Available Commercial License v1.3**. Personal, educational, and evaluation use is free of charge. Commercial use requires a paid license from ZippyTechnologiesLLC. See [LICENSE](LICENSE) for the full terms.
