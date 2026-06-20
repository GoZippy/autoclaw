# Multi-Agent Workspace Visibility & the Control-Plane Question

> AutoClaw strategy memo — generated 2026-06-19 via a 6-stream parallel research workflow
> (Cursor / Antigravity / visualization-tool landscape / power-user workflows /
> standalone-vs-extension trend / heterogeneous interop) + synthesis. Exploratory.

## 0. The question behind the question

The maintainer runs **many** VS Code / Kiro / Cursor windows across many projects, each with
AutoClaw orchestrating heterogeneous agents (Claude Code, Codex, Kilo, …). It works for
*coordination* but the **desktop is a mess**: past 2–3 chat sessions per project, VS Code's tab
model hides work and the human loses the thread. The ask: how do we let a human *manager* see
many agents working at once — with accountability, task assignment, and token/cost tracking —
and should AutoClaw stay a VS Code extension or follow the industry toward a standalone app?

**The central finding of this research:** *the window-sprawl pain is structural.* An extension
lives **inside one of the windows that is causing the mess**, so it can never show you the other
windows, the other projects, or the other machines. Every credible 2026 answer to "one human,
many agents, many repos" is a **separate surface that sits above the editors** (Cursor 3 Agents
Window, Google Antigravity Manager, Warp Oz, GitHub Copilot desktop app, Conductor). AutoClaw's
existing panel work is necessary but **cannot, by construction, be the whole answer.**

The good news: AutoClaw already owns the hard part everyone else is missing — **heterogeneous,
cross-vendor, cross-machine *coordination*** (file-bus + MCP + beacons + consensus + local-first
intelligence). The competitors ship *parallelism within one vendor's app*. None ship
*coordination across vendors and machines*. That is the moat to lead with.

---

## 1. What the research found (condensed)

**Cursor (2.0 Oct 2025 → 3.0 Apr 2026).** Rebuilt "around agents rather than files." 3.0's
**Agents Window** unifies *every* agent session — local + cloud, started from desktop / web /
Slack / Linear / GitHub PR — into **one sidebar inbox**, explicitly fixing "one session per
window, no unified view." Agent chats are normal editor tabs (split-pane, grid). Up to 8 parallel
agents in **git worktrees**; "best-of-N judging." In-house Composer model + cloud execution =
margin + lock-in. Complaints: pricing whiplash, >5 agents → judging latency / crashes, 2.0
redesign "lost functionality / overwhelming."

**Google Antigravity (Nov 2025).** Standalone agent-first IDE with **two surfaces in one app**:
an *Editor View* and a separate **Manager Surface** ("mission control") where you spawn / observe
**multiple parallel agents across workspaces** and don't write code. **Artifacts** (plans,
task-lists, screenshots, **browser-session recordings**) are the accountability layer — you verify
"at a glance" instead of reading diffs, and **comment on an Artifact like a Google Doc** and the
agent absorbs it *without halting*. Plan-before-execution gate; completion notifications.
Complaints: brutal rate limits / multi-day lockouts, instability, single-vendor (Gemini-only), no
plugin surface.

**Visualization-tool landscape.** Recurring primitives: **worktree-per-agent isolation**
(Conductor, Crystal, Vibe Kanban, Claude Squad), **kanban dispatch board**, **unified
diff/review-merge queue**, **session grid**, **notify-only-when-input-needed**, and **MCP as the
status bus**. The in-VS-Code option, `padjon.vscode-agent-grid`, is just tmux panes (77 installs,
WSL-only). **CORRECTION (2026-06-19):** an earlier draft of this memo called "OpenCoven / Coven
Cave" a phantom — that was a research miss (an agent matched an unrelated `2389-research/coven`).
**OpenCoven is very real and central — see the dedicated section "§1A" below; the maintainer has
forked both repos.** **Gaps nobody fills:** heterogeneous coordination *inside the editor*, cross-machine fleet
visibility, **per-agent token/cost meters** (though Coven Cave *does* fill this — §1A), and Windows-native. **Embeddability verdict:** kanban,
session grid, per-task threads, diff queue, token meters, consensus UI are all **webview-friendly**;
only container isolation, interactive terminals-at-scale, true remote execution, and mobile push
**need a host process / standalone surface.**

