# Changelog

## [3.1.4] - 2026-05-29

Panel UX completion over 3.1.3. Ships the review-request decision UI (the "validate each other's work" feature) and the final visual-cleanup pass, closing the panel-ux sprint.

### Added

- **Review-request decision UI** (`src/webview-render.ts`, `src/webview/kdream-dashboard.{css,js}`). When a `review_request` lands in your "Awaiting You" list, the row now renders an inline decision surface instead of a free-text reply box:
  - **Vote buttons** — approve / request_changes / reject, acted on inline.
  - **Live consensus tally** — approvals/changes/rejects, votes received vs required, the active rule (majority for tasks, unanimous for security findings), your own existing vote if cast, decided state, and any deadline.
  - **Source-work drill-in** (`ReviewContext`) — resolves the request's `source_task_complete_id` against the shared inbox so you see *what* you are approving: author, task, sprint, summary, branch, and files touched. Falls back gracefully when the source `task_complete` can't be located.
  - `payloadExcerpt` now describes auto-promoted reviews instead of dumping raw JSON.

### Changed

- **Panel visual cleanup** (`src/webview/kdream-dashboard.css`) — vertical rhythm normalized to a 4-6-8px scale (top-level sections on 8px, nested cards on 6px); nested-card borders lightened to 50-60% opacity via `color-mix` so the section frame stays dominant; whole agent-card hover state (border lifts to `focusBorder`) with a 0.12s transition to avoid flicker on list refresh.

### Tests

- 55 webview-rendering tests pass (6 new for the review-decision UI).

## [3.1.3] - 2026-05-29

Daemon stability patch over 3.1.2. Fixes three live bugs in the cross-agent heartbeat daemon and the orchestrator-loop work-discovery dispatcher. The bugs were visible in production: heartbeat entries on the Fleet panel showed garbage like `current_task: ".env"` (whichever file VS Code had open), every detected agent was stamped with the host's `session_id` so peer sessions could not be told apart, and the `inboxes/shared/` directory filled up with `task_claim-next-<agent>` placeholders at ~4/minute. The `autobuild heartbeat-drift-check` workflow that ships alongside this release surfaces these conditions automatically if they recur.

### Fixed

- **Heartbeat `current_task` no longer overwritten with host UI state** (`src/extension.ts`). The previous daemon stamped `vscode.window.activeTextEditor?.document.fileName` onto every detected agent's `current_task`, overwriting the agent-owned value with whichever file the user had open in the IDE (e.g. `.env`, `.autoclaw/docs/foo.md`, AikidoSecurity output channel paths). `current_task` is now agent-owned: the daemon preserves whatever the agent wrote and only updates `timestamp` and `status` on the heartbeat tick.

- **`session_id` only stamped on the HOST agent's heartbeat** (`src/extension.ts`, `src/comms.ts`). The previous daemon copied the host extension's `sessionId` into every detected agent's heartbeat, so two concurrent sessions of different agents (e.g. claude-code and kilocode) showed the same `session_id` — and the orchestrator could not distinguish them. New pure helper `detectAutoclawHostAgent(appName)` (in `comms.ts`) identifies the host agent from `vscode.env.appName`; peer agents preserve their own `session_id`.

- **`orchestratorLoop.discoverWork` no longer re-broadcasts `next-<agent>` placeholders every tick** (`src/orchestratorLoop.ts`). New `readClaimedAgentIds()` skips agents that already own an active (non-expired) claim under `comms/claims/`; new `readRecentNextDispatches()` skips agents that received a `next-<agent>` placeholder in the last 5 minutes. Result: the placeholder fires at most once per agent per cooldown window instead of once per 30-second tick.

### Added

- **AutoBuild stability workflows** (`.autoclaw/autobuild/workflows/`, `.autoclaw/autobuild/scripts/`) — five scheduled jobs that surface and self-heal recurring drift conditions:
  - `heartbeat-drift-check` (every 15 min) flags daemon heartbeat bugs by detecting `current_task` values that look like file paths and `session_id` collisions across agents; writes a `finding_report` to `inboxes/shared/` when drift is seen.
  - `inbox-prune` (every 30 min) moves `task_claim-next-*` placeholders older than 10 min from `inboxes/shared/` to `processed/`. Real `task_claim-<task-id>` messages are not touched.
  - `state-json-drift` (hourly) compares `.autoclaw/orchestrator/state.json` against the last 24h of git history and surfaces tasks that shipped via commit but still show `pending`/`review` status.
  - `nightly-publish-dryrun` (daily 3am) dry-runs both Marketplace and OpenVSX publishes so version-skew and missing-publisher bugs surface before the actual release window.
  - `ux-1-close-check` (one-shot via `/autobuild run`) runs `tsc --noEmit` + the webview-rendering and orchestratorLoop test files as a fast pre-commit gate.

