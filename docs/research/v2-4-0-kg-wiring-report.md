# v2.4.0 — KG Daemon Wiring Report

## Summary

Promotes `packages/kg-daemon/` from an isolated prototype to a managed
companion process spawned by the AutoClaw extension when the user opts
in. Default behaviour is unchanged for everyone who has not flipped
`autoclaw.kg.enabled` on.

- **Branch:** `worktree-agent-ac521577e8fddeb83` (off `63bb699`).
- **Commits:** 4 (settings → lifecycle → doctor+commands → tests).
- **LOC delta:** +702 / −3 across 6 files (`git diff --stat 63bb699..HEAD`).
- **Tests:** baseline 226 → **240 passing** (+14 new tests).
- **`npm run adapters:check`:** clean — skills untouched.

## Changes by file

| File | Δ | Purpose |
|---|---|---|
| `package.json` | +25 | New `autoclaw.kg.*` config + 2 commands + extra mocha file |
| `src/kg.ts` | +217 (new) | Pure lifecycle helpers (spawn/stop/health/probe) |
| `src/extension.ts` | +102 | Activation hook, deactivate teardown, command wiring, doctor shim |
| `src/doctor.ts` | +84 | New `KgDaemonSection` + `## KG Daemon` render block |
| `src/test/kg-lifecycle.test.ts` | +206 (new) | 11 lifecycle tests including a fake-daemon spawn |
| `src/test/doctor.test.ts` | +71 | 3 tests for `buildKgDaemonSection` + render check |

## Surface added

### Settings (`autoclaw.kg.*`)
- `enabled` — boolean, default `false` (opt-in).
- `port` — number, default `9877`.
- `dbPath` — string, default `""` (empty = daemon picks default).

### Commands
- `autoclaw.kg.openOutput` — focuses the `AutoClaw KG` OutputChannel.
- `autoclaw.kg.healthCheck` — `GET /api/v1/health`, shows result in a
  notification (with "Open KG Output" button on failure).

### Doctor
- `## KG Daemon` block: enabled flag, port, deps-installed flag, entry
  path with existence check, child PID, last `/health` summary
  (`ok=…`, `sqlite=…`, `vec=…`, `fts=…`).

### Lifecycle
- On activation: if `autoclaw.kg.enabled === true`, probe
  `packages/kg-daemon/node_modules/` and `packages/kg-daemon/dist/server.js`.
  Missing either → log a one-liner and skip the spawn (no auto-install,
  no auto-build). Otherwise `spawn(process.execPath, [dist/server.js])`
  with `KG_PORT` and (if non-empty) `KG_DB_PATH` env vars. stdout / stderr
  go to the `AutoClaw KG` channel; `'exit'` and `'error'` events log
  but never throw.
- On deactivate: `SIGTERM`, then `SIGKILL` after 5s if the child is
  still alive.

## Manual verification (operator)

```sh
# 1. Install kg-daemon deps (one-time, native bindings)
cd packages/kg-daemon
npm install
npm run build
cd ../..

# 2. Flip the opt-in setting in settings.json (user or workspace)
#    "autoclaw.kg.enabled": true

# 3. Reload the VS Code window
#    Ctrl+Shift+P → "Developer: Reload Window"

# 4. Confirm the OutputChannel
#    View → Output → choose "AutoClaw KG" from the dropdown
#    Expect: [kg] started pid=… port=9877 entry=…/dist/server.js

# 5. Run the health check command
#    Ctrl+Shift+P → "AutoClaw: KG — Health Check"
#    Expect: notification "AutoClaw KG: 200 OK — {ok:true,sqlite:true,...}"

# 6. Optional — confirm doctor surfaces the live PID
#    Ctrl+Shift+P → "AutoClaw: Doctor (Health Check)"
#    Look for the "## KG Daemon" block with `child pid: <n>`.
```

## Deviations from the prompt

- **`fetchKgHealth` doctor probe is live, not cached.** The prompt asked
  the doctor section to show the "last `/health` response". Since we
  don't otherwise tick the daemon, "last" would always be `null` until
  someone runs `autoclaw.kg.healthCheck`. The doctor command now
  performs an inline `fetchKgHealth` when a child PID is present so
  operators don't have to run a separate command first. Result is still
  passed through the existing `DoctorVscodeShim` so unit tests never
  hit the network.