**Power-user workflows.** The dominant substrate is **git worktree + tmux** (one worktree per
agent/branch, one pane to watch each); Boris Cherny calls worktrees the "single biggest
productivity unlock." The referenced YouTube video (`nj_nVIfXRA8`, *pookie*) is literally "How to
Set Up Tmux for AI Coding Agents." The Reddit post was unfetchable, but the canonical r/ClaudeAI
pattern it matches is **coordinator-session + worker-sessions sharing a markdown task file** — the
manual ancestor of Claude Code Agent Teams. **The real bottleneck is human review, not spawning
agents** (Simon Willison: "I can only review and land one significant change at a time"; Addy
Osmani: enforce **WIP limits**). Implication: the differentiator is not *more agents*, it's
*making one human's review throughput keep up*.

**Standalone vs extension trend.** Gravity is toward **standalone agent surfaces**; the winners
**hedge with "both"** — a standalone agent/control plane *plus* a familiar editor reach (Windsurf
plugins for 40+ IDEs, Antigravity 2.0 you "dual-wield," Copilot's new desktop app + extension).
Augment's "DIY multi-agent vs Intent" thesis: **past ~3–5 agents, coordination complexity (merge
conflicts, spec drift, observability collapse, port/DB clashes) becomes the hard part, and
building that layer yourself means owning its maintenance** — which is *exactly* AutoClaw's
existing job. Complaints about **forks**: upstream-merge tax, Electron bloat, hidden windows.
Complaints about **standalone**: ecosystem loss, lock-in, "yet another app." **Nobody owns mobile.**

**Interop (the Hermes/OpenClaw question).** **MCP** = how an agent *acts on* a shared board;
**A2A** (now Linux Foundation, 150+ orgs) = how agents *describe themselves + pass tasks*; ACP/AG-UI
are orthogonal. AutoClaw already exposes the board as MCP tools (`presence.beacon`, `claim.task`,
`consensus.vote`, `inbox.read`, `fleet.status`) and a beacon tree. The lightest path to "any agent
joins": **keep the file-bus as the source of truth; expose it via MCP (done) + an A2A Agent Card +
a 3-verb adapter SDK (`announce / claim / report`).** This is **already fully designed** in
[STANDARDIZED-ADAPTER-A2A-PLATFORM.md](./STANDARDIZED-ADAPTER-A2A-PLATFORM.md) (acp/1) — see §3 idea 5.

---

## 1A. Reference learnings from OpenCoven + Coven Cave (study, don't depend)

The maintainer pointed to `github.com/GoZippy/coven` and `github.com/GoZippy/coven-cave-zippy`
(forked 2026-06-19, both **clean mirrors — 0 ahead / 0 behind**) as **prior art to learn from, not a
dependency to bake in.** Treat them exactly that way: a deep read validates several of our ideas and
hands us concrete, de-risked *implementation patterns* — but AutoClaw builds its own surfaces and
does **not** take a runtime dependency on Coven (Windows blocker, AGPL on Cave, upstream PRs closed
until July 2026, and we don't want our coordination moat sitting on someone else's daemon). Below:
what they are, what they prove, what to harvest, and what stays distinctly ours.

