# Changelog

## [2.1.0] - 2026-05-03

### Added
- **`@autoclaw` chat participant** — type `@autoclaw /orchestrate plan`, `@autoclaw /kdream start`, or `@autoclaw /inbox` directly in VS Code Chat (or any compatible panel like KiloCode, Kiro, Continue). AutoClaw reads the relevant skill and your live workspace state, then drives the AI — no copy-pasting prompts required. Degrades gracefully to clipboard fallback on hosts that don't support the Chat Participant API (Cursor, Windsurf).
- **Inbox notifications** — when a parallel agent drops a completion signal into the shared inbox (`.autoclaw/orchestrator/comms/inboxes/shared/`), you get a VS Code notification with one-click buttons to run a consensus review or check status. Critical security findings trigger a warning notification immediately.
- **Agent identity registry** — `autoclaw.orchestrate.assign` now auto-detects which AI tools are active (Kiro, KiloCode, Cline, Claude Code, etc.) and writes `.autoclaw/orchestrator/agents.json` mapping each sprint work-agent slot (WA-1, WA-2, …) to the actual platform and inbox path. Eliminates the manual bookkeeping when mixing different AI tools on the same sprint.
- **Consensus review command** — `AutoClaw: Orchestrate — Run Consensus Review` (Command Palette or dashboard button) reads all agent votes for the current sprint and applies the consensus rules: 2/3 majority required, unanimous approval for security findings, veto blocking. Results are displayed per-task with pass/fail verdict. Merge is gated until the sprint is approved.
- **Orchestrate adapters regenerated for all 8 platforms** — the adapter generator now includes the Orchestrate skill, so claude-code, cline, cursor, antigravity, windsurf, kiro, continue, and kilocode adapters all stay in sync with `skills/orchestrate/SKILL.md` automatically on `npm run adapters:build`.
- **Kiro auto-activation** — AutoClaw steering rules in Kiro now use `inclusion: auto` instead of `inclusion: manual`. Kiro users no longer need to manually opt in to each skill.

### Fixed
- Consensus review and agent registry operations now resolve all file paths to absolute paths before reading or writing, preventing any path traversal from manifests or config values that contain `..` segments.

## [2.0.3] - 2026-05-03

### Added
- **Orchestrate skill** — 4th skill for multi-agent parallel development orchestration. Reads task manifests (YAML), builds dependency DAGs, generates sprint plans via bin-packing, assigns scoped work to parallel agents, and coordinates review gates. Commands: `/orchestrate init`, `plan`, `assign`, `status`, `review`, `merge`, `next`.
- **DAG planner engine** (`src/orchestrate.ts`) — Topological sort via Kahn's algorithm, critical path computation, scope conflict detection (glob intersection), sprint bin-packing with effort capacity, mutual exclusion, and affinity constraints. Migration range allocation for database migration files.
- **Multi-agent consensus validation** — Cross-provider validation loop where agents from different AI tools (Kiro, Kilo Code, Claude Code, etc.) vote on task completion. Configurable approval threshold (default 2/3 majority), veto blocking, confidence filtering, unanimous categories for security findings, finding deduplication with severity upgrade, and deadlock detection after max rounds.
- **Extension commands** — `autoclaw.orchestrate.plan` (Plan Sprints), `autoclaw.orchestrate.status` (Show Status), `autoclaw.orchestrate.assign` (Assign Next Sprint). Keybinding: `Ctrl+Alt+O` for plan.
- **Configuration settings** — `autoclaw.orchestrate.workAgents`, `maxTasksPerAgent`, `maxSubtasksPerSprint`, `branchPrefix`, `migrationRangeSize`.
- **YAML serializer** — Minimal built-in YAML writer for sprint plans and summaries (no external dependency).
- **Template renderer** — Mustache-style `{{key}}` replacement with fallback defaults and array joining for sprint assignment documents.
- **54 unit tests** for orchestrate module covering DAG construction, topological sort, cycle detection, scope conflicts, sprint planning, consensus evaluation, finding merge, template rendering, YAML serialization, and state management.

### Changed
- `chatSkills` in `package.json` now includes `skills/orchestrate/SKILL.md`.
- `deactivate()` cleans up the orchestrate output channel.

## [1.2.6] - 2026-05-01

