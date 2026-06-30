# Clickable Chat-Session and Message-Lineage Tracking in the AutoClaw Panel

> AutoClaw design idea — generated 2026-06-15 via multi-agent workflow (3-lens judge panel + synthesis). Exploratory; not yet scheduled.

## Summary

A unified design that turns the panel's inert session rows into navigable objects backed by a typed provenance graph. The linchpin already exists on disk: every session row's identity comes from Heartbeat.session_id, which is verbatim the GUI tool's sessionId and verbatim the <sessionId>.jsonl transcript filename — the one exact bridge between the coordination plane and the GUI plane. The proposal (1) adds a LineageRef join key + ProvenanceEdge ledger so any of the four planes (GUI session, GUI message, comms, board/commit) can resolve forward/backward to the others; (2) makes each session row clickable with a tiered "Open chat" action and a per-message lineage drill-in, reusing the shipped server-render + postMessage + expand/collapse machinery; (3) drives the open action down a four-rung deep-link ladder where Claude Code is the only tool with a true resume-exact-session URI and every other tool degrades to open-the-tool / copy-resume-command / reveal-transcript. All type changes are additive/back-compatible; the only genuinely new surfaces are one correlator module, one session-lineage renderer, three webview commands, and an out-of-workspace-aware file opener.

## Key decisions
- Heartbeat.session_id is the linchpin: it is verbatim the GUI tool's sessionId AND verbatim the <sessionId>.jsonl transcript filename — the single exact, already-on-disk bridge between the coordination plane and the GUI plane. The whole model hangs on it.
- Introduce one canonical join key, LineageRef (`<kind>:<tool>:<localId>`), with localId stored VERBATIM per plane so refs always round-trip back to the raw record (no lossy rewrite).
- Make all type changes additive/back-compatible: SessionMessage gains optional ref/parentRef, SessionProvenance gains optional self/guiSession/project/gitBranch/emitted, Message/CommsLogEntry gain optional session_id. Existing adapters keep compiling.
- Store correlation as typed directed edges (ProvenanceEdge) in an append-only lineage.jsonl, each carrying confidence + basis so the panel distinguishes EXACT (session_id, structural) from INFERRED (branch+author+time, task_id) links.
- Drive Open chat via a four-rung deep-link ladder, attempting the highest rung the tool supports and telling the user which tier fired. Claude Code is the only tool with a true resume-exact-session URI (vscode://anthropic.claude-code/open?session=<id>).
- Reuse the entire existing panel stack (server-render innerHTML, postMessage command switch, uiState.threads expand/collapse, SectionSearch, participant/ROLE_META) — no new webview framework; new code is one correlator, one renderer, three commands, a uiState.sessions map, and an out-of-workspace-aware opener.
- Do NOT reuse handleOpenAwaitingFile verbatim — it rejects absolute/out-of-workspace paths (extension.ts:4226), but transcript stores live under ~/.claude and globalStorage; the session opener needs a new handler that allowlists the known adapter store roots.
- Make the panel show absence honestly: Codex/CodeGPT/Copilot-chat get no clickable row (no store, no adapter) and a muted 'no source adapter' hint, turning the gap into a discoverable feature request.

## Phasing
1. MVP (Phase 1): clickable session rows + Open chat ladder (claude-code rungs 1/3, universal rung-4 file/dir reveal), driven only off existing Heartbeat fields + provenance.rawRef. New: openSession command + out-of-workspace-aware opener. No data-model change. Delivers 'jump from a panel row to my chat' immediately.
2. Phase 2 (backward lineage): stamp SessionMessage.ref/parentRef + provenance.self/guiSession in claudeCode.ts; ship renderSessionLineage + loadSessionLineage/sessionLineage commands; render time/role/origin/kept-code chips + chain-of-thought expander. Backward trace within one session.
3. Phase 3 (forward cross-plane correlation): ship correlate.ts + lineage.jsonl; add session_id to new comms messages; wire forward()/backward() so a board card links to the firing turn and a session links to its board thread/commit. The '↳ task thread' bridge + board-card lineage chip.
4. Phase 4 (breadth + polish): kilocode/cursor/kiro/gemini deep-link rungs; team-summary session-count pivot; outcome search/filter; muted 'no source adapter' rows for codex/codegpt/copilot-chat; make lineage.jsonl learnable via the autoclaw-native adapter.

## Open questions
- Kilo Code's exact command ids and whether it registers an onUri handler that opens a specific task by id — could not retrieve the live package.json; Roo/Cline lineage suggests panel-level commands only. Treat task-level open as 'reveal the task dir' until package.json is inspected directly.
- Cursor resume-by-id: not documented as of the current deeplinks page (only prompt/command/rule create-new). If Cursor ships cursor://chat/{id}, it jumps rung 2 to rung 1. Periodic re-check warranted.
- Should lineage.jsonl be authoritative or a rebuildable cache? Authoritative needs an edit/delete compaction story; cache needs a deterministic correlator so a rebuild reproduces edges. Recommend rebuildable cache.
- Does the protocol actually stamp session_id on ALL comms message types today or only heartbeats? The contract mandates it, but Message has no session_id field yet — verify the writers before relying on the exact join for new data.
- Privacy/consent: surfacing transcript content (kept-code, chain-of-thought) in the panel must respect the same default-off SourceToggle consent gate that third-party sources use — confirm the lineage drill-in honors it.
- Claude Desktop / Kiro / Gemini chat deep links: none found documented (assume rung 4). Absence-of-evidence, not confirmation a private scheme doesn't exist.

## Risks
- Open-the-live-chat is not universally possible: only claude-code in the same workspace supports rung-1; the claude-code URI silently starts a BLANK chat if the session isn't in the open workspace — must guard with session.project == hostWorkspace, otherwise a confusing silent failure.
- The workspace-escape guard in handleOpenAwaitingFile rejects out-of-workspace/absolute paths (extension.ts:4226); the new opener must allowlist only known adapter store roots, not open arbitrary absolute paths (refs can be attacker-influenced bus data).
- Inferred edges (branch+author+time, task_id) are heuristic with confidence <1 and can mislead; the panel must label exact vs inferred via the basis field so a wrong link is visibly low-confidence, not presented as fact.
- Legacy comms-log.jsonl lines have no session_id, so historical correlation falls back to the lower-confidence task_id join; full-fidelity correlation only applies to new messages going forward.
- Long sessions (142+ messages) in a narrow sidebar require capped chain-of-thought + '+N more' discipline and lazy parse (nothing until Lineage is expanded) to stay usable and performant.
- Codex/CodeGPT/Copilot-chat have no local store and no adapter, so they get no clickable rows at all — the panel must show that absence rather than hide it, or users will think the feature is broken.
- Cursor's rawRef is a binary state.vscdb#key — revealing the file is useless; the row must fall back to opening Cursor + a search-history hint rather than the generic file opener.

---

# Clickable Chat-Session + Message-Lineage Tracking in the AutoClaw Panel

## 1. Problem

The user runs many GUI chat windows (Claude Code, Kilo Code, Cursor, Codex, CodeGPT, Copilot-chat) and cannot map a given window to the session AutoClaw is tracking, nor trace a board action / commit / comms message back to the chat turn that produced it. AutoClaw already holds every fact needed to close this gap — it just never connects or exposes them:

- **Session rows are inert.** `renderSessionList()` (`webview-render.ts:253`) already prints id / status / model / task / age per session, but the row links nowhere.
- **The four planes share no join key.** GUI session (`sessionId`), GUI message (`uuid`/`parentUuid` DAG), intelligence record (`UnifiedSession.id` + `provenance.rawRef`), and coordination (comms `Message.id`, `Heartbeat.session_id`, board `task_id`) are correlatable only through scattered, lossy fragments.
- **No "open the live chat".** There is no action to jump from a panel row to the conversation, even though `provenance.rawRef` records the exact transcript path for every session.

The single existing bridge is `Heartbeat.session_id`: it **is** the GUI tool's `sessionId`, and that UUID **is** the `<sessionId>.jsonl` transcript filename. Everything below is built on making that bridge a typed, end-to-end, clickable chain.

## 2. Data model — the provenance graph

### 2.1 The join key: `LineageRef`

Every correlatable thing gets one canonical, parseable address. Canonical string form `<kind>:<tool>:<localId>` (URN-like, filesystem-safe), cached as `uri`. `localId` is **verbatim** per plane — never rewritten — so a ref always round-trips back to its raw record.

```ts
export type LineageKind =
  | 'gui_session'   // a tool's chat session as the GUI knows it
  | 'gui_message'   // one turn inside a gui_session
  | 'unified'       // an intelligence UnifiedSession
  | 'comms'         // a cross-agent Message / CommsLogEntry
  | 'board'         // a board.json card action (claim/review/complete)
  | 'commit' | 'pr';

export interface LineageRef {
  kind: LineageKind;
  tool: string;     // 'claude-code' | 'kilocode' | 'git' | 'github' | 'autoclaw'
  localId: string;  // EXACTLY as that plane stores it
  uri: string;      // `${kind}:${tool}:${localId}` — the join key
}
```

Examples: `gui_session:claude-code:7dfb9ecd-…`, `gui_message:claude-code:7dfb9ecd-…/23f2b995-…` (`sessionId/uuid`), `unified:claude-code:7dfb9ecd-…` (== `UnifiedSession.id`, namespaced), `comms:claude-code:msg-2026-06-13T19-06-04-996Z-…`, `board:claude-code:panel-fleet-visibility#review_request`, `commit:git:68d2bf4`.

### 2.2 Per-adapter `SessionIdentity` (declarative, no special-casing)

Each adapter declares how its tool addresses its own sessions/messages, so the correlator mints refs uniformly:

```ts
export interface SessionIdentity {
  sessionIdField: 'record.sessionId' | 'taskDir' | 'fileBasename' | 'composerId';
  messageIdField: 'uuid' | 'message.id' | null;     // kilo: null (index-only)
  messageGraph: 'dag' | 'ordered';                   // claude-code: 'dag'
  projectField: 'cwd' | 'workspaceRoot' | null;
  branchField: 'gitBranch' | null;
}
// SourceAdapter gains:  readonly identity: SessionIdentity;
```

This captures what adapters already parse (claude-code reads `sessionId`, `cwd`, `uuid`/`parentUuid`/`gitBranch`/`message.id`) and what they can't (kilocode has no per-message id), making the limitation **typed, not silent**.

### 2.3 Message-level granularity (the missing link)

Today `SessionMessage` is `{ role, ts, text, codeBlocks }` (`types.ts:138`) — no id, so a board action cannot point at a turn. Add two optional, back-compatible fields:

```ts
export interface SessionMessage {
  role: MessageRole; ts?: number; text: string; codeBlocks?: SessionCodeBlock[];
  ref?: LineageRef;        // NEW — gui_message:<adapter>:<sessionId>/<uuid>
  parentRef?: LineageRef;  // NEW — parentUuid; reconstructs the transcript DAG
}
```

And `SessionProvenance` (`types.ts:171`) is upgraded from a flat stamp to the session's lineage spine — all additions optional:

```ts
export interface SessionProvenance {
  adapterId: string; rawRef: string; extractedAt: number;  // unchanged
  self?: LineageRef;        // == UnifiedSession.id, namespaced (single id authority)
  guiSession?: LineageRef;  // the bridge to Heartbeat.session_id
  project?: string;         // normalized cwd
  gitBranch?: string;       // bridge to commits/PRs
  emitted?: LineageRef[];   // comms/board/commit/pr refs, back-filled by the correlator
}
```

### 2.4 The provenance edge — append-only ledger

Correlation is stored as directed, typed edges in `.autoclaw/orchestrator/comms/lineage.jsonl` (mirrors `comms-log.jsonl` / `loop-journal.jsonl` conventions; itself ingestible by the autoclaw-native adapter, so lineage becomes learnable):

```ts
export type LineageRelation =
  | 'extracted_from' | 'contains' | 'replied_to'
  | 'emitted' | 'acted_on' | 'produced' | 'about' | 'reviews';

export interface ProvenanceEdge {
  id: string; from: LineageRef; to: LineageRef; relation: LineageRelation;
  assertedBy: 'adapter' | 'correlator' | 'agent';
  confidence: number;  // 1.0 structural; <1 inferred
  basis?: ('session_id' | 'task_id' | 'branch' | 'author+time' | 'commit_hash' | 'msg_id')[];
  ts: number;
}
```

`confidence`/`basis` matter because two joins are **exact** (structural) and two are **inferred** (heuristic). Storing the basis lets the panel show "linked by session_id (exact)" vs "linked by branch+author+time window (inferred)".

### 2.5 The four-step join (each field confirmed on disk)

```
GUI session ──fname──► <sid>.jsonl ──extract──► provenance.guiSession/self
  sessionId               uuid/parentUuid          project / gitBranch
     └──────── heartbeat.session_id (THE exact bridge) ──────┐
                                                              ▼
                                comms Message · board card · git commit
```

1. **GUI session → transcript (EXACT).** The file *is* `<sessionId>.jsonl`. → `extracted_from`, conf 1.0, basis `[session_id]`.
2. **Transcript → UnifiedSession (EXACT, structural).** Stamp `provenance.self/guiSession/project/gitBranch`; stamp each `SessionMessage.ref` from `uuid`, `parentRef` from `parentUuid`. → `contains` + `replied_to`, conf 1.0.
3. **UnifiedSession → comms / board.** *Exact path:* `Heartbeat.session_id === provenance.guiSession.localId`; the heartbeat's `agent_id` + time window claims every comms `Message` and board action by that agent. → `emitted`/`acted_on`, basis `[session_id]`, conf 1.0. *Fallback (legacy lines with no session_id):* join on shared `task_id`, narrowed by `from === claimed_by` and `timestamp ∈ [startedAt, endedAt]`. → basis `[task_id, author+time]`, conf ~0.6.
4. **UnifiedSession → commit / PR (INFERRED).** `provenance.gitBranch` + commit author + commit time inside the session window → `produced`, basis `[branch, author+time]`. Tighten to 1.0 when a commit hash / PR number appears in the transcript or `signals.gitKeptCommit.hash`.

### 2.6 The correlator surface

A pure, host-free module (same constraints as `sources/*` and `webview-render-board.ts`: no `vscode`, no native modules), consumed by both the panel and `/learn`:

```ts
export interface Correlator {
  correlate(input: {
    sessions: UnifiedSession[]; heartbeats: Heartbeat[];
    comms: CommsLogEntry[]; board: BoardSnapshot;
    commits?: { hash: string; author: string; branch: string; ts: number }[];
  }): ProvenanceGraph;
  forward(ref: LineageRef): ProvenanceEdge[];   // "what did this session produce?"
  backward(ref: LineageRef): ProvenanceEdge[];  // "what produced this board action?"
}
```

`backward(board:claude-code:panel-fleet-visibility#review_request)` resolves to the exact `gui_session` (and, where ids exist, the `gui_message` turn) that fired it — the question the system cannot answer today.

## 3. Panel UX

No new webview framework. Everything reuses the shipped server-render (`webview-render.ts` / `-board.ts` innerHTML injection), the `postMessage` command switch (`extension.ts:1710`), and the expand/collapse-that-survives-data-ticks mechanism (`uiState.threads` in `kdream-dashboard.js`).

### 3.1 The clickable session row

Promote each flat `<div class="session-row">` (`webview-render.ts:259`) to a `role="button"` row carrying `data-session-id`, `data-source` (adapter id), and `data-raw-ref` (transcript path), so the host acts without re-deriving anything:

```
● 7dfb9ec…  opus-4.8  feat/multi-project-orch…  2m ago  [Open chat ↗] [Lineage ▸]  (you)
  └ claude-code · <local-projects>/autoclaw · 142 msgs · /learn ✓ indexed     ▸ drill-in
```

- **status dot** (`s.status`, stale after 10 min — unchanged).
- **session id = primary affordance** (the "Open chat" target).
- **model + current-task chips** (`shortModel(s.current_llm)`, `s.current_task` — unchanged).
- **"you" marker** when `session_id === selfId` (reuse the agent card's `is-self`/`you-pill`) — the single most important affordance: "which of my windows is driving AutoClaw right now."
- **two explicit buttons** so the row isn't one ambiguous target:

| Button | Webview command | Host behavior |
|---|---|---|
| **Open chat ↗** | `openSession {source, sessionId, rawRef, project}` | Run the deep-link ladder (§4). |
| **Lineage ▸** | `loadSessionLineage {source, sessionId, rawRef}` | Lazily parse the transcript and post back `sessionLineage` for the drill-in (§3.2). Nothing parsed until expanded. |

Add a `uiState.sessions` map keyed by `session_id` (parallel to `uiState.threads`) so an open drill-in survives innerHTML re-render.

### 3.2 The message-lineage drill-in

Expanding **Lineage ▸** reveals, inside the row, a compact reverse-chronological view built from `UnifiedSession.messages`, rendered for **attribution/debugging** not reading:

```
Lineage — claude-code:7dfb9ecd · 142 msgs · <local-projects>/autoclaw     [Open transcript ↗]
▾ 2m  assistant opus-4.8  "scope the panel UX to session rows…"
    ├ feeds → [Edit webview-render.ts] [applied ✓]   ← kept signal: applied_edit
    └ chain-of-thought ▸ (3 prior turns)
▸ 4m  user                "Investigate the existing panel…"   ← prompt origin
▸ 9m  tool      Read      webview-render.ts  [tool_result]
```

Each line (all already parsed by adapters): **time + role** (role color reuses the board's `participant()`/`ROLE_META` palette); **origin badge** (first user turn = prompt origin; assistant = producing model; tool = tool name); **"feeds →" outcome chips** from `SessionSignals.keptCode[].reason` (`applied_edit` / `git_commit` / `user_approval`) — the load-bearing dev-attribution feature ("this turn wrote that line and it shipped"); **chain-of-thought ▸** nested expander showing the N preceding turns (default 3, "+N more", same discipline as `MAX_CARDS_PER_COLUMN`).

**Two lineage directions** (because "trace a message" is ambiguous): *backward* = prior turns + originating prompt (the CoT chain); *forward* = kept-code chips plus, when `current_task` matches a board `task_id`, a "↳ task B1 thread" chip that scrolls the board card into view and opens its thread — the bridge that finally connects a *transcript* message to the *coordination* message it became.

**Search/filter** reuses the shipped `SectionSearch.wire` config: role chips (user/assistant/tool) + an outcome chip (applied/discarded/read-only), so "show only turns that wrote code that shipped" is one click.

### 3.3 Where it lives (no new section)

- Session rows stay inside the **expanded agent card** (`renderSessionList`, called at `webview-render.ts:430`) — agent → its sessions is the right hierarchy and the card already has open/collapse machinery.
- Make the **team-summary session count** (`webview-render.ts:218`) a filter pivot: clicking it expands every agent card to its session list and focuses the search box — the fast path for "show me all my live chats across all tools."
- The lineage drill-in lives purely inside the row; it never opens a new panel, so it composes with the persisted-UI-state system unchanged.

## 4. Per-tool deep-link strategy — the capability ladder

There is no universal "focus this chat tab" API, so **Open chat ↗** attempts the highest rung the source supports and silently falls back, **telling the user which tier fired** rather than silently doing less.

**Rungs (best → worst):** (1) deep-link to the *exact* session; (2) deep-link to the tool's session list / new chat (user picks the row); (3) copy a `--resume`/CLI command + toast; (4) reveal the raw transcript file/dir. Rung 4 is **always available** — `provenance.rawRef` already records the exact source for every adapter.

### 4.1 Per-tool table

| Tool (adapter id) | Best clickable action | Mechanism (verified) | Fallback |
|---|---|---|---|
| **claude-code** | Resume exact session in VS Code panel | `vscode://anthropic.claude-code/open?session=<sessionId>` (documented). Resumes that conversation; focuses it if open. **Constraint: the session must belong to the workspace open in VS Code, else a fresh blank chat starts** — only offer when the session's project matches the host workspace. | Different repo → copy `claude --resume <id>`. Terminal → `claude-cli://open?cwd=<repo>` (no resume-by-id param). Last resort → open the `.jsonl`. |
| **claude-desktop** | Reveal transcript | Same `.jsonl` format, no documented desktop URI scheme. `--resume` does not apply to desktop. | Open the `.jsonl`. |
| **cursor** | Open Cursor / new chat | `cursor://anysphere.cursor-deeplink/prompt?text=…` documented; **no documented resume-existing-chat-by-id** (community-requested, unshipped). `rawRef` = `state.vscdb#<key>` (binary SQLite — useless to reveal). | `cursor://file/<repo>` + "search chat history" hint. |
| **kilocode** | Open the Kilo task/tab UI | VS Code extension (Roo/Cline fork); contributes panel commands ("Open in New Tab", provider `kilo-code.TabPanelProvider`) + history view. **No confirmed `onUri` or per-task command id** (see open questions). `rawRef` = `…/tasks/<taskId>/` (real dir). | `revealFileInOS(taskDir)` or open `api_conversation_history.json`; optionally `executeCommand('kilo-code.openInNewTab')` then user picks. |
| **kiro** | Reveal transcript / spec | VS Code fork; headless CLI, no resume-by-id, no documented chat deep-link. `rawRef` = real `.json`/spec dir. | Open the file (generic `vscode.open` works if Kiro is the host). |
| **gemini** | Reveal transcript | CLI logs; no chat-resume deep link. `rawRef` = per-session `.json`. | Open the `.json`. |
| **continue / cline-roo / generic** | Reveal transcript | File- or DB-backed; no per-session deep link known. | Open the file; for DB-backed, "open the tool" + copy hint. |
| **autoclaw-native** | Open in our own thread view | We own the format — route directly, no external URI. | n/a |
| **codex / codegpt / copilot-chat** | *No row* | No local store, no adapter. Row renders a muted "no source adapter" hint instead of an Open button — turning the gap into a discoverable feature request. | n/a |

### 4.2 Decision order (host-side)

```
if claude-code AND session.project == hostWorkspace:
    openExternal( vscode://anthropic.claude-code/open?session=<id> )   # rung 1
elif claude-code:                                                       # different repo
    copyToClipboard("claude --resume <id>") + toast                     # rung 3
elif rawRef is a real file/dir (kilo, kiro, gemini, desktop, continue):
    openTextDocument(file)  OR  revealFileInOS(dir)                     # rung 4
elif rawRef is state.vscdb#key (cursor):
    openExternal( cursor://file/<repo> ) + "search chat history" hint   # rung 2-ish
else:
    toast: "No deep link for <tool>; transcript at <rawRef>"            # honest floor
```

Custom-scheme URIs fire exactly the way the codebase already fires external URIs: `vscode.env.openExternal(vscode.Uri.parse(uri))` (`asExternalUri` is only for localhost/port forwarding, not these schemes). The button's tooltip carries the tier ("Opens the transcript read-only — <tool> has no focus API") so a click is never surprising. Always show a secondary "Copy resume command" / "Reveal transcript" affordance so a failed primary has an obvious manual path.

### 4.3 The fallback is already 90% built — with one fix

`provenance.rawRef` (set by `makeProvenance` in `sources/parse.ts`) already stores the exact source for every adapter, and `handleOpenAwaitingFile` (`extension.ts:4219`) already opens a referenced file with a friendly "it may have moved" toast. **Critical fix:** that handler resolves paths relative to the workspace root and *rejects absolute / out-of-workspace paths* (`extension.ts:4226`). Transcript stores live under `~/.claude` / `globalStorage` — **outside** the workspace — so the session opener needs its **own** handler that allowlists the known adapter store roots rather than reusing the workspace-confined guard. Use `revealFileInOS` for the task-**directory** case (kilocode) and the binary `state.vscdb` case (cursor), since there is no text doc to show.

## 5. What changes, concretely (additive, back-compatible)

- **`intelligence/types.ts`** — add `LineageKind`/`LineageRef`/`SessionIdentity`/`ProvenanceEdge`/`LineageRelation`; extend `SessionMessage` with optional `ref`/`parentRef`; extend `SessionProvenance` with `self`/`guiSession`/`project`/`gitBranch`/`emitted`. All additive → existing adapters compile and stay valid.
- **`sources/parse.ts`** — `makeProvenance` gains `guiSession`/`self`; add `makeMessageRef(adapterId, sessionId, uuid)`; `makeMessage` gains optional ref params.
- **`sources/claudeCode.ts`** — already reads `sessionId`/`cwd`; stop discarding `uuid`/`parentUuid`/`gitBranch` and stamp them onto `SessionMessage.ref`/`parentRef` + `provenance`. The only adapter with full message-DAG fidelity. Declare `identity`.
- **`sources/kilocode.ts`** (+ cline/roo) — declare `identity` with `messageIdField:null`, `messageGraph:'ordered'`; mint `gui_session` from the task-dir name (the limitation is now typed, not silent).
- **`comms.ts`** — `Message` (l.97) / `CommsLogEntry` (l.214) gain optional `session_id?: string` (protocol already mandates stamping it). New messages → step-3 exact; legacy lines → `task_id` fallback.
- **New `intelligence/correlate.ts`** — the `Correlator`; appends edges to `comms/lineage.jsonl`, ingested by the autoclaw-native adapter.
- **`webview-render-board.ts`** — `ThreadMessage` + card renderer gain optional `lineage?: LineageRef[]` so a card deep-links "opened by session 7dfb9ecd, turn 23f2b995" via `backward()`.
- **New `webview-render-session.ts`** — pure `renderSessionLineage` renderer (unit-testable like its siblings).
- **`webview-render.ts`** — promote `renderSessionList` rows to clickable buttons; make team-summary session count a pivot.
- **`webview/kdream-dashboard.js`** — wire `openSession` / `loadSessionLineage` / `sessionLineage`; add `uiState.sessions`.
- **`extension.ts`** — add three webview commands to the switch (`extension.ts:1710`) + a new out-of-workspace-aware `handleOpenSession` (do NOT reuse the workspace-confined guard verbatim).

## 6. Phasing

- **MVP (Phase 1 — clickability with zero new data model):** clickable session rows + the **Open chat ↗** ladder for claude-code (rungs 1/3) and the universal rung-4 file/dir reveal for everyone else, driven entirely off existing `Heartbeat` fields + `provenance.rawRef`. New: `openSession` command + out-of-workspace-aware opener. No correlator, no lineage. Delivers the headline value ("jump from a panel row to my chat") immediately.
- **Phase 2 — lineage drill-in (backward):** stamp `SessionMessage.ref`/`parentRef` + `provenance.self`/`guiSession` in claudeCode.ts; ship `renderSessionLineage` + the `loadSessionLineage`/`sessionLineage` commands; render time/role/origin/kept-code chips + chain-of-thought expander. Backward trace within a single session.
- **Phase 3 — cross-plane correlation (forward):** ship `correlate.ts` + `lineage.jsonl`; add `session_id` to new comms messages; wire `forward()`/`backward()` so a board card links back to the firing turn and a session links forward to its board thread / commit. The "↳ task B1 thread" bridge and the board-card lineage chip.
- **Phase 4 — breadth + polish:** kilocode/cursor/kiro/gemini deep-link rungs; team-summary session-count pivot; outcome search/filter; muted "no source adapter" rows for codex/codegpt/copilot-chat; make `lineage.jsonl` learnable via the autoclaw-native adapter.

## 7. Risks

- **Open-the-live-chat is not universally possible.** Only claude-code (same-workspace) supports rung-1; everything else degrades. Mitigated by the tiered button + honest tooltip making the limit visible. **The biggest silent-failure trap:** the claude-code URI starts a *blank* chat if the session isn't in the open workspace — guard with the `session.project == hostWorkspace` check.
- **Workspace-escape guard must be relaxed carefully.** Transcript stores are out-of-workspace by design; the new opener must allowlist only the known adapter store roots, not open arbitrary absolute paths (the original guard exists because refs can be attacker-influenced bus data).
- **Inferred edges can mislead.** Branch+author+time and task_id joins are heuristic (conf <1). The panel must label exact vs inferred (the `basis` field) so a wrong inferred link is visibly low-confidence, not presented as fact.
- **Legacy comms have no session_id.** Historical `comms-log.jsonl` lines fall back to the lower-confidence task_id join until new messages carry `session_id`. Acceptable degradation, but means full-fidelity correlation only applies going forward.
- **Performance on long sessions.** A 142-message session in a narrow sidebar needs the capped chain-of-thought + "+N more" discipline and lazy parse (nothing until **Lineage ▸** is expanded) to stay usable.
- **Codex / CodeGPT / Copilot-chat have no rows at all** (no store, no adapter). Show the absence rather than hide it.

## 8. Open questions

- **Kilo Code command ids / `onUri` handler.** Could not retrieve the live `package.json` to confirm the precise command id (likely `kilo-code.openInNewTab`) or whether any `onUri` handler opens a specific task by id. Roo/Cline lineage suggests panel-level commands only. Treat task-level open as "reveal the task dir" until the `package.json` is inspected directly.
- **Cursor resume-by-id.** Not documented as of the current deeplinks page (only prompt/command/rule create-new). If Cursor ships `cursor://chat/{id}`, it jumps rung 2 → rung 1. Worth a periodic re-check.
- **Should `lineage.jsonl` be the single source of truth or a cache?** If it's authoritative, edits/deletes need a compaction story; if it's a rebuildable cache, the correlator must be deterministic so a rebuild matches. Recommend rebuildable cache.
- **`session_id` on comms messages** — does the protocol already stamp it on *all* message types, or only heartbeats? The contract mandates it; verify the actual writers before relying on the exact join for new data.
- **Privacy/consent** for surfacing transcript content (kept-code, CoT) in the panel — third-party sources are default-off; confirm the lineage drill-in respects the same `SourceToggle` consent gate.

## 9. Why this is low-risk

Every primitive already exists; this is wiring, not new architecture. Server-rendered esc'd HTML (`webview-render.ts`), expand/collapse that survives data ticks (`uiState.threads`), webview→host open-a-file (`openAwaitingFile`→`handleOpenAwaitingFile`), deep-link-or-clipboard fallback (`launchSkill`), per-adapter transcript parsing (`readClaudeTranscript`/`sessionFromTaskDir`), per-message outcome signals (`buildOutcomeSignals`/`SessionSignals.keptCode`), role-colored participants (`participant()`/`ROLE_META`), and section search (`SectionSearch.wire`) are all shipped and reused as-is. New surfaces: three webview commands, one correlator module, one session-lineage renderer, a `uiState.sessions` map, an out-of-workspace-aware file opener, and CSS — no native modules, no new dependency, fully testable outside the Electron host.