**Coven** (`OpenCoven/coven`, MIT, Rust) — a *local-first runtime substrate*. A Rust **daemon** owns
agent sessions in SQLite, **PTY-supervises** harness CLIs inside a hard project-root jail, and
exposes a **versioned socket API** (`coven.daemon.v1` over `~/.coven/coven.sock`:
`health`/`capabilities`/`sessions`/`events`/`actions`). Harnesses are **data, not code** — a new
agent is a **JSON adapter manifest** (`coven adapter install hermes` writes one; prompt appended as
final argv, no `sh -c`). **Hermes ships as a built-in recipe; OpenClaw connects as an ACP *client*
of the daemon.** It also has a *git-native Parallel Work Protocol* (worktrees + TTL claims at
`<git-common-dir>/agent-claims/` + guard hooks). **But it has NO message bus / inboxes / consensus /
cross-agent messaging** — that's "Phase F," explicitly unbuilt. **macOS/Linux only** (Windows x64 is
*staging*; recent commits are Windows-socket fixes). PRs closed until **July 2026**.

**Coven Cave** (`OpenCoven/coven-cave`, AGPL-3.0/MIT, **Tauri 2 + Next.js 16 / React 19**, v0.0.104,
ships **Windows `.msi`** / Linux AppImage / macOS dmg) — *the desktop operator GUI*. A single-page
shell with `Cmd+1–8` surfaces: **Chat · Board · Calendar · Inbox · Library · Browser · Terminal ·
Roles · Workflows · Projects · Capabilities**. It already ships almost everything I listed as
"build":
- **Kanban Board** with full lifecycle (backlog→inbox→running→review→blocked→done), per-card
  `familiarId`/`sessionId`/`steps[]`/`github[]`/`retryCount`/`timeoutMs`/`needsHuman`, swimlanes by
  status/familiar/project, and **task→live-chat handoff** — i.e. Ideas 2 + 3, done.
- **"Coven Floor"** multi-familiar status board (active/stuck/idle/quiet, **subagent nesting trees**)
  — Idea 2's session grid, done and better.
- **Real token/cost/context meters** — parses Claude Code stream-json `result.usage` + `costUsd`,
  live context-window fill meter with a per-model catalog (opus-4-8 = 1M). **This is Idea 7, already
  shipped** — the "slot nobody fills" turns out to be filled here.
- **Mobile over Tailscale** (browser handoff + native iOS Tauri shell) — **Idea 8, already shipped.**
- Heterogeneous runtime adapters (codex/claude/hermes/openclaw); memory inspector + Library with
  **3D provenance timelines** (Three.js).

**What Cave explicitly LACKS — and it's exactly AutoClaw's shipped core.** Cave's own
`docs/multi-session-coordination.md` *proposes but has not built*: a surface-claim file, pre-commit
broadcast, and intent signals to prevent **orphaned/duplicate work**. That is precisely AutoClaw's
**file-bus comms, create-exclusive scope claims (FS-as-mutex), consensus voting, scope-violation
findings, beacons, reputation/HR routing, and local-first intelligence/RAG over past sessions.**
Coven only *plans* a coordination layer (Phase F); AutoClaw *ships* one.

**Patterns to harvest into AutoClaw's *own* roadmap** (the point of studying them):