### Added
- **Compilation freshness check** in Doctor — detects when `src/` has files newer than `out/` and tells the user to recompile, so stale JS no longer ships silently.
- **Adapter schema validation** in Doctor — verifies every per-host adapter directory exposes all three skills (kdream/autobuild/mateam). KiloCode and ZippyMesh are exempt (custom layouts).
- **Git Health section** in Doctor — branch name, upstream tracking, ahead/behind counts vs remote, uncommitted/untracked file counts, hours-since-last-commit. Surfaces stale work and missing upstreams without leaving the editor.
- **JSON Doctor output** — new `AutoClaw: Doctor (Health Check, JSON output)` command (`autoclaw.doctorJson`) emits the structured `DoctorReport` for tooling/grep workflows.
- **`npm run sample:doctor`** — runs `runDoctor()` against the autoclaw repo itself and prints both text + JSON renderings; used for human-in-the-loop verification of new sections without booting VS Code.
- **Cursor + Antigravity adapter health** — both standalone hosts are now monitored alongside the VS Code-native adapters. Detection: Cursor via `.cursor/` markers, Antigravity via `vscode.env.appName` or workspace `.agent/`.
- **Keybindings** — `Ctrl+Alt+K` (open KDream Dashboard), `Ctrl+Alt+R` (refresh dashboard), `Ctrl+Alt+D` (Doctor), `Ctrl+Alt+B` (AutoBuild Run Now). Mac variants use `Cmd`.
- **AutoBuild log rotation** — `pruneRunLogs` keeps the most recent 50 logs per workflow after every successful run, so `.autoclaw/autobuild/runs/` no longer grows unbounded.
- **AutoBuild cross-host lockfile** — `tick()` now opportunistically acquires `.autoclaw/autobuild/.lock` (atomic `wx`) before reading the registry. Stale locks (dead PID, or older than 30 s) are taken over. Prevents two VS Code windows on a shared workspace from both firing the same workflow at the same minute.
- **Webview accessibility** — KDream Dashboard HTML now declares `role="banner"`/`"main"`/`"region"`, `aria-label`/`aria-labelledby`, and `aria-live="polite"` on auto-updating regions; progress bars expose `role="progressbar"` + `aria-valuenow`/min/max.
- **package.json metadata** — added `bugs`, `homepage`, `qna: marketplace`, and an explicit `license` reference for marketplace compliance.

### Fixed
- `DEFAULT_ADAPTERS` and `package.json`'s `autoclaw.kdream.adapters` default were missing Cursor and Antigravity, so health for those tools was never reported even when detected.
- KDream productivity / health collectors no longer swallow non-`ENOENT` filesystem errors silently — unexpected stat/read failures now log via `console.warn` so users can diagnose corrupt or unreadable state.
- Webview TODO and adapter renderers now defensively coerce missing `type` / `status` / `name` fields instead of throwing on `undefined.toLowerCase()`. Status class is also pattern-validated before being injected into `className`.
- Snapshot export automatically picks up the new Compilation, Adapter Schema, and Git Health doctor sections via the existing `renderReport()` integration — no extra wiring needed.

### Documentation
- README rewritten with a Quick Start guide (5 steps to first tick), a full keyboard shortcut table, concrete per-skill command examples with sample sessions, annotated AutoBuild YAML patterns (nightly build, dep audit, DB backup), MAteam example output, Doctor section explaining all 11 health checks, Snapshot Export section, workspace layout guide, full Command Palette reference, and a roadmap table for upcoming features.

### CI
- GitHub Actions now runs `npm run test:unit` (Mocha) AND `npm test` (VS Code integration), and gates on `npm run adapters:check` so adapter drift can no longer slip through review.

### Tests
- `pruneRunLogs` (2): keep-N, no-op when keep=0.
- AutoBuild lock (3): acquire/release, EEXIST on re-acquire, stale-PID takeover.
- `buildCompilationSection` (3): missing out/, stale src/ vs out/, fresh out/.
- `buildAdapterSchemaSection` (5): missing dir, flat .md layout, subdir layout, missing skills, custom-layout exemptions.
- `renderReportJson` (1): JSON round-trip + presence of new sections.
- `buildGitHealthSection` (3): no .git, null workspace, real git init+commit.
- 99 unit tests passing (was 81 in 1.2.5).

## [1.2.5] - 2026-04-30

### Added
- `AutoClaw: Doctor (Health Check)` command (`autoclaw.doctor`) — surfaces a
  single comprehensive read-only health report covering workspace state,
  KDream `state.json`, MEMORY.md follow-up counts and required sections,
  log-file presence, adapter drift vs `skills/`, per-host adapter installation
  (claude-code, kilocode, cline, cursor, antigravity, windsurf, kiro,
  continue), ZippyMesh LLM Router reachability, and skill-source sanity. The
  report is rendered into a dedicated `AutoClaw Doctor` OutputChannel so it
  can be copy-pasted or diffed.
