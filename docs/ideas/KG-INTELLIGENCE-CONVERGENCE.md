# Knowledge Graph ↔ Intelligence Layer Convergence

> **Status:** Findings + design (Direction A, approved 2026-06-17).
> **Author:** Claude Code (`claude-code`), raised via the cross-agent protocol.
> **Supersedes the operational role of:** `packages/kg-daemon/` as the
> extension's KG backend (the package stays as an optional language-agnostic
> standalone server for non-Node external agents).

## 1. Problem — the KG has never worked for any install

The panel chip "kg: off" with the tooltip *"kg-daemon dependencies not
installed; run `cd packages/kg-daemon && npm install`"* is not a
misconfiguration — the feature is structurally unreachable for every
non-monorepo install. Three stacked blockers:

1. **The daemon isn't shipped.** [.vscodeignore](../../.vscodeignore) line 12
   excludes `packages/**` from the `.vsix`. A marketplace / Open VSX install
   contains **zero** kg-daemon code — no `node_modules`, no `dist/`, no `src/`.
   [`kgDepsInstalled()`](../../src/kg.ts) finds no `node_modules` and returns
   `deps_missing`; the printed fix (`cd packages/kg-daemon`) points at a
   directory that does not exist in the install. (Confirmed: the user's failing
   instance is `extension-output-ZippyTechnologiesLLC.autoclaw`, the *published*
   build, not the dev host.)

2. **The spawn would launch an editor window, not Node.** `startKgDaemon`
   does `spawn(process.execPath, [entry])`. In VS Code `process.execPath` is
   `Code.exe` (Electron). Without `ELECTRON_RUN_AS_NODE=1` that does not run
   `server.js` as Node. There is no `ELECTRON_RUN_AS_NODE` anywhere in `src/`.

3. **`better-sqlite3` is an ABI trap.** `packages/kg-daemon/src/db.ts` imports
   the native `better-sqlite3`, compiled for one specific Node/Electron ABI.
   This is the *same* problem already solved for the Intelligence Layer vector
   backend by moving to `node:sqlite` (see `project_vector_backend_abi`).

Net: a separately-spawned child process built on `better-sqlite3` is the wrong
shape for an extension that ships through a marketplace.

## 2. Decision — Direction A: in-process KG on the Intelligence stack

Fold the KG into the Intelligence Layer's proven, in-process, `node:sqlite`
storage path and serve its HTTP contract through the **existing bridge** — no
child process, no `packages/**` in the `.vsix`, no native ABI dependency. The
always-available `none` embedding provider means the KG works on a bare install
out of the box and upgrades silently when transformers/ollama are present.

This also unifies "agent memory" (KG thoughts) with the intelligence corpus and
the embedding provider, instead of running two parallel storage stacks.

## 3. Architecture

