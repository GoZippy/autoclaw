# Changelog

## [2.3.0] - 2026-05-09

This release ("Phase 1 schema and identity") extends the cross-agent registry and heartbeat schemas, adds an inbox state machine, ships a reconciliation sweep, and folds in two pre-flagged cleanups. Net: +1124/-16 LOC across 10 source files, +28 unit tests (224 total passing, was 196), zero regressions, zero new npm dependencies. Every schema change is additive and backwards compatible — existing `agents.json`, `registry.json`, sprint YAMLs, heartbeats, and message JSON files all continue to parse without modification.

### Added

- **`RegisteredAgent` v2 fields** — additive to `src/comms.ts`'s `RegisteredAgent` interface: `capabilities?: string[]`, `llms_available?: string[]`, `context_window?: number`, `machine_id?: string`, `machine_ip?: string`, `tools_supported?: string[]`, `trust_level?: 'untrusted' | 'low' | 'medium' | 'high'`, `cost_budget?: { daily_usd?; hourly_usd? }`, `max_parallel_tasks?: number`, `human_in_loop_required?: boolean`, `skills_loaded?: string[]`. Per `docs/specs/registered-agent-v2.md`.
- **`Heartbeat` v2 fields** — additive: `session_id?`, `token_budget_remaining?`, `queue_depth?`, `current_llm?`, `last_error?: { code?; message; timestamp }`, `network_latency_ms?`, `error_rate_1m?`. Per `docs/specs/heartbeat-v2.md`.
- **`overloaded` agent status** — new value in the `AgentStatus` union. Returned by `agentStatusFromHeartbeat()` when a heartbeat is fresh AND (`queue_depth >= 10` OR `error_rate_1m >= 0.5`). Constants `OVERLOAD_QUEUE_DEPTH` and `OVERLOAD_ERROR_RATE` exported from `src/comms.ts`. `stalled` continues to win over `overloaded` when both apply.
- **`redactErrorMessage()` helper** — exported from `src/comms.ts`. Truncates to 500 chars, strips ANSI escape sequences, replaces the user's home directory with `$HOME`, and redacts token-shaped strings (`acl_*`, `sk-*`, `ghp_*`) with `<redacted>`. Mandatory before persisting any `last_error.message` to disk.
- **Inbox state machine** — `<commsDir>/inboxes/<agent>/_state/<message-id>.json` files track `read_at`, `replied_at`, `archived_at`. New helpers in `src/comms.ts`: `readMessageState`, `markMessageRead`, `markMessageReplied`, `markMessageArchived`, and `getInboxSummary` (returns `{ total, unread, awaiting_response, archived }`). Backwards compatible — when `_state/` is empty, every message is "unread" and "awaiting_response" (if `requires_response`).
- **Session-level heartbeats** — the extension generates a `sessionId` (UUID) once on activation and stamps it into every heartbeat written by the heartbeat ticker. The panel can now distinguish multiple sessions of the same agent (e.g., two VS Code windows running Claude Code on the same workspace) instead of seeing them as one.
- **Sprint-N markdown generation** — new exported helpers in `src/orchestrate.ts`: `renderSprintMarkdown(plan: SprintPlan): string` and `writeSprintArtifacts(...)`. Output includes sprint number, status, dependencies-met flag, estimated days, per-assignment agent ID + resolved platform + task list + scope globs + branch name, plus a "GENERATED — edit sprint-N.yaml instead" header. Helpers ship with full test coverage; planner integration is deferred to v2.3.1.
- **Reconciliation sweep** — new `src/reconcile.ts` module exports `runReconcile(workspaceRoot): Promise<ReconcileReport>`. Reads `.kiro/specs/*/tasks.md`, all sprint YAMLs, and the last 1000 lines of `comms-log.jsonl`, then cross-references and lists drifts. Module is `vscode`-free so it's testable in plain Mocha. Wired into the extension as a 5-min ticker (configurable via new setting `autoclaw.orchestrate.reconcileIntervalSeconds`, default `300`, `0` to disable). Each tick writes `.autoclaw/orchestrator/reconcile-report.json` and posts a `system` message to `inboxes/shared/` if any mismatch is detected. Read-only — never auto-fixes.
- **Bridge port fallback** — `src/bridge.ts` now retries on the next 4 ports (9877, 9878, 9879, 9880) when the configured port is `EADDRINUSE`. The actual bound port is recorded in bridge state and surfaced via the `/health` endpoint.

