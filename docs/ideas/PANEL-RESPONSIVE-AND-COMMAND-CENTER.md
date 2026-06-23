# Panel Responsiveness + Companion Command Center

> AutoClaw initiative tracking doc — kicked off 2026-06-22. Built on branch
> **`feat/panel-responsive-command-center`**. No code in this doc; it captures the
> problem, the plan, the decisions, and the open questions so the work stays scoped.
>
> **Parent strategy:** [MULTI-AGENT-WORKSPACE-VISIBILITY-AND-CONTROL-PLANE.md](./MULTI-AGENT-WORKSPACE-VISIBILITY-AND-CONTROL-PLANE.md)
> (the standalone-vs-extension memo). This initiative is the *near-term, in-extension*
> half of that strategy's "Manager Surface upgrade inside the existing panel" (Idea 2) plus
> the first dispatch seam toward the eventual standalone **AutoClaw Control** (Idea 1). The
> visual surfaces are explicitly treated as commoditized/table-stakes there; the moat is the
> coordination data underneath — so this work is *make the existing surface legible at any
> width* + *let the human dispatch intents*, not a UI rebuild.

---

## 0. TL;DR

The unified panel renders into a VS Code **sidebar dock that is routinely 240–300px wide**, but
several sections were laid out assuming a comfortable editor-column width. Two of them **break
hard** at dock width (content overflows or clips), the rest degrade. This initiative:

1. Makes all three panel stylesheets **responsive across four container bands** so nothing
   overflows or clips from ~240px up to a full editor tab.
2. Adds a **Command Center** affordance that lets the human *dispatch intents* (join/invite/
   admit/decline now; evict later) over the existing file-bus — **execution stays in the IDEs**.
3. Sequences a shared **FLEET-DIGEST** read substrate (`fleet-status.json`) *first*, because both
   the responsive board and the Command Center want one cheap, pre-rolled status read.

Everything is additive and in-extension. The standalone surface remains a *later* bet
(AUTOCLAW-CONTROL-TAURI-PLAN.md), and destructive lifecycle (EVICT) is designed separately
(EVICT-AGENT-LIFECYCLE.md) so it can carry its own safety review.

---

## 1. The narrow-panel problem

The panel HTML/CSS lives in three independently-loaded webviews, each with its own stylesheet:

| Stylesheet | Webview | Host markup |
|---|---|---|
| `src/webview/kdream-dashboard.css` | the **visible sidebar** panel (KDreamViewProvider) | board markup injected at `src/extension.ts:2298` (`#board-body`) by `src/webview-render-board.ts` / `src/webview-render.ts` |
| `media/panel/fleet.css` | the Fleet dashboard webview | `media/panel/fleet.html` (`#board-body` at line 25), wired in `media/panel/fleet.js` |
| `media/intelligence/dashboard.css` | the Intelligence metrics dashboard | `media/intelligence/dashboard.*` |

### 1A. Critical failures (these break, not just degrade)

**BOARD-OVERFLOW — the kanban cannot fit the dock, and nests two scroll axes.**
`.board-kanban` is a horizontal flexbox of **5 columns** (backlog → in progress → review →
blocked → done), each `flex: 1 1 0` with **`min-width: 132px`**
(`src/webview/kdream-dashboard.css:1175-1216`). 5 × 132px + 4 × 6px gaps ≈ **684px of minimum
content width**. In a 240–300px dock that overflows by >2×, so the column's own
`overflow-x: auto` kicks in — and because the board sits inside the section body, the user gets a
**nested two-axis scroll** (horizontal inside the board, vertical for the page), which is the
worst-case sidebar UX: columns are unreadable slivers and the horizontal scrollbar is easy to
miss. File refs: `.board-kanban` / `.board-col { min-width: 132px }` in
`src/webview/kdream-dashboard.css`; container `#board-body` at `src/extension.ts:2298` and
`media/panel/fleet.html:25`; board emitted from `src/webview-render-board.ts:296`
(`<div class="board-kanban">`).

**AGENTHEAD-NOWRAP — the agent card summary line clips its own metadata.**
`.agent-card-head` is a single-line flex row with **no `flex-wrap`**
(`src/webview/kdream-dashboard.css:161-169`). The head is packed with chips by
`src/webview-render.ts:479-528`: chevron, status-pill, **agent-name**, optional **you-pill**,
**role-chip**, **agent-id** (ellipsis), **agent-platform** (`margin-left:auto`), **agent-model**,
optional **origin-badge**, **awaiting-pip**, and a **workload-pip** (*also* `margin-left:auto`).
Two competing `margin-left:auto` elements plus a non-wrapping row means at dock width the later
chips (platform/model/workload) are pushed off the edge and clipped — the at-a-glance signals
(model, "done today") vanish exactly when the user most needs the compact view. File refs:
`.agent-card-head` (no wrap) `src/webview/kdream-dashboard.css:161`; `.agent-platform`
`margin-left:auto` line 280; `.workload-pip` `margin-left:auto` line 1240; head assembly
`src/webview-render.ts:479-528`.