```
┌─────────────────────── extension host (in-process) ───────────────────────┐
│                                                                            │
│  KnowledgeGraphStore  ──opens──►  node:sqlite DatabaseSync                 │
│   (port of kg-daemon's            (better-sqlite3 = fallback only)         │
│    db.ts + kg.ts)                 schema: thoughts · edges · FTS5 · vec0   │
│        │                          db file: .autoclaw/kg/kg.db              │
│        │ embeddings via                                                    │
│        ▼ src/intelligence/embeddings.getEmbedding (none|ollama|xenova)     │
│                                                                            │
│   served three ways, all in-process:                                       │
│   1) Bridge HTTP   GET/POST /api/v1/kg/*   (src/bridge.ts route block)     │
│   2) MCP tools     kg.record · kg.search · kg.relate · kg.traverse         │
│   3) Panel chip    FabricHealth.kg  (ready|degraded|disabled)              │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Storage — `KnowledgeGraphStore`

New module `src/intelligence/kg/` (sibling of `vector/`). Port the daemon's
`db.ts` + `kg.ts` from `better-sqlite3` to `node:sqlite` `DatabaseSync`,
preserving the **full** `KnowledgeGraph` contract from
`packages/kg-daemon/src/types.ts` — thoughts, edges, bi-temporal
`valid_from`/`valid_to`, multi-strategy (`vec`/`fts`/`graph`/`multi`) recall.

- **Driver:** lazy `require('node:sqlite').DatabaseSync`. On failure fall back
  to `better-sqlite3` if present; on *both* failing, return a **degraded**
  handle (writes no-op, search returns `[]`) — never throw, mirroring
  `initVectorDB`'s degrade contract (R3.1).
- **FTS5 + vec0:** FTS5 is built into SQLite. `vec0` stays optional via
  `sqlite-vec`; absent ⇒ `caps.vec=false` and search degrades to FTS, exactly
  as the daemon does today.
- **Embeddings:** replace the ZippyMesh-only `embed()` with the intelligence
  `getEmbedding(text, cfg.embedding)` provider so the `none` provider gives a
  deterministic vector with zero native deps. Embedding dimension comes from
  the active signature (default 768).
- **Paths:** `intelligencePaths(root)` gains a `kgDbPath` (`.autoclaw/kg/kg.db`)
  or we reuse `.autoclaw/vector/` — TBD in implementation; keep KG in its own
  file to avoid schema entanglement with the vector store.

> **node:sqlite API deltas to handle in the port:** `DatabaseSync` uses
> `db.prepare(sql)` → `stmt.run/get/all/iterate` (positional or named `@`/`$`
> params), `db.exec()` for DDL. No `db.transaction(fn)` helper — wrap in
> `db.exec('BEGIN')`/`COMMIT`/`ROLLBACK`. Blob params are `Uint8Array`. These
> are the only meaningful differences from better-sqlite3 for our queries.

### 3.2 HTTP — mount on the bridge

The bridge (`src/bridge.ts`, port 9876) already serves `/api/v1/*` with CORS,
token auth, and health. Register a KG route block before the 404 fallthrough:

| Method | Path | Maps to |
|---|---|---|
| POST | `/api/v1/kg/thoughts` | `recordThought` |
| POST | `/api/v1/kg/relations` | `recordRelation` |
| GET  | `/api/v1/kg/thoughts/search` | `searchSimilar` |
| GET  | `/api/v1/kg/thoughts/traverse` | `traverseFrom` |
| GET  | `/api/v1/kg/thoughts` | `forAgent`/`forProject`/`since` |
| GET  | `/api/v1/kg/thoughts/export` | streamed export |
| GET  | `/api/v1/kg/health` | `{ ok, sqlite, vec, fts, embedding }` |

Re-homing under `/api/v1/kg/*` (vs the daemon's bare `/api/v1/thoughts`) avoids
collision with the bridge's own `/api/v1/messages` etc. No external clients
exist yet (the feature never worked), so there is no compatibility cost.

### 3.3 MCP tools — the primary agent surface

Agents speak MCP, not HTTP. Add read tools (`kg.search`, `kg.traverse`) and
write tools (`kg.record`, `kg.relate`) following the `presence.beacon` pattern
in `src/mcp/tools.ts` / `src/mcp/writeTools.ts`. This is what actually lets
Claude Code / Kilo / federated agents record and recall shared thoughts.

### 3.4 Panel UX — stop lying

Replace the `off|running|unreachable` state machine with one that reflects an
always-available in-process service:

- `disabled` — `autoclaw.kg.enabled=false` → chip offers "Enable Knowledge Graph".
- `ready` — store healthy (vec or fts) → chip opens the dashboard.
- `degraded` — store fell back to no-op (both drivers failed) → chip explains
  why and links the doctor section. **Never** print "cd packages/kg-daemon".

Doctor's KG section ([src/doctor.ts](../../src/doctor.ts)) is updated to report
the in-process store (driver in use, caps, embedding provider, db path) instead
of `packages/kg-daemon/node_modules` + `dist/server.js`.

### 3.5 What happens to `packages/kg-daemon`

Kept as an **optional standalone** server for non-Node external agents that
prefer HTTP over MCP. It is no longer on the extension's critical path and is no
longer referenced by `startKgDaemon`. README updated to say so. (A later pass
can port it to `node:sqlite` too, but it is no longer urgent.)

## 4. Work breakdown (sprint `kg-conv`)

| Task | Scope (files) | Depends on | Parallel? |
|---|---|---|---|
| **KGC-1 Storage core** | `src/intelligence/kg/store.ts`, `schema.ts`, `index.ts`, `paths.ts` (+`kgDbPath`) | — | foundation, do first |
| **KGC-2 Unit tests** | `src/intelligence/kg/__tests__/` | KGC-1 API | after KGC-1 |
| **KGC-3 Bridge HTTP** | `src/bridge.ts` (kg route block), bridge tests | KGC-1 API | parallel w/ 4,5 |
| **KGC-4 MCP tools** | `src/mcp/tools.ts`, `src/mcp/writeTools.ts`, tests | KGC-1 API | parallel w/ 3,5 |
| **KGC-5 Panel + doctor** | `src/extension.ts`, `src/webview-render.ts`, `src/doctor.ts`, `src/kg.ts` (state types), tests | KGC-1 API | parallel w/ 3,4 |
| **KGC-6 Docs/changelog** | `packages/kg-daemon/README.md`, `CHANGELOG.md`, settings desc in `package.json` | 3,4,5 | last |

KGC-1 is the critical path (every surface keys off its API), built first and
in one context. KGC-3/4/5 fan out in parallel once KGC-1's API is frozen.

## 5. Acceptance

- Fresh marketplace-style install (no `packages/`, no native modules): KG chip
  shows `ready`, a thought records and round-trips via MCP **and** HTTP using
  the `none` embedding provider, with **no** "deps not installed" message.
- `sqlite-vec` / transformers present ⇒ vector search active; absent ⇒ FTS
  fallback, no crash.
- All existing `kg-lifecycle` / `webview-rendering` / doctor tests updated and
  green; new store + route + tool + panel tests green.
