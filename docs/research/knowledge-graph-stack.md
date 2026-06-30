# Knowledge Graph + Shared Memory Stack for AutoClaw

> Research date: 2026-05-09 | Author: Claude Code (Opus 4.7)
> Mission: pick a pragmatic shared agent thought-store for AutoClaw's
> multi-agent fabric (Claude Code, Kilo Code, future LLMs / IDEs).

## 1. Executive Summary

AutoClaw needs a single store where any agent can write a thought,
observation, or finding and any other agent can pull it back as
context. The store must run locally (zero infra), support hybrid
retrieval (vector + graph + keyword), tag every record with agent +
project + timestamp, and survive a future jump to multi-user / multi-LAN
deployment without a rewrite.

After surveying 14 candidates, the recommended path is two-tier:

- **Tier 1 (Phase 1, ~1 week):** SQLite (better-sqlite3) + `sqlite-vec`
  + a hand-rolled `edges` table. Embedded, single-file, MIT-licensed,
  trivial to ship inside the AutoClaw VS Code extension. Optionally
  swap `sqlite-vec` for an embedded LanceDB table if multimodal blobs
  show up.
- **Tier 2 (Phase 2, when concurrency / cross-machine matters):**
  KuzuDB (embedded property graph, MIT, native Cypher, built-in HNSW
  vector + FTS) fronted by a tiny HTTP service. If multi-writer
  concurrency from multiple machines becomes the bottleneck, fall
  forward to Neo4j Community 5.x with its native vector index, or to
  Postgres + Apache AGE + pgvector.

Both tiers implement the same `KnowledgeGraph` TypeScript interface
(see s.6) so agents and the AutoClaw orchestrator never see the
swap. Higher-level "agent memory frameworks" (Graphiti, Cognee, Mem0,
Letta) are noted as **opt-in layers on top** — useful, but each pulls
in heavy infra (Neo4j, Postgres, Python services) and policy that
duplicates what AutoClaw already does. Better to own the contract.

## 2. Requirements Recap

| # | Requirement | Why |
|---|---|---|
| R1 | Runs locally, zero/cheap infra | User already runs ZippyMesh on :20128; can't ask for a managed DB |
| R2 | Ingest plain-text thoughts / message bodies | Agents drop notes via the `comms/inboxes` protocol |
| R3 | Entity + relation extraction | So an agent can ask "what does Kilo know about file X?" |
| R4 | Hybrid retrieval (vector + graph + keyword) | Recall is bad if you only have one |
| R5 | Per-agent attribution + timestamps | Multi-agent provenance, replay, blame |
| R6 | Project / repo scoping | Don't bleed thoughts across repos |
| R7 | TS/Node-friendly + HTTP reachable | AutoClaw is TS; sub-agents are polyglot |
| R8 | Permissive license (MIT/Apache/BSD) | This is shipping in an OSS extension |
| R9 | Easy export | "Give me everything Kilo wrote about task T" must be one query |
| R10 | Scale path to multi-user / multi-LAN | Without rewriting the agent code |

## 3. Candidate Survey

License legend: green = MIT/Apache/BSD, yellow = source-available
with caveats, red = AGPL/SSPL/strong-copyleft (incompatible with a
permissively-licensed extension).

### 3.1 Higher-level agent-memory frameworks

#### Graphiti (Zep)
- One-liner: temporal knowledge graph for agents; every fact has a
  validity window (when true / when superseded).
- License: **Apache 2.0** (green). Zep Cloud is the hosted product.
- Runtime: Python service. **Requires Neo4j 5.26+ or FalkorDB.**
- TS bindings: none official; HTTP via Zep Cloud or Graphiti MCP server.
- Strength: best-in-class temporal semantics, autonomous extraction,
  proven at agent scale, ~14k GH stars.
- Weakness: drags in Neo4j + Python + an LLM call per ingest. Heavy
  for a 1-user / 1-laptop setup.
- Fit for AutoClaw: **3/5** (good Tier 3 destination, overkill today).

#### Cognee
- One-liner: "memory control plane for agents in 6 lines of code";
  `remember / recall / forget / improve` API; semantic graph + vectors.