| Learning from Coven/Cave | Folds into | Why it de-risks us |
|---|---|---|
| **Adapter = data, not code.** A harness is a JSON manifest: `executable` (PATH name only, never absolute), `interactive_prompt_prefix_args` / `non_interactive_prompt_prefix_args`, `system_prompt_flag`, `model_flag`; prompt appended as the **final argv** (no `sh -c`). Hermes/OpenClaw onboard as *recipes*. | **acp/1 (Idea 5)** | Validates our connector-manifest direction and gives a minimal, proven schema. Confirms the cleanest answer to "connect Hermes/OpenClaw" is a manifest, not bespoke code. |
| **Token/cost/context meters** by parsing the harness's own stream-json (`result.usage`: input/output/cache-read/cache-creation + `costUsd`) + a per-model context-window catalog (opus-4-8 = 1M) for a live fill meter. | **Token ledger (Idea 7)** | Turns Idea 7 from "someday" into a known recipe — we read the same stream the agents already emit. |
| **Board lifecycle schema:** card states queued→dispatched→running→review→completed/failed/cancelled, plus `needsHuman`, `timeoutMs`, `retryCount`/`maxRetries`, a `steps[]` checklist, swimlanes by status/agent/project. | **Review Queue (Idea 3) + Manager Surface (Idea 2)** | A concrete, battle-tested card model to copy instead of inventing. |
| **"Floor" status rollup:** per-agent active/stuck/idle/quiet with **subagent nesting** (`parentId`, `↳`), and a cross-agent **inbox** with snooze/resolve. | **Manager Surface (Idea 2)** | Exactly the session-grid + notify-when-needed UX we want; proves it works. |
| **Worktree isolation + TTL claims** at `<git-common-dir>/agent-claims/` + pre-commit/pre-push guard hooks; **PTY supervision + project-root jail** for hard scope enforcement. | **Worktree-per-task (Idea 4) + acp/1 scope-jail** | Confirms the substrate and the enforcement direction (audit → *prevent*). |
| **Mobile recipe:** Tailscale Serve + short-lived signed invite + QR; desktop keeps the daemon, phone is a thin client rendering the served URL (+ native iOS Tauri shell). | **Mobile glance (Idea 8)** | A proven, low-infra mobile path for when we get there — no app-store dependency. |
| **Versioned local API** pattern: mandatory `GET /health` handshake, capability negotiation, `actions` control-plane intents, `events` with an `afterSeq` cursor, structured error envelopes. | **AutoClaw Control's local read API (Idea 1)** | Good shape for however Control reads the comms/beacon data. |

**What stays distinctly ours (the moat — neither Coven nor Cave has it):** AutoClaw's
**coordination + consensus + intelligence** — file-bus comms, create-exclusive scope claims,
consensus voting, scope-violation findings, beacons, reputation/HR routing, and local-first RAG over
past sessions. Cave's own `docs/multi-session-coordination.md` *proposes but has not built* a
claim-file + intent-signal layer to stop orphaned/duplicate work — i.e. it independently confirms the
exact gap AutoClaw already fills. We keep building that; we just borrow their UI/manifest/metering
*recipes* to ship our own surfaces faster.

**Net effect on the ideas below:** none are dropped. Ideas 1/2/3/7/8 get *cheaper and more concrete*
because Coven/Cave proved the patterns; Idea 5 (acp/1) gets a validated manifest shape to adopt. We
build AutoClaw's own neutral, in-IDE-anchored surfaces — informed by, not dependent on, Coven.

---

## 2. Analysis frameworks (defined, since SWAMP is non-standard)

