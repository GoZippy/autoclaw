# v2.5.0 Hardening Report

Two small hardening items deferred from earlier phases, executed in a
worktree off `master @ 94729c3` (v2.4.0). Worktree branch:
`worktree-agent-afa5e8088aa9c0970`. **Not pushed, not tagged, version
not bumped.**

## Scope

| # | Item                                       | Touchpoints                                  |
|---|--------------------------------------------|----------------------------------------------|
| 1 | kg-daemon EADDRINUSE port fallback         | `src/kg.ts`, `src/test/kg-lifecycle.test.ts` |
| 2 | Bridge token revocation list               | `src/bridge.ts`, `src/test/bridge.test.ts`, `src/extension.ts`, `package.json` |

## Commits (all on `worktree-agent-afa5e8088aa9c0970`)

```
17e3a61 feat(kg): port fallback 9877→9881 on EADDRINUSE
5e0fce6 test(kg): port fallback coverage
7d71d8f feat(bridge): token revocation list — revokeToken helper + validateToken check
8a7ac2f feat(bridge): autoclaw.bridge.revokeToken command + system broadcast
```

## Files Touched and LOC Delta

```
 package.json                  |   4 ++
 src/bridge.ts                 |  30 +++++++-   (+27 / -3)
 src/extension.ts              |  86 ++++++++++++++++++++---   (+85 / -1)
 src/kg.ts                     |  86 +++++++++++++++++++++--   (+82 / -4)
 src/test/bridge.test.ts       | 104 ++++++++++++++++++++++++++-   (+103 / -1)
 src/test/kg-lifecycle.test.ts | 159 ++++++++++++++++++++++++++++++++++++++++--   (+153 / -6)
 6 files changed, 447 insertions(+), 22 deletions(-)
```

Net: **+425 LOC** (production + tests, including doc-comments).

## Tests

Baseline: **259 passing**.
After Item 1 commits: **265 passing** (+6).
After Item 2 commits: **271 passing** (+6 over Item 1, +12 total).
Final: **271 passing, 0 failing.**

`npm run test:unit` was run after each of the four commits and after
the implementation steps; it stayed green throughout.
`npm run adapters:check` reports `Adapters in sync with skills/.`

### New tests — Item 1 (`src/test/kg-lifecycle.test.ts`)

- `isPortAvailable returns true for an unbound port`
- `isPortAvailable returns false when something is bound`
- `findAvailablePort skips occupied ports and returns the next free one`
- `findAvailablePort returns null when every probed port is busy`
- `startKgDaemon falls back to the next available port when configured
  port is busy` (also asserts the `[kg] configured port N in use` log
  line and the `port=N` line for the actual port)
- `startKgDaemon returns no_port_available when every probed port is
  busy` (asserts the structured message + a logger record)

The two pre-existing `startKgDaemon` happy-path tests were updated for
the now-async API and a `state.port === requested` assertion was added.

### New tests — Item 2 (`src/test/bridge.test.ts`)

- `revokeToken stamps revoked_at and persists to disk`
- `revokeToken returns false for an unknown token`
- `revokeToken returns false for an empty/missing token value`
- `validateToken returns null for a revoked token even before expiry`
- `legacy tokens (no revoked_at field) continue to validate`
  (backwards-compatibility with existing tokens.json files)
- End-to-end via HTTP: `create → use (201) → revoke → use again (401)`

## Item 1 — kg-daemon port fallback (design notes)

Mirrors the bridge's port-fallback pattern (`9876→9880`) but uses a
**probe-then-spawn** approach instead of trying to detect EADDRINUSE
out of the daemon's stderr.

Rationale: kg-daemon prints `[kg-daemon] listening on http://...`
on `console.log` only after `app.listen` resolves, and surfaces
`startDaemon` failures via `console.error("[kg-daemon] failed to
start:", e); process.exit(1)`. Parsing those lines reliably across
platforms (and waiting up to 5s for them) is significantly more
fragile than just doing a `net.createServer().listen(port).then(close)`
round-trip *before* spawn.

New helpers (all exported for reuse + direct testing):

- `isPortAvailable(port, host = '127.0.0.1'): Promise<boolean>`
- `findAvailablePort(startPort, count = 4, host): Promise<number | null>`
- `KG_PORT_FALLBACK_COUNT = 4` (mirrors `BRIDGE_PORT_FALLBACK_COUNT`)

Surface changes:

- `startKgDaemon` is now `async` and returns `Promise<KgStartResult>`.
  All call sites (`maybeStartKgDaemon` in `src/extension.ts`, both
  spawn-based unit tests) updated to `await`.
- New `KgStartResult` discriminator: `'no_port_available'` when every
  port in the window is occupied. The user-visible message is
  `kg-daemon: no port available in {start}..{start+4}`.
- New field: `KgState.port: number` records the port the daemon was
  actually spawned on. The doctor section, `kgHealthCheckCommand`, and
  the doctor command's `fetchKgHealth` call all prefer `activeKg.port`
  over the configured value when the daemon is alive, so `/health`
  probes hit the correct port after a fallback.
- `kgHealthCheckCommand` now logs an informational line when the live
  port differs from the configured one
  (`(configured port N unavailable; daemon bound to M)`).

## Item 2 — Bridge token revocation list (design notes)

- `RemoteAgentToken` gains an optional `revoked_at?: string | null`
  field. Backwards compatible: existing `tokens.json` files parse with
  the field as `undefined`, which is falsy so they continue to
  validate.
- `revokeToken(tokensPath, tokenValue): Promise<boolean>` stamps the
  current ISO timestamp and persists. Returns `false` for unknown /
  empty token values; returns `true` when a matching entry is found
  and updated. Already-revoked entries are re-stamped (last-write
  wins); the security property — that the token cannot validate — is
  unchanged either way.
- `validateToken` and `validateRawToken` both gain a single new line
  that returns `null` when `m.revoked_at` is set.
- New extension command `autoclaw.bridge.revokeToken` (also exposed
  via `package.json` `contributes.commands`):
  - reads `tokens.json` from the workspace's
    `.autoclaw/orchestrator/comms/`
  - filters out already-revoked entries
  - shows a `vscode.window.showQuickPick` over the active tokens with
    `agent_id` (label), `expires_at` (description), and the
    `created_at` + first 12 chars of the token (detail)
  - on selection, calls `revokeToken` and posts a `system` message to
    `inboxes/shared/` with payload
    `{ kind: 'token_revoked', agent_id, revoked_at, message }`. The
    human-readable `message` reads
    `agent <id>'s token revoked at <timestamp>`.
  - the broadcast is fire-and-forget (`.catch(() => {})`) — the
    revocation itself is the source of truth.

## Deviations

None. The spec listed two acceptable approaches for Item 1 (stderr
parse vs. probe-then-spawn); the report-spec already flagged the
probe-based path as the preferred fallback, and that's what landed.

## Constraints Honoured

- Backwards compatible (legacy tokens.json validates; existing
  `KgStartResult` consumers gain a new variant but the existing
  variants are unchanged).
- No new npm dependencies (only `node:net` added to `kg.ts`).
- Code style matches the surrounding files (single-quote strings,
  trailing-semicolon, JSDoc on exported helpers, etc.).
- `npm run test:unit` green after every commit.
- `npm run adapters:check` clean at the end.
- Did NOT push, did NOT bump version, did NOT tag.