- License: **MIT** (green).
- Runtime: Python library or Cognee MCP server.
- TS bindings: none first-party; reachable via MCP / HTTP.
- Strength: opinionated, ergonomic, has dataset-level ACLs and OTEL.
- Weakness: Python-first; storage backends still proxy to a real
  graph + vector DB (you're picking one anyway); cloud tier is paid.
- Fit: **3/5** (nice DX layer, but adds dependency surface).

#### Mem0
- One-liner: universal memory layer; per-user/per-agent long-term
  memory with auto-extracted facts.
- License: **Apache 2.0** (green).
- Runtime: library (Python or TS SDK) + vector store + optional
  graph store.
- TS bindings: yes, official `mem0ai` npm; v3 beta.
- Strength: TS-native is rare in this category; smallest cognitive
  load; pluggable vector store.
- Weakness: memory model is per-user/agent, not "shared team brain";
  graph features lag the vector ones; cloud upsell is loud.
- Fit: **3.5/5** (could ride alongside Tier 1 as an agent-personal
  memory; not the team store).

#### Letta (formerly MemGPT)
- One-liner: stateful-agent platform; treats context window like RAM,
  spills to archival memory.
- License: **Apache 2.0** (green).
- Runtime: server (Postgres + pgvector) + ADE UI.
- TS bindings: HTTP / OpenAPI client.
- Strength: full agent runtime + memory; great if you want Letta to
  *be* your agent host.
- Weakness: it's an agent OS, not a memory primitive. AutoClaw
  already has its own agent runtime (Claude Code, Kilo, etc.) — you
  don't want a second one.
- Fit: **2/5** (wrong abstraction level for AutoClaw).

#### Microsoft GraphRAG
- One-liner: RAG with LLM-built entity graph + Leiden community
  detection + hierarchical summaries.
- License: **MIT** (green).
- Runtime: Python pipeline; storage is pluggable (Parquet / LanceDB /
  Neo4j).
- TS bindings: none.
- Strength: great for "explain this whole codebase" global queries.
- Weakness: indexing is **10–40× more expensive than vector RAG**
  ($50–$200 to index a corpus that costs <$5 to embed). LazyGraphRAG
  fixes this but is newer. Wrong fit for streaming agent thoughts —
  you'd reindex constantly.
- Fit: **2/5** (consider only as a periodic offline summarizer).

#### LightRAG
- One-liner: simple, fast, dual-level (low/high-level) graph + RAG.
- License: **MIT** (green).
- Runtime: Python lib; storage adapters for Neo4j, NetworkX,
  PostgreSQL, etc.
- TS bindings: none official; Go and Rust ports exist.
- Strength: way cheaper than GraphRAG, EMNLP'25 paper, active.
- Weakness: still Python-first; still needs an LLM per ingest;
  agent-attribution is not a first-class concept.
- Fit: **3/5** (good extraction layer that emits to whatever DB
  Tier 1/2 picks).

### 3.2 Vector-only options

#### LanceDB
- One-liner: embedded multimodal vector DB on the Lance columnar
  format; vector + FTS + SQL via DuckDB.
- License: **Apache 2.0** (green).
- Runtime: embedded (in-process) or LanceDB Cloud.
- TS bindings: official `@lancedb/lancedb` npm; Rust core, Python +
  TS + Rust SDKs.
- Strength: zero-server; multimodal; FTS + vector + SQL together;
  scales from laptop to S3-backed billion-vector lakehouse without
  changing the API. Big momentum 2026.
- Weakness: not a graph DB. Edges have to be modeled by hand or
  stored alongside in DuckDB / SQLite.
- Fit: **4.5/5** as the vector half of Tier 1.

#### DuckDB-VSS
- One-liner: HNSW vector extension for DuckDB.
- License: **MIT** (green).
- Runtime: embedded.
- TS bindings: via `duckdb` npm.
- Strength: SQL-native, great for analytics on top.
- Weakness: less mature than `sqlite-vec` for tiny-footprint use,
  HNSW persistence had rough edges historically.
- Fit: **3/5**.

#### Chroma
- One-liner: dev-friendly embedding DB; embedded or client/server.
- License: **Apache 2.0** (green).
- Runtime: in-process (SQLite/DuckDB backend) or server.
- TS bindings: official.
- Strength: easiest "hello world" of any vector DB.
- Weakness: graph-y queries unsupported; perf trails Qdrant /
  LanceDB at scale.
- Fit: **3/5**.

#### Qdrant
- One-liner: Rust-native production vector DB with rich payload
  filtering.
- License: **Apache 2.0** (green).
- Runtime: server (Docker), or in-memory embedded for testing.
- TS bindings: official `@qdrant/js-client-rest`.
- Strength: best price/perf 2026; mature filters; strong HTTP.
- Weakness: server, not embedded. Adds an ops surface.
- Fit: **3.5/5** (good Tier 2 vector half if Postgres is too heavy).

#### Weaviate
- One-liner: vector DB with built-in vectorizers + native hybrid
  (BM25 + vector).
- License: **BSD-3** (green).
- Runtime: server.
- TS bindings: official.
- Strength: hybrid search out of the box; modules for embedding gen.
- Weakness: heavyweight server; more than AutoClaw needs.
- Fit: **2.5/5**.

### 3.3 Graph-first options

#### Neo4j Community
- One-liner: the property graph DB; Cypher; native vector index in 5.x.
- License: **GPLv3** (yellow — copyleft. AutoClaw extension stays
  permissive because it talks to Neo4j over the network, but
  *bundling* the JAR would relicense the bundle. Run as a separate
  process and you're fine.). Enterprise is commercial.
- Runtime: server (JVM, ~1 GB RAM minimum realistically).
- TS bindings: official `neo4j-driver`.
- Strength: most mature graph DB; huge ecosystem; Graphiti / LightRAG /
  Cognee all support it as a backend.
- Weakness: JVM, RAM-hungry, single-leader writes in Community.
- Fit: **3.5/5** (canonical Tier 3 if KuzuDB ever runs out of legs).

#### KuzuDB
- One-liner: embedded, MIT, Cypher property graph; **vector (HNSW)
  and FTS extensions built in** as of v0.11.x.
- License: **MIT** (green).
- Runtime: embedded (single-file, like SQLite). C++ core.
- TS bindings: official `kuzu` npm package (Node addon, CommonJS +
  ESM).
- Strength: This is the "SQLite for graphs". Native Cypher, native
  vector + FTS, in-process, zero ops. Perfect for a VS Code
  extension.
- Weakness: single-writer (file-locked) like SQLite — multi-process
  writes need an HTTP wrapper. Younger than Neo4j; some ecosystem
  gaps (no Graphiti adapter today).
- Fit: **5/5** as Tier 2.

#### TerminusDB
- One-liner: git-style graph DB; branch / merge / time-travel queries
  on RDF + JSON.
- License: **Apache 2.0** (green).
- Runtime: Rust server (`terminusdb-store`).
- TS bindings: `@terminusdb/terminusdb-client` (older, less active).
- Strength: branch/merge semantics map *beautifully* onto multi-agent
  thought streams ("merge Kilo's branch into shared").
- Weakness: niche; small community vs Neo4j; query languages (WOQL +
  GraphQL) are unfamiliar; fewer LLM-tooling integrations.
- Fit: **3/5** (interesting research direction; not the safe pick).

#### SurrealDB
- One-liner: multi-model (document + graph + vector + KV +
  time-series) DB in one engine.
- License: **BSL 1.1** (yellow → converts to Apache 2.0 four years
  after each release; Additional Use Grant allows everything except
  offering it as a commercial DBaaS). Embedded SDK is fine for
  AutoClaw.
- Runtime: embedded *or* server. Single binary in Rust.
- TS bindings: official `surrealdb` npm.
- Strength: one engine covers vector + graph + docs in one
  transaction. Embedded mode is excellent.
- Weakness: BSL is not classic OSS — must read the Use Grant. Graph
  + vector features are newer than Neo4j / LanceDB. Recent funding
  ($23M, Feb 2026) means rapid change, occasional breakage.
- Fit: **4/5** (strong dark-horse alternative to Tier 1+2 if you want
  one tool not two; just confirm BSL is acceptable).

#### Apache AGE on Postgres + pgvector
- One-liner: Cypher inside Postgres + pgvector for embeddings; AGE
  is **GA in 2026** on Azure for PG 16/17/18.
- License: **Apache 2.0** (green) for AGE; **PostgreSQL license**
  (green) for PG; pgvector PostgreSQL.
- Runtime: Postgres server.
- TS bindings: any PG client (`pg`, `postgres.js`).
- Strength: ACID across vector + graph in one transaction; AutoClaw
  gets backups, replication, ops familiarity for free.
- Weakness: ops surface (a Postgres). Cypher-on-AGE has rough edges
  vs native Neo4j. Overkill for one user on one laptop.
- Fit: **4/5** (best Tier 3 multi-user landing pad).

### 3.4 Minimal / DIY

#### SQLite + sqlite-vec + edges table
- One-liner: better-sqlite3 + Alex Garcia's `sqlite-vec` (successor
  to `sqlite-vss`) + a tiny `edges(src, type, dst)` table.
- License: SQLite (public domain), **sqlite-vec is Apache 2.0**
  (green).
- Runtime: embedded; one `.db` file per project.
- TS bindings: `better-sqlite3` (sync, fast) or `node:sqlite`
  (Node ≥22).
- Strength: Lowest friction conceivable. Single file ⇒ trivially
  rsync-able / committable / exportable. Pure C, no native graph
  engine, no Python. WASM-runnable too.
- Weakness: graph traversals are recursive CTEs (slower past ~3
  hops on 100k+ edges). Single-writer. Vector-vec is newer than
  vector-vss but actively maintained by Mozilla Builders.
- Fit: **5/5** as Tier 1.

## 4. Scoring Matrix

| Candidate | License | Embed? | TS | Vector | Graph | FTS | Fit |
|---|---|---|---|---|---|---|---|
| Graphiti | Apache 2.0 | no (needs Neo4j) | HTTP | yes | yes | yes | 3 |
| Cognee | MIT | no | HTTP/MCP | yes | yes | yes | 3 |
| Mem0 | Apache 2.0 | lib | yes | yes | partial | partial | 3.5 |
| Letta | Apache 2.0 | no | HTTP | yes | weak | yes | 2 |
| GraphRAG | MIT | lib | no | yes | yes | yes | 2 |
| LightRAG | MIT | lib | no | yes | yes | yes | 3 |
| LanceDB | Apache 2.0 | yes | yes | yes | no | yes | 4.5 |
| DuckDB-VSS | MIT | yes | yes | yes | no | yes | 3 |
| Chroma | Apache 2.0 | yes | yes | yes | no | weak | 3 |
| Qdrant | Apache 2.0 | server | yes | yes | no | yes | 3.5 |
| Weaviate | BSD-3 | server | yes | yes | no | yes | 2.5 |
| Neo4j CE | GPLv3 (sep proc) | server | yes | yes | yes | yes | 3.5 |
| **KuzuDB** | **MIT** | **yes** | **yes** | **yes (HNSW)** | **yes (Cypher)** | **yes** | **5** |
| TerminusDB | Apache 2.0 | server | yes (older) | weak | yes | yes | 3 |
| SurrealDB | BSL 1.1 (→ Apache) | yes | yes | yes | yes | yes | 4 |
| AGE + pgvector | Apache 2.0 | server | yes | yes | yes | yes | 4 |
| **SQLite + sqlite-vec + edges** | **MIT/Apache 2.0/PD** | **yes** | **yes** | **yes** | **DIY** | **FTS5** | **5** |

## 5. Two-Tier Recommendation

### Tier 1 — Phase 1 (ship in ~1 week)

**Stack: better-sqlite3 + sqlite-vec + FTS5 + a hand-rolled edges table.**

Schema sketch (illustrative, single file `.autoclaw/kg/<project>.db`):

```sql
CREATE TABLE thoughts (
  id           TEXT PRIMARY KEY,           -- ULID
  agent        TEXT NOT NULL,              -- "claude-code", "kilocode"
  project      TEXT NOT NULL,              -- repo slug
  task_id      TEXT,                       -- optional sprint/task ref
  ts           INTEGER NOT NULL,           -- unix ms
  kind         TEXT NOT NULL,              -- thought|finding|observation|decision
  body         TEXT NOT NULL,
  meta_json    TEXT                        -- JSON sidecar
);
CREATE INDEX thoughts_proj_ts ON thoughts(project, ts DESC);
CREATE INDEX thoughts_agent   ON thoughts(agent);

CREATE VIRTUAL TABLE thoughts_fts USING fts5(
  body, content='thoughts', content_rowid='rowid'
);

CREATE VIRTUAL TABLE thoughts_vec USING vec0(
  embedding float[768]                     -- whatever the embedder emits
);

CREATE TABLE entities (
  id TEXT PRIMARY KEY, project TEXT, name TEXT, kind TEXT, meta_json TEXT
);

CREATE TABLE edges (
  src TEXT NOT NULL,                       -- entity or thought id
  rel TEXT NOT NULL,                       -- "mentions","supersedes","derives_from"
  dst TEXT NOT NULL,
  ts  INTEGER NOT NULL,
  agent TEXT NOT NULL,
  PRIMARY KEY (src, rel, dst, ts)
);
CREATE INDEX edges_dst ON edges(dst, rel);
```

Why this is enough:
- One file per project ⇒ R6 (project scoping) is filesystem-trivial.
- `agent` + `ts` columns ⇒ R5 + R9 (attribution, export) are SQL.
- `vec0` + `fts5` + recursive-CTE traversal of `edges` ⇒ R4 (hybrid).
- Entity / relation extraction is **out-of-process**: any agent calls
  ZippyMesh on :20128 to get an embedding + a small JSON of
  `{entities, relations}` and writes the rows itself. No Python
  pipeline needed.
- File can be checked into a project-local `.autoclaw/` dir, rsynced,
  zipped, exported as JSONL with one query.
- License: all green.

Multi-process write strategy: one tiny Node "kg-daemon" per machine
(spawned by AutoClaw on demand) owns the file in WAL mode and
exposes a localhost HTTP port. Agents on that machine POST to it.
This is the same pattern AutoClaw already uses for the comms inboxes,
so the operational story is unchanged.

### Tier 2 — Phase 2 (when concurrency or cross-machine shows up)

**Stack: KuzuDB embedded inside the same kg-daemon, exposed over HTTP/WS.**

Triggers for the swap:
- More than ~3 machines writing simultaneously, or
- Edge count past ~1–2 M and traversals past 3 hops feel slow, or
- The team wants Cypher / shared schema migrations.

Why KuzuDB:
- MIT, embedded, single-file, **same operational story as SQLite**.
- Native Cypher (`MATCH (a)-[:MENTIONS]->(t:Thought) WHERE ...`).
- HNSW vector index + FTS built in as of v0.11; one DB instead of
  three indexes glued together.
- Official `kuzu` npm package.
- Drops into the same `kg-daemon`; the `KnowledgeGraph` interface
  doesn't change.

Fallback if KuzuDB ever underdelivers: switch the daemon's backend
to **Postgres + Apache AGE + pgvector** (multi-user, multi-LAN, ACID,
backup story, all green licenses). The AutoClaw kg-daemon stays the
same HTTP surface.

Higher-level frameworks (Graphiti / Cognee / LightRAG) become
*pluggable enrichers* — they can read from and write into the
kg-daemon over HTTP without owning the storage.

## 6. The `KnowledgeGraph` TypeScript Interface

Both tiers implement this. It's deliberately small; agents don't see
the backend.

```ts
// <local-projects>/autoclaw/src/kg/KnowledgeGraph.ts (sketch — not yet implemented)

export type AgentId   = string;   // "claude-code" | "kilocode" | ...
export type ProjectId = string;   // repo slug
export type ThoughtId = string;   // ULID
export type EntityId  = string;
export type Kind = "thought" | "finding" | "observation" | "decision" | "question" | "answer";

export interface Thought {
  id: ThoughtId;
  agent: AgentId;
  project: ProjectId;
  taskId?: string;
  ts: number;            // unix ms
  kind: Kind;
  body: string;
  meta?: Record<string, unknown>;
  embedding?: number[];  // optional; daemon may compute if missing
}

export interface Entity {
  id: EntityId;
  project: ProjectId;
  name: string;
  kind: string;          // "file" | "symbol" | "concept" | "task" | ...
  meta?: Record<string, unknown>;
}

export interface Edge {
  src: ThoughtId | EntityId;
  rel: string;           // "mentions" | "supersedes" | "derives_from" | "blocks" | ...
  dst: ThoughtId | EntityId;
  ts: number;
  agent: AgentId;
}

export interface SearchHit<T> { item: T; score: number; }

export interface Filter {
  project?: ProjectId;
  agent?: AgentId | AgentId[];
  kind?: Kind | Kind[];
  taskId?: string;
  since?: number;        // unix ms
  until?: number;
}

export interface KnowledgeGraph {
  // --- ingest ---
  recordThought(t: Omit<Thought, "id" | "ts"> & { ts?: number }): Promise<ThoughtId>;
  recordEntity(e: Omit<Entity, "id"> & { id?: EntityId }): Promise<EntityId>;
  recordRelation(e: Omit<Edge, "ts"> & { ts?: number }): Promise<void>;

  // --- retrieval ---
  searchSimilar(query: string | number[], k: number, f?: Filter): Promise<SearchHit<Thought>[]>;
  searchKeyword(query: string, k: number, f?: Filter): Promise<SearchHit<Thought>[]>;
  searchHybrid(query: string, k: number, f?: Filter): Promise<SearchHit<Thought>[]>;

  // --- graph walk ---
  traverseFrom(
    start: ThoughtId | EntityId,
    opts?: { rels?: string[]; depth?: number; direction?: "out" | "in" | "both" }
  ): Promise<{ nodes: (Thought | Entity)[]; edges: Edge[] }>;

  // --- filtered streams ---
  forAgent(agent: AgentId, f?: Filter): AsyncIterable<Thought>;
  forProject(project: ProjectId, f?: Filter): AsyncIterable<Thought>;
  since(ts: number, f?: Filter): AsyncIterable<Thought>;

  // --- ops ---
  export(f?: Filter): AsyncIterable<{ thought?: Thought; entity?: Entity; edge?: Edge }>;
  stats(f?: Filter): Promise<{ thoughts: number; entities: number; edges: number }>;
  close(): Promise<void>;
}
```

HTTP surface (kg-daemon):

```
POST /v1/thoughts            -> recordThought
POST /v1/entities            -> recordEntity
POST /v1/edges               -> recordRelation
POST /v1/search/similar      -> { query, k, filter }
POST /v1/search/keyword      -> { query, k, filter }
POST /v1/search/hybrid       -> { query, k, filter }
POST /v1/traverse            -> { start, rels, depth, direction }
GET  /v1/stream?since=...    -> NDJSON tail (for forAgent / forProject / since)
GET  /v1/export?...          -> NDJSON dump
GET  /v1/stats               -> JSON
```

Agents in any language hit the same HTTP — Kilo Code can write a
finding with curl; Claude Code uses the TS client; a future Python
agent uses requests. Cross-machine: same daemon binds 0.0.0.0 with
a token from `.autoclaw/orchestrator/comms/auth.json` (already a
pattern in this repo).

## 7. Risks & Open Questions

- **Embedding model choice** — must be local (offline) and stable.
  ZippyMesh likely has a default; pin it and version it in the row.
- **Schema evolution** — Tier 1 ⇒ Tier 2 migration is "read NDJSON
  export, replay into Kuzu." Build the export path **first**, before
  the first byte is written.
- **Concurrency on Tier 1** — only one process should open the SQLite
  file for writes. Hence the daemon. Tested pattern in Node via
  `better-sqlite3` + WAL.
- **Sensitive content** — agent thoughts may include credentials
  echoed from logs. Add a redaction hook in `recordThought` *before*
  persistence; do not rely on after-the-fact scrubbing.
- **Graphiti temptation** — Graphiti's temporal-fact model is
  genuinely the right semantics for "X was true until Y." If we want
  it, run it as an *enricher service* against the kg-daemon, not as
  the system of record.

## 8. Decision

Build the kg-daemon now around **Tier 1 (SQLite + sqlite-vec + edges)**
behind the `KnowledgeGraph` interface. Earmark **Tier 2 (KuzuDB)** as
the drop-in upgrade. Treat Graphiti / Cognee / Mem0 / LightRAG as
optional layers on top — never as the storage.

## Sources

- [Graphiti (getzep/graphiti)](https://github.com/getzep/graphiti)
- [Graphiti: Knowledge Graph Memory for an Agentic World — Neo4j blog](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [Zep — Graphiti Open Source](https://www.getzep.com/product/open-source/)
- [Cognee (topoteretes/cognee)](https://github.com/topoteretes/cognee)
- [Cognee — model your agent's world](https://www.cognee.ai/)
- [Mem0 (mem0ai/mem0)](https://github.com/mem0ai/mem0)
- [Mem0 OSS overview](https://docs.mem0.ai/open-source/overview)
- [Letta (letta-ai/letta)](https://github.com/letta-ai/letta)
- [Mem0 vs Letta (MemGPT) — vectorize.io](https://vectorize.io/articles/mem0-vs-letta)
- [Microsoft GraphRAG — Project page](https://www.microsoft.com/en-us/research/project/graphrag/)
- [GraphRAG costs — Microsoft Community Hub](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/graphrag-costs-explained-what-you-need-to-know/4207978)
- [LazyGraphRAG — Microsoft Research blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- [LightRAG (HKUDS/LightRAG)](https://github.com/hkuds/lightrag)
- [LightRAG paper (arXiv 2410.05779)](https://arxiv.org/html/2410.05779v1)
- [LanceDB (lancedb/lancedb)](https://github.com/lancedb/lancedb)
- [LanceDB docs](https://docs.lancedb.com/)
- [LanceDB Jan 2026 newsletter](https://www.lancedb.com/blog/newsletter-january-2026)
- [Vector DB benchmarks 2026 — CallSphere](https://callsphere.ai/blog/vector-database-benchmarks-2026-pgvector-qdrant-weaviate-milvus-lancedb)
- [Vector DB comparison 2026 — 4xxi](https://4xxi.com/articles/vector-database-comparison/)
- [sqlite-vec (asg017/sqlite-vec)](https://github.com/asg017/sqlite-vec)
- [sqlite-vss (asg017/sqlite-vss)](https://github.com/asg017/sqlite-vss)
- [State of Vector Search in SQLite — Marco Bambini](https://marcobambini.substack.com/p/the-state-of-vector-search-in-sqlite)
- [KuzuDB (kuzudb/kuzu)](https://github.com/kuzudb/kuzu)
- [KuzuDB docs](https://kuzudb.github.io/docs/)
- [kuzu npm](https://www.npmjs.com/package/kuzu)
- [Neo4j licensing](https://neo4j.com/licensing/)
- [TerminusDB (terminusdb/terminusdb)](https://github.com/terminusdb/terminusdb)
- [SurrealDB license FAQ](https://surrealdb.com/license)
- [SurrealDB raises $23M — SiliconANGLE](https://siliconangle.com/2026/02/17/surrealdb-raises-23m-expand-ai-native-multi-model-database/)
- [Apache AGE](https://age.apache.org/)
- [Combining pgvector and Apache AGE — Microsoft Community Hub](https://techcommunity.microsoft.com/blog/adforpostgresql/combining-pgvector-and-apache-age---knowledge-graph--semantic-intelligence-in-a-/4508781)
- [Graph RAG in 2026: What Works in Production — paperclipped.de](https://www.paperclipped.de/en/blog/graph-rag-production/)