- **No restart-on-crash supervisor.** Prompt said "best-effort — if it
  crashes, the extension should keep working." We log the exit and
  leave it down. Adding a backoff/restart loop is intentionally out of
  scope (would invite zombie storms during dev).
- **Spawn uses `process.execPath`, not literal `node`.** Matches the
  Electron-bundled Node the extension host is already running and
  avoids PATH ambiguity on Windows. Equivalent to running
  `node packages/kg-daemon/dist/server.js`.
- **Doctor section reads via shim, builder is decoupled.** Following
  the existing `DoctorVscodeShim` pattern so the section is fully
  unit-testable without mocking `vscode`.

## Suggested CHANGELOG entry (v2.4.0)

```markdown
## v2.4.0 — KG Daemon Companion Process

### Added
- **Knowledge Graph daemon companion process** (opt-in). When
  `autoclaw.kg.enabled` is `true`, the extension spawns
  `packages/kg-daemon` as a managed child process on activation and
  shuts it down (SIGTERM, then SIGKILL after 5s) on deactivation. New
  settings: `autoclaw.kg.enabled` (default `false`), `autoclaw.kg.port`
  (default `9877`), `autoclaw.kg.dbPath` (default `""`).
- **Commands.** `AutoClaw: KG — Open Output Channel` focuses the
  `AutoClaw KG` log; `AutoClaw: KG — Health Check` GETs
  `/api/v1/health` and shows the result.
- **Doctor `## KG Daemon` section.** Reports enabled flag, port,
  deps-installed status, entrypoint existence, live child PID, and the
  last `/health` response.

### Setup
The daemon is opt-in because `better-sqlite3` ships native bindings.
Run `cd packages/kg-daemon && npm install && npm run build` once
before flipping `autoclaw.kg.enabled` on.
```

## Risks and open questions

- **Port conflicts.** `startKgDaemon` does not currently fall back to
  a different port on `EADDRINUSE`. The bridge does (see
  `BRIDGE_PORT_FALLBACK_COUNT`). If a user already has another process
  on `:9877` we will see the daemon log a fatal `listen EADDRINUSE`
  on stderr and exit. Mitigation today: change `autoclaw.kg.port`.
  Future: add a fallback range mirroring the bridge.
- **Mid-session port changes.** Updating `autoclaw.kg.port` does not
  restart the running daemon; the new value only takes effect on the
  next reload. Acceptable for a Phase-3 prototype, but worth surfacing
  in docs (or wiring `vscode.workspace.onDidChangeConfiguration` to
  re-spawn — left as a follow-up).
- **Native build fragility.** `better-sqlite3` requires a Node ABI
  match. Because we spawn with the extension host's `process.execPath`
  (Electron's bundled Node), the prebuild has to match Electron's ABI.
  If users hit `NODE_MODULE_VERSION` mismatch they will see it on the
  daemon's first stderr line; the extension itself stays healthy.
- **No auth on loopback.** Daemon binds `127.0.0.1` only and has no
  auth; matches the bridge's pre-token posture. Documented in the
  fabric doc Phase 3 follow-ups.
- **Workspace-aware DB path is deferred to the daemon.** When
  `autoclaw.kg.dbPath` is empty we let the daemon's own default kick
  in. The README claims `~/.autoclaw/kg/<workspace-name>.db` but the
  current daemon falls back to `./kg-prototype.db` in cwd. Either fix
  the daemon default in a follow-up or document that operators should
  set `autoclaw.kg.dbPath` explicitly. Out of scope here per the
  "DO NOT modify packages/kg-daemon/ source" constraint.

## Tests

```
240 passing (was 226 baseline → +14)
- KG: resolveKgEntry / kgDepsInstalled (4)
- KG: startKgDaemon — short-circuit paths (2)
- KG: spawn + stop with a fake daemon script (2)
- KG: fetchKgHealth (1)
- KG: package.json contributions (2)
- Doctor: buildKgDaemonSection() (3)
```

`npm run adapters:check` is clean (skills untouched).