### Tests

- 53 orchestratorLoop tests pass (13 new), covering claim-aware dedup, cooldown-window dedup, and per-host detection for all five recognized IDE variants.

## [3.1.1] - 2026-05-25

Hot-patch over 3.1.0. The 3.1.0 VSIX inadvertently shipped JSDoc header
comments in `out/llm/oracle.js` and `out/llm/index.js` that referenced
an internal-only host codename. No credentials, customer data, or tokens
were exposed — but the comments named internal infrastructure that
should never have left the repo. 3.1.1 removes those references from
source, regenerates the compiled output, and rewrites local git history
so the strings are not present in any commit reachable from the pushed
branch. Functionally identical to 3.1.0; users on 3.1.0 should update.

### Fixed

- Replace internal-host references in `src/llm/oracle.ts`,
  `src/llm/index.ts`, and `src/llm/zippymesh.ts` JSDoc with neutral
  language ("upstream model-oracle", "ZMLR project") so the compiled
  `out/llm/*.js` no longer carries internal infra names.
- Sanitize internal `ssh://` URLs and local-only filesystem paths in
  `docs/rfc/llm-provider-abstraction.md`, `docs/specs/llm-provider-s1/spec.md`,
  `docs/specs/llm-provider-s2-zmlr-mcp-route/spec.md`, and
  `docs/V3_1_ROADMAP.md` (none of which ship in the VSIX, but were
  about to be pushed to GitHub).

## [3.1.2] - 2026-05-27

This release ("IDE-aware port allocation + cross-IDE agent orchestration registry") solves the `EADDRINUSE` crash that occurred when running AutoClaw simultaneously in multiple IDEs (e.g. VS Code + Kiro on the same workspace). Net: +327 LOC across 2 new files + 3 modified files, zero new dependencies.

### Added

- **IDE-aware port allocation** (`src/ide-ports.ts`) -- Each recognized IDE gets a dedicated non-overlapping 5-port block so bridge and KG daemon ports never collide across IDEs:

  | IDE         | Bridge ports  | KG ports      |
  |-------------|---------------|---------------|
  | VS Code     | 9876-9880     | 9877-9881     |
  | Cursor      | 10876-10880   | 10877-10881   |
  | Kiro        | 11876-11880   | 11877-11881   |
  | Windsurf    | 12876-12880   | 12877-12881   |
  | Antigravity | 13876-13880   | 13877-13881   |
  | Other       | 14876-14880   | 14877-14881   |

  Within each IDE block, a SHA-1 hash of the workspace path produces a deterministic salt (0-4) so different projects get different starting ports. The allocator checks both a machine-wide port registry AND live port availability before assigning.

- **Machine-wide port registry** (`~/.autoclaw/.port-registry.json`) -- Tracks which (IDE, workspace, PID) owns which ports. Dead PIDs are garbage-collected on load. Ports are released on bridge stop or extension deactivation.

- **Cross-IDE agent orchestration registry** (`src/workspace-registry.ts`, `~/.autoclaw/.agent-registry.json`) -- Each IDE instance registers its bridge endpoint (URL, PID, capabilities, status) on bridge start. Other agents (Codex, Claude Code, OpenClaw, Hermes, etc.) can query `getAvailableWorkers()` to discover all live AutoClaw bridge endpoints on the machine. Stale entries auto-expire after 5 minutes.

- **Centralized IDE detection** (`detectIde()`) -- Single source of truth for IDE identification from `vscode.env.appName`, replacing the previous scattered regex checks. Used by `activeHostAgentId()`, port allocation, and adapter installation.

- **Bridge port block constraint** (`BridgeConfig.portBlockBase`) -- Bridge fallback probing now stays within the IDE's assigned port block instead of potentially leaking into another IDE's range.

### Changed

- **`autoclaw.bridge.port` default: `9876` -> `0`** -- A value of 0 (default) triggers automatic IDE- and workspace-aware port allocation. Users can still set an explicit port to override.
- **`autoclaw.kg.port` default: `9877` -> `0`** -- Same auto-allocation behavior for the KG daemon.
- **Bridge auto-start** now calls `allocatePorts()` before `startBridge()`, ensuring the allocated port is conflict-free across all running IDE instances.
- **Bridge stop** now calls `releasePorts()` and `unregisterWorker()` to clean up registries.
- **Extension deactivation** now unregisters the worker and releases ports.

### Settings

| Setting | Default | What |
|---|---|---|
| `autoclaw.bridge.port` | `0` | Bridge port. 0 = auto-allocate per IDE/workspace. |
| `autoclaw.kg.port` | `0` | KG daemon port. 0 = auto-allocate per IDE/workspace. |
| `autoclaw.workspaceRegistry.enabled` | `true` | Enable cross-IDE agent registry at `~/.autoclaw/.agent-registry.json`. |

