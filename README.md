# AutoClaw — Autonomous AI Agents

Persistent background agents, autonomous build workflows, and multi-agent teams — all inside VS Code. Install once, zero configuration required.

Works with **GitHub Copilot, Claude Code, Cursor, Kiro, Windsurf, KiloCode, Cline, Continue**, and any Agent Skills compatible AI.

---

## License at a glance

- Free for personal, educational, and evaluation use.
- Commercial use requires a paid license — contact ZippyTechnologiesLLC.
- Full terms: see [LICENSE](LICENSE).

---

## What's Included

AutoClaw ships three skills:

| Skill | What it does |
|---|---|
| **KDream** | Always-on background agent that monitors your workspace and consolidates memory |
| **AutoBuild** | Autonomous scheduled build and workflow pipelines (real in-process cron scheduler since v1.2.5) |
| **MAteam** | Multi-agent coordinator — Researcher → Coder → Reviewer → Verifier (real subagent dispatch on Claude Code, in-session fallback elsewhere, since v1.2.5) |

Plus extension-level commands:

- `AutoClaw: Doctor (Health Check)` — single-command health report covering workspace, KDream state, MEMORY.md, log presence, adapter drift, per-host install matrix, ZippyMesh status, skill-source sanity.
- `AutoClaw: Export Health Snapshot` — Markdown snapshot of the doctor report plus state.json, log tail, and open follow-ups; share-friendly.
- `AutoClaw: Run AutoBuild Workflow Now` and `AutoClaw: Tail Latest Workflow Run` — fire and inspect scheduled workflows on demand.

---

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ZippyTechnologiesLLC.autoclaw).

On first activation AutoClaw automatically detects which AI extensions you have installed and copies the correct skill files to each tool's expected location. No manual setup needed.

To re-run adapter installation at any time:
`Ctrl+Shift+P` → **AutoClaw: Install Adapters for Detected AI Extensions**

---

## Compatibility

| AI Tool | How skills load |
|---|---|
| **GitHub Copilot Chat** | Built-in via VS Code `chatSkills` |
| **Claude Code** | `SKILL.md` files copied to `~/.claude/skills/` |
| **Cursor** | `.mdc` rules copied to `.cursor/rules/` in workspace |
| **Kiro** | Steering files copied to `.kiro/steering/` in workspace |
| **Windsurf** | Rules copied to `.windsurf/rules/` in workspace |
| **KiloCode** | Custom modes merged into `.kilocodemodes` in workspace |
| **Cline** | Rules copied to `.clinerules/` in workspace |
| **Continue** | `.prompt` files copied to `.continue/prompts/` in workspace |

---

## KDream — Persistent Background Agent

KDream monitors your workspace in the background, tracks git status, scans for TODO/FIXME items, and consolidates activity into persistent memory.

### Starting KDream

**Claude Code / Copilot / Continue:**
```
/kdream start
```

**KiloCode:** Switch to **KDream** mode in the mode selector, then type `start`.

**Cursor / Windsurf / Kiro / Cline:** Describe what you want — the rule activates automatically when you ask to start a background agent.

### KDream Commands

| Command | What it does |
|---|---|
| `/kdream start` | Start the background agent and run first tick |
| `/kdream ps` | Show status: running/stopped, tick count, open TODOs, open follow-ups |
| `/kdream logs` | View last 30 lines of today's activity log |
| `/kdream stop` | Gracefully shut down |
| `/kdream dream` | Run memory consolidation immediately |
| `/kdream add <note>` | Add a task or reminder for KDream to watch |
| `/kdream todo` | List all open TODO/FIXME items found in the workspace |
| `/kdream work <item>` | Tell KDream to actively implement or resolve an item |

### How to give KDream work to do

There are three ways to assign tasks to KDream:

#### 1. TODO/FIXME comments in your code (automatic)

KDream scans every source file on each tick. Any of these markers are picked up automatically:

```typescript
// TODO: add input validation here
// FIXME: this crashes when array is empty
// HACK: temporary workaround, needs proper fix
// BUG: race condition when two users submit simultaneously
```

