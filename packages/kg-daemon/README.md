# @autoclaw/kg-daemon

> **Prototype, not production.** Tier-1 implementation of the AutoClaw
> shared Knowledge Graph daemon. Single Node process, single SQLite
> file, localhost HTTP. See
> [`docs/research/knowledge-graph-stack.md`](../../docs/research/knowledge-graph-stack.md)
> and `docs/DISTRIBUTED_AGENT_FABRIC.md` §2.4 / §3 for the contract.

## What it is

A standalone daemon any AutoClaw agent (Claude Code, Kilo Code, future
LLMs) can hit to record thoughts / findings / observations and search
them back. Stack:

- `better-sqlite3` (sync, fast, MIT-friendly)
- `sqlite-vec` for vector search (optional — degrades gracefully)
- FTS5 for keyword search (built into SQLite)
- A hand-rolled `edges` table for graph traversal via recursive CTE
- Embeddings via ZippyMesh `POST :20128/embeddings` (also optional)

## How it relates to AutoClaw

- One `.db` per project; the AutoClaw extension will spawn one daemon
  per workspace, on `127.0.0.1:9877` (the bridge lives on `:9876`).
- Implements the `KnowledgeGraph` TS interface from §2.4 of the fabric
  doc; Tier 2 (KuzuDB) will be a drop-in swap behind the same HTTP.
- Speaks JSON over HTTP — language-agnostic, so non-Node agents can
  POST with `curl` / `fetch` / `requests`.

## Install (manual, when ready)

This package is currently standalone — not yet wired into the
workspace. From this directory:

```sh
npm install
npm run build
npm start
```

Optional env:

| Var | Default | Meaning |
|---|---|---|
| `KG_DB_PATH` | `./kg-prototype.db` | SQLite file path |
| `KG_PORT` | `9877` | HTTP port |
| `KG_HOST` | `127.0.0.1` | Bind address (keep loopback) |
| `ZIPPYMESH_URL` | `http://localhost:20128` | Embedding endpoint base |

## HTTP surface (all `/api/v1/*`, JSON)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/thoughts` | `recordThought` |
| POST | `/api/v1/relations` | `recordRelation` |
| GET | `/api/v1/thoughts/search?q=&k=10&project=&agent=&since=` | `searchSimilar` (vector if available, else FTS) |
| GET | `/api/v1/thoughts/traverse?seed=&kinds=a,b&depth=2` | `traverseFrom` |
| GET | `/api/v1/thoughts?agent=&project=&since=` | `forAgent` / `forProject` / `since` |
| GET | `/api/v1/thoughts/export?project=&format=jsonl` | streamed export |
| GET | `/api/v1/health` | `{ ok, sqlite, vec, fts, zippymesh }` |

Errors match the bridge shape:

```json
{ "error": { "code": 400, "message": "..." } }
```

## What still works when things are missing

- **No `sqlite-vec`** (e.g. install failed): vector search silently
  falls back to FTS5 keyword search; ingest still works.
- **No ZippyMesh**: thoughts are stored without embeddings; search
  uses FTS only. The daemon never crashes on embed failures.
- **No FTS5** (theoretical — SQLite is built with it by default in
  `better-sqlite3`): server still serves writes and graph traversal.

## Test

```sh
npm test
```

A vitest smoke test starts the server on a random port, posts a
thought, searches for it, and asserts it round-trips even if ZMLR is
unreachable.

## Status

Prototype. Promote to production by addressing items in the fabric
doc Phase 3 (auth tokens, redaction hook, NDJSON streaming export
contract, Tier-2 Kuzu adapter).
