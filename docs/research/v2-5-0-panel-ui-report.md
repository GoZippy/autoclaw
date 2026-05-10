# v2.5.0 Panel UI Rebuild — Execution Report

> Branch: `worktree-agent-a8fa1feeaca6dfb42`
> Base: `94729c3` (master @ v2.4.0)
> Status: complete; not pushed, not version-bumped, not tagged.

## Mission

Rebuild the AutoClaw orchestrator panel webview to render the v2.3.0+
extended `RegisteredAgent` and `Heartbeat` fields and the v2.4.0
push-channel + kg-daemon health.

## Files Touched

| File | Δ | Notes |
|---|---|---|
| `src/webview-render.ts` | **+329** (new) | Pure HTML helpers, fully tree-shakeable. Imported only by `extension.ts` and the unit-test file. |
| `src/extension.ts` | **+228 / -2** | Added imports, new HTML sections (`<fabric-health-bar>`, `<awaiting-you-section>`), new postMessage payloads in `refreshOrchestratorData`, helpers (`activeHostAgentId`, `probeFabricHealth`, `httpGetJson`, `handleReplyAwaiting`), and a `replyAwaiting` message handler. |
| `src/webview/kdream-dashboard.js` | **+66** | Three new message kinds (`updateAgentCards`, `updateAwaitingYou`, `updateFabricHealth`), card expand/collapse, Reply button click wiring. |
| `src/webview/kdream-dashboard.css` | **+287** | New components: `.agent-card`, `.status-pill`, `.chip`, `.trust-pill`, `.queue-bar`, `.inbox-summary`, `.awaiting-row`, `.fabric-health-bar`, `.health-badge`. All colors use VS Code theme tokens (`--vscode-charts-green/yellow/red`, `--vscode-badge-background`, etc.). |
| `src/test/webview-rendering.test.ts` | **+353** (new) | 30 unit tests across 6 suites. |
| `package.json` | **+1 / -1** | Adds `out/test/webview-rendering.test.js` to the `test:unit` mocha invocation. |
| **Total** | **+1,262 / -3** | |

## Test Count Delta

- **Baseline (94729c3):** 259 passing
- **After commit 1** (feature work, with the uncommitted test file present in WT): 289 passing
- **After commit 2** (test commit landed): **289 passing**
- **Net new tests:** **+30**

`npm run adapters:check` stays clean — skills/ is untouched.

## Commits

```
a459bda test(panel): HTML generation unit tests for v2 webview render module
ed864f1 feat(panel): expandable agent cards, Awaiting You, fabric health badges
94729c3 release: v2.4.0 — Phase 2 part A (bridge push channels) ...   <-- base
```

The work was originally planned as 4 commits (one per top-level goal),
but the changes interleave so densely across `extension.ts`,
`kdream-dashboard.js`, and `kdream-dashboard.css` that splitting them
cleanly would have required either partial-file commits with intermediate
broken states or duplicating effort. The actual split is feature work
(commit 1) + tests (commit 2). Each commit leaves `npm run test:unit`
green and `npm run adapters:check` clean.

## What the User Sees

```
┌─────────────────────────────────────────────────────────┐
│ ⚡ Launch Skill   ↻ Refresh   📦 Export                 │
├─────────────────────────────────────────────────────────┤
│ [bridge: sse]  [kg: running]                            │  ← fabric badges
├─────────────────────────────────────────────────────────┤
│ ▶ Awaiting You                                       2 │  ← auto-opens when >0
│   ┌───────────────────────────────────────────────┐   │
│   │ kiro  review_request  sprint 4  T-9           │   │
│   │ Please review the new HTTP handler …          │   │
│   │                                       [Reply] │   │
│   └───────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│ ▼ Agents                                             3 │
│   ┌───────────────────────────────────────────────┐   │
│   │ ▶ [active] Kiro  kiro                  [kiro] │   │  ← collapsed card
│   │ ▼ [active] Claude Code  claude-code [claude]  │   │  ← expanded
│   │   Capabilities: [typescript][react][go]       │   │
│   │   LLMs:         [claude-3.5-sonnet][gpt-4o]   │   │
│   │   Context Window:    1M                       │   │
│   │   Trust:        [HIGH]                        │   │
│   │   Budget:       $25/day · $5/hr               │   │
│   │   Last Heartbeat:    2 min ago                │   │
│   │   Current LLM:  claude-3.5-sonnet             │   │
│   │   Queue Depth:  [████░░░░░░░░░░ 4]            │   │
│   │   Tokens Remaining: 12000                     │   │
│   │   Error Rate (1m):  2.0%                      │   │
│   │   Last Error:                                 │   │
│   │   ┌────────────────────────────────────────┐  │   │
│   │   │ transient timeout                      │  │   │
│   │   └────────────────────────────────────────┘  │   │
│   │   Session:      abcdefgh…                     │   │
│   │   ┌──────┬──────┬──────────┬──────────┐       │   │
│   │   │  9   │  3   │    2     │    4     │       │   │
│   │   │TOTAL │UNREAD│AWAITING U│ ARCHIVED │       │   │
│   │   └──────┴──────┴──────────┴──────────┘       │   │
│   │ ▶ [detected] Cursor  cursor                   │   │
│   └───────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│ ▶ Sprints / Messages / Tasks / Activity / Health …    │
└─────────────────────────────────────────────────────────┘
```