- MAteam and `/kdream work` now explicitly dispatch via `Agent` tool on Claude Code and degrade to in-session execution elsewhere, instead of leaving the choice ambiguous.
- Export Health Snapshot — dashboard button + `autoclaw.exportSnapshot` command save the doctor report plus state/logs/follow-ups to a single Markdown file.
- AutoBuild scheduler now actually executes cron-scheduled workflows from the extension host. A 30-second tick (configurable via `autoclaw.autobuild.tickIntervalSeconds`, off when `autoclaw.autobuild.enabled` is false) reads `.autoclaw/autobuild/workflows/*.yaml`, fires due workflows, streams stdout/stderr to `.autoclaw/autobuild/runs/<name>-<ISO>.log` (truncated at 1 MB), honours per-step `timeout`, and updates `registry.json`. New commands `AutoClaw: AutoBuild — Run Workflow Now` and `AutoClaw: AutoBuild — Tail Most Recent Run Log`; doctor gained an `## AutoBuild` section listing scheduled workflows and last-run status.

### Fixed
- Removed `K:/Projects/zippymesh-router` and `S:/Projects/zippymesh-router` developer drive paths from the ZippyMesh MCP setup wizard. Candidate search is now workspace-relative first, then `~/zippymesh-router`, then user-supplied paths from the new `autoclaw.kdream.zippymeshSearchPaths` setting.
- `getCodeChurnMetrics` aggregates lines added/deleted across the last 30 days of commits instead of just the most recent diff (`HEAD~1..HEAD`).
- `churnRate` (lines per day) and `avgCommitSize` (lines per commit) now use distinct formulas instead of returning the same value.
- `adapterCoverage` no longer divides by zero when the adapter health array is empty.
- ZippyMesh LLM Router health check has a 60-second cache with ±5 second jitter; "healthy" requires either a ZippyMesh-identifying response header or a JSON body that names ZippyMesh, not just a 200 OK on the configured port.
- All blocking `execSync` git calls in the dashboard refresh path were replaced with awaited `execFile` so the extension host stops stalling on large repositories.
- `mergeKiloModes` now upgrades existing `.kilocodemodes` files in place when the AutoClaw block is delimited by a marker comment, instead of leaving stale modes for users upgrading from older AutoClaw releases.

### Distribution
- VSIX is now runtime-only: 45 files / ~150 KB. `out/test/`, `out/scripts/`, source maps, and dev-only workspace artifacts (`.autoclaw/`, `.kilocodemodes`, `.voidspec/`, `.kilo/`) are excluded from the published package.
- Published to the VS Code Marketplace as `ZippyTechnologiesLLC.autoclaw v1.2.5` (2026-04-30T12:40:23Z).
- Published to Open VSX as `ZippyTechnologiesLLC.autoclaw v1.2.5` (2026-05-01T05:59:03Z) — VSCodium, Cursor, Windsurf, Antigravity, Theia and other Eclipse-Open-VSX clients can now install AutoClaw.
- Cross-platform publish wrappers `scripts/publish-vsce.js` and `scripts/publish-ovsx.js` load credentials from a local `.env` (template at `.env.example`). New `npm run publish:all` packages and pushes to both registries.

## [1.2.4] - 2026-04-29

### Fixed
- KDream `start` failed under Kilo Code on Windows because the agent fell back to
  `mkdir -p`, which PowerShell rejects. All skills (kdream, autobuild, mateam) and
  adapter copies (claude-code, kilocode, cline, cursor, antigravity, windsurf, kiro,
  continue) now instruct the agent to create directories and files with the host's
  file/write tool instead of shelling out, and to use forward slashes.
- `/kdream start` is now explicitly idempotent — if `state.json` already shows
  `status=="running"`, the agent skips init and just runs a fresh tick instead of
  re-initialising state.

### Changed
- Each skill gained an "Operating Rules" header that pins output discipline
  (≤3 short confirmation lines, no reasoning narration, no invented style rules)
  to suppress the verbose / repetitive startup transcripts seen under some hosts.
- `start` confirmation now reports concrete counts (uncommitted, TODOs, follow-ups)
  rather than the generic "KDream is running."

## [1.2.1] - 2026-04-06