### Fixed

- **`EADDRINUSE` crash when opening the same workspace in multiple IDEs** -- Root cause: all IDE instances tried to bind to port 9876. Fixed by IDE-specific port blocks with zero overlap.

## [3.1.0] - 2026-05-24

This release ("v3.1.0 — hands-off peer review + the agendaboard") closes
the loop the DRK-style "Claude said X, do you concur?" workflow exposed:
agents no longer need a human to broker `task_complete → review_request →
consensus` between them, and a single live board surfaces what's
claimable, in flight, awaiting review, or stuck. Also bundles the v3.1
panel UI work (status-dot legend, section search/filter/sort) and the
three canonical agent-coordination prompts. Net: +1100 LOC across 8
new/changed files, +34 tests (742 total passing).

### Added

- **Auto peer-review on `task_complete`** (`src/orchestrator/peerReview.ts`,
  `peerReviewWatcher.ts`) — the orchestrator loop now scans `shared/` for
  every `task_complete`, picks eligible peers (filters author, halted,
  offline, stale-heartbeat; caps at 3; deterministic sort), emits a
  per-peer `review_request`, and opens a `consensus/active/<task>.json`
  vote stub. Idempotent via an atomic `consensus/_promoted/<msg-id>.json`
  ledger (`wx` create): a second tick — or a second orchestrator process
  — never double-fires the same review. When no peer is live the ledger
  is released so a future tick retries. Reduces the manual copy-paste
  consensus dance to zero.
- **Agendaboard** (`src/orchestrator/board.ts`, `boardWriter.ts`) — each
  tick the loop writes `.autoclaw/orchestrator/board.json` (machine
  view) + `board.md` (human view) with four sections: **Claimable**
  (open + dependency-satisfied + unclaimed), **In flight** (active
  claim + owner health), **Awaiting review** (consensus stub + vote
  tally), **Stuck** (claim expired, owner offline, review overdue, no
  eligible reviewers). New agents read `board.json` first to pick the
  highest-priority unclaimed item; humans read `board.md` in any editor.
- **Agendaboard panel section** (`media/panel/fleet.html/js/css`,
  `src/panel/fleetPanel.ts`) — the Fleet view now renders the same four
  buckets at the top of the panel with a `live / fleet-size` badge.
  Auto-refreshes on the existing 5-second poll.
- **Status-dot legend** (`renderStatusLegend()` in `src/webview-render.ts`)
  — the `(?)` chip in the Agents section header opens a popover
  explaining every status colour (active / idle / overloaded / stalled
  / offline / detected) in plain English.
- **Section search / filter / sort** (`src/webview/section-search.{css,js}`,
  wiring in `src/extension.ts` + `kdream-dashboard.js`) — sections with
  >5 items get a search toggle, sort dropdown (default / newest / A–Z /
  active-first), filter chips per section (agents: active/idle/stalled;
  messages: assign/review/complete/finding; tasks: pending/done), and
  per-section filter state persisted to `.autoclaw/orchestrator/filters/`
  via Memento-style round-trip messages.
- **Three canonical starter prompts** for coordinating multi-agent builds
  ([`skills/orchestrate/templates/starter/`](skills/orchestrate/templates/starter/)) —
  `bootstrap.md` (one-time `/orchestrate init && /orchestrate plan`),
  `coordinator.md` (one window per fleet, runs review/merge/revive, never
  claims tasks), and `worker.md` (host-agnostic `/loop`-style cycle for
  any agent that checks in for work). Replaces the older "paste a giant
  blob with `.clinerules/` paths" pattern that mixed bootstrap into the
  loop body, hardcoded a single host's rules path, and shipped without a
  HALT clause. Per-project overrides go in
  `.autoclaw/orchestrator/templates/starter/`.
- **`docs/AGENT_WORKFLOW.md`** — the user-facing guide that wraps the
  three templates: which prompt for which role, when to use each, why
  the three-template split fixes the failure modes of the single-blob
  approach, and a troubleshooting section for the common stuck states
  (duplicate claims, scope violations, stale plan).
- **Starter ↔ keepalive cross-link** in
  [`templates/keepalive/README.md`](.autoclaw/orchestrator/templates/keepalive/README.md) —
  clarifies that starter templates seed first check-ins (user pastes)
  while keepalive templates revive known stalled sessions (rendered by
  `/orchestrate revive`).

### Why

Field reports showed users defaulting to a long, manually-assembled
worker prompt that worked worse than the terse `/loop orchestrate all
agents — … Run forever.` coordinator prompt. Root causes: bootstrap
steps (`init`, `plan`) re-running every cycle; host-specific rules paths
breaking portability across Claude Code / Kilo / Cursor / Kiro; missing
HALT conditions causing infinite spin after all sprints merged. The
three-template split makes the right shape the path of least
resistance.