### 1B. Secondary failures (degrade / look bad, don't hard-break)

- **Two-up grids collapse to slivers.** `.card-grid` uses
  `repeat(auto-fill, minmax(180px, 1fr))` (`media/panel/fleet.css:107-111`) and
  `.cards` uses `minmax(110px, 1fr)` (`media/intelligence/dashboard.css:113-118`). At <360px the
  180px floor forces 1 column anyway (fine), but in the 360–540px band auto-fill yields awkward
  1.x-column whitespace rather than a clean 2-up snap.
- **Fixed-width meters overflow their row.** `.queue-bar { width: 80px }`
  (`src/webview/kdream-dashboard.css:389`) and `.detail-label { min-width: 110px }` (line 357)
  don't shrink; in a narrow `agent-detail-row` they force horizontal overflow before the value
  even renders.
- **Wide tables clip.** `table { table-layout: fixed }` with `white-space: nowrap` th/td
  (`src/webview/kdream-dashboard.css:116-131`) and the fleet `.board-table` / `.health-grid`
  (`media/panel/fleet.css:88-103, 262-277`) ellipsis-truncate aggressively at dock width — columns
  past the second become unreadable.
- **Toolbars wrap but buttons keep a min-width floor.** `button.action { min-width: 56px }`
  (`media/intelligence/dashboard.css:56-66`) and the quick-actions bar
  (`src/webview/kdream-dashboard.css:21-40`) wrap OK but the floor can still push a 2-button row to
  3 lines at the narrowest band.
- **Activity / message feeds** (`.activity-feed`, `.msg-feed`) are fine vertically but their inline
  rows (time + kind + text) rely on `white-space: nowrap` text that ellipsis-clips early.

All secondary items are "tighten the existing rules at the narrow band," not structural rewrites.

---

## 2. Responsive plan — four container bands across three stylesheets

The fix is **container-driven responsiveness**, not viewport media queries, because each of these
webviews can be docked narrow *or* opened as a full editor tab and the same CSS must serve both.

**The container hook is `#board-body`** (and the analogous section bodies), **not the `:has()`
selector** — `:has()` support is uneven across the Electron/webview versions we ship to, and
container queries on a known wrapper id are the portable, testable choice. We size against the
section body's inline size, so the board reflows to *its* width regardless of viewport.

### 2A. The four bands

| Band | Container width | Layout intent |
|---|---|---|
| **Stacked** | **< 360px** | Single column everywhere. Kanban becomes **vertical lane stack** (each lane = a collapsible group, no horizontal scroll). Card heads **wrap** (`flex-wrap`), grids force 1-up, meters/labels drop their fixed mins. This is the default dock case (240–300px) and must be flawless. |
| **Snap 2-up** | **360–560px** | Two columns where it helps: `.card-grid` / `.cards` snap to a clean 2-up; board may show **2 lanes side-by-side with the rest stacked** (or 2-up paged). Card heads still wrap as needed. |
| **Auto-fit** | **560–760px** | Let `auto-fit`/`auto-fill` breathe to 3-up; board shows 3–4 lanes; tables show more columns. |
| **Full** | **> 760px** | Full layout: all 5 kanban lanes in a row (the current design, which is correct at this width), wide tables, multi-column grids. |

### 2B. Per-stylesheet work

- **`src/webview/kdream-dashboard.css`** — the heaviest lift (owns the kanban + agent cards).
  - `.board-kanban` / `.board-col`: drop `min-width: 132px` to a band-aware floor; below 360px
    switch the flex-row to a **column stack** (lanes vertical) so the two-axis scroll disappears.
  - `.agent-card-head`: add `flex-wrap: wrap` and resolve the **double `margin-left:auto`** (only
    one auto-spacer per row; push the second cluster onto a wrapped line at narrow widths).
  - `.queue-bar` width, `.detail-label` min-width, `table` columns: band-aware shrink.
- **`media/panel/fleet.css`** — `.card-grid` `minmax(180px…)` → band-aware (2-up snap at 360–560);
  `.board-table` / `.health-grid` column hiding/stacking at narrow; presence-bar already wraps.
- **`media/intelligence/dashboard.css`** — `.cards` `minmax(110px…)` 2-up snap; `button.action`
  `min-width: 56px` relaxed at the narrowest band; charts already `width:100%`.

### 2C. Notes

