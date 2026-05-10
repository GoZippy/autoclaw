# v2.5.0 Execution Report — FabricBus + A2A `capabilities.extensions[]` mirroring + capability_* message types

> Worktree: `worktree-agent-af9231d7d30a09354`
> Base: `94729c3` (master, v2.4.0)
> Date: 2026-05-10

## Summary

Three Phase-2/Phase-3 deliverables landed together because they share
`src/comms.ts` at the worktree level (only Item C actually modified
comms.ts, but they were planned to ship as one unit):

- **Item A — NATS opt-in bus driver (Phase 2B):** new `src/fabric.ts`
  with `FabricBus` interface + three drivers (`fs` no-op, `ws` over the
  existing `BridgeEventBus`, `nats` lazy-loaded), wired into extension
  activation behind two new settings.
- **Item B — A2A `capabilities.extensions[]` mirroring:** new
  `src/agent-card.ts` with `buildAgentCard()`, plus a debug command
  `autoclaw.agentCard.show`.
- **Item C — `capability_query` / `capability_offer` (and Phase-3
  subcontract / thought_record) message types** appended to the
  `MessageType` union in `src/comms.ts`, with payload-shape JSDoc.

## Files touched (LOC delta vs 94729c3)

```
 adapters/antigravity/cross-agent.md  |   3 +
 adapters/claude-code/cross-agent.md  |   3 +
 adapters/cline/cross-agent.md        |   3 +
 adapters/continue/cross-agent.prompt |   3 +
 adapters/cursor/cross-agent.mdc      |   3 +
 adapters/kiro/cross-agent.md         |   3 +
 adapters/windsurf/cross-agent.md     |   3 +
 package.json                         |  24 ++-
 src/agent-card.ts                    | 230 ++++++++++++++++++++++ (new)
 src/comms.ts                         |  45 ++++-
 src/extension.ts                     | 105 ++++++++++
 src/fabric.ts                        | 369 +++++++++++++++++++++++++++ (new)
 src/test/agent-card.test.ts          | 153 +++++++++++++++ (new)
 src/test/comms.test.ts               |  46 +++++
 src/test/fabric.test.ts              | 161 +++++++++++++++ (new)
 15 files changed, 1152 insertions(+), 2 deletions(-)
```

Total LOC delta: **+1152 / -2** across 15 files.

## Commits (in order)

1. `feat(fabric): FabricBus abstraction with fs/ws driver implementations`
2. `feat(fabric): nats driver behind dynamic import + optional dep`
3. `feat(fabric): wire FabricBus into extension activation; new autoclaw.fabric.* settings`
4. `feat(agent-card): build canonical A2A v0.2.5 Agent Card with capabilities.extensions[] mirroring x-autoclaw`
5. `feat(comms): add capability_query/offer + thought_record + subcontract_* message types`
6. `docs(rules): list new message types in cross-agent-protocol.md`

## Tests added (one-line each)

### `src/test/fabric.test.ts` (11 new)

1. fs driver — creates without error; stats() reports driver=fs
2. fs driver — publish/subscribe are no-ops but increment counters; close() is idempotent
3. ws driver — publish on bus → subscriber receives matching topic
4. ws driver — subscriber unsubscribe stops further deliveries
5. ws driver — close() prevents further deliveries and is idempotent
6. nats fallback — falls back to fs and warns when import throws
7. nats fallback — falls back to fs when import returns no connect() entry
8. nats fallback — falls back to fs when connect() rejects (server unreachable)
9. topic matcher — exact match
10. topic matcher — `*` matches a single token
11. topic matcher — `>` matches one or more terminal tokens

### `src/test/agent-card.test.ts` (6 new)

1. Minimal input produces a valid card with required fields populated
2. All `x-autoclaw.*` fields populated → mirrored into both top-level AND `capabilities.extensions[].params`
3. Schema sanity: endpoints is an object with at least an http URL; extensions[] is an array; AutoClaw URI matches
4. Caller-supplied `capabilities.extensions[]` are preserved alongside the AutoClaw entry
5. `endpoints.ws` / `endpoints.nats` are pass-through when supplied
6. Only populated `x-autoclaw` fields appear in `extensions[].params` (no undefined leakage)

### `src/test/comms.test.ts` (2 new)

1. capability_query round-trips with all payload fields preserved
2. capability_offer round-trips with all payload fields preserved

**Test count: 259 baseline → 278 total (+19 new tests, all green).**

## Manual verification — FabricBus driver switch

The bus is initialized best-effort during `activate()` from
`autoclaw.fabric.busDriver`; `deactivate()` calls `FabricBus.close()`.

To verify each driver locally:

1. **`fs` (default).** Open VS Code on this repo. The Output → AutoClaw
   logs (or `console.log` in the dev-tools console) show
   `AutoClaw FabricBus: driver=fs`. Existing inbox-based comms keeps
   working unchanged.
2. **`ws`.** Settings → search "autoclaw fabric" → set
   `autoclaw.fabric.busDriver` to `ws`. Reload window. Console shows
   `AutoClaw FabricBus: driver=ws`. The bridge `/api/v1/messages/stream`
   SSE channel keeps working as before because the ws fabric multiplexes
   on the same `BridgeEventBus`.
