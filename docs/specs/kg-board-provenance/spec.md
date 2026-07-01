# KG Board Provenance — make the agendaboard drillable to "why this task exists"

Status: draft · 2026-07-01 · Owner: claude-code
Scope: FREE / community. No premium gating. Local-first, degrade-safe, honest.
Companions: `docs/specs/kg-edge-outcome-contract.md`, `docs/specs/outcome-to-reputation-and-kg.md`.

---

## 1. Summary

AutoClaw already ships a purpose-built provenance graph — the in-process Knowledge
Graph (`.autoclaw/kg/kg.db`) with a `thoughts` table (agent/task/sprint-attributed
assertions with a bi-temporal validity window) and an `edges` table (typed relations
between thoughts). It is designed exactly for "chain of thought" lineage, but in live
use `thoughts` is written only by `/learn` (consensus verdicts, workflow findings) and
by `recordOutcomeEdge` at task completion, and `edges` is written almost never — so on
a normal project the graph is effectively empty and the kanban board (`board.json` /
`board.md`, rendered by the Fleet panel) can show that a task *exists* but not *why* it
exists, who created it, its activity timeline, or its parent/child lineage. This spec
turns KG writes into a **non-optional protocol step on every task-lifecycle event**,
makes each board item **drillable to its `thoughts`+`edges` on click**, links inbox
messages ↔ board ↔ KG so message history becomes the activity log, and backfills the
trail we already have on disk (handoff sidecars, dispatch/completion sidecars, sprint
assignment files) so the board is immediately useful. The infrastructure is built; this
is the wiring.

---

## 2. Problem & evidence

The graph exists and is well-formed, but nobody feeds it during normal work.

- **Tables exist** (`src/intelligence/kg/schema.ts`):
  - `thoughts(id, project, agent, sprint, task_id, kind, text, created_at, meta_json,
    has_embed, valid_from, valid_to)` with indexes on `(project, created_at)`,
    `(agent, created_at)`, `created_at`, `valid_from`, `valid_to`.
  - `edges(from_id, kind, to_id, meta_json, created_at)` with **PRIMARY KEY
    (from_id, kind, to_id)** and indexes `edges_from_kind`, `edges_to`.
  - Optional `thoughts_fts` (FTS5, feature-detected) and `thoughts_vec` (vec0, only
    when sqlite-vec loaded). Both are transparently maintained by the store.

- **Who writes today** (confirmed by grepping `recordThought`/`recordRelation` call
  sites):
  - `/learn` → `recordCoordinationToKg` (consensus outcomes, `kind: 'decision'`) and
    `recordLearningsToKg` (workflow patterns + review findings, `kind: 'finding'`) —
    `src/intelligence/learn.ts:596`, `:612`.
  - The orchestrator loop → `recordOrchestrationEventsToKg` (`kind: 'observation'`) on
    **dispatch** (`src/orchestratorLoop.ts:774`) and on **completion promotion**
    (`src/orchestratorLoop.ts:1024`). This is the closest thing to lifecycle wiring
    today, but it only fires inside the *active manager* loop, only for dispatch and
    peer-review promotion, and writes no `edges`.
  - Task completion fan-out → `recordOutcomeEdge` (entity nodes + `completed` /
    `reviewed` / `demonstrated` edges) — `src/extension.ts:4045`, `src/bridge.ts:630`.
  - The `kg.record` / `kg.relate` MCP tools (`src/mcp/`) — manual, human-triggered.
  - Project memory confirms: **`/index-code` does NOT write the KG** (it writes the
    code/learning vector store); the KG holds *coordination* facts.

- **Consequence:** on a project that has not run `/learn` or a full completion fan-out,
  `thoughts` and `edges` are ~0 rows. The KG viewer itself documents this — its module
  header (`src/kg/kgViewPanel.ts:16-19`) says "the stored `edges` table is usually
  empty (relations are only written via `kg.relate`)" and it *synthesizes* "same-task"
  edges at render time (`deriveSameTaskEdges`) to make the graph non-empty. That is a
  workaround for the missing writes.

- **Board has no drill-down.** `src/orchestrator/board.ts` buckets tasks into
  `claimable / in_flight / awaiting_review / stuck` and carries `task_id` on every item,
  but nothing else — no author, no timeline, no lineage. `boardWriter.ts` assembles the
  model from `state.json` + claims + consensus + heartbeats + evidence capsules; none of
  those sources is a per-task *history*. The Fleet panel (`src/panel/fleetPanel.ts:46`,
  `readBoardJsonIfExists`) renders `board.json` read-only and has an
  `onDidReceiveMessage` handler that today only understands `refresh` / `ready`
  (`fleetPanel.ts:148`). So a click on a board item has nowhere to go.