- Already-good patterns to preserve: `box-sizing: border-box` everywhere, `overflow-x: hidden` on
  body, `word-wrap`/`overflow-wrap`, the existing `@media (max-width: 300px)` block in
  `kdream-dashboard.css:962-982` (fold its rules into the new <360 band so we don't have two
  competing narrow rules).
- Verify on **dark / light / high-contrast** themes (all three sheets are token-driven, so this is
  cheap) and across the Electron/webview floor we ship to.
- Tests: extend `src/test/board-rendering.test.ts` / `webview-rendering.test.ts` where structural,
  but most of this is visual — capture before/after screenshots at 260 / 420 / 640 / 900px.

---

## 3. The Command Center decision

**Decision: the Command Center DISPATCHES intents; it does not execute them.** It writes intent
messages onto the **existing file-bus** (the `comms/` inbox tree) and lets the agents/IDEs that own
execution pick them up. This keeps the panel a thin, safe control surface and avoids the panel
becoming a process supervisor.

- **P1 wires only safe, already-shipped commands.** The commands the panel already contributes and
  that are non-destructive: **`joinPrompt`** (generate an agent-join prompt — `autoclaw.fleet.joinPrompt`),
  **`invite`**, **`admit`**, **`decline`** (the pending-agents tray, FF-3 — see the
  `.pending-*` styles in `kdream-dashboard.css:880-943`). These are already real, already
  reversible, and already file-bus-backed, so wiring them into a single Command Center affordance is
  low-risk and ships in P1.
- **EVICT is designed separately.** Removing/killing an agent is destructive and needs its own
  safety model (grace period, reclaim of its claims, audit trail). It is intentionally **out of
  P1** and tracked in its own doc → **[EVICT-AGENT-LIFECYCLE.md](./EVICT-AGENT-LIFECYCLE.md)** *(to
  be authored)*. The Command Center will surface an EVICT slot but it stays disabled until that doc
  lands.
- **Single-window until the standalone.** The Command Center is, by construction, still inside one
  VS Code window — it can dispatch to agents on the file-bus, but it **cannot see across windows /
  projects / machines**. That cross-window single-pane is the job of the eventual **AutoClaw
  Control** standalone, tracked in **[AUTOCLAW-CONTROL-TAURI-PLAN.md](./AUTOCLAW-CONTROL-TAURI-PLAN.md)**
  *(to be authored)* and in the parent strategy memo (Idea 1). The Command Center built here is the
  **R&D bench** whose dispatch verbs Control later reuses — so design the intent schema to be
  surface-agnostic from day one.

This mirrors the parent memo's repeated guidance: don't rebuild VS Code; the panel/Command Center
is an *observer + dispatcher*, and the standalone Control is the cross-window aggregator.

---

## 4. FLEET-DIGEST — the shared read substrate (sequenced first)

Both the responsive board and the Command Center want **one cheap, pre-rolled status read** instead
of each surface re-walking the `comms/` tree. So the first deliverable is a **fleet digest**:

- A single **`fleet-status.json`** rolled up by the extension (roster + per-agent status/role/model
  + board lane counts + pending-invite tray + awaiting-you counts), written alongside the existing
  comms tree.
- All three webviews read the digest instead of recomputing; the Command Center reads the same file
  to know what intents are valid (who can be admitted/declined, who holds which claim).
- It is the natural **seam toward AutoClaw Control**: Control's file-watcher reads the *same*
  `fleet-status.json` per project, so the read model is built once and reused above the editors.

**Sequence:** FLEET-DIGEST (read model) → responsive bands consume it → Command Center dispatch
consumes it. Building the digest first means the responsive work and the dispatch work share one
data shape and don't drift.

> Overlap note: per-agent workload, board lane membership, and the pending tray are *already
> computed* today (see §7) — FLEET-DIGEST consolidates those existing rollups into one file rather
> than inventing new metrics.

---

## 5. Ranked additional ideas

Ordered by leverage; all in-extension and additive unless noted.

1. **Container-query polyfill / fallback audit.** Confirm container queries render on the lowest
   Electron/webview we ship; if a target lacks support, fall back to a width-class set by the host
   JS on `#board-body` (measure → add `.w-narrow|.w-mid|.w-wide`). De-risks the whole §2 plan.
2. **Board "lane focus" at narrow width.** Below 360px, instead of stacking all 5 lanes, default to
   showing one lane (e.g. *In Progress*) with a compact lane-switcher — fewer pixels, more signal.
3. **Collapse-to-summary card mode.** A density toggle that renders agent cards as one-line rows
   (name + status dot + workload pip only) for the narrowest dock, expanding on click.
4. **Command Center as a command palette.** Surface the safe intents (join/invite/admit/decline)
   both as buttons *and* as quick-pick entries, so they work even when the panel is too narrow to
   show a button row.