- **SWOT** — strategic *position*: Strengths · Weaknesses · Opportunities · Threats.
- **SWAMP** — execution *risk* (my working definition; adjust if you mean something else):
  **S**cope (what's in/out) · **W**ork (effort/size) · **A**ssumptions (what must hold) ·
  **M**onetization (revenue path) · **P**itfalls (failure modes).
- **MOAT** — *defensibility*: what makes this hard for Cursor/Antigravity/Warp to copy, and how
  durable that edge is.

---

## 3. The product ideas

Seven ideas, ordered by leverage. Two of them (5, 6) are **already designed** in your `docs/ideas/`
and just need scheduling; the rest are new here. The headline new bet is **Idea 1**.

### Idea 1 — **AutoClaw Control**: a standalone single-pane-of-glass *above* the editors

> **Note (per §1A):** Coven Cave is a useful *reference* for what this surface must do (board, floor,
> token meters, mobile) — borrow those recipes, but build AutoClaw's own neutral, coordination-native
> Control rather than depending on Cave/Coven.

A separate lightweight app (Tauri preferred over Electron for footprint; or a local web server you
open in a browser tab) that reads the **same** `~/.autoclaw/beacons/` + per-project `comms/` trees
that already exist — across **all** your open windows, projects, and machines — and renders **one**
manager dashboard: fleet roster, kanban board, per-agent **token/cost meters**, per-task threads,
and a **review queue**. Clicking a task does an **"Open in IDE" handoff** (the deep-link ladder
from your session-tracking doc). It is **read-the-files, not run-the-agents** — execution stays in
the IDEs/CLIs; Control is the cross-window *observability + dispatch* layer. This is the direct,
structural fix for "too many windows," and it mirrors Cursor 3's unified inbox, Antigravity's
Manager, and Warp Oz — but **heterogeneous and vendor-neutral**, which none of them are.

| Lens | Assessment |
|---|---|
| **S**trengths | Only this can see *across* windows/projects/machines — the actual pain. Reuses 100% of the existing file-bus/beacon data (no new protocol). Vendor-neutral by design. |
| **W**eaknesses | A second surface to build + maintain; "yet another app" onboarding friction; must stay in sync with the extension's data shapes. |
| **O**pportunities | Become the *Mission Control for heterogeneous fleets* category nobody owns; natural paid/Pro tier; gateway that can offer to install the other tools (worktree helper, adapters). |
| **T**hreats | Cursor/Warp/Copilot are racing into single-pane control — but each is vendor-locked; our wedge is neutrality. |
| **SWAMP** — Scope | In: cross-project read aggregation, kanban, token meters, review queue, IDE handoff. Out (v1): running agents, editing code, cloud exec. |
| Work | Medium-large. ~Tauri shell + reuse the webview renderers (they're already pure, host-free HTML modules) + a file watcher over beacon/comms roots. The renderers port nearly as-is. |
| Assumptions | Beacon/comms trees are the source of truth (true); renderers stay host-free (true today); users will run one extra app to *kill* N windows of confusion (the whole bet). |
| Monetization | Free extension as the on-ramp; **Control is the Pro/Team surface** (per-seat). Aligns with the existing license tiers. |
| Pitfalls | Building a heavy Electron clone of VS Code (don't — it's an *observer*, not an editor); data-shape drift between app and extension; scope creep into "also run agents." |
| **MOAT** | **High & durable.** The data it aggregates only exists because of AutoClaw's coordination protocol; a competitor would have to first build heterogeneous cross-vendor coordination (the thing they all skip). Neutrality is structurally hard for Cursor/Google/GitHub to copy (they monetize lock-in). |

### Idea 2 — **Manager Surface** upgrade inside the *existing* panel (ship now)

Before the standalone app, steal the proven UX into the webview you already have: a **session
grid** (all live chats across all tools as rows you can pivot/expand — you already have
`renderSessionList`), **completion toasts** (notify-only-when-input-needed), **plan-before-execute**
gate, and **comment-on-artifact** non-blocking feedback (Antigravity's best idea). Research
confirmed every one of these is webview-friendly. This is the *within-a-project* relief while
Control solves *across* projects.

| Lens | Assessment |
|---|---|
| SWOT | **S:** ships in the current architecture, no new app. **W:** still trapped in one window — relieves per-project clutter, not cross-project. **O:** validates the Manager UX patterns cheaply before porting them to Control. **T:** none material. |
| SWAMP | **Scope:** session grid + toasts + plan-gate + artifact-comments. **Work:** small–medium (reuses shipped render/postMessage/expand machinery). **Assumptions:** panel webview can hold it (yes). **Monetization:** free (drives adoption). **Pitfalls:** cramming a mission-control into a narrow sidebar — keep it a *full-tab* webview, not the sidebar. |
| MOAT | Low on its own (UI is commoditized) — but it's the **R&D bench** for Idea 1 and the place the coordination data first becomes legible. |

### Idea 3 — **Review Queue / PR-packet view + WIP limits** (attack the real bottleneck)

The single strongest cross-source finding: **review, not spawning, is the ceiling.** Build a batched
review surface where each finished task = **diff + tests + summary + verification artifacts**, with
one-click approve / request-changes, and a **configurable WIP cap** so the fleet physically cannot
outrun the reviewer. AutoClaw's consensus voting + scope leases already model the gate; this is the
human-facing front-end for it.

| Lens | Assessment |
|---|---|
| SWOT | **S:** targets the proven bottleneck; differentiating; maps onto existing consensus/lease primitives. **W:** needs clean diff/test capture per task. **O:** "the tool that makes 10 agents reviewable by 1 human" is a sharp, ownable pitch. **T:** Cursor/Conductor have review UIs, but single-vendor. |
| SWAMP | **Scope:** review inbox, PR-packet card, WIP cap, approve/reject → consensus vote. **Work:** medium. **Assumptions:** tasks emit a diff+test artifact (define a packet schema). **Monetization:** Pro/Team feature. **Pitfalls:** WIP limit that nags instead of *gating* dispatch; reviewing in a sidebar (needs the full-tab/Control surface). |
| MOAT | Medium-high — defensibility comes from coupling it to *heterogeneous* consensus (a Claude agent's work reviewed alongside a Codex agent's, in one queue), which single-vendor tools can't do. |

### Idea 4 — **Worktree-per-task auto-provisioning + fleet view**

Lean into the power-user substrate: when an agent claims a task, auto-create a **git worktree** with
its own copied `.env` + assigned port, and offer a **fleet terminal grid** (the in-editor answer to
tmux panes). AutoClaw already has the claim-mutex + scope locking that makes this safe.

| Lens | Assessment |
|---|---|
| SWOT | **S:** the dominant, battle-tested isolation pattern; eliminates the port/DB-clash failure mode Augment cites. **W:** Windows worktree + per-worktree env hygiene is fiddly. **O:** "claim → isolated worktree → review → merge" as a one-command loop. **T:** Conductor/Crystal already do this on Mac — opportunity is Windows-native + heterogeneous. |
| SWAMP | **Scope:** auto-worktree on claim, env/port templating, cleanup on merge, optional terminal grid. **Work:** medium. **Assumptions:** project uses git (yes); env is copy-not-symlink. **Monetization:** free core / Team polish. **Pitfalls:** orphaned worktrees, disk bloat, symlinked env collisions — auto-GC required. |
| MOAT | Low-medium (worktrees are commodity) — value is in *integrating* it with the claim/scope/consensus loop. |

### Idea 5 — **Universal Join Adapter (acp/1)** — answers "I can't connect Hermes/OpenClaw"

**Already fully designed** in [STANDARDIZED-ADAPTER-A2A-PLATFORM.md](./STANDARDIZED-ADAPTER-A2A-PLATFORM.md).
The research independently arrived at the same answer: **expose the board over MCP (largely done —
`presence.beacon` just landed in commit `8b80600`) + publish an A2A Agent Card + ship a thin 3-verb
SDK (`announce / claim / report`)** with two backends (MCP for tool-capable agents, file-drop for
shell-only ones). A third party joins in **<1 hour**, no fork. This is the direct fix for the
maintainer's side-note.

| Lens | Assessment |
|---|---|
| SWOT | **S:** ~90% of the substrate ships today; additive; turns "closed extension" into "open platform." **W:** governance/signing surface for external *runners* is real work. **O:** an open, neutral coordination standard others build on = ecosystem + moat. **T:** A2A/MCP are converging fast — move before someone else defines the coding-coordination layer. |
| SWAMP | **Scope:** SDK + Agent Card + `/.well-known/agent.json` + out-of-tree loader (phased; see acp/1 doc). **Work:** small for presence/visibility (phase 1–2), larger for signed runner governance (phase 4–6). **Assumptions:** file-bus stays canonical (yes). **Monetization:** free standard (adoption); marketplace later. **Pitfalls:** external runners = arbitrary code (the doc's whole §3 governance is the mitigation). |
| MOAT | **Highest.** Being the *neutral standard* for heterogeneous coordination is a network-effect moat single-vendor incumbents structurally won't build (it commoditizes their lock-in). |

### Idea 6 — **Clickable session / message tracking** — answers "I lose track of work"

**Already fully designed** in [CHAT-SESSION-MESSAGE-TRACKING.md](./CHAT-SESSION-MESSAGE-TRACKING.md).
The linchpin (`Heartbeat.session_id` == the GUI tool's `sessionId` == the `<sessionId>.jsonl`
filename) is on disk today. Phase 1 (clickable rows + "Open chat" deep-link ladder) delivers
"jump from a panel row to the actual conversation" immediately, and is the **per-row primitive that
Control (Idea 1) reuses** to do its cross-window IDE handoff.

| Lens | Assessment |
|---|---|
| SWOT | **S:** linchpin already on disk; mostly wiring. **W:** only Claude Code supports true resume-by-id; others degrade to reveal-transcript. **O:** the "which window is driving this agent?" answer nobody else gives. **T:** none. |
| SWAMP | **Scope:** clickable rows + deep-link ladder (phase 1), lineage drill-in + cross-plane correlation (phases 2–3). **Work:** small (phase 1). **Assumptions:** session_id bridge holds (verified). **Monetization:** free. **Pitfalls:** out-of-workspace file-open guard; blank-chat trap on resume — both called out in the doc. |
| MOAT | Medium — the cross-plane provenance graph (chat turn → commit → board action) is hard to replicate without the coordination substrate. |

### Idea 7 — **Token / cost accountability ledger** (manager view)

Per-agent, per-task, per-sprint **token + cost meters** — the research flagged this as a slot
**almost nobody fills**. Beacons already carry `current_llm`; the cost-ledger work already exists.
Surface it as a manager-facing accountability column (who burned what, on which task) in the panel
now and Control later.

| Lens | Assessment |
|---|---|
| SWOT | **S:** rare in the market; cheap given the ledger exists; directly serves the "track tokens used per agent" ask. **W:** cost attribution across vendors needs each runner to report usage. **O:** "accountability dashboard for an AI dev team" — a manager/SMB selling point. **T:** vendors show *their own* spend; cross-vendor roll-up is ours to own. |
| SWAMP | **Scope:** usage capture per dispatch → per-agent/sprint roll-up + budget alerts. **Work:** small–medium. **Assumptions:** runners surface token counts (true for some, infer for others). **Monetization:** Team/manager tier. **Pitfalls:** wrong/spoofed counts from external runners — label confidence. |
| MOAT | Medium — value is the *cross-vendor* roll-up, which requires the neutral coordination layer. |

### (Frontier) Idea 8 — **Mobile / remote glance** — long-term, open category

Notify-when-input-needed + a read-only mobile/web view of the fleet. The research found **nobody
owns mobile** for coding agents. Defer, but it's the natural extension of Control once the
beacon/comms data is already aggregated server-side. Park it.

---

## 4. The decision you actually asked me to weigh: standalone vs. stay-in-VS-Code

| Direction | Pros | Cons | Verdict for AutoClaw |
|---|---|---|---|
| **Stay extension-only** | Lowest effort; lives where you already work; no migration. | *Structurally cannot see across windows/projects/machines* — i.e. cannot fix your actual pain. Caps you out of the single-pane category where the value is consolidating. | Necessary but **insufficient**. |
| **Go full standalone fork** (à la Cursor) | Own the whole UX. | Upstream-merge tax, Electron bloat, **lose the extension ecosystem**, "yet another editor." Wrong shape for a *coordinator*. | **No.** |
| **Hybrid: thin connector extension + standalone Control plane** | Extension stays a zero-config on-ramp/beacon inside each project; Control aggregates *above* all editors and hands work back via "Open in IDE." Matches the proven winning pattern (Windsurf / Antigravity / Copilot). | Two surfaces to maintain; onboarding friction. | **Recommended.** |

**Why hybrid wins for *you* specifically:** the thing making your desktop messy (many windows) is
the thing an in-window extension can't address. Control is an *observer* above the windows — it
doesn't replace VS Code (you keep the editor you grew up on), it gives you the **one screen** that
shows every agent on every project so you stop losing track. You keep VS Code/Kiro/Cursor open for
*editing*; you watch and dispatch from Control.

---

## 5. Roadmap

### Right now — no building required (this week, your workflow)
1. **Adopt git worktrees per agent** (you partly do). One worktree per task/branch → no
   file/port clashes; this is the SV-standard substrate and de-clutters by isolating.
2. **One project per VS Code window, agents as *tabs* not windows.** Use the panel's session
   list as the within-project index; stop opening a new window per chat.
3. **Set a WIP cap on yourself** — review-and-land one significant change at a time (the bottleneck
   is your review, not agent count). Queue the rest.
4. **Use a real terminal multiplexer** (Windows Terminal panes / WezTang / tmux-in-WSL) for the
   CLI agents you watch, per the *pookie* tmux video — it's the cheap "watch the fleet" answer today.

### Now — ship in the existing extension (small, additive, high-leverage)
5. **Finish acp/1 phase 1–2** (Idea 5): the `presence.beacon` MCP tool already landed; add
   `presence.fleet`, the optional `Beacon.transports[]`/`card_url` fields, serve
   `/.well-known/agent.json`, and publish the 3-verb adapter SDK. **This connects Hermes/OpenClaw
   in <1 hour and is mostly done.**
6. **Ship session-tracking phase 1** (Idea 6): clickable session rows + "Open chat" ladder. Cheap,
   and it's the primitive Control reuses.
7. **Token/cost ledger column** (Idea 7) in the panel — accountability you can see today.
8. **Manager Surface as a full-tab webview** (Idea 2): session grid + completion toasts +
   plan-gate + comment-on-artifact. Validates the UX before porting it.

### Next — the bottleneck + substrate
9. **Review Queue / PR-packet view + enforced WIP limits** (Idea 3).
10. **Worktree-per-task auto-provisioning + cleanup** (Idea 4).

### Long term — the standalone bet
11. **AutoClaw Control** (Idea 1): Tauri shell reusing the (already host-free) webview renderers,
    watching `~/.autoclaw/beacons/` + every project's `comms/` tree → one cross-project mission
    control with IDE handoff. **This is the real fix for your desktop.** Ship it as the Pro/Team
    surface; keep the extension free as the on-ramp. Borrow Cave's board-lifecycle, floor-rollup,
    token-meter, and local-API recipes (§1A) to build it faster.
12. **Mobile / remote glance** (Idea 8) once Control's aggregation exists — copy Cave's
    Tailscale-Serve + signed-invite + thin-client recipe (§1A) rather than an app-store path.

---

## 6. MOAT synthesis — what's actually defensible

Everyone is shipping **parallelism within one vendor's walled app**. The visual patterns (kanban,
session grid, worktrees, diff queues) are **commoditized and webview-portable — build them, don't
agonize over them.** The durable moat is the layer the incumbents *structurally won't* build because
it commoditizes their lock-in:

1. **Heterogeneous, cross-vendor, cross-machine coordination** (file-bus + MCP + A2A + beacons +
   consensus) — acp/1 makes it an open standard.
2. **A neutral control plane above all editors** — Control is the only single-pane that isn't tied
   to one model vendor.
3. **Local-first intelligence/memory + cross-vendor cost accountability** — counters the two loudest
   complaints (statelessness, lock-in) at once.

Lead with neutrality + coordination; treat the pretty visuals as table stakes you assemble from
proven, embeddable patterns.

---

## 7. One-line recommendation

*Keep the extension as a free, zero-config connector/beacon inside each project; finish the two
already-designed pieces (acp/1 interop — adopting Coven's data-not-code manifest shape — + clickable
session tracking) now to close the Hermes/OpenClaw gap and the "lose track" gap; add a token-ledger
(Cave's stream-json recipe) and a full-tab Manager Surface as the R&D bench; then build **AutoClaw
Control**, a vendor-neutral standalone single-pane-of-glass above all your editors, as the Pro/Team
product — learning UI/manifest/metering recipes from Coven/Cave but depending on neither — because the
multi-window mess is structural and only a surface above the windows can fix it.*