### Fixed

- **`mergeFindings()` no longer mutates its input** — deep-clones the input findings via `structuredClone()` before merging. Previously acceptable in v2.2.0 because `evaluateConsensus()` did not reuse the votes after merging, but the mutation was a latent foot-gun. Test asserts caller's votes array is untouched after merge.

### Settings

| Setting | Default | What |
|---|---|---|
| `autoclaw.orchestrate.reconcileIntervalSeconds` | `300` | Reconciliation sweep tick frequency. `0` disables. |

### Deferred to v2.3.1

- **Wiring `renderSprintMarkdown` into the planner's `/orchestrate plan` flow.** Helpers ship with tests; AI-driven plan command not yet calling them. Held alongside the v2.2.1 SKILL.md follow-up.
- **Panel rendering for the new RegisteredAgent + Heartbeat fields** — schema is in place; webview panel reads the new fields when v2.4.0 ships the broader fabric panel work.

### Carried forward to a later release

- Token revocation list, claim tokens, subcontract message types (`subcontract_request/accept/deliver/ack`).

## [2.2.0] - 2026-05-09

This release ("Phase 0 activation") wires up cross-agent infrastructure that was implemented and tested in 2.0.3 / 2.1.0 but never reached the extension activation path. Net: +878/-11 LOC across 9 source files, +43 unit tests (196 total passing, was 153), zero regressions.

### Added
- **Bridge auto-start** — when at least one task manifest exists in `.autoclaw/orchestrator/manifests/`, the OpenClaw HTTP bridge auto-starts on `127.0.0.1:9876` (loopback only). New setting `autoclaw.bridge.autoStart` (default `true`); the existing `autoclaw.bridge.enabled` continues to work as an explicit override. The bridge is no longer invisible to users who never manually flipped a config key.
- **Consensus evaluate endpoint** — `POST /api/v1/consensus/{task_id}/evaluate` reads vote files from `consensus/active/`, runs `evaluateConsensus()`, broadcasts `consensus_result` to the shared inbox, and returns the verdict. Idempotent — does not move vote files (sweep is a Phase 1 concern). Wires the `evaluateConsensus()` engine that was tested but never invoked into both the bridge and the `/orchestrate review` command.
- **Heartbeat-aware sprint assignment** — `/orchestrate assign` now reads agent heartbeats before assigning. Slots whose mapped agent is `stalled` or `offline` for more than `autoclaw.orchestrate.heartbeatStallSeconds` (default `300`) are excluded; an empty assignment plus a `<sprint>-stalled.json` sidecar lands instead, so the skill prompt can decide how to recover. New setting `autoclaw.orchestrate.heartbeatStallSeconds`. New `excludedSlots` parameter on `planSprints` and `generatePlan`.
- **Resolved platform/inbox stamped into SprintAssignment** — `planSprints()` now invokes `resolveAgentId()` for each WA-N slot when an `AgentRegistry` is supplied and writes the resolved `platform` and `inbox` into the assignment YAML. Plans stay self-describing even after the registry drifts. Backwards compatible — both fields are optional.
- **mergeFindings invoked in consensus** — `evaluateConsensus()` now calls `mergeFindings()` when consensus is reached and exposes the deduplicated set as `ConsensusResult.merged_findings`. Severity is upgraded on agreement. Eliminates duplicate findings showing up multiple times in cross-agent reviews.
- **Defensive guard on `planSprints()`** — outer-while loop now breaks if no progress is made in a pass (previously could spin if every slot was excluded or scope conflicts blocked all candidates). Exposed and fixed during Phase 0 test development.
- **Unit test suites for bridge and comms** — new `src/test/bridge.test.ts` (token validate / message round-trip / heartbeat POST+GET / consensus vote POST+GET / random port within 9876–10876) and `src/test/comms.test.ts` (sendMessage→readInbox / shared inbox / comms-log JSONL / heartbeat write/read / registry / status inference). Locks in v2.1.x behavior so future refactors are safe. +43 tests; 196 passing total.
- **Manifest probe helper** — new `src/manifest-probe.ts` extracts the manifest-existence check from `extension.ts` so it stays unit-testable in Mocha (importing `vscode` would have broken plain-Mocha test runs). Documented as the only deviation from the Phase 0 implementation plan.