On the next tick KDream will surface new items and ask if you want it to work on them. When an item is resolved (the comment is removed), KDream logs it as completed automatically.

#### 2. Quick add via command

```
/kdream add remind me to update the API docs after merging this branch
/kdream add check if the nightly build is passing
/kdream add the login flow needs error handling for expired tokens
```

This appends the item to `MEMORY.md` under `## Follow-ups`. KDream picks it up on the next tick.

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

### Telling KDream to act on an item

Once KDream surfaces an item, you can tell it to work on it:

```
/kdream work the login flow error handling
/kdream work TODO #3
```

KDream will read the relevant files, implement or resolve the item, and mark it complete.

### What KDream does on each tick

Each time you invoke KDream in chat, it runs one tick:

1. **Git check** — runs `git status` and flags uncommitted changes older than 1 hour
2. **TODO scan** — globs all source files for `TODO`, `FIXME`, `HACK`, `XXX`, `BUG` markers; reports new ones, marks resolved ones as done
3. **Follow-up review** — reads `## Follow-ups` in `MEMORY.md`; reports any open `- [ ]` items
4. **Act or stay silent** — if anything needs attention, surfaces a summary; otherwise logs a silent heartbeat and does nothing

### The autoDream cycle

After 20 ticks or 24 hours KDream consolidates everything it has observed:

1. **Orient** — lists all memory files
2. **Gather** — reads last 7 days of logs, extracts new TODOs, resolved items, warnings
3. **Consolidate** — merges into `MEMORY.md`, removes contradictions, converts relative dates to ISO, deduplicates, moves completed follow-ups to Observations
4. **Prune** — if `MEMORY.md` exceeds 200 lines or 25 KB, archives the oldest 20% to `archive-YYYY-MM-DD.md`
5. **Finalize** — updates last dream timestamp in `state.json`

### MEMORY.md structure

KDream creates and maintains this file automatically:

```markdown
# KDream Memory

## Follow-ups
<!-- KDream checks this section on every tick. Add tasks here. -->
- [ ] Open item KDream will watch
- [x] Completed item (moved to Observations on next dream)

## Facts
<!-- Consolidated knowledge about this workspace. -->
- Project uses npm workspaces with 3 packages
- Main branch is protected, PRs required

## Observations
<!-- Notable events and patterns observed over time. -->
- 2026-04-01: Resolved login flow error handling TODO in src/auth.ts
```

### Where KDream stores data

```
.autoclaw/kdream/
├── state.json              ← status, tick count, last dream, todo snapshot
├── logs/
│   └── YYYY-MM-DD.md       ← append-only daily activity log
└── memory/
    ├── MEMORY.md            ← live memory (< 200 lines)
    └── archive-YYYY-MM-DD.md  ← overflow archive
```

### KDream Dashboard

The KDream Dashboard provides a visual overview of your background agent's status, tasks, and health.

#### Opening the Dashboard

- Click the **AutoClaw KDream** icon in the activity bar (lobster icon)
- Or run: `Ctrl+Shift+P` → **KDream: Show Dashboard**

#### Dashboard Sections

| Section | What it shows |
|---|---|
| **Status** | Current KDream state (running/stopped), tick count, last dream time |
| **Tasks & Follow-ups** | All tasks from `MEMORY.md` with completion checkboxes |
| **Recent Activity** | Last 10 lines from today's activity log |
| **Adapter Health** | Status of detected AI extension integrations |
| **TODOs** | All `TODO`/`FIXME` markers found in workspace source files |

#### Dashboard Commands

| Command | Description |
|---|---|
| **KDream: Show Dashboard** | Open the dashboard view in the sidebar |
| **KDream: Refresh Dashboard** | Manually refresh dashboard data |
| **KDream: Add Task** | Add a task to KDream memory via input prompt |

#### Configuration Settings