Status-pill colors:
- `active` → `--vscode-charts-green`
- `idle` / `overloaded` → `--vscode-charts-yellow`
- `stalled` / `offline` → `--vscode-charts-red`
- `detected` → `--vscode-descriptionForeground`

## Fields Surfaced

From `RegisteredAgent` (v2):
- `id`, `name`, `extension_id` (shown as platform tag), `status`
- `capabilities[]`, `llms_available[]`, `context_window`,
  `trust_level`, `cost_budget.{daily_usd,hourly_usd}`

From `Heartbeat` (v2):
- `timestamp` → "2 min ago", `current_llm`, `queue_depth` (with warn at
  >=10), `token_budget_remaining`, `error_rate_1m` → percent,
  `last_error.message` (already redacted in `comms.ts`), `session_id`.

## Fields Not Rendered (out of v2 spec scope)

- `RegisteredAgent.machine_id` / `machine_ip` / `tools_supported` /
  `max_parallel_tasks` / `skills_loaded` / `human_in_loop_required` /
  `agent_card_path` / `spiffe_id` / `last_detected_at` /
  `cost_budget.per_task_usd` — the mission spec called out a specific
  subset; these are present in the type but not part of the v2.5 panel
  brief, so they are skipped (no breaking changes; future revisions can
  add them as additional `agent-detail-row`s).
- `Heartbeat.network_latency_ms` — same reason.
- `RegisteredAgent.rules_path` — left unchanged because the panel can
  link to it via the existing chat-participant flow.

## Architecture Notes

- **No frameworks**: per the brief, plain HTML + CSS + JS in the
  webview. The renderer module is TypeScript so we can unit-test it
  without spinning up Electron.
- **HTML generated server-side**: `webview-render.ts` runs in the
  extension host, posts the rendered HTML strings to the webview, and
  the webview only swaps `innerHTML` and wires events. This keeps the
  webview JS minimal and CSP-safe (we still use a per-render `nonce`).
- **No webview polling**: the webview asks for an initial dump via
  `command: 'getInitialData'` and receives proactive pushes from
  `refreshOrchestratorData`. The existing 30-second extension-host
  refresh interval is unchanged.
- **All values pass through `esc()`**: every interpolated value in
  `webview-render.ts` is HTML-escaped, including `data-*` attributes
  on the Reply buttons.
- **Accessibility**: `role="button"`, `tabindex="0"`, and `aria-expanded`
  toggling on agent-card heads; `aria-live="polite"` on the Awaiting
  You content area; `role="progressbar"` with `aria-valuemin/max/now`
  on the queue-depth bar.

## CHANGELOG entry suggestion

```markdown
## [2.5.0] - 2026-05-10

### Added
- Panel: expandable agent cards now render the v2.3.0+ extended
  `RegisteredAgent` and `Heartbeat` fields — capabilities, llms_available,
  context window (formatted as 1M/200K), trust level, cost budget,
  current LLM, queue depth (with warn bar at ≥10), token budget remaining,
  1-minute error rate, redacted last error, and session id.
- Panel: per-agent inbox summary block (Total / Unread / Awaiting You /
  Archived) sourced from `getInboxSummary()`.
- Panel: top-level **Awaiting You** section (per
  COORDINATION_IMPROVEMENTS §2.7) listing only messages addressed to the
  active host agent that require a response and have no `replied_at`.
  Reply button writes a `review_response` (or `answer` for `question`
  messages) back to the sender's inbox and marks the original replied.
- Panel header: `bridge: poll | sse | ws` health badge derived from
  `/api/v1/health`'s `sse_clients` / `ws_clients` counters.
- Panel header: `kg: off | running | unreachable` badge derived from
  the kg-daemon child-process state and `/api/v1/health`.

### Internal
- New `src/webview-render.ts` module with pure HTML-generating helpers,
  unit-tested without booting Electron (30 new tests, total 289).
```