5. **Per-lane horizontal-scroll affordance.** If any band still needs horizontal scroll, add an
   explicit "← →" lane pager rather than relying on a hidden native scrollbar.
6. **Digest-backed completion toasts.** Once `fleet-status.json` exists, diff it between writes to
   fire notify-when-input-needed toasts (the Manager-Surface idea from the parent memo) cheaply.
7. **Sticky section headers** so that when a section body scrolls, the section title stays put — a
   small legibility win at dock width.

---

## 6. Open questions for the maintainer

1. **Band breakpoints** — are 360 / 560 / 760 the right cut points for *your* typical dock widths,
   or do you dock narrower (≤260) often enough that the stacked band should be the design target and
   the rest treated as bonus?
2. **Narrow board behavior** — at <360px, do you prefer **all lanes stacked vertically** (scan
   everything) or **single-lane focus + switcher** (idea 5.2, less scrolling)?
3. **Command Center placement** — its own panel section, a header toolbar, or both a section *and* a
   command-palette entry (idea 5.4)?
4. **EVICT urgency** — does EVICT need to ship in this initiative, or is splitting it into
   EVICT-AGENT-LIFECYCLE.md (with its own safety review) acceptable for now?
5. **FLEET-DIGEST location** — write `fleet-status.json` under the per-project `comms/` tree, or
   under `~/.autoclaw/` so a future Control reads one well-known path per machine?
6. **Three sheets, one system?** — worth extracting the shared band tokens/rules into a tiny common
   stylesheet imported by all three, or keep them independent (current state) and accept some
   duplication for isolation?

---

## 7. Overlap map — what already ships (so nothing gets rebuilt)

Before building, here is what's already on disk; this initiative *reuses* it, not replaces it.

| Capability | Already exists | This initiative |
|---|---|---|
| Kanban board (5 lanes, cards, threads) | `src/webview-render-board.ts` (`.board-kanban` from line 296), styles `kdream-dashboard.css:1175+`, container `#board-body` (`extension.ts:2298`, `fleet.html:25`) | Make it **responsive** (band-aware lanes); do not re-author the board. |
| Agent cards + per-agent workload pip | `src/webview-render.ts:479-528`, styles `kdream-dashboard.css:1238+` | Fix **AGENTHEAD-NOWRAP** wrapping; reuse the workload data. |
| Pending-agents tray (invite/admit/decline) | FF-3 — `.pending-*` styles `kdream-dashboard.css:880-943`, commands wired in `extension.ts` | **Command Center P1** wires these safe verbs; tray UI stays. |
| Agent-join prompt generator | `autoclaw.fleet.joinPrompt` (commit `bf9591f`), doc [AGENT-JOIN-AND-FLEET-VISIBILITY.md](./AGENT-JOIN-AND-FLEET-VISIBILITY.md) | Surface **`joinPrompt`** as a Command Center verb. |
| Narrow-sidebar CSS | existing `@media (max-width: 300px)` block `kdream-dashboard.css:962-982` | **Fold into** the new <360 stacked band (avoid two competing rules). |
| Fleet/intel dashboards | `media/panel/fleet.*`, `media/intelligence/dashboard.*` | Add the same four bands to their sheets. |
| File-bus comms / claims / consensus | shipped core (`comms/` tree, FS-as-mutex claims) | Command Center **dispatches intents onto it**; execution unchanged. |
| Cross-window single-pane | **does not exist** (structural — an extension can't) | Out of scope here → **AutoClaw Control** standalone (AUTOCLAW-CONTROL-TAURI-PLAN.md). |
| Destructive agent lifecycle (evict/kill) | **does not exist** | Out of scope here → **EVICT-AGENT-LIFECYCLE.md** (own safety review). |
| Pre-rolled fleet read model | **does not exist** (each surface re-walks `comms/`) | New: **FLEET-DIGEST `fleet-status.json`** (§4), built first. |

---

## 8. Sibling docs

- Parent strategy: [MULTI-AGENT-WORKSPACE-VISIBILITY-AND-CONTROL-PLANE.md](./MULTI-AGENT-WORKSPACE-VISIBILITY-AND-CONTROL-PLANE.md)
- Join model + fleet visibility: [AGENT-JOIN-AND-FLEET-VISIBILITY.md](./AGENT-JOIN-AND-FLEET-VISIBILITY.md)
- EVICT lifecycle (to author): EVICT-AGENT-LIFECYCLE.md
- Standalone control plane (to author): AUTOCLAW-CONTROL-TAURI-PLAN.md
- Session/message tracking (Control reuses its deep-link rows): [CHAT-SESSION-MESSAGE-TRACKING.md](./CHAT-SESSION-MESSAGE-TRACKING.md)