| Setting | Default | Description |
|---|---|---|
| `autoclaw.kdream.enableFileWatcher` | `true` | Enable automatic dashboard refresh when state changes |
| `autoclaw.kdream.notifyNewTodos` | `true` | Show notification when new TODOs are detected |
| `autoclaw.kdream.refreshInterval` | `30` | Dashboard refresh interval in seconds |
| `autoclaw.kdream.scanPatterns` | `["**/*.ts", "**/*.js", "**/*.tsx", "**/*.jsx", "**/*.py", "**/*.md"]` | File patterns to scan for TODOs/FIXMEs |
| `autoclaw.kdream.notificationLevel` | `"all"` | Notification verbosity: `"all"`, `"warnings"`, `"errors"`, or `"none"` |
| `autoclaw.kdream.autoInstallAdapters` | `true` | Automatically install adapters for detected AI extensions on activation |
| `autoclaw.kdream.adapters` | _(array)_ | List of AI adapters to monitor for health status (name and extension ID pairs) |

---

## AutoBuild — Autonomous Workflow Engine

AutoBuild creates, schedules, and executes multi-step build pipelines. Workflows are plain YAML — readable, version-controllable, and easy to customize.

### Creating a workflow

**Schedule a recurring workflow:**
```
/autobuild schedule "0 2 * * *" nightly-build
```
This creates a workflow YAML you can then edit to add your actual steps.

**Run immediately (one-shot):**
```
/autobuild run nightly-build
```

**Describe a task in plain English:**
```
/autobuild run my tests and then deploy to staging
```
AutoBuild infers the steps and runs them without requiring a YAML file.

### AutoBuild Commands

| Command | What it does |
|---|---|
| `/autobuild schedule "<cron>" <name>` | Create a scheduled workflow |
| `/autobuild run <name>` | Run a named workflow immediately |
| `/autobuild list` | Show all workflows with last run status |
| `/autobuild cancel <name>` | Delete a workflow |
| `/autobuild status <name>` | Show last run log output |

### Cron expression reference

| Expression | Meaning |
|---|---|
| `"0 2 * * *"` | Every day at 2am |
| `"0 * * * *"` | Every hour |
| `"*/15 * * * *"` | Every 15 minutes |
| `"0 9 * * 1-5"` | Weekdays at 9am |
| `"0 0 * * 0"` | Every Sunday midnight |

### Workflow YAML format

Workflows live in `.autoclaw/autobuild/workflows/<name>.yaml`. Edit them directly to customize steps:

```yaml
name: nightly-build
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
    condition: "{{test.exit_code}} == 0"   # only runs if test passed

notify: true     # VS Code notification on completion
timeout: 600     # seconds per step (default 120)
```

**Adding steps:** Each step needs an `id` (used in logs) and a `run` command (any shell command). Add as many steps as needed.

**Conditional steps:** Use `condition: "{{<step-id>.exit_code}} == 0"` to gate a step on the success of a previous one.

**Notifications:** Set `notify: true` to receive a VS Code notification when the workflow completes or fails.

### Where AutoBuild stores data

```
.autoclaw/autobuild/
├── registry.json           ← index of all workflows and last run status
├── workflows/
│   └── nightly-build.yaml  ← workflow definitions (edit these)
└── runs/
    └── nightly-build-2026-04-01T02-00-00.log  ← timestamped run logs
```

---

## MAteam — Multi-Agent Coordinator

MAteam decomposes a complex task and delegates to a sequence of specialized roles, each reading from and writing to a shared scratchpad.

### Launching a team

```
/mateam launch "refactor the authentication module to use JWT"
```

MAteam assigns the minimum roles the task requires and executes them in order:

| Role | What it does |
|---|---|
| **Researcher** | Reads relevant files, searches the codebase, identifies dependencies and patterns |
| **Coder** | Implements changes based on the Researcher's findings |
| **Reviewer** | Audits the Coder's output for correctness, security issues, and style |
| **Verifier** | Runs tests and confirms acceptance criteria are met |

The Reviewer can halt the pipeline before any tests run if blockers are found — you'll be notified before anything is committed or executed.

### MAteam Commands

| Command | What it does |
|---|---|
| `/mateam launch "<task>"` | Decompose and execute a task with a full agent team |
| `/mateam status` | Show all active sessions with current phase and last update |
| `/mateam list-peers` | List each agent role, its assigned task, and current state |
| `/mateam cancel` | Halt all active agents |
| `/mateam result` | Show the final output from the most recent session |

