# AutoClaw Control (Tauri) — Build Plan

> Decision doc — 2026-06-22. The maintainer chose to **plan toward** a Tauri standalone
> *AutoClaw Control*: a vendor-neutral, cross-window / cross-project / cross-machine
> **single pane of glass above the editors**. This is a concrete build plan, not a re-pitch.
>
> **Why this exists (one paragraph, settled — see the strategy memo, don't re-argue it):**
> window-sprawl is *structural*. An extension lives inside one of the windows that is causing
> the mess, so it can never show the other windows, the other projects, or the other machines.
> Control is the only surface that structurally fixes it. The full strategic case is
> [MULTI-AGENT-WORKSPACE-VISIBILITY-AND-CONTROL-PLANE.md](./MULTI-AGENT-WORKSPACE-VISIBILITY-AND-CONTROL-PLANE.md)
> (Idea 1, already scoped). This doc is *how to build it*.
>
> **Related, load-bearing docs:**
> - [STANDARDIZED-ADAPTER-A2A-PLATFORM.md](./STANDARDIZED-ADAPTER-A2A-PLATFORM.md) (`acp/1`) — the
>   four transports / one envelope / Beacon presence model Control rides on. Control speaks **none
>   of its own protocol**; it reads the same file-bus + beacon trees and writes the same envelope.
> - [CHAT-SESSION-MESSAGE-TRACKING.md](./CHAT-SESSION-MESSAGE-TRACKING.md) — the four-rung **Open
>   chat deep-link ladder** Control reuses verbatim for its "Open in IDE" handoff.
> - [AGENT-JOIN-AND-FLEET-VISIBILITY.md](./AGENT-JOIN-AND-FLEET-VISIBILITY.md) +
>   [FLEET-FEDERATION-SELF-HEALING.md](./FLEET-FEDERATION-SELF-HEALING.md) — the join/roster
>   primitives Control renders.

---

## 0. The one-sentence shape

Control is a **Tauri shell** that runs a **file-watcher** over `~/.autoclaw/beacons/` **and** every
registered project's `.autoclaw/orchestrator/comms/` tree, **aggregates** them into one cross-project
read model, **renders** that model with the extension's **already host-free HTML-string renderers**,
and acts strictly as an **observer that dispatches intents over the same file-bus** (it writes
request files into the comms tree; it never runs an agent itself). Execution stays in the IDEs/CLIs.

---

## 1. The key reuse asset (do not re-implement)

The extension's render layer is **already host-agnostic** — pure functions that take a plain data
model and return an HTML string, with **no `vscode` import**:

- **`src/webview-render.ts`** — fleet roster / agent cards / session list / role rollups. Imports only
  `fs`, `path`, and sibling pure modules (`roles.ts`, `llm/modelCatalog.ts`). Every interpolated value
  passes through `esc()`. Documented intent (verbatim): *"split out … so they can be unit-tested
  without booting the Electron host."*
- **`src/webview-render-board.ts`** — the four-lane kanban (Backlog → In progress → Review → Blocked),
  the **Done** lane (rebuilt from the durable task ledger), per-task message threads, capsule cards.
  Header comment: *"No fs / vscode imports."* Input shapes mirror `board.json` on disk.
- **`src/views/fleetViewModelBuilders.ts`** (`buildFleetDashboard`) + **`src/panel/fleetData.ts`** —
  the read→model pipeline. `fleetData.ts` is **already** `READ-ONLY, no vscode import, pure fs/path`,
  rooted at a single `workspaceRoot` via `commsDir(workspaceRoot)`.

**Consequence:** the entire visual layer ports to Control **as-is**. Control supplies a *different
data-gathering front* (N workspaces instead of one) feeding the *same* builders and renderers. The
only thing that changes is the read fan-out, not the render. This is what makes a second surface
affordable: ~one screen of new aggregation glue, zero new UI components.

---

## 2. Architecture

```
                         ┌───────────────────────────────────────────────┐
                         │  AutoClaw Control  (Tauri shell)               │
                         │                                               │
   ~/.autoclaw/beacons/  │  ┌──────────────┐   ┌──────────────────────┐  │
   (machine-global) ─────┼─▶│ Rust watcher │──▶│ Aggregator (read     │  │
                         │  │ (notify-rs)  │   │ model over N roots)   │  │
   <projA>/.autoclaw/    │  └──────────────┘   └─────────┬────────────┘  │
     orchestrator/comms/ │         ▲                     │ host-free      │
   <projB>/.autoclaw/    │         │ debounced fs events │ render model   │
     orchestrator/comms/ │         │                     ▼                │
   <projN>/… ────────────┼─────────┘            ┌──────────────────────┐  │
                         │                       │ webview-render*.ts   │  │
        (writes)         │  ┌──────────────┐    │ (REUSED renderers)   │  │
   request files  ◀──────┼──│ Dispatcher   │    └──────────┬───────────┘  │
   into comms/inboxes/   │  │ (intent →    │               │ HTML         │
   + control/ envelopes  │  │ envelope)    │    ┌──────────▼───────────┐  │
                         │  └──────────────┘    │ WebView (system WV)  │  │
                         │         ▲            │  roster · board ·    │  │
                         │         │ click      │  meters · review     │  │
                         │         └────────────┤  + "Open in IDE"     │  │
                         │                       └──────────────────────┘  │
                         └───────────────────────────────────────────────┘
                                   ▲                               │
   IDE / CLI windows ─────────────┘ (execution stays here) ◀──────┘ deep-link handoff
```

### 2.1 Tauri shell
- **Tauri 2** (Rust core + system WebView). Chosen over Electron for footprint: a Tauri binary is
  single-digit MB vs Electron's ~150 MB, and it ships **Windows `.msi`** / Linux AppImage / macOS dmg
  out of the box — exactly the targets we need (maintainer is Windows-primary; the extension already
  fights Windows-path bugs, so a Windows-native installer is non-negotiable). Coven Cave (the
  reference prior art) is itself **Tauri 2** and proves this shape ships on Windows
  (strategy memo §1A).
- The WebView is a **dumb renderer**: it receives finished HTML from the host-free renderers and
  posts click intents back. **No business logic in JS** — same discipline as the extension's webview.

### 2.2 The watcher (Rust, `notify`-rs)
- One watcher process, two classes of root:
  1. **Machine-global beacons** — `~/.autoclaw/beacons/*.json` (one dir, the cross-tool / cross-machine
     check-in lane; `src/fleet/beacons.ts` `machineBeaconDir`).
  2. **Per-project comms trees** — for each *registered* project, watch
     `<root>/.autoclaw/orchestrator/comms/` (registry, heartbeats, inboxes, `_state/`, claims, beacons,
     board, ledger) per `src/panel/fleetData.ts::commsDir`.
- **Debounce** (250–500 ms) and coalesce — comms writes are bursty (a sprint can rewrite many files at
  once). Emit a single "project X changed" signal; the aggregator re-reads that project only.
- **Project registry** for Control itself: `~/.autoclaw/control/projects.json` — the list of roots to
  watch, added by (a) auto-discovery of any `~/.autoclaw/beacons/*.json` whose `workspace` field points
  at a real dir, and (b) explicit "Add project folder". This is **Control's own** config, not part of
  any project's tree.
- **TS option for P1:** the watcher may start as a Node sidecar (`chokidar`) reusing `fleetData.ts`
  directly with zero porting, then move to Rust `notify` once the read model is stable. Decide at P1
  exit (§5) based on watch-fan-out cost; the render layer is identical either way.

### 2.3 The aggregator — the **read model that spans many workspaces**
This is the **one genuinely new piece**. Contrast:

| | Extension (today) | Control (new) |
|---|---|---|
| Root scope | **one** `workspaceFolders[0]` → one `commsDir(root)` | **N** roots from `projects.json` |
| Beacons read | machine dir + **this** workspace's beacon dir (`readAllBeacons({commsDir})`) | machine dir **once** + **every** project's beacon dir |
| Output | one `FleetDashboardModel` for one project | a **map** `projectId → FleetDashboardModel`, plus a **cross-project roll-up** (all agents, all boards, all sessions, deduped by `(agent_id, session_id)` keeping freshest — the dedupe rule `readAllBeacons` already implements) |
| Identity | agent rows scoped to the project | agent rows carry `workspace_id` / `host` / `machine_id` (already on `Beacon`) so the **same** physical agent appearing in two projects is one roster entry with two lanes |

Implementation: call the **existing** `buildFleetDashboard` once per project (it is pure, takes
`FleetDashboardInputs`, returns a model), then a thin new `rollupFleet(models[])` that unions the
per-project models for the cross-project views. **No new render code** — the roll-up feeds the same
`webview-render*.ts`. The dedupe + staleness logic (`normalizeBeacon`, `BEACON_TTL_MS = 5 min`,
`(agent_id, session_id)` freshest-wins) is reused verbatim from `beacons.ts`; Control does not invent
a second freshness model.

### 2.4 The dispatcher — **observer that writes request files**
Control **never spawns an agent**. Every "control" action is a **write into the same file-bus** the
extension and runners already poll:
- Dispatch / re-dispatch / cancel / nudge → a message file in the target project's
  `comms/inboxes/<to>/` using the existing envelope (`src/comms/types.ts` `MessageType`:
  `task_assign`, `task_claim`, `question`, `finding_report`, …) with the documented filename
  convention (ISO-ts-with-millis + type + sender + session-frag) and idempotency rules
  (`inboxState.ts`).
- Control's sender identity is a reserved agent id (e.g. `control`) with its **own** beacon so the
  fleet sees who issued an intent. It claims **nothing** and edits **no** code files — it only ever
  writes message/request/control envelopes.
- The IDE-resident extension / runner picks the request up on its next poll and **executes there**.
  This keeps execution, scope-jailing, and trust enforcement exactly where `acp/1` already puts them
  (the host — i.e. the IDE/runner — holds enforcement; Control is not a runner).

---

## 3. The "Open in IDE" handoff (deep-link ladder)

Clicking a **task card** or **session row** in Control performs the cross-window handoff. Control
**reuses the four-rung ladder** from
[CHAT-SESSION-MESSAGE-TRACKING.md](./CHAT-SESSION-MESSAGE-TRACKING.md) §4 verbatim — it attempts the
**highest rung the source tool supports** and **tells the user which tier fired** (never silently does
less):

| Rung | What | Example | Availability |
|---|---|---|---|
| **1** | Deep-link the **exact** session | `vscode://anthropic.claude-code/open?session=<id>` (Claude Code is the only tool with a true resume-by-id URI today) | tool-dependent |
| **2** | Deep-link the tool's **session list / new chat** (user picks the row) | `cursor://…/prompt`, Kilo "open in new tab" | tool-dependent |
| **3** | **Copy a `--resume`/CLI command** + toast | `claude --resume <id>` | any CLI |
| **4** | **Reveal the raw transcript file/dir** | open `…/tasks/<taskId>/`, the `.jsonl`, the spec dir | **always** (uses `provenance.rawRef`) |

Control-specific deltas from the in-extension version:
- **It fires from outside any editor.** Control resolves the deep link, then hands it to the OS via the
  Tauri shell's external-open (the desktop equivalent of `vscode.env.openExternal`). If the target IDE
  is **not running**, the ladder degrades one rung (e.g. rung-4 reveal, or rung-3 copy-command) and the
  toast says so.
- **Cross-machine rows** (a beacon whose `machine_id` ≠ this host) cannot deep-link locally; the row
  shows a *"on `<machine_id>`"* badge and offers rung-3 (copy resume command) + a "remote glance" stub
  reserved for P5. No silent failure.
- The linchpin (`Heartbeat.session_id` == the IDE tool's `sessionId` == the `<sessionId>.jsonl`
  filename) is already on disk for every beacon Control reads — so the ladder needs **no new data**.

---

## 4. Per-project read primitive (FLEET-DIGEST) + control feedback (EVICT ack-envelope)

Two small **conventions** make Control cheap and its control loop honest. Both are *additions to the
existing comms tree*, not new protocols, and both stay readable by the extension so the two surfaces
never diverge.

### 4.1 FLEET-DIGEST — one `fleet-status.json` per project
Each project's orchestrator writes a **single rolled-up digest** at
`<root>/.autoclaw/orchestrator/comms/fleet-status.json`: the already-computed `FleetDashboardModel`
(roster + board + session list + cost roll-up + staleness) serialized to one file, refreshed on each
orchestrator cycle (and on any comms write, debounced).

- **Why:** Control's watcher can read **one file per project** for the steady-state board instead of
  walking the whole `comms/` tree on every fs event. The full walk (`fleetData.ts`) remains the
  fallback/cold-start path and the source of truth; the digest is a **cache the producer already has
  in memory** (it literally just calls `buildFleetDashboard` and writes the result).
- **Reuse:** the digest *is* the existing model shape — so Control reads it and hands it straight to the
  host-free renderers with zero transform. This is the per-project **read primitive**; the cross-project
  roll-up (§2.3) is `N` digests unioned.
- **Staleness:** the digest carries the orchestrator's heartbeat; if it is older than `BEACON_TTL_MS`
  Control falls back to the live tree walk and badges the project "digest stale."
- **Producer:** a small writer hung off the existing orchestrator loop (`src/orchestratorLoop.ts`),
  emitting the model it already builds. **No new computation** — it persists what the panel computes
  anyway. (Open: whether the extension or a standalone refresh service owns the write when no IDE is
  open on that project — see Risks.)

### 4.2 EVICT ack-envelope — control feedback
A dispatched intent is fire-and-forget unless we close the loop. Control writes a **control envelope**
into `comms/control/` (or the target inbox) and the IDE-resident handler replies with an **ack
envelope** so Control can show *applied / rejected / no-op*:

```jsonc
// Control → project:  comms/control/<ts>-control-evict-<frag>.json
{ "id": "ctl-<uuid>", "from": "control", "type": "evict",
  "to": "claude-code", "session_id": "<control-session>",
  "target": { "agent_id": "claude-code", "session_id": "9f2c…" },
  "reason": "stale lane reclaim", "requires_ack": true, "timestamp": "<iso>" }

// IDE-resident handler → Control:  ack back into comms/control/acks/
{ "id": "ack-<uuid>", "ack_of": "ctl-<uuid>", "from": "claude-code",
  "result": "applied" | "rejected" | "noop", "detail": "…", "timestamp": "<iso>" }
```

- **EVICT** is the worked example (reclaim a stale/orphaned lane an agent is holding) because it is the
  most common control action that *must* be acked — Control must not show a lane as freed until the
  owner confirms it released it. The same ack-envelope shape generalizes to dispatch/cancel/nudge.
- **Honest UI:** until the ack lands, Control shows the action **pending**, not done. A `rejected` ack
  (the agent refused / is mid-write) surfaces as a `finding_report`-style note, never a silent drop —
  consistent with the cross-agent protocol's "report honestly / surface drift as findings" rule.
- **Idempotency:** acks honor the existing `inboxState.ts` read-once → `_state/` → `processed/` ledger
  so a re-read never double-applies.

---

## 5. Phased milestone plan

Each phase is independently shippable and **read-only until P3** (no control actions leave Control
until the read model and handoff are proven). "Must be true first" gates each phase.

### P1 — Read-only multi-project board + roster
- **Scope:** Tauri shell; project registry (`projects.json`) + auto-discovery from beacons; watcher
  over `~/.autoclaw/beacons/` + each project's `comms/`; aggregator (`buildFleetDashboard` per project +
  `rollupFleet`); render roster + four-lane board + Done lane + session list via the **reused**
  `webview-render*.ts`; **Open-in-IDE ladder** (§3) wired for click-through. **No dispatch, no writes.**