3. **`nats` — dependency missing (fallback).** With no `nats` package
   installed, set `autoclaw.fabric.busDriver` to `nats`. Reload.
   Expect a warning `FabricBus: nats package not available …; falling
   back to fs driver` and `driver=fs` final state.
4. **`nats` — server unreachable (fallback).** `npm install nats` (it's
   `optionalDependencies`). Without a NATS server running, set the
   driver to `nats`. Reload. Expect `FabricBus: could not connect to
   NATS at nats://127.0.0.1:4222 (…); falling back to fs driver`.
5. **`nats` — happy path.** Run `nats-server` on `:4222`, set
   `autoclaw.fabric.busDriver` to `nats`, reload. Console shows
   `driver=nats`. (No production callers publish to it yet — that
   integration is a follow-up.)

To verify the `autoclaw.agentCard.show` command:

1. Run from Command Palette: `AutoClaw: Show Agent Card (A2A) for Host
   Agent`.
2. An Untitled JSON editor opens with a card. Confirm:
   - `protocolVersion === "0.2.5"`
   - `endpoints.http` is the bridge URL (`http://127.0.0.1:9876/a2a` by
     default).
   - `capabilities.extensions[]` contains exactly one entry whose
     `uri === "https://github.com/GoZippy/autoclaw/extensions/v1"` and
     whose `params` mirrors the `x-autoclaw` block.

## Deviations from the prompt

- **Canonical A2A field names retained (`protocolVersion`, `url`,
  `defaultInputModes`, `defaultOutputModes`).** The prompt asked for
  `schema_version`, `inputModes`, `outputModes`, `endpoints`. The spec
  doc `docs/specs/agent-card-schema.md` (v0.2.5-pinned and verified
  2026-05-10) documents the canonical names and explicitly notes
  `schema_version` is **not** an A2A canonical field. The implementation
  emits BOTH the canonical names (so strict A2A consumers keep working)
  AND the prompt-named aliases (`endpoints`, `inputModes`,
  `outputModes`) on the same object, satisfying both contracts.
- **Top-level `.claude/rules/cross-agent-protocol.md` not edited.** That
  file is gitignored at the worktree level (the in-tree `.claude/` is
  blocked from edits in this worktree). The Phase-3 message types were
  added to every per-adapter `cross-agent.md`/`.mdc`/`.prompt` rules
  file under `adapters/*/`, which is what actually ships to end users
  on adapter install. The user-facing project rules can be synced
  manually from any of the adapter copies.
- **No production wiring of FabricBus into `comms.ts`.** Per the prompt
  ("Don't yet integrate the bus with comms.ts message paths") this is
  deferred. The bus is constructed and held in `activeFabric` but
  nothing publishes to it yet.
- **No capability message handler.** Per the prompt ("Don't yet
  implement a handler that consumes capability messages and routes
  tasks based on them"), the new `MessageType`s flow through the
  existing send/receive plumbing only.

## CHANGELOG entry — suggested text for v2.5.0

```markdown
## v2.5.0 — Phase 2B (FabricBus) + A2A `capabilities.extensions[]` + capability_* messages

### Added
- **FabricBus** (`src/fabric.ts`): pluggable cross-agent message-bus
  abstraction with three drivers — `fs` (no-op; FS mailbox stays
  canonical), `ws` (wraps BridgeEventBus for SSE/WS push), and `nats`
  (lazy-loaded via dynamic import; optional dependency; gracefully
  falls back to `fs` if the package is missing or the server is
  unreachable).
- **Settings** `autoclaw.fabric.busDriver` (default `'fs'`) and
  `autoclaw.fabric.natsUrl` (default `nats://127.0.0.1:4222`).
- **Optional dependency** on `nats@^2.29.0`. Installs without it still
  succeed; users opt in via `npm install nats` and switch the driver.
- **A2A Agent Card builder** (`src/agent-card.ts`):
  `buildAgentCard()` emits a canonical A2A v0.2.5 Agent Card with the
  AutoClaw extension fields mirrored into
  `capabilities.extensions[]` keyed by
  `https://github.com/GoZippy/autoclaw/extensions/v1`. The legacy
  top-level `x-autoclaw` block is preserved for backwards compatibility
  (transitional).
- **Command** `AutoClaw: Show Agent Card (A2A) for Host Agent`
  (`autoclaw.agentCard.show`) renders the local card as JSON.
- **Cross-agent message types**: `capability_query`,
  `capability_offer`, `thought_record`, `subcontract_request`,
  `subcontract_accept`, `subcontract_deliver`, `subcontract_ack`.
  Routed through the existing FS plumbing; capability-aware router
  ships separately.

### Changed
- Adapter rules files (`adapters/*/cross-agent.md`/`.mdc`/`.prompt`)
  now list the new Phase-3 message types.

### Notes
- FabricBus is not yet integrated with `sendMessage()` /
  `readInbox()` — that wiring is the next milestone. The FS mailbox
  remains canonical and durable.
```