### Changed
- License updated to Zippy Technologies Source-Available Commercial License v1.3
  (personal/educational use remains free; commercial use requires a paid license)

### Fixed
- Patched high-severity `serialize-javascript` transitive vulnerability in dev dependencies
  via package override (does not affect the published extension — devDeps are not bundled)
- Updated `@vscode/test-cli` to 0.0.12

## [1.2.0] - 2026-04-01

### Added
- ZippyMesh LLM Router adapter with setup guide and routing playbooks
- Auto-detection of ZMLR on extension activation
- `mateam-playbook.json` and `kdream-playbook.json` for ZMLR routing
- MCP server setup wizard for Claude Code + ZippyMesh integration

## [1.1.0] - 2026-04-01

### Added
- **KDream Dashboard** — Visual sidebar showing KDream status, tasks, recent activity, adapter health, and TODOs
- New commands:
  - `kdream.showDashboard` — Open the KDream Dashboard view
  - `kdream.refreshDashboard` — Refresh dashboard data
  - `kdream.addTask` — Add a task to KDream memory via input box
- Activity bar icon for KDream Dashboard (lobster icon)
- File system watcher for `.autoclaw/kdream/state.json` — dashboard auto-refreshes on state changes
- Content Security Policy headers for webview security
- New settings:
  - `autoclaw.kdream.enableFileWatcher` — Toggle file system watcher
  - `autoclaw.kdream.notifyNewTodos` — Toggle notifications for new TODOs
  - `autoclaw.kdream.refreshInterval` — Dashboard refresh interval in seconds
  - `autoclaw.kdream.scanPatterns` — File patterns to scan for TODOs/FIXMEs
  - `autoclaw.kdream.notificationLevel` — Notification verbosity level
  - `autoclaw.kdream.autoInstallAdapters` — Auto-install adapters on activation
  - `autoclaw.kdream.adapters` — AI adapters to monitor for health status

### Fixed
- Replaced synchronous I/O operations with async `fs.promises` to prevent UI blocking
- Added Content Security Policy to webview to prevent XSS attacks
- Proper nonce generation for webview script and style loading
- Fixed error handling for missing state.json and MEMORY.md files

### Changed
- Build process now copies webview assets via `copy-webview.js` script
- Added `npm run copy-webview` to `vscode:prepublish` script
- Webview resources served from `out/webview/` directory

## [1.0.7] - 2026-04-01

### Added
- Universal adapter system — AutoClaw now auto-detects installed AI extensions and installs the correct skill files automatically on activation
- Adapters for 7 platforms:
  - **Claude Code** — `SKILL.md` files copied to `~/.claude/skills/`
  - **Cursor** — `.mdc` rule files for `.cursor/rules/`
  - **Kiro** — steering `.md` files for `.kiro/steering/`
  - **Windsurf** — rules `.md` files for `.windsurf/rules/`
  - **KiloCode** — custom modes YAML merged into `.kilocodemodes`
  - **Cline** — `.md` files copied to `.clinerules/`
  - **Continue** — `.prompt` files copied to `.continue/prompts/`
- New command: **AutoClaw: Install Adapters for Detected AI Extensions** — manually re-run adapter installation from the Command Palette

## [1.0.6] - 2026-04-01

### Fixed
- `chatSkills` paths now point to `SKILL.md` files directly instead of directories — skills now register correctly in GitHub Copilot Chat

## [1.0.5] - 2026-04-01

### Changed
- Rewrote all three SKILL.md files with full behavioral instructions for the AI — previously they were descriptions only, now they contain step-by-step execution logic

## [1.0.4] - 2026-04-01

### Added
- `icon` field added to `package.json` — lobster Z logo now appears on the Marketplace listing

## [1.0.3] - 2026-04-01

### Added
- Lobster Z icon (`icon.png`)

## [1.0.2] - 2026-04-01

### Added
- `README.md` with full user documentation for all three skills
- `LICENSE` (MIT)
- `repository` field in `package.json`

### Fixed
- Publisher corrected to `ZippyTechnologiesLLC`

## [1.0.1] - 2026-04-01

### Fixed
- Publisher updated from placeholder to `ZippyTechnologiesLLC`

## [1.0.0] - 2026-04-01

### Added
- Initial release
- Three chat skills: `kdream`, `autobuild`, `mateam`
- VS Code `chatSkills` contribution point for GitHub Copilot Chat
- Commands: `autoclaw.enableAll`, `autoclaw.startKdream`
- Activates on `onStartupFinished`