## [3.0.0] - 2026-05-17

This release ("v3.0.0 — Cross-pollination harvest: criticality tiers, multi-strategy recall, fleet metrics") completes the `docs/DISTRIBUTED_AGENT_FABRIC.md` §4 cross-pollination roadmap. All Phase 3 and Phase 4 items from the spec are now shipped. Net: +420 LOC across 5 new/changed files, +19 tests (424 total passing).

### Added

- **Task criticality tiers** (`src/orchestrate.ts`) — `TaskCriticality = 1 | 2 | 3` on `ManifestTask` maps to consensus thresholds: 1=CRITICAL (unanimous, threshold=1.0), 2=MAJOR (2/3 majority, default), 3=ROUTINE (simple majority, threshold=0.501). New `consensusConfigForTask(criticality, base?)` helper selects the right `ConsensusConfig` without changing `evaluateConsensus()` API. Inspired by clawbridge-a2a NCR/IV criticality tiers. +8 tests.
- **Hindsight-style multi-strategy parallel recall** (`packages/kg-daemon/`) — `SearchOpts.strategy` field (`"multi" | "vec" | "fts"`, default `"multi"`) controls retrieval. `"multi"` runs vector + FTS arms in parallel and optionally a graph traversal arm (`graph_seed`, `graph_edge_kinds`, `graph_depth` opts). Results are merged by deduplication with arm-priority ordering (vec wins ties). `GET /api/v1/thoughts/search` exposes all new params as query strings. Inspired by Hindsight Retain/Recall/Reflect parallel recall architecture.
- **Fleet metrics** (`src/metrics.ts`) — `recordTaskDuration(taskId, agentId, durationMs)` accumulates task latency samples in a rolling 1-hour window (configurable). `getFleetMetrics()` returns p50/p95/p99/min/max/mean in ms, throughput in tasks/hour, per-agent breakdowns, and window timestamps. `autoclaw.fleet.metrics` command shows a modal summary in VS Code. `resetMetrics()` called on deactivation. Inspired by zippy-mcp-kit p50/p95/p99 instrumentation. +11 tests.

### Changed

- **`evaluateConsensus()` is unchanged** — `consensusConfigForTask()` is the public API for criticality-aware threshold selection; existing callers using `DEFAULT_CONSENSUS_CONFIG` continue to work.

## [2.9.0] - 2026-05-17

This release ("Phase 4 SPIFFE/SVID workload identity") completes the final Phase 4 item from `docs/DISTRIBUTED_AGENT_FABRIC.md`. Net: +290 LOC across 3 new/changed files, +17 tests (405 total passing).

### Added

- **SPIFFE/SVID workload identity layer** (`src/svid.ts`) — `mintSvid(agentId, opts)` produces a JWT-SVID (SPIFFE JWT-SVID spec) with a 5-minute TTL by default. The JWT uses HMAC-SHA256 signing (mock path, always available via `AUTOCLAW_SVID_SECRET` or `AUTOCLAW_BISCUIT_SECRET`); when `AUTOCLAW_SPIRE_SOCKET` points to a running SPIRE workload agent, real SVIDs are fetched via the SPIFFE Workload API gRPC endpoint. `verifySvid(raw, opts)` checks signature, expiry (with configurable clock-skew tolerance), and audience. `getCurrentSvid(agentId)` caches the current SVID and auto-refreshes every 4 minutes before the 5-minute TTL expires. `stopSvidRefresh()` clears the timer on extension deactivation. `isSpireAvailable()` probes for the optional `@spiffehq/spiffe-workload-api` dep.
- **SVID → bridge integration** — `validateRawToken()` now tries JWT-SVID verification first (detected by 3-part JWT shape), then Biscuit, then bearer DB. This gives fleet agents a self-contained identity credential with short-lived tokens and no pre-registration required.
- **SVID tests** (`src/test/svid.test.ts`) — 14 tests: mint, TTL defaults and custom, verify (fresh/tampered header/tampered sig/expired/wrong audience/malformed), unsafe decode, SPIRE unavailable, getCurrentSvid caching, stopSvidRefresh.
- **Bridge SVID tests** (`src/test/bridge.test.ts`) — 3 new tests: accept valid SVID, reject expired, fall through from SVID to Biscuit when token format doesn't match.

## [2.8.0] - 2026-05-17

This release ("Phase 4 Hatchet durable workflow adapter + kg-daemon bi-temporal validity") delivers the final two Phase 4 items from `docs/DISTRIBUTED_AGENT_FABRIC.md`. Net: +310 LOC across 2 new/changed files, +12 tests (388 total passing).