- **Effort:** Medium. The renderers and `buildFleetDashboard`/`fleetData.ts` port as-is; net new =
  Tauri scaffold + watcher + `rollupFleet` + the project registry. Optionally start the watcher as a
  Node/`chokidar` sidecar to reuse `fleetData.ts` directly (§2.2).
- **Dependency:** the host-free renderers (shipped) + `fleetData.ts`/builders (shipped) + beacon read
  (shipped).
- **Must be true first:** renderers stay `vscode`-free (true today — guard with the existing
  webview-rendering unit tests, run from Control's package too). Beacon `workspace`/`machine_id` fields
  populated (they are). At least one project writing beacons.

### P2 — Token / cost meters
- **Scope:** add the per-agent / per-task / per-sprint **token + cost** column to the roster and board
  cards. Read the existing cost-ledger entries (`CostLedgerEntry`, already consumed by
  `fleetData.ts`) + `current_llm` on beacons; render the meters the renderers already support.
  Cross-project roll-up = "who burned what, across all repos."
- **Effort:** Small–medium. The ledger + model catalog (`contextWindowForModel`) already exist; this is
  a column + a roll-up, no new capture.
- **Dependency:** P1 read model; cost ledger present per project (it is, where orchestrate ran).
- **Must be true first:** runners surface usage into the ledger (true for some, inferred for others —
  **label confidence**; an external runner's count is unverified). FLEET-DIGEST (§4.1) carries the cost
  roll-up so Control reads it without re-summing.

### P3 — Dispatch controls (reuse the extension's safe commands)
- **Scope:** turn on the **dispatcher** (§2.4): re-dispatch / cancel / nudge / **EVICT** a stale lane,
  written as comms envelopes into the target project — **reusing the exact same command paths and
  envelope shapes the extension already exposes** (Control does not invent control verbs). Close the
  loop with the **EVICT ack-envelope** (§4.2): pending → applied/rejected/no-op.
- **Effort:** Medium. The envelope writers + idempotency exist; net new = the control/ folder
  convention, the ack reader, and the pending-state UI.
- **Dependency:** P1 (roster to act on) + P2 (so an action is informed by cost) + the ack-envelope
  convention landing in the extension's handler first.
- **Must be true first:** an IDE-resident handler **acks** control envelopes (build it in the extension
  *before* Control writes any) — otherwise Control would issue fire-and-forget actions with no honest
  feedback, violating "report honestly." Control's own beacon + reserved `control` id exist so intents
  are attributable. Hard rule: Control still **never edits code files and never runs a vendor agent** —
  it only writes request envelopes; execution + scope/trust enforcement stay in the IDE/runner host.

### P4 — Cross-machine + signed control auth
- **Scope:** aggregate beacons/digests from **other machines** (the existing relay lane,
  `src/cloud/relay.ts` / `relay-server/*`, forwards beacons with `host`/`workspace`/`origin`); Control
  reads the relayed set. **Sign control envelopes** so a cross-machine EVICT/dispatch is authenticated
  (a remote IDE must verify the issuer before applying). Adopt `acp/1`'s signing/pin-on-first-use posture
  for the control plane.
- **Effort:** Medium–large. Relay is shipped-but-inert; signing/verification + a key the IDE pins is the
  real new work (mirrors the `acp/1` runner-governance signing chain, scoped down to control intents).
- **Dependency:** P3 (a control action to sign) + relay configured + a signing trust root decision
  (the open `acp/1` question: who holds the publisher/issuer key).
- **Must be true first:** relay deployed and forwarding beacons; an agreed signing root + the IDE-side
  verifier (an unsigned cross-machine control envelope must **fail closed**, same posture as
  `validateScopeFile`). Cross-machine rows already render in P1 (badged); P4 makes them *actionable*.

### P5 — Mobile glance over Tailscale
- **Scope:** a read-only mobile/web view of the aggregated fleet, served from the desktop Control over
  **Tailscale Serve** behind a short-lived signed invite + QR (the Coven Cave recipe cited in the
  strategy memo §1A — desktop keeps the watcher/aggregator, the phone is a thin client rendering the
  served URL). Notify-when-input-needed push.
- **Effort:** Medium. Reuses P1–P2 render output served over HTTP; the new bits are the Tailscale serve
  wrapper, the signed invite, and a phone-friendly layout pass on the host-free HTML.
- **Dependency:** P1/P2 aggregation (so there's something to serve) + Tailscale on the host.
- **Must be true first:** the aggregated model is served over a local HTTP endpoint (a small addition to
  the Tauri host); invite signing reuses P4's signing root. **Read-only first** — mobile dispatch is out
  of scope until signed control (P4) is proven on desktop.

**Critical path:** P1 → P3 are the spine (read → meter → act). P4/P5 are independent extensions off the
P1 aggregation + the P4 signing root, and can be deferred without blocking the core value.

---

## 6. Risks

- **Data-shape drift extension ↔ app.** Control reuses the extension's model types and renderers; if the
  extension changes `FleetDashboardModel` / board / beacon shapes, Control silently mis-renders.
  **Mitigation:** Control imports the **same TS modules** (`webview-render*.ts`, `fleetViewModelBuilders`,
  `beacons.ts`) from a shared package rather than copying — one definition, one set of unit tests run
  from both surfaces. Treat the FLEET-DIGEST file as a **versioned** artifact (carry a `schema`/`acp`
  tag) so a stale Control degrades to the live walk instead of mis-parsing. This is the
  `acp/1` "unknown future fields preserved on round-trip" discipline applied to the digest.
- **Packaging.** Two binaries to sign/ship (Windows `.msi` + the VS Code `.vsix`), each with its own
  CI. Windows path/space bugs have repeatedly bitten the extension; a native app multiplies the surface
  (installer, autostart, file-watch handles, code-signing cert). **Mitigation:** Tauri's first-class
  Windows `.msi` (proven by Coven Cave); reuse the existing `.vscodeignore`/size-guard discipline for
  the app bundle; keep Control's footprint single-digit MB (the reason Tauri over Electron).
- **Two surfaces to maintain.** A standalone app is a second onboarding story and a second bug queue.
  **Mitigation:** the extension stays the **free zero-config on-ramp** (writes beacons, runs agents);
  Control is the **Pro/Team observability surface** that adds nothing the extension must depend on.
  Maximize shared code (renderers, builders, beacon/comms readers) so the app is *mostly* the watcher +
  aggregator + Tauri shell — i.e. minimize the second surface's *unique* footprint.
- **FLEET-DIGEST producer ownership.** When **no IDE is open** on a project, nobody writes its
  `fleet-status.json`. **Mitigation:** Control falls back to the live tree walk (the digest is a cache,
  never the source of truth); optionally a tiny standalone refresh service (precedent: the standalone
  intel-refresh service, PR #35) owns the write headlessly. Decide at P3.
- **Control dispatch with no acker.** If Control writes control envelopes before any IDE acks them, it
  reports actions as done that never applied. **Mitigation:** the P3 gate — build the IDE-side
  ack-envelope handler **first**; show **pending** until acked; surface `rejected` as a finding.
- **Cross-machine trust.** A cross-machine EVICT is a remote actor mutating another box's fleet.
  **Mitigation:** P4 signing + fail-closed verification; until then cross-machine rows are
  **read-only/badged**, never actionable.

---

## 7. Non-goals (explicit — guard against scope creep)

1. **Control is not an editor.** It does not open, edit, or render code files for editing. It is an
   *observer + dispatcher*. The "Open in IDE" ladder hands editing **back** to the real IDE.
2. **Control does not run vendor code.** It never spawns a Claude/Codex/Kilo/Hermes process, never
   holds a model API key, never executes a dispatch itself. It writes a **request envelope**; the
   IDE/runner host executes it under that host's scope/trust enforcement (`acp/1`: the host — not the
   observer — holds enforcement; CI holds merge authority).
3. **Not a fork of VS Code.** No Electron clone, no editor surface, no plugin host. The footprint
   argument (Tauri, single-digit MB) only holds if it stays an observer.
4. **No new coordination protocol.** Control reads the **existing** beacon + comms file-bus and writes
   the **existing** envelope. FLEET-DIGEST and the EVICT ack-envelope are *conventions on the existing
   tree*, not a second bus. If a feature needs a new protocol, it belongs in `acp/1`, not here.
5. **Not the source of truth.** The per-project `comms/` tree is canonical; FLEET-DIGEST is a cache.
   Control never writes anything an IDE-resident reader couldn't have written.

---

## 8. One-line summary

*Build AutoClaw Control as a Tauri observer that watches `~/.autoclaw/beacons/` + every project's
`comms/` tree, aggregates N workspaces into one cross-project read model fed to the **already host-free**
`webview-render*.ts` renderers, hands clicks back to the editors via the reused four-rung deep-link
ladder, and dispatches **only** as request envelopes on the same file-bus (per-project FLEET-DIGEST as
the read primitive, EVICT ack-envelope for honest control feedback) — shipping read-only multi-project
board first (P1), then cost meters (P2), dispatch (P3), cross-machine + signed control (P4), and mobile
over Tailscale (P5) — never an editor, never running vendor code.*