### Documentation
- New planning artifacts in `docs/`: `DISTRIBUTED_AGENT_FABRIC.md` (master synthesis with phased roadmap), `IDEAS_LOG.md` (append-only idea trail), `research/code-audit-cross-agent.md`, `research/distributed-orchestration-prior-art.md`, `research/knowledge-graph-stack.md`, `research/phase-0-implementation-plan.md`, `research/phase-0-execution-report.md`, `otherProjects.md`, `otherProjects-catalog.md`, `COORDINATION_IMPROVEMENTS.md`. Forward-looking specs at `docs/specs/`: `agent-card-schema.md`, `registered-agent-v2.md`, `heartbeat-v2.md`, `nats-topic-conventions.md`, `biscuit-token-attenuation.md`, `program-plane-registry.md`, `coordination-improvements-mapping.md`. Spec docs are flagged `[needs verification]` until live A2A/MCP/Biscuit specs are confirmed.
- New isolated prototype `packages/kg-daemon/` — Tier 1 knowledge-graph daemon (better-sqlite3 + sqlite-vec + FTS5 + edges table; embeddings via ZippyMesh fallback; vitest smoke test). Standalone, not yet wired into the extension; uninstalled until promoted in a future release.

### Adapters
- All 29 adapter files regenerated from `skills/*/SKILL.md` to clear pre-existing line-ending and content drift. `npm run adapters:check` now clean.

### Deferred to v2.2.1
- 1-line `skills/orchestrate/SKILL.md` mention of the new `/api/v1/consensus/{tid}/evaluate` endpoint and stalled-slot sidecar behavior. The endpoint is for remote-agent use and doesn't change the local AI flow, so deferring keeps Phase 0 minimal.
- Bridge port fallback `9877..9880` if `9876` is taken.
- `mergeFindings()` cloning its input rather than mutating in place — accepted for v2.2.0 because `evaluateConsensus()` does not reuse the votes after merging.

## [2.1.1 – 2.1.3] - 2026-05-03 — interim cleanup

These three patch releases bumped `package.json` without explicit CHANGELOG sections. Combined retroactive entry (2.1.1 was skipped — `package.json` jumped 2.1.0 → 2.1.2 directly).

### Changed
- Removed the bundled IDE agent rule directories (`.kilocodemodes`, `.clinerules/`, `.kiro/`, etc.) from version control on the public repo so consumer installs aren't polluted by maintainer-side IDE state.

### Fixed
- Stripped UTF-8 BOM from all JSON reads in `src/comms.ts` (and downstream) so heartbeat / registry / message / consensus-vote files written by editors that prepend BOMs (some Windows editors) are parsed correctly.
- Scrubbed IDE workspace state and developer artifacts from the public repo.

### Internal
- Added an integration test runner script alongside the existing unit-test harness, so `npm test` and `npm run test:unit` are runnable independently and integration suites can be added without booting Electron.

Tags retroactively created on 2026-05-09: `v2.0.3`, `v2.1.0`, `v2.1.2`, `v2.1.3` (no `v2.1.1` — that version number was skipped). Going forward every release commit gets its own tag.

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