### Controlling which roles run

MAteam only assigns roles the task actually requires. You can also specify roles directly:

```
/mateam launch "review my last commit for security issues" --roles Researcher,Reviewer
```

### Where MAteam stores data

```
.autoclaw/mateam/scratch/
└── 2026-04-01-refactor-auth/
    ├── plan.md      ← task breakdown and role assignments
    ├── context.md   ← Researcher findings
    ├── output.md    ← Coder deliverables
    ├── review.md    ← Reviewer notes and blockers
    └── verify.md    ← Verifier test results
```

All scratchpad files are plain Markdown — you can read, edit, or add notes to them at any point during execution.

---

## Workspace State

All AutoClaw state lives under `.autoclaw/` in your workspace root:

```
.autoclaw/
├── kdream/
│   ├── state.json          ← daemon status and tick count
│   ├── logs/               ← daily activity logs
│   └── memory/             ← MEMORY.md + archives
├── autobuild/
│   ├── registry.json       ← workflow index
│   ├── workflows/          ← YAML workflow definitions
│   └── runs/               ← timestamped run logs
└── mateam/
    └── scratch/            ← per-session agent scratchpads
```

Add `.autoclaw/` to your `.gitignore` to keep it local, or commit it to share agent memory and workflow definitions with your team.

---

## Command Palette

| Command | Description |
|---|---|
| **AutoClaw: Enable All Autonomous Features** | Confirms all skills are loaded and ready |
| **AutoClaw: Start KDream Background Agent** | Opens chat and launches KDream |
| **AutoClaw: Install Adapters for Detected AI Extensions** | Re-runs adapter detection and installation |
| **KDream: Show Dashboard** | Open the KDream Dashboard view |
| **KDream: Refresh Dashboard** | Manually refresh dashboard data |
| **KDream: Add Task** | Add a task to KDream memory |

---

## Avoiding Rate Limits with ZippyMesh LLM Router

When running MAteam or long KDream sessions, you may hit rate limits from free-tier AI providers
(e.g., "fetch failed" errors in KiloCode with Qwen3.6 free, Groq, or Gemini free tiers).

**ZippyMesh LLM Router** is a companion tool from Zippy Technologies that solves this by acting
as a local proxy that automatically routes requests across multiple providers with intelligent failover.

### Quick Setup
1. Download ZippyMesh LLM Router from [zippymesh.com](https://zippymesh.com)
2. Start it: `node run.js` (runs on `http://localhost:20128`)
3. In your AI extension (KiloCode, Cursor, Continue), set the base URL to:
   ```
   http://localhost:20128/v1
   ```
4. That's it — AutoClaw skills work exactly the same, but requests now route across
   multiple providers automatically when one is rate-limited or unavailable.

### For MAteam: Enabling Parallel Burst Mode
When running `/mateam launch` for multi-agent tasks, add these headers in your AI extension config:
```
X-Session-Parallel: true
X-Intent: multi-agent
```
ZippyMesh will distribute each agent's calls across different free providers (Groq, Gemini,
GitHub Models, Cerebras, Ollama) instead of hammering one.

### Supported Providers (Free Tier)
- Groq (fastest, free tier)
- Google Gemini Flash (free tier)
- GitHub Models (free with GitHub account)
- Cerebras (free tier)
- Ollama (fully local, unlimited)

AutoClaw's dashboard will show ZippyMesh connection status in the **Adapter Health** panel
once you have ZippyMesh running locally.

---

## Source & Issues

- GitHub: [GoZippy/autoclaw](https://github.com/GoZippy/autoclaw)
- Report bugs or request features via [GitHub Issues](https://github.com/GoZippy/autoclaw/issues)
- Changelog: [CHANGELOG.md](https://github.com/GoZippy/autoclaw/blob/master/CHANGELOG.md)

---

## License

AutoClaw is distributed under the **Zippy Technologies Source-Available Commercial License v1.3**. Personal, educational, and evaluation use is free of charge. Commercial use requires a paid license from ZippyTechnologiesLLC. See [LICENSE](LICENSE) for the full terms.