### Added

- **Hatchet durable workflow adapter** (`src/hatchet.ts`) — `registerWorkflow(def)` registers a DAG-structured workflow; `triggerWorkflow(name, input)` executes it asynchronously and returns a `runId` immediately. `getWorkflowStatus(runId)` and `listWorkflowRuns(name?)` provide observability. Steps declare `depends_on[]` edges for topological execution; each step gets a `WorkflowContext` with prior `stepResults`. Per-step `timeout_ms` enforcement prevents hung handlers. `isHatchetAvailable()` dynamically probes for `@hatchet-dev/typescript-sdk` and transparently upgrades the `triggerWorkflow()` path to the real Hatchet runtime when found. `registerAutoclawPipeline()` registers the canonical plan→assign→review→merge pipeline as a built-in workflow. In-memory engine is always available as a fallback for local development without Hatchet credentials.
- **Hatchet tests** (`src/test/hatchet.test.ts`) — 12 tests: registerWorkflow + trigger, unknown workflow rejection, succeeded status with stepResults, DAG chain with ctx.stepResults, failing step transitions to failed, step timeout, null status for unknown runId, listWorkflowRuns with and without filter, started_at/finished_at timestamps, input preservation, full 4-step pipeline.
- **kg-daemon bi-temporal validity** (`packages/kg-daemon/`) — `thoughts` table gains `valid_from` and `valid_to` columns (additive `ALTER TABLE` migration — safe against existing databases). `POST /api/v1/thoughts` accepts `valid_from` and `valid_to` fields. `GET /api/v1/thoughts/search` accepts `?at=<ISO>` for time-travel queries returning only thoughts that were valid at that instant. `applyPostFilters()` in `kg.ts` enforces the bi-temporal window: `valid_from ≤ at < valid_to`. Agents can now query "what did the fleet believe at sprint N" without needing a snapshot.

## [2.7.0] - 2026-05-17

This release ("Phase 4 Biscuit capability tokens — mint, attenuate, verify, bridge integration") delivers the Biscuit token layer from `docs/specs/biscuit-token-attenuation.md`. Net: +360 LOC across 3 files, +14 tests (376 total passing).

### Added

- **Biscuit capability token layer** (`src/biscuit.ts`) — `mintBiscuitToken(agentId, capabilities, ttl)` creates an authority block with Ed25519 (WASM) or HMAC-SHA256 (mock). `attenuateBiscuitToken(token, restriction)` appends a restriction block narrowing capabilities to their intersection and expiry to the minimum — preventing privilege escalation. `verifyBiscuitToken(raw, required, revokedIds)` checks MAC, expiry, revocation, and required capabilities; returns `effective_capabilities`. `decodeBiscuitTokenUnsafe(raw)` for display-only decoding.
- **Biscuit → bridge integration** — `validateRawToken()` (and `validateToken()`) now tries Biscuit verification before falling back to the UUID bearer DB. Biscuit tokens minted by any AutoClaw agent are accepted by the bridge without pre-registration. When `@biscuit-auth/biscuit-wasm` is installed as an optional dep, real Ed25519 tokens are used; without it the HMAC-SHA256 mock handles all local development.
- **Biscuit tests** (`src/test/biscuit.test.ts`) — 11 tests: mint, verify, reject tampered/expired/revoked, attenuation privilege-escalation prevention, expiry narrowing.
- **Bridge Biscuit tests** (`src/test/bridge.test.ts`) — 3 new tests: accept valid Biscuit token, reject expired, fall through to bearer DB.

## [2.6.0] - 2026-05-17

This release ("Phase 3 remaining + Phase 4 foundations — capability query/offer handler, program-plane registry, kg-daemon path fix, panel v2 fields") completes Phase 3's distributed capability resolution cycle and delivers the Phase 4 cross-repo program-plane registry. Net: +700 LOC across 6 new/changed files, +24 tests (362 total passing).

### Added