The gap is not missing infrastructure. It is: (a) lifecycle events don't append
`thoughts`+`edges`, and (b) the board has no click→query→render path into the KG.

---

## 3. Current state (grounded)

### 3.1 KG schema (actual columns)

`thoughts` (from `schema.ts`, mirrored by `ThoughtRow` in `store.ts` and `Thought` in
`types.ts`):

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | caller-suppliable (deterministic id → dedup) or `randomUUID()` |
| `project` | TEXT NOT NULL | `resolveProjectKey(workspaceRoot)` |
| `agent` | TEXT NOT NULL | attributed actor (`claude-code`, `orchestrator`, `learn`, …) |
| `sprint` | TEXT (nullable) | note: **TEXT**, board/loop uses numeric sprint → stringify |
| `task_id` | TEXT (nullable) | **the board join key** |
| `kind` | TEXT NOT NULL | free string; typed as `ThoughtKind` (open union) in `types.ts` |
| `text` | TEXT NOT NULL | human-readable fact |
| `created_at` | TEXT NOT NULL | ISO 8601 |
| `meta_json` | TEXT (nullable) | `JSON.stringify(meta)` |
| `has_embed` | INTEGER default 0 | set by the store when a vec row was written |
| `valid_from` / `valid_to` | TEXT (nullable) | bi-temporal; `valid_from` defaults to `created_at`, `valid_to` null = still valid |

`edges`: `(from_id, kind, to_id, meta_json, created_at)`, PK `(from_id, kind, to_id)`.
`recordRelation` does **`INSERT OR REPLACE`** → an edge is idempotent by its triple
(re-recording refreshes `meta`, latest wins). **`traverseFrom` joins `edges` → `thoughts`
on the walked id**, so an edge endpoint only resolves in a traversal if it is a thought
id. Endpoints that are *task ids* rather than *thought ids* are still stored and still
returned by `listEdges`, but won't hydrate to a thought in `traverseFrom` unless a
thought with that id exists (this matters for the design below — see §4.1).

### 3.2 KG write/read API (actual function names)

Access is via `getKnowledgeGraph({ workspaceRoot }).kg` (`src/intelligence/kg/service.ts`)
— one lazily-opened, cached `KnowledgeGraph` handle per process, WAL-safe for concurrent
readers + serialized writers. `openKnowledgeGraph` (`index.ts`) **never throws**; on
driver failure it returns a `degraded` handle whose writes are no-ops and reads return
`[]`. The `KnowledgeGraph` interface (`types.ts`):

- Write: `recordThought(t)` → `ThoughtId` (plain `INSERT`; a duplicate `id` **throws** —
  this is how callers get idempotency: catch-and-skip). `recordRelation(from, kind, to,
  meta?)` → void (`INSERT OR REPLACE`, idempotent by triple).
- Read: `searchSimilar(text, opts)` (multi/vec/fts), `traverseFrom(seed, edgeKinds,
  depth)`, `forAgent`, `forProject`, `since`, `allThoughts({limit})`,
  `listEdges({limit})`, `export`.
- **There is no `thoughtsForTask(taskId)` and no `edgesFrom(id)` / `edgesTo(id)` today.**
  `store.ts` has `filterStream({agent, project, since})` (private) but no `task_id`
  filter. This spec adds two small read methods (§4.3) rather than forcing the board to
  pull `allThoughts()` and filter in JS.

The reusable higher-level writers already live in `src/intelligence/kgRecord.ts`:
`recordCoordinationToKg`, `recordOrchestrationEventsToKg` (dispatch/completion
`observation`s), `recordLearningsToKg`, `recordOutcomeEdge` (entity nodes + structural
edges). All are degrade-safe, deterministic-id-deduped, never throw. This spec extends
that module rather than inventing a new one.

### 3.3 Why the board has no drill-down today

`board.json` items carry `task_id` (and title/priority/owner/age) but no history.
`fleetPanel.ts` reads `board.json` and renders it; its webview message handler only
knows `refresh`/`ready`. The KG viewer (`autoclaw.kg.browse`, `openKgViewPanel`) is a
*separate* full-tab webview with no task-scoped entry point — you can browse the whole
graph but cannot say "show me task BL-30's lineage". Nothing connects a board item's
`task_id` to a KG query.

---

## 4. Design

### 4.1 Thought/edge model for task provenance

**Two-plane model** (keep the structural entity-node plane that `recordOutcomeEdge`
already established, and add a per-event *lifecycle-thought* plane the timeline reads):

- **Entity nodes** (already defined in `kgRecord.ts` + `kg-edge-outcome-contract.md`):
  `agent:<id>` (kind `agent`), `task:<project>:<taskId>` (kind `task`),
  `capability:<cap>` (kind `capability`). Idempotent by deterministic id. These anchor
  the lineage graph so `traverseFrom(task:<project>:<taskId>, …)` resolves.

- **Lifecycle thoughts** (new): one `thought` per lifecycle event, keyed
  deterministically by `task_id + sprint + agent + kind + eventDiscriminator`. These are
  the activity-log rows.

**`kind` set for lifecycle thoughts** (maps the proposal's set onto existing kinds where
one already exists, so we don't fork vocabulary):

| lifecycle `kind` | reuse existing? | fired when |
|---|---|---|
| `created` | new | a task first appears in the catalog / ops-task / assignment |
| `claimed` | new | a `comms/claims/<task>.json` create-exclusive write succeeds |
| `progress` | reuse `observation` semantics; use `kind: 'progress'` | a work-loop progress note / dispatch |
| `decision` | **reuse** existing `decision` (already written by `recordCoordinationToKg`) | a consensus verdict resolves |
| `spawned` | new | a task/finding is spawned from a report (ops-task from a `finding_report`) |
| `blocked` | new | a task is marked blocked / a scope/dep conflict is raised |
| `review` | new | a `review_request` / `review_response` on a task |
| `done` | reuse `completion` observation + add `kind: 'done'` marker thought | a handoff note is written + `task_complete` broadcast |

`kind` is a free TEXT column and `ThoughtKind` is an open union (`… | string`), so **no
schema change is needed to add these kinds.** The existing `decision` writer stays as-is;
`created/claimed/progress/spawned/blocked/review/done` are additive.

**Edge kinds** (`edges.kind` is free TEXT — no schema change):

| edge | from → to | meta | fired when |
|---|---|---|---|
| `spawned_by` | `task:<p>:<B>` → `<report-thought-id>` | `{ finding_id }` | task B was created from a finding/report |
| `derived_from` | `task:<p>:<B>` → `task:<p>:<A>` | `{ reason }` | task B is a follow-up of task A (e.g. handoff `next_task_suggested`) |
| `implements` | `task:<p>:<taskId>` → `spec:<req-id>` | `{ source }` | task implements a spec/requirement id |
| `blocks` | `task:<p>:<A>` → `task:<p>:<C>` | `{}` | A blocks C (from `depends_on` inverse) |
| `activity` | `task:<p>:<taskId>` → `<lifecycle-thought-id>` | `{ kind }` | every lifecycle thought — links the task node to its event so `traverseFrom(task…)` yields the timeline |
| `completed` / `reviewed` / `demonstrated` | (existing, from `recordOutcomeEdge`) | — | unchanged |

**Keying (idempotency).** Every lifecycle thought gets a deterministic id so a
re-processed message never double-writes:

```
lifecycle thought id = evt:<project>:<taskId>:<kind>:<discriminator>
```

where `<discriminator>` is the stable natural key of the underlying event — the message
id for a message-driven event, the claim file basename for a claim, the handoff
`session_id`+`timestamp` for a done event, the dispatch sidecar basename for a dispatch.
Because `recordThought` throws on duplicate id and callers catch-and-skip, re-running is
a no-op. `spec:<req-id>` implements-target nodes are `ensureNode`d the same way (a
lightweight thought so the edge endpoint resolves).

**Schema additions needed: none for storage.** Every `kind` and edge-kind fits the
existing free-TEXT columns. The one place the current schema is *thin* is **read
performance**: there is no index on `thoughts(task_id, created_at)`. The board timeline
query is `WHERE task_id = ? ORDER BY created_at`. Add:

```sql
CREATE INDEX IF NOT EXISTS thoughts_task_created ON thoughts(task_id, created_at);
```

This is an additive `CREATE INDEX IF NOT EXISTS` in `createKgSchema` — safe to run on an
existing `kg.db` (idempotent, no data migration, no `ALTER`). That is the **only** schema
change in this spec.

### 4.2 Lifecycle instrumentation (event → seam → thought+edges)

Each lifecycle write is **best-effort and degrade-safe** (same contract as the existing
`recordOrchestrationEventsToKg`): wrapped in try/catch, never blocks or breaks the
protocol step it hooks. Idempotency is enforced two ways — the deterministic thought id
(§4.1) AND the caller respecting the **existing message ledger**: the cross-agent
protocol already requires reading each inbox message once, writing
`inboxes/<agent>/_state/<msg-id>.json`, then moving to `processed/` and recording
`responded_at` in `state.json`'s `message_ledger`. A KG write for a message-driven event
must happen **on first processing only** — the ledger check that already gates
re-processing gates the KG write for free. Do not add a second dedup mechanism at the
message layer; rely on ledger + deterministic id.

| event | seam (file / function) | thought `kind` | edges written |
|---|---|---|---|
| Task created / catalog-ingested | `src/orchestrator/taskCatalogIngest.ts` (`ingestTaskCatalog`, called from `boardWriter.writeBoard`) | `created` (per newly-seen task id) | `ensureNode(task:*)`; `implements`→`spec:<req-id>` when the task carries a spec/req id; `blocks` edges from inverse of `depends_on` |
| Ops-task spawned from a finding | `src/orchestrator/opsTasks.ts` (readOpsTasks) + the `finding_report` handler | `spawned` | `spawned_by`→ the finding thought; `ensureNode(task:*)` |
| Dispatch | `src/orchestratorLoop.ts:774` (already calls `recordOrchestrationEventsToKg` for `dispatch`) | keep `observation`, **add** an `activity` edge `task:*`→dispatch-thought | `activity` |
| Claim | claim write path (`comms/claims/<task>.json` create-exclusive) — new hook in the claim writer; board also reads claims in `boardWriter.readClaims` | `claimed` | `activity`; `ensureNode(agent:*)`, agent→task `claimed` edge |
| Progress note | work-loop progress sidecar (same dispatch family) | `progress` | `activity` |
| Review requested / responded | `review_request` / `review_response` message handler (comms) | `review` | `activity`; reviewer `agent:*`→task `reviewed` (defer to `recordOutcomeEdge` at resolution to avoid double-count) |
| Consensus resolved | `src/intelligence/kgRecord.ts:recordCoordinationToKg` (already fires from `/learn`) — **also** call it (or a thin real-time variant) from the tally/resolve path | `decision` (existing) | `activity` linking `task:*`→the `coord:` decision thought |
| Blocked / scope conflict | `scope_conflict` / `finding_report` handler + `state.tasks[].status === 'blocked'` transition | `blocked` | `blocks` when a blocker task is identified |
| Done (task_complete) | `src/orchestrator/handoff.ts:writeHandoffNote` (protocol already requires this sidecar before `task_complete`) + completion fan-out at `extension.ts:4045` / `bridge.ts:630` (`recordOutcomeEdge`) | `done` | existing `completed` edge (via `recordOutcomeEdge`) + `activity`; `derived_from` when the handoff carries `next_task_suggested` |

**Where to centralize.** Add `recordLifecycleEventToKg(workspaceRoot, event)` next to the
existing writers in `kgRecord.ts`. It takes `{ taskId, sprint?, agent, kind, text,
discriminator, meta?, edges?: Array<{from,kind,to,meta?}> }`, `ensureNode`s the
`task:<project>:<taskId>` node, writes the lifecycle thought under the deterministic id,
then the `activity` edge + any caller-supplied edges. This keeps every call site a
one-liner and every write idempotent + degrade-safe. The handoff-note write in
`handoff.ts` is the single guaranteed choke point for `done` (protocol rule 7: no
handoff note = incomplete task), so hooking `writeHandoffNote` guarantees a `done`
lifecycle thought for every completed task.

**Note on `sprint` type:** `thoughts.sprint` is TEXT; board/loop sprint is numeric.
`recordLifecycleEventToKg` must `String(sprint)` (matching how `Thought.sprint?: string`
is already typed).

### 4.3 Board drill-down (click → query → render)

**New read methods** on the KG store (`store.ts`) + interface (`types.ts`), both
additive and small:

```ts
// timeline: every thought for a task, oldest→newest (activity log order)
thoughtsForTask(taskId: string, opts?: { project?: string }): Promise<Thought[]>;
// lineage: edges touching the task node (parents + children)
edgesForNode(nodeId: string): Promise<Edge[]>; // from_id = node OR to_id = node
```

`thoughtsForTask` = `SELECT * FROM thoughts WHERE task_id = ? [AND project = ?] ORDER BY
created_at ASC` (uses the new `thoughts_task_created` index). `edgesForNode` = two
indexed lookups (`edges_from_kind` on `from_id`, `edges_to` on `to_id`) unioned. The
degraded handle returns `[]` for both (extend `DEGRADED_KG` in `index.ts`).

**Panel wiring.** Reuse the existing KG viewer webview shell rather than building a new
one, but give it a **task-scoped entry point**:

1. `board.json` items already carry `task_id`. In the Fleet panel's board rendering,
   make each task row a clickable element that posts
   `{ command: 'openTaskProvenance', taskId }` back through the existing
   `onDidReceiveMessage` channel (`fleetPanel.ts:148` — currently only handles
   `refresh`/`ready`; add the new case).
2. The panel handler calls a new command `autoclaw.kg.taskProvenance` (registered
   alongside `autoclaw.kg.browse` in `kgViewPanel.ts:registerKgViewPanel`) with the
   `taskId`.
3. That command opens/reveals the KG viewer panel in a **task-focused mode**: it calls
   `thoughtsForTask(taskId)` + `edgesForNode(task:<project>:<taskId>)` and posts a new
   message `{ type: 'taskProvenance', taskId, header, timeline, lineage }` to the
   webview. The webview renders three regions:
   - **Header ("created by / why")** — derived from the earliest `created`/`spawned`
     thought (`agent`, `created_at`, `text`, and any `spawned_by` / `implements` target).
   - **Timeline (activity log)** — the `thoughtsForTask` list rendered oldest→newest,
     one row per lifecycle thought (kind badge + agent + timestamp + text). This is where
     "who did what when" lives.
   - **Lineage graph (parents/children)** — `edgesForNode` filtered to structural kinds
     (`spawned_by`, `derived_from`, `implements`, `blocks`), rendered with the viewer's
     existing force-graph (`media/kg/force-graph.min.js`) seeded on the task node. Reuse
     `deriveSameTaskEdges` only as a fallback when no stored `activity` edges exist yet
     (keeps old graphs non-empty during rollout).

Reusing `kgViewPanel.ts` means CSP/nonce/asWebviewUri/handshake and the force-graph
vendoring are already solved; we add one message type and one render mode. No new
webview asset bundle.

### 4.4 Message ↔ board ↔ KG linking

The cross-agent message taxonomy lives in `src/comms.ts` (`MessageType`). Message
history becomes the activity log by writing a matching lifecycle thought+edge on
**first** processing of each of these types (gated by the message ledger, §4.2):

| message type (`comms.ts`) | lifecycle `kind` | discriminator |
|---|---|---|
| `task_assignment` / `task_claim` | `created` / `claimed` | message `id` |
| `task_complete` | `done` | message `id` (+ handoff `session_id`) |
| `review_request` / `review_response` | `review` | message `id` |
| `consensus_vote` / `consensus_result` | `decision` (existing `coord:` id) | verdict natural key |
| `finding_report` | `spawned` (if it spawns an ops-task) | finding id / message `id` |
| `scope_conflict` | `blocked` | message `id` |

The `activity` edge from `task:<project>:<taskId>` to the lifecycle thought is what makes
the message *drillable from the board*: the board item → `thoughtsForTask` shows the row;
the `meta_json` of the thought carries `{ source: 'message', message_id, from, to }` so
the timeline row can link back to the exact inbox file. This is a read-time convenience,
not a new store — the message file itself stays the source of truth.

### 4.5 Backfill (one-shot ingest from existing artifacts)

The trail we already have on disk (verified present in this repo):

- **Handoff sidecars** — `.autoclaw/orchestrator/comms/handoffs/*.json` (confirmed:
  `BL-30-*.json`, `BL-7a-*.json`, etc.). Schema = `HandoffNote` (`handoff.ts`):
  `task_id`, `agent_id`, `session_id`, `timestamp`, `files_changed`,
  `integration_points`, `tests_run`, `risks`, `summary`, `next_task_suggested`,
  `branch`. → one `done` lifecycle thought per note (id
  `evt:<p>:<taskId>:done:<session_id>`), plus `derived_from` edge when
  `next_task_suggested` is set.
- **Dispatch sidecars** — the dispatch record files written by `orchestratorLoop.ts:768`
  (basename is the existing `eventId`). → `progress`/dispatch thought + `activity` edge.
- **Consensus** — `.autoclaw/orchestrator/comms/consensus/` (present). Already covered by
  `recordCoordinationToKg`; backfill just replays resolved verdicts. → `decision`.
- **Sprint assignment / catalog** — `.autoclaw/orchestrator/sprints/plan-summary*.yaml`
  + `sprint-*.yaml` + `state.json` `tasks[]` (all present). → `created` thought per task
  with `implements`→`spec:<req-id>` when the task references a spec.
- **`docs/ENHANCEMENT_LOG.md`** — **does not exist in this repo** (checked). The proposal
  named it as a possible source; treat it as optional/absent. Do not block on it. If a
  project has one, ingest each entry as a `progress`/`created` thought; otherwise skip.

Implement `backfillTaskProvenance(workspaceRoot, opts?)` as a one-shot function in
`kgRecord.ts` (companion to the deferred `backfillOutcomeEdges` mentioned in
`kg-edge-outcome-contract.md`), exposed behind a command `autoclaw.kg.backfillProvenance`
and callable from `/learn`. It walks the four present sources, maps each to a lifecycle
thought under a deterministic id, and relies on duplicate-id-skip for idempotency, so
re-running never grows the graph. Best-effort per record; returns
`{ recorded, skipped }`.

---

## 5. Phased implementation plan

Land each phase as a gated increment (worktree + `mergeGate` scope) on `dev-beta`.
**`test:unit` gotcha:** `package.json`'s `test:unit` script is an *explicit* file list of
`out/test/*.test.js` — a new test file is **not** picked up unless its compiled path is
appended to that list (or the phase reuses an already-listed file such as
`out/test/intelligence-kgrecord.test.js`). Every phase below either extends an existing
listed test file or appends the new one to `test:unit`.

### KG-P1 — schema + read API confirmation (foundation)
- Scope: `src/intelligence/kg/schema.ts` (add `thoughts_task_created` index),
  `src/intelligence/kg/store.ts` + `types.ts` (add `thoughtsForTask`, `edgesForNode`),
  `src/intelligence/kg/index.ts` (extend `DEGRADED_KG` with the two no-op reads).
- Tests: extend `src/test/intelligence-kg.test.ts` (in-memory `:memory:` store already
  used there) — assert `thoughtsForTask` order + project filter, `edgesForNode` union,
  degraded no-op. `intelligence-kg.test.js` is already in the `test:unit` list.
- Risk: none (additive index + additive methods).

### KG-P2 — lifecycle writes (`recordLifecycleEventToKg`)
- Scope: `src/intelligence/kgRecord.ts` (new function + deterministic id helper), no call
  sites yet.
- Tests: extend `src/test/intelligence-kgrecord.test.ts` (fake KG, already listed) —
  assert node ensured, deterministic id dedup, `activity` + caller edges, degrade-safe.
- Risk: none (pure additive module function, mirrors `recordOutcomeEdge`).

### KG-P3 — board query + panel drill-down
- Scope: `src/kg/kgViewPanel.ts` (new `autoclaw.kg.taskProvenance` command + task-focused
  render message), `media/kg/kg-view.{html,js,css}` (task-provenance render mode),
  `src/panel/fleetPanel.ts` (clickable board rows → `openTaskProvenance` message +
  handler case at `:148`).
- Tests: a new `src/test/kg-board-provenance.test.ts` for `gatherKgData`/task-scope
  assembly (host-free parts) — **append `out/test/kg-board-provenance.test.js` to
  `test:unit`**. Webview HTML is exercised by the existing `webview-rendering.test.ts`
  pattern if the render is factored into a pure function.
- Risk: panel is a shared hot file — isolate in a worktree, coordinate with any live UX
  session (project memory flags fleetPanel/kgViewPanel churn).

### KG-P4 — backfill (`backfillTaskProvenance`)
- Scope: `src/intelligence/kgRecord.ts` (new one-shot walker), a command
  `autoclaw.kg.backfillProvenance` in `extension.ts`, optional call from `learn.ts`.
- Tests: extend `intelligence-kgrecord.test.ts` — feed synthetic handoff/dispatch dirs
  (tmp workspace), assert deterministic ids + idempotent re-run.
- Risk: reads arbitrary on-disk JSON — guard every parse (the readers already do:
  `readJson` swallows). Bound the walk (cap per source) to avoid a huge first run.

### KG-P5 — message linking
- Scope: the comms message handlers that process `task_assignment` / `task_claim` /
  `task_complete` / `review_*` / `finding_report` / `scope_conflict` — add a
  `recordLifecycleEventToKg` call **gated on first-processing** (reuse the existing
  ledger check; do not add a parallel dedup). Files: wherever these are dispatched
  (grep `message_ledger` / `processed/` movers).
- Tests: a handler-level test asserting one KG write per first-processing and **zero** on
  re-processing a `processed/` message (append to `test:unit` if a new file).
- Risk: double-write if the ledger gate is bypassed — the deterministic id (message id
  discriminator) is the backstop, so even a bypass is a no-op INSERT.

Landing order rationale: P1 (schema/reads) unblocks everything; P2 (writer) is pure and
testable in isolation; P3 makes the value visible even with only backfilled data; P4
fills the graph from disk so P3 has something to show immediately; P5 makes it live
going forward.

---

## 6. Risks / open questions

- **Write volume / perf.** Lifecycle writes are one small INSERT (+1–2 edges) per event,
  on a WAL SQLite with serialized writers. The orchestrator already writes
  dispatch/completion thoughts every tick without issue. `activity` edges are bounded by
  event count. Keep the embedding on `text` optional — the `none` provider means no
  network and `has_embed=0`; do not force real embeddings on the hot lifecycle path
  (pass through the existing lazy `embed` seam, which is already best-effort).
- **Privacy.** The KG holds *coordination* facts and is local-first
  (`.autoclaw/kg/kg.db`, never committed — steering rule: "Never commit … generated
  intelligence caches"). Lifecycle `text` and `meta` must stay redacted: reuse the
  existing intelligence redaction before writing free-form summaries (handoff summaries
  can contain paths — the steering rule requires scrubbing public paths). Do **not** put
  secrets, tokens, or customer transcripts into `text`/`meta`.
- **Schema migration on an existing `kg.db`.** The only change is
  `CREATE INDEX IF NOT EXISTS thoughts_task_created …` in `createKgSchema`, which runs
  idempotently on every open (the schema function is already `CREATE … IF NOT EXISTS`
  throughout). No `ALTER`, no data rewrite, no version bump of the db.
- **Keep it FREE.** No premium gating anywhere in this feature — it is core board
  usability. No `PremiumApi` seam, no license check, no `enforceGates` involvement.
- **Endpoint-resolution subtlety.** `traverseFrom` only hydrates edge endpoints that are
  thought ids. `task:*` and `spec:*` nodes are `ensureNode`d as thoughts so lineage
  resolves; `activity` edges point at real lifecycle thought ids. Any edge whose endpoint
  is *only* a raw task id (not the `task:*` thought) will store but not traverse —
  callers must always use the `task:<project>:<taskId>` node id, never the bare id.
- **Open question — sprint typing.** `thoughts.sprint` is TEXT but the board/loop sprint
  is numeric. Stringify at the writer. Confirm no downstream reader parses `sprint` as a
  number (grep showed only display use).
- **Open question — do we retire `deriveSameTaskEdges`?** Once `activity` edges are
  populated, the viewer's synthesized "same-task" edges become redundant. Keep them as a
  labeled fallback (`derived:true`) during rollout; consider removing after backfill is
  standard. Not a blocker.

---

## 7. Non-goals

- **Not** a new database, daemon, or store. The standalone `packages/kg-daemon` is not
  revived; everything is the in-process store via `getKnowledgeGraph`.
- **Not** a change to how `board.json` is *bucketed* (`board.ts` bucketing logic is
  untouched); this only adds a drill-down path off existing items.
- **Not** a rewrite of the KG viewer — it is reused with one added task-scoped mode.
- **Not** embeddings/semantic quality work — lifecycle thoughts index via whatever
  provider is configured (default `none` → FTS/LIKE), and that is fine; recall quality is
  a separate track.
- **Not** premium/enterprise reporting, evidence ranking, or hosted engines — those stay
  in the private repo per the ecosystem steering; this is free community wiring.
- **Not** `/index-code` behavior — the code/learning vector store is unchanged; this is
  purely the coordination KG.
- **Not** committing any of the generated `kg.db` or backfilled provenance to git.