- **Capability query/offer handler** (`src/orchestrate.ts`) — `planSprints()` now populates `sprint.capability_pending[]` with `CapabilityPendingTask` entries (query_id, required_capabilities, sprint, task_id) when a task declares `required_capabilities` that no local agent satisfies. `broadcastCapabilityQueries(commsDir, fromAgent, pending)` fans out `capability_query` messages to the shared inbox. `resolveCapabilityOffers(commsDir, agentId, pending)` reads `capability_offer` responses and picks the best agent by recall × inverse-cost. `runCapabilityResolutionSweep()` in `extension.ts` calls both functions from the reconcile ticker. Sprint YAML artifacts now include a JSON sidecar when `capability_pending` is non-empty.
- **Program-plane registry** (`src/program-plane.ts`) — `createProgram()`, `joinProgram()`, `leaveProgram()`, `listPrograms()`, `touchParticipant()`, `fanInCommsLog()`. Programs stored at `~/.autoclaw/programs/<program_id>/registry.json`; per-workspace backref at `<repo>/.autoclaw/program-link.json`. Comms-log fan-in (`fanInCommsLog`) tails each participant's JSONL and merges into `<program_root>/comms-log.jsonl` using crash-safe byte offsets. Reconcile tick calls `touchParticipant` + `fanInCommsLog` every interval.
- **`autoclaw.program.create/join/leave` commands** — Quick Pick UI for creating, joining, and leaving cross-repo programs. Registered in `package.json` and wired to Command Palette.
- **Program-plane tests** (`src/test/program-plane.test.ts`) — 14 tests covering full lifecycle (create, join, leave, listPrograms, touchParticipant, fanInCommsLog idempotency).
- **Capability query/offer tests** (`src/test/orchestrate.test.ts`) — 5 tests (broadcastCapabilityQueries round-trip, resolveCapabilityOffers best-offer selection, no-offers case, wrong-query-id filtering).
- **Webview panel v2 fields** — `renderAgentCard()` now renders `machine_id`, `machine_ip`, `max_parallel_tasks`, `human_in_loop_required`, `tools_supported` (chips), and `skills_loaded` (chips) in the expanded body. +5 tests.

### Fixed

- **kg-daemon default DB path** — changed from `./kg-prototype.db` (relative to process CWD, wrong on Windows when spawned from the extension) to `~/.autoclaw/kg/kg.db`; directory created automatically. Override via `KG_DB_PATH` env var as before.
- **Capability router recall semantics** — `resolveCapabilityOffers()` uses recall (intersection / required_size) rather than Jaccard, so agents with a superset of required capabilities aren't penalized for having additional capabilities.

## [2.5.0] - 2026-05-16

This release ("Phase 2B/C + Phase 3 router — FabricBus, A2A v0.2.5 Agent Card, capability-aware routing, and expandable panel UI") delivers the four wave-4 parallel workstreams: the cross-transport FabricBus abstraction (fs/ws/NATS drivers), canonical A2A v0.2.5 Agent Card with `capabilities.extensions[]` mirroring, the capability-aware sprint router with Jaccard-score-based agent selection, and a fully rebuilt webview panel with expandable agent cards, push-channel health badges, and KG status indicators. Net: +1435 LOC across 7 new/changed files, +30 unit tests (339 total passing). Also includes hardened comms filename uniqueness fix (timestamp collision prevented by appending message ID suffix) and an environment-resilient ZippyMesh health test.

### Added

- **FabricBus abstraction** (`src/fabric.ts`) — unified pub/sub primitive with three drivers: `fs` (passthrough to filesystem mailbox, zero new deps), `ws` (wraps `BridgeEventBus` SSE/WS fanout from v2.4.0), and `nats` (dynamic `import('nats')` with graceful fallback when the optional dep is absent). Configured via `autoclaw.fabric.busDriver` and `autoclaw.fabric.natsUrl` settings. Lifecycle managed by extension activation/deactivation.
- **A2A v0.2.5 Agent Card** (`src/agent-card.ts`) — `buildAgentCard()` produces a canonical Agent Card served at `/.well-known/agent.json`. Uses `capabilities.extensions[]` URI-keyed array (extension URI: `https://github.com/GoZippy/autoclaw/extensions/v1`) to mirror all AutoClaw-specific metadata (`x-autoclaw` fields) without violating A2A spec constraints. `autoclaw.agentCard.show` command displays it in the panel.
- **Capability-aware sprint router** — `scoreAgent(agent, task)` in `src/orchestrate.ts` computes `jaccard_capability_match × trust_weight × idle_factor / estimated_cost`. Called by `resolveAgentId()` during `planSprints()`; manifests can declare `required_capabilities: [...]` on tasks to trigger capability-matched routing. Backwards compatible — tasks without `required_capabilities` route exactly as before.
- **Expandable agent card panel UI** (`src/webview-render.ts`, `src/webview/kdream-dashboard.css/js`) — rebuilt webview with expandable agent cards (click to expand/collapse), capability chips, trust badges, queue-depth bar, "Awaiting You" section aggregating messages that need a human response, push-channel health badge (SSE/WS connected/disconnected), and KG daemon health badge (enabled/port/last-seen).
- **`autoclaw.agentCard.show` command** — opens a webview panel rendering the local agent card JSON.
- **FabricBus tests** (`src/test/fabric.test.ts`) — 9 tests covering fs/ws/nats driver selection, subscribe/unsubscribe round-trips, and close idempotency.
- **Agent Card tests** (`src/test/agent-card.test.ts`) — 8 tests covering schema validation and `capabilities.extensions[]` mirroring correctness.
- **Webview rendering tests** (`src/test/webview-rendering.test.ts`) — 30 tests covering HTML generation for all panel components (expandable cards, chips, badges, queue bar, Awaiting You section).

### Fixed

- **Comms message filename collision** — `messageFilename()` now appends the last 8 chars of `msg.id` to the filename, preventing messages sent from the same agent with the same type within the same millisecond from overwriting each other. Previously `getInboxSummary()` under-counted when rapid-fire tests sent 3+ messages in quick succession.
- **ZippyMesh health test resilience** — the default-URL ZippyMesh health check test no longer hard-asserts `'warning'` (which fails when something is listening on the default port in the test environment). It now accepts any of `healthy | warning | error` as a valid outcome; the unreachable-port test (`localhost:1`) still asserts `'warning'` exactly.
- **Adapter drift** — regenerated 8 adapter files to include `required_capabilities` field documentation for manifests.

## [2.4.0] - 2026-05-10

This release ("Phase 2 part A — push channels and the kg-daemon companion") wires the OpenClaw HTTP bridge with bidirectional push (Server-Sent Events + WebSockets) and turns `packages/kg-daemon/` from an isolated prototype into an opt-in managed companion process. Net: +1650/-29 LOC across 16 files (4 new modules: `src/bridge-ws.ts`, `src/kg.ts`, `src/test/kg-lifecycle.test.ts`, `src/test/bridge.test.ts` extended), +33 unit tests (259 total passing, was 226), one new runtime dependency (`ws` ^8.20.0). All push paths are backwards compatible — existing polling clients continue to work unchanged.

### Added

- **Bridge SSE push channel** — `GET /api/v1/messages/stream` now opens a long-lived `text/event-stream` connection. Streams `event: message` (data = the message JSON) when a new message arrives, `event: heartbeat` when any agent posts one (filterable via `?agent=` query param), and `event: consensus` when a `consensus_result` is broadcast. Sends a `: keepalive` comment line every 25 s so reverse proxies don't drop the connection. Authenticated via existing `Authorization: Bearer <token>` header or `?token=` query param fallback for header-less clients (browser `EventSource`, etc).
- **Bridge WebSocket push channel** — same URL `GET /api/v1/messages/stream` with `Upgrade: websocket` is routed to a WS handler in the new `src/bridge-ws.ts` module. WS clients receive one JSON object per frame: `{ "type": "message" | "heartbeat" | "consensus", "data": { ... } }`. Authentication via `Sec-WebSocket-Protocol: bearer.<token>` header (subprotocol scheme) with `?token=` query param fallback. The `ws` package is loaded via dynamic `import()` so SSE keeps working if `ws` ever fails to load.
- **`BridgeEventBus`** — new in-memory pub/sub primitive in `src/bridge.ts`. Existing handler paths (`POST /messages`, `POST /heartbeat`, the new `/consensus/{tid}/evaluate`) call `publish()` after writing to disk; SSE and WS subscribers fan-out from there. Self-cleans subscribers on disconnect. Unit-tested directly.
- **kg-daemon as a managed companion** — new `src/kg.ts` module ports the bridge's lifecycle pattern (`spawn` / `stop` / `health`) to child processes. On extension activation, if `autoclaw.kg.enabled === true` AND `packages/kg-daemon/node_modules/` is present AND `packages/kg-daemon/dist/server.js` is present, the daemon is spawned via `child_process.spawn(process.execPath, ...)` (uses Electron-host Node's ABI for `better-sqlite3` consistency on Windows). Wires stdout/stderr to a new `AutoClaw KG` OutputChannel. On `deactivate()`, sends SIGTERM and escalates to SIGKILL after 5 seconds.
- **Doctor `## KG Daemon` section** — reports enabled flag, configured port, `node_modules/` presence, `dist/server.js` presence, child PID if running, last `/api/v1/health` response. Surfaced via `DoctorVscodeShim.kg` so it stays unit-testable. Doctor command performs an inline `fetchKgHealth` when a child PID is alive.
- **`/api/v1/health` push-channel counts** — bridge health endpoint now reports `{ port, sse_clients, ws_clients }` so operators can verify push channels are live without instrumenting Prometheus.

### Settings

| Setting | Default | What |
|---|---|---|
| `autoclaw.kg.enabled` | `false` | Opt-in. Spawn `packages/kg-daemon/dist/server.js` as a managed companion when the extension activates. |
| `autoclaw.kg.port` | `9877` | Port for the kg-daemon to listen on (loopback only). |
| `autoclaw.kg.dbPath` | `""` | Override the daemon's default DB path. Empty = daemon picks `~/.autoclaw/kg/<workspace-name>.db`. |

### Commands

- `autoclaw.kg.openOutput` — focus the `AutoClaw KG` Output Channel.
- `autoclaw.kg.healthCheck` — fetch `GET http://127.0.0.1:<port>/api/v1/health` and surface result in a notification.

### Documentation

- **Spec verification pass** — `docs/specs/agent-card-schema.md`, `biscuit-token-attenuation.md`, `nats-topic-conventions.md`, and `registered-agent-v2.md` updated against canonical sources (A2A v0.2.5, NATS docs, Biscuit RFC, MCP). 5 of 6 `[needs verification]` flags resolved. Discrepancies found and corrected: A2A well-known path is `/.well-known/agent.json` (not `/agent-card.json`); `schema_version` alias removed (not an A2A field name); A2A extension namespace is `capabilities.extensions[]` URI-keyed (not arbitrary `x-` prefixes); NATS specifies no per-token char limit (the 32-char cap is an internal best-effort policy). Each spec now ends with a `## Sources` appendix citing the URLs verified on 2026-05-10. The remaining `[still needs verification]` flag is the AIP IBCT benchmark numbers (arxiv.org WebFetch denied from the agent sandbox).

### Dependencies

- New runtime dependency: `ws` ^8.20.0 (MIT, ~80 KB, zero transitive deps). Required for the WebSocket push channel; loaded lazily so SSE works even if `ws` fails to load.
- New dev dependency: `@types/ws` ^8.18.1.

### Deferred to v2.4.x

- **NATS opt-in bus driver** (`autoclaw.fabric.busDriver`) — Phase 2 part B. Spec exists in `docs/specs/nats-topic-conventions.md`; opt-in driver implementation lands in v2.4.x.
- **Panel UI for new RegisteredAgent + Heartbeat fields** (capability chips, llms_available, queue_depth, current_llm, last_error) — Phase 2 part C. Schema is in place since v2.3.0; webview rendering refresh batches with the broader fabric panel rebuild.
- **Bridge auto-restart on `EADDRINUSE` for kg-daemon** — bridge has port-fallback (9876→9880); kg-daemon could mirror the pattern. Mid-session port changes still need a window reload.

## [2.3.1] - 2026-05-09

Patch release clearing the small follow-up queue from v2.2.0 / v2.3.0 and hardening the publish wrapper scripts. Net: +263/-18 LOC across 13 files, +2 unit tests (226 total passing, was 224), zero regressions, zero new dependencies.

### Added

- **Sprint-N markdown is now written by the planner** — `src/orchestrate.ts` gains an exported `writePlanArtifacts(sprintsDir, plan, projectName)` helper that drives `writeSprintArtifacts()` for every sprint and emits `plan-summary.yaml` alongside. After v2.3.0 shipped the helpers, this commit wires them into the planner output path so `/orchestrate plan` actually produces the human-readable `sprint-N.md` files alongside each `sprint-N.yaml`. Backwards compatible — existing helpers retain their signatures.
- **`scripts/publish-vsce.js` and `scripts/publish-ovsx.js` `--dry-run` flag** — when set, scripts log the planned `vsce` / `ovsx` invocation (with PAT/token redacted) and exit 0 without invoking the real tool. Useful for verifying the wrapper end-to-end without burning a publish.

### Documentation

- **`skills/orchestrate/SKILL.md`** — three short additions covering consumer-visible Phase 0 + Phase 1 behavior:
  - `review` sub-command now mentions the new `POST /api/v1/consensus/{task_id}/evaluate` bridge endpoint as the parallel programmatic path for remote agents.
  - `assign` sub-command now describes the `sprint-{N}-stalled.json` sidecar emitted when an agent slot is stalled longer than `autoclaw.orchestrate.heartbeatStallSeconds`, and instructs the AI to surface it to the user with a re-run hint.
  - `plan` sub-command now mentions that `sprint-N.md` is auto-generated alongside `sprint-N.yaml` (generated view; edit the YAML).
- All 8 adapters regenerated to propagate the SKILL.md additions.

### Fixed

- **`npm run publish:all` silent-stop diagnosed and hardened.** Root cause: the previous 43-line `publish-vsce.js` did not pass `--packagePath`, emitted zero output before/after the spawn, did not warn on missing `VSCE_PAT`, and forwarded `result.status ?? 1` with no error message. Under the harness's non-interactive stdio, vsce's no-PAT/EOF-prompt path exited non-zero with all output buffered or muted, so npm's `&&` saw the failure and stopped while the operator saw nothing. Both `scripts/publish-vsce.js` and `scripts/publish-ovsx.js` now ship pre/post status banners, explicit `--packagePath` resolution from `package.json`'s current version, PAT/token-source logging (which source was used, never the value), `spawnSync.error` forwarding, a diagnostic line on non-zero exit, and the new `--dry-run` flag.

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
