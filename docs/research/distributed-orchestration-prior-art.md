# Distributed, Cross-Machine, Cross-Vendor Multi-Agent Orchestration — Prior Art (2025–2026)

> Research input for designing AutoClaw's "fabric" layer above its existing
> filesystem mailbox + HTTP bridge (`src/comms.ts`, `src/bridge.ts`,
> `src/orchestrate.ts`). Today AutoClaw has: per-agent JSON inbox folders, an
> HTTP bridge with bearer tokens (`/messages`, `/heartbeat`, `/status`,
> `/consensus/vote`), an `AgentRegistry` with `RegisteredAgent`, an append-only
> JSONL comms log, a 2/3-majority consensus engine (unanimous on security),
> and adapters for nine IDE agents.
>
> **Date:** 2026-05-09. All citations 2025–2026.

---

## Executive Summary

The agent-orchestration ecosystem in 2025–2026 has converged on a small set of
interoperable patterns. Google's **A2A** (Linux Foundation, June 2025) and
Anthropic's **MCP** (Agentic AI Foundation, Dec 2025) are now the two universal
wire protocols every framework speaks: A2A is *agent-to-agent* (peers, tasks,
streaming), MCP is *agent-to-tool/resource* (capabilities exposed to a model).
Microsoft Agent Framework 1.0, AG2, LangGraph, CrewAI, and the OpenAI Agents
SDK all ship native A2A. AutoClaw should adopt both: publish each registered
agent as an **A2A Agent Card** at a well-known URL, and expose AutoClaw's own
orchestrator (registry, consensus, knowledge graph) as **MCP servers** that
agents can subscribe to.

For LAN-scale fabric, **NATS JetStream** dominates: single-binary, embeddable,
sub-3 ms p99, built-in service discovery and heartbeats — a near-perfect fit
for "many machines, many windows" without Kafka's operational tax. Replace
filesystem polling with NATS subjects; keep the JSONL log as a durable JetStream
stream. For long-running workflows we recommend **Hatchet** (Postgres-backed,
TypeScript-friendly) over Temporal for AutoClaw's scale.

For shared knowledge, **Graphiti** (temporal knowledge graph, Neo4j or embedded
Kuzu backend) is the clear winner — episodic + semantic + procedural memory
with bi-temporal validity windows, which matches AutoClaw's "what did agent X
believe at sprint Y" requirement. Mem0 is a faster path if we want a hosted
option.

For identity: **SPIFFE/SPIRE** for workload identity within the user's LAN
trust domain, plus **Biscuit-based capability tokens** (the AIP IBCT pattern)
for delegation and subagent dispatch. This replaces today's static bearer
tokens with attenuable, revocable, sub-ms-verifiable credentials.

A phased rollout (v2.2 → v3.0) is proposed at the end: keep filesystem mailboxes
as the durability fallback; add NATS as the live channel in v2.2; add A2A
Agent Cards and MCP servers in v2.3; and integrate Graphiti + SPIFFE + Hatchet
for the v3.0 "Distributed Agent Fabric." Total greenfield surface stays under
~3 KLoC because every recommended piece is a thin shim over an OSS library.

---

## 1. Protocols

### 1.1 Google A2A (Agent-to-Agent)

- **Summary:** Open protocol (Apache 2.0, Linux Foundation since June 2025) for
  peer agents built by different vendors to discover each other, delegate
  tasks, and stream updates. Wire: JSON-RPC 2.0 over HTTPS + SSE for streaming
  + webhook push for async tasks. 150+ orgs adopted including Microsoft, AWS,
  Salesforce, IBM. ([A2A spec](https://a2a-protocol.org/latest/specification/),
  [Google announcement](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/))
- **Agent Card:** Each agent publishes
  `https://host/.well-known/agent-card.json` describing identity, skills,
  endpoint URL, supported modalities, auth requirements, and capability flags
  (e.g. `capabilities.pushNotifications: true`). ([Streaming & Async docs](https://a2a-protocol.org/latest/topics/streaming-and-async/))
- **Task lifecycle:** `submitted → working → input-required → completed/failed`,
  identified by stable `taskId`, with artifacts produced incrementally.
- **What AutoClaw borrows:** Replace our ad-hoc `RegisteredAgent` with an
  Agent Card. Map message types (`review_request`, `task_claim`, `consensus_vote`)
  to A2A `skills`. Expose `/.well-known/agent-card.json` from the bridge.
  Switch streaming heartbeat/state from poll to SSE.
- **Integration cost:** **Medium.** ~600 LoC: card publisher, JSON-RPC
  router on the bridge, SSE endpoint. Reference SDKs in Python/TS/.NET.
- **Source:** [a2a-protocol.org/latest/](https://a2a-protocol.org/latest/),
  [IBM explainer](https://www.ibm.com/think/topics/agent2agent-protocol),
  [Stellagent timeline](https://stellagent.ai/insights/a2a-protocol-google-agent-to-agent).

### 1.2 Anthropic MCP (Model Context Protocol)

- **Summary:** Open standard (Nov 2024, donated to Agentic AI Foundation /
  Linux Foundation Dec 2025). Clients (LLM apps) connect to **servers** that
  expose three primitives: **tools** (callable functions), **resources**
  (read-only context), **prompts** (templates). Wire: JSON-RPC 2.0, LSP-style
  message flow. 5,800+ servers and 300+ clients by April 2025.
  ([MCP spec](https://modelcontextprotocol.io/specification/2025-11-25),
  [Anthropic intro](https://www.anthropic.com/news/model-context-protocol))
- **Agent-to-agent layer:** While MCP was originally tool-to-LLM, it is now
  routinely used between agents — one agent acts as a server exposing its
  capabilities; another acts as a client. Anthropic's "code execution with
  MCP" engineering post explicitly recommends this pattern for efficiency.
  ([Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp))
- **What AutoClaw borrows:** Expose four MCP servers from the orchestrator:
  - `autoclaw-registry` (resource: agents, tools: register/heartbeat)
  - `autoclaw-knowledge` (resource: shared graph, tools: query/upsert)
  - `autoclaw-consensus` (tools: vote, get_result)
  - `autoclaw-tasks` (tools: claim, complete, subcontract)
  Every agent that already speaks MCP (Claude Code, Cursor, Windsurf, Codex
  CLI, ChatGPT desktop) connects with zero adapter code.
- **Integration cost:** **Low.** ~400 LoC using `@modelcontextprotocol/sdk`.
- **Source:** [modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-11-25),
  [MCP Wikipedia](https://en.wikipedia.org/wiki/Model_Context_Protocol).

### 1.3 LangGraph / LangServe

- **Summary:** Graph-based agent runtime (TypedDict state schemas, reducer
  functions, named nodes/edges) with pluggable **checkpointers**
  (`PostgresSaver`, `RedisSaver`, `CouchbaseSaver`, `MemorySaver`) for
  durability and pause/resume. State organized into "threads" with unique IDs.
  ([LangGraph repo](https://github.com/langchain-ai/langgraph),
  [LangChain page](https://www.langchain.com/langgraph),
  [Redis blog](https://redis.io/blog/langgraph-redis-build-smarter-ai-agents-with-memory-persistence/))
- **What AutoClaw borrows:** The **checkpointer** abstraction. Today
  `orchestrate.ts` keeps sprint state in flat YAML; a Postgres or SQLite
  checkpointer would give us pause/resume and "replay sprint from step N"
  for free. Steal the **reducer pattern** for multi-agent state merges
  (e.g. consensus tallies, knowledge-graph upserts).
- **Integration cost:** **Low** if we only adopt the pattern; **Medium** if we
  embed `@langchain/langgraph` directly. Recommend the former.
- **Source:** [Sparkco checkpointing 2025 guide](https://sparkco.ai/blog/mastering-langgraph-checkpointing-best-practices-for-2025),
  [Latenode multi-agent guide](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-multi-agent-orchestration-complete-framework-guide-architecture-analysis-2025).

### 1.4 Microsoft AutoGen / Agent Framework

- **Summary:** AutoGen v0.4 introduced `GrpcWorkerAgentRuntime` — a distributed
  runtime where each worker hosts one agent and they pub/sub on a default
  topic. AutoGen is now in maintenance mode; **Microsoft Agent Framework
  (MAF) 1.0** (April 2026) is the successor: Python + .NET, native A2A,
  Azure Functions / Durable Task hosting, cross-language interop.
  ([AutoGen distributed runtime](https://microsoft.github.io/autogen/dev//user-guide/core-user-guide/framework/distributed-agent-runtime.html),
  [MAF 1.0 announcement](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/),
  [A2A integration docs](https://learn.microsoft.com/en-us/agent-framework/integrations/a2a))
- **What AutoClaw borrows:** The **gRPC worker runtime** model — every IDE
  window can be a worker process subscribing to topics. The **group chat**
  pattern (manager + worker + reviewer roles) maps directly to our consensus
  engine.
- **Integration cost:** **High** to embed; **Low** to mimic via NATS subjects.
- **Source:** [VentureBeat AutoGen 0.4 article](https://venturebeat.com/ai/microsofts-autogen-update-boosts-ai-agents-with-cross-language-interoperability-and-observability),
  [GitHub microsoft/agent-framework](https://github.com/microsoft/agent-framework).

### 1.5 CrewAI

- **Summary:** Lightweight Python framework, no LangChain dependency. Four
  primitives: **Agents, Tasks, Tools, Crew**. Three process modes:
  **sequential**, **hierarchical** (manager delegates), **custom**.
  ([CrewAI docs](https://docs.crewai.com/en/concepts/agents),
  [GitHub](https://github.com/crewaiinc/crewai))
- **What AutoClaw borrows:** The **role taxonomy** (Manager / Worker /
  Researcher) maps to AutoClaw scopes. The hierarchical process model is
  exactly our orchestrator-dispatches-to-agents pattern.
- **Integration cost:** **Low** (pattern only).
- **Source:** [Latenode CrewAI 2025 review](https://latenode.com/blog/ai-frameworks-technical-infrastructure/crewai-framework/crewai-framework-2025-complete-review-of-the-open-source-multi-agent-ai-platform).

### 1.6 OpenAI Swarm → Agents SDK

- **Summary:** Swarm (Oct 2024, experimental) was replaced by the **OpenAI
  Agents SDK** (March 2025, production). Four primitives: Agents, Handoffs,
  Tools, Guardrails. **Handoffs** are just tools named `transfer_to_<agent>`
  that pass context across an explicit boundary.
  ([Agents SDK](https://openai.github.io/openai-agents-python/),
  [Handoffs docs](https://openai.github.io/openai-agents-python/handoffs/),
  [Cookbook orchestrating agents](https://cookbook.openai.com/examples/orchestrating_agents))
- **What AutoClaw borrows:** Model **subcontract / subagent dispatch** as a
  handoff: `transfer_to_kilocode(scope, deadline)` returns a typed result.
  Carry conversation context across the transition explicitly.
- **Integration cost:** **Low** (pattern only).
- **Source:** [Mem0 review](https://mem0.ai/blog/openai-agents-sdk-review).

### 1.7 AG2 (formerly AutoGen)

- **Summary:** Community fork of pre-Microsoft AutoGen v0.2 by original
  creators (Chi Wang, Qingyun Wu). AG2 ships **native A2A and MCP support**
  with enterprise security baked in.
  ([ag2.ai](https://www.ag2.ai/), [GitHub](https://github.com/ag2ai/ag2),
  [Native A2A announcement](https://discuss.google.dev/t/introducing-native-a2a-protocol-support-in-ag2-building-interoperable-multi-agent-systems-at-scale/286168))
- **What AutoClaw borrows:** AG2's group-chat-with-protocol pattern is the
  cleanest reference implementation of "AutoGen meets A2A." Read their A2A
  bridge code as our template.
- **Integration cost:** **Low** (reference reading).
- **Source:** [DEV.to AutoGen split explainer](https://dev.to/maximsaplin/microsoft-autogen-has-split-in-2-wait-3-no-4-parts-2p58).

---

## 2. Transport / Message Bus Options for LAN Fabric

| System | Throughput (1KB) | p99 latency | Ops complexity | Best for |
|---|---|---|---|---|
| Kafka | 1.2M msg/s | 12.5 ms | High (3+ brokers, ZK/KRaft) | Multi-week retention, event sourcing |
| **NATS JetStream** | **820K msg/s** | **3.2 ms** | **Single binary, embeddable** | **LAN microservices, agent fabric** |
| Redis Streams | 480K msg/s | 0.8 ms | Already-have-Redis shops | Sub-ms latency, ephemeral |
| RabbitMQ | ~50K msg/s | ~5 ms | Medium | Complex routing, classic queue |
| ZeroMQ | very high | <1 ms | Library, no broker | P2P, no durability needed |

Source: [Java Code Geeks NATS vs Kafka vs Redis 2026](https://www.javacodegeeks.com/2026/03/nats-vs-kafka-vs-redis-streams-for-java-microservices-when-simpler-actually-wins.html),
[DEV.to event streaming 2026](https://dev.to/young_gao/real-time-event-streaming-kafka-vs-redis-streams-vs-nats-in-2026-34o1),
[Synadia comparison](https://www.synadia.com/blog/nats-and-kafka-compared).

### 2.1 NATS JetStream — recommended

- **Summary:** Single-binary message system written in Go; embeddable in a
  Node addon or run as a sidecar. Built-in service discovery (NATS micro),
  health monitoring, durable streams, replay, at-least-once delivery, KV and
  object stores. ~10 MB binary.
  ([NATS JetStream docs](https://docs.nats.io/nats-concepts/jetstream),
  [Synadia "Heterogeneous agents, one fabric"](https://www.synadia.com/blog/heterogeneous-agents-one-fabric))
- **Why for AutoClaw:** Fits "many machines, many windows" exactly. mDNS-style
  cluster auto-discovery on LAN. NATS micro provides automatic service
  registration, heartbeats (1/s default), and load balancing — replacing our
  `last_heartbeat` polling. Subjects (`autoclaw.agent.<id>.inbox`,
  `autoclaw.shared`, `autoclaw.consensus.<task>`) directly model our current
  filesystem layout.
- **Integration cost:** **Medium.** Embed `nats.ws` in the extension and
  spawn a `nats-server` from the bridge. Keep filesystem mailbox as durability
  fallback (subscribe a logger that mirrors every message to JSONL).
- **Source:** [NATS by Example](https://natsbyexample.com/),
  [oneuptime micro-services guide](https://oneuptime.com/blog/post/2026-02-02-nats-microservices/view).

### 2.2 Redis Streams — alternative

- **Summary:** Sub-ms latency. Best if a Redis instance is already running
  for cache / vector store. Durability requires `appendonly yes`.
- **Cost:** **Low** if Redis is present.
- **Source:** [Salfarisi comparison](https://salfarisi25.wordpress.com/2024/06/07/redis-streams-vs-apache-kafka-vs-nats/).

### 2.3 ZeroMQ — alternative

- **Summary:** Library, no broker. Brilliant for P2P direct sockets between
  two known agents (e.g. orchestrator ↔ specific worker). Lacks discovery and
  persistence — would need to layer those.
- **Cost:** **Medium.**

### 2.4 Kafka / RabbitMQ — not recommended

Both are over-spec for a developer-laptop LAN fabric. Kafka's 3-broker minimum
HA cluster plus partition planning is wasted at our message volumes.

---

## 3. Bidirectional Channel Choice

| Channel | Direction | Latency | Auto-reconnect | Browser/IDE friendly | Use case |
|---|---|---|---|---|---|
| HTTP long-poll | client→server, then drain | high | manual | yes | Legacy fallback only |
| **SSE** | server→client | low | **built-in (event IDs)** | yes (EventSource) | **Status / streaming events** |
| **WebSockets** | full duplex | low | manual | yes | **Agent ↔ orchestrator chatter** |
| gRPC streaming | full duplex (HTTP/2) | lowest | manual | needs proxy | Backend ↔ backend |

Source: [Charles Sieg deep dive](https://www.charlessieg.com/articles/real-time-messaging-protocols-grpc-websocket-sse-deep-dive.html),
[GetStream protocol comparison](https://getstream.io/blog/communication-protocols/),
[gRPC India panel recap](https://tldrecap.tech/posts/2025/grpconf-india/ai-protocols-hybrid-approach/).

### Recommendation

**Hybrid, matching A2A's own choice:**

1. **SSE** for orchestrator → agent state streams (heartbeat aggregation,
   task status, consensus tallies). Built-in `Last-Event-ID` resumability is
   a free win over our current poll loop.
2. **WebSockets** for full-duplex agent ↔ orchestrator command channel
   (replaces today's bridge POST + filesystem read pair). The user's IDE
   adapters all support WS.
3. **NATS JetStream** under the hood for the actual fabric — the WS/SSE
   endpoints on the bridge are just thin adapters over NATS subjects so
   browser/IDE clients without a NATS lib can still participate.
4. **gRPC streaming** as an optional power channel for hardware-pinned
   workers (Python/Rust bots) where Protocol Buffers' compactness matters.

Reject HTTP long-poll — it's only worth keeping the existing `/messages`
POST endpoint as a write fallback for environments without WS.

---

## 4. Distributed Knowledge Bases

### 4.1 Memory frameworks compared

| Framework | Memory model | Backend(s) | Strength |
|---|---|---|---|
| **Mem0** | 3-scope (user/session/agent), hybrid vector+graph+KV | OSS + cloud | Hosted convenience; Kuzu embedded option Sep 2025 |
| **Letta (MemGPT)** | Editable memory blocks, stateful runtime | Postgres | Most explicit, debuggable |
| **Zep / Graphiti** | **Temporal knowledge graph, bi-temporal validity** | **Neo4j / Kuzu / FalkorDB / Neptune** | **Best for "what did X believe at time Y"** |
| **Cognee** | RAG-as-pipeline (ingest → structure → recall) | Vector + graph hybrid | Pipeline ergonomics |
| **MemGPT** (now Letta) | Hierarchical context (core / archival) | varies | Original paper |

Source: [Letta forum comparison](https://forum.letta.com/t/agent-memory-letta-vs-mem0-vs-zep-vs-cognee/88),
[Atlan 2026 ranking](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/),
[Graphlit survey](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks),
[Fountaincity 2026 guide](https://fountaincity.tech/resources/blog/agent-memory-knowledge-systems-compared/).

### 4.2 Graphiti — recommended for AutoClaw

- **Summary:** Open-source temporal knowledge-graph engine (the core of Zep's
  product). Bi-temporal: every fact has a *valid_from / valid_to* window so
  superseded beliefs are retained. Hybrid retrieval combines semantic
  embeddings, BM25 keyword, and graph traversal at p95 ~300 ms. Backends:
  Neo4j 5.26+, Kuzu (embedded, no server), FalkorDB, Amazon Neptune.
  ([Graphiti GitHub](https://github.com/getzep/graphiti),
  [Neo4j blog post](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/),
  [Zep arXiv paper](https://arxiv.org/html/2501.13956v1))
- **Why for AutoClaw:** Multi-agent collective memory needs "agent A claimed
  X at sprint 3, agent B refuted at sprint 5" — exactly Graphiti's bi-temporal
  model. Three memory scopes (episodic / semantic / procedural) match
  AutoClaw's `finding_report`, `task_complete`, and learned routing rules.
- **Integration cost:** **Medium.** Run Kuzu embedded (no server tax) or a
  dockerized Neo4j on the orchestrator host. Wrap as an MCP `autoclaw-knowledge`
  server so all agents read/write through the same protocol.
- **Source:** [Graphiti agent memory store review](https://codex.danielvaughan.com/2026/03/30/graphiti-agent-memory-store/),
  [Presidio Graphiti story](https://www.presidio.com/technical-blog/graphiti-giving-ai-a-real-memory-a-story-of-temporal-knowledge-graphs/).

### 4.3 GraphRAG pattern

- **Summary:** Microsoft's GraphRAG splits retrieval into two layers: vectors
  for semantic candidate selection, graph for relational expansion via
  community detection. Now standard practice — "vectors for entry-point,
  graph for relational depth."
  ([Qdrant + Neo4j tutorial](https://qdrant.tech/documentation/examples/graphrag-qdrant-neo4j/),
  [Databricks deployment guide](https://www.databricks.com/blog/building-improving-and-deploying-knowledge-graph-rag-systems-databricks),
  [AgentMarketCap 2026 comparison](https://agentmarketcap.ai/blog/2026/04/07/graph-rag-vs-vector-rag-agent-memory-neo4j-pgvector))
- **Cost:** **Low** (pattern); Graphiti already implements it.

### 4.4 Recommended stack

```
Embedded Kuzu (graph)  +  LanceDB or Qdrant (vector)  +  Graphiti API
                              ↓
                    autoclaw-knowledge MCP server
                              ↓
                    All agents (Claude Code, Kilo, etc.)
```

Kuzu chosen because [it shipped as a Mem0 backend in Sep 2025](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
specifically because it eliminates the server-process operational tax — perfect
for a user laptop deployment. LanceDB for vectors because it's also embedded
(Lance file format), avoiding a Qdrant container.

---

## 5. Identity, Trust, Revocation

### 5.1 SPIFFE / SPIRE — recommended for workload identity

- **Summary:** SPIFFE issues each workload a **SVID** (Verifiable Identity
  Document) — either an X.509 cert or a JWT — tied to a SPIFFE ID like
  `spiffe://autoclaw.local/agent/claude-code-window-3`. SPIRE is the reference
  implementation: agent on each machine, attestation (process selectors,
  host UUID), short-lived SVIDs auto-rotated on every mTLS handshake.
  ([SPIFFE](https://spiffe.io/),
  [HashiCorp on SPIFFE for agentic AI](https://www.hashicorp.com/en/blog/spiffe-securing-the-identity-of-agentic-ai-and-non-human-actors),
  [Spletzer demystified post](https://www.spletzer.com/2025/03/zero-to-trusted-spiffe-and-spire-demystified/))
- **Why AutoClaw:** Replaces today's static `acl_<hex>` bearer tokens with
  rotating, attestable identity. Cross-machine LAN federation works out of
  the box via shared trust bundle. CPU cost <100 millicore per node.
- **Integration cost:** **Medium-High.** Run a SPIRE server on the orchestrator
  host, agents on each machine. ~800 LoC for SPIFFE-aware bridge auth.
  Optional: keep static bearer tokens as the "easy mode" for hobbyists.
- **Source:** [Riptides SPIFFE+OAuth+MCP](https://riptides.io/blog/bringing-spiffe-to-oauth-for-mcp-secure-identity-for-agentic-workloads/),
  [Curity SPIFFE JWT-SVID guide](https://curity.io/resources/learn/oauth-client-credentials-spiffe-jwt-svids/).

### 5.2 Capability tokens — Biscuit + AIP IBCT

- **Summary:** The arXiv **Agent Identity Protocol** (AIP) introduces
  Invocation-Bound Capability Tokens (IBCTs): compact mode is a signed JWT
  for single-hop calls; chained mode is a **Biscuit** token with Datalog
  policies for multi-hop subagent delegation, with completion blocks for
  provenance. Verification: **0.049 ms in Rust, 0.189 ms in Python**, 100%
  attack rejection across 600 adversarial tests.
  ([AIP arXiv paper](https://arxiv.org/html/2603.24775))
- **Why AutoClaw:** Subagent / subcontract is exactly multi-hop delegation.
  When `claude-code` dispatches a scoped task to `kilocode`, it should pass
  a Biscuit attenuated by scope (`right(/src/auth/**, write)`,
  `expires(2026-05-09T12:00Z)`). Kilocode can further attenuate before
  subcontracting to a Python bot, but cannot escalate.
- **Integration cost:** **Medium.** Use the `biscuit-auth` Rust lib via a
  WASM build, or its Node port. ~400 LoC.
- **Source:** [Biscuit-auth project](https://www.biscuitsec.org/).

### 5.3 DIDs / Verifiable Credentials — not recommended

W3C DIDs introduce blockchain dependencies and circular trust bootstrapping
that don't fit a LAN-scale developer tool. AIP and SPIFFE supersede them for
non-human workload identity per the AIP paper's analysis.

### 5.4 mTLS

Use SPIFFE SVIDs as the cert source. Every agent ↔ orchestrator and
agent ↔ agent connection over the LAN is mTLS-authenticated. No raw HTTP
on port 31415.

---

## 6. Worker-Pool / Durable-Execution Engines

| Engine | Backend | TS support | Best for |
|---|---|---|---|
| **Temporal** | Custom DB | First-class TS SDK | Enterprise scale; weeks-long workflows |
| **Hatchet** | **Postgres** | **First-class TS SDK** | **Self-hosted, Postgres-only ops** |
| Restate | Custom | TS | Lighter-footprint Temporal |
| Inngest | Cloud + OSS | Native TS step.run() | Serverless / event-driven |
| DBOS | Postgres | TS | Postgres-first durable functions |

Source: [Zylos durable execution patterns](https://zylos.ai/research/2026-02-17-durable-execution-ai-agents),
[Render durable workflow comparison](https://render.com/articles/durable-workflow-platforms-ai-agents-llm-workloads),
[Hatchet GitHub](https://github.com/hatchet-dev/hatchet),
[Temporal AI page](https://temporal.io/solutions/ai),
[Tiare Balbi DBOS vs Temporal](https://www.tiarebalbi.com/en/blog/dbos-vs-temporal-postgres-durable-execution),
[Inngest vs Temporal](https://www.inngest.com/compare-to-temporal).

### 6.1 Hatchet — recommended

- **Summary:** Postgres-backed durable orchestration. Workers connect via
  gRPC to a Hatchet engine; tasks are durably logged on every step. Worker
  slot control, rate limiting, complex routing (matches AutoClaw's
  capability-based routing need).
- **Why for AutoClaw:** Postgres is the only operational dependency. TS SDK
  matches our codebase. Worker-slot control directly maps "agent X has 3
  available LLM context slots" — exactly the heartbeat-richness gap. Hatchet
  resumes workflows on crash, which gives us "sprint replay" for free.
- **Integration cost:** **Medium.** Optional dependency — sprints stay flat
  YAML for hobbyist mode; Hatchet kicks in if Postgres is configured.
- **Source:** [Hatchet GitHub](https://github.com/hatchet-dev/hatchet).

### 6.2 Temporal — alternative

- **Summary:** Defined the durable-execution category. "Very long-running
  workflow" pattern supports weeks-to-years state. Heaviest ops footprint
  (Cassandra/Postgres + Temporal server cluster).
- **Cost:** **High** ops; **Low** code.
- **Verdict:** Over-spec for a developer-laptop fabric, but the right answer
  if AutoClaw later targets enterprise CI clusters.

### 6.3 Pattern to copy regardless

The **journal/replay** mechanism (Restate, Hatchet, Temporal): record every
externalized step (LLM call, file write, message sent) into a durable journal;
on crash, replay returns cached results without re-execution. This is how
AutoClaw should evolve `comms-log.jsonl` — from append-only audit log into
a true workflow journal keyed by `(sprint_id, step_n)`.

---

## 7. Heartbeats & Capability Advertisement

### 7.1 Pattern sources

- **Kubernetes node-status:** kubelet posts `Lease` objects every ~10 s with
  `conditions[].type=Ready`, `allocatable.cpu`, `allocatable.memory`. Stale
  leases mark a node `NotReady`. AutoClaw's heartbeat should mirror this:
  post `{capabilities, context_window_remaining, queue_depth, current_task,
  last_error}` every 10 s; missing 3 = `stalled`.
- **BOINC / SETI@home compute pool:** workers advertise CPU class, GPU,
  available RAM; the scheduler dispatches work units sized to capability.
  Direct analog: AutoClaw routes "needs 200K context" to agents with budget.
- **Distributed crawlers (Heritrix, StormCrawler):** capability + politeness
  budget + queue depth — same shape as our routing problem.
- **NATS micro:** automatic service registration, discovery, and heartbeats
  built in (1/s default, customizable per
  [issue #4094](https://github.com/nats-io/nats-server/issues/4094)). Use
  this directly instead of inventing our own.
  ([NATS micro guide](https://oneuptime.com/blog/post/2026-02-02-nats-microservices/view))

### 7.2 Concrete heartbeat schema (recommendation)

```json
{
  "agent_id": "claude-code-laptop1-window3",
  "spiffe_id": "spiffe://autoclaw.local/agent/...",
  "timestamp": "2026-05-09T18:00:00Z",
  "status": "active",
  "capabilities": {
    "llm": "claude-opus-4-7",
    "context_window": 1000000,
    "context_remaining": 720000,
    "tools": ["Read", "Edit", "Bash", "WebSearch", "MCP:autoclaw-knowledge"],
    "scopes": ["src/comms.ts", "src/bridge.ts"],
    "max_concurrent_tasks": 2
  },
  "load": {
    "current_task": "task_42",
    "queue_depth": 1,
    "tokens_used_session": 184_000,
    "tokens_budget_remaining": 16_000
  },
  "last_error": null,
  "host": {"machine": "laptop1", "os": "win32", "ide": "claude-code"}
}
```

Map `capabilities` 1:1 to A2A Agent Card `skills` so a single source of truth
serves both protocols.

---

## 8. AutoClaw Distributed Agent Fabric — Recommended Stack

### 8.1 Recommended stack (one-line each)

| Layer | Choice | Why |
|---|---|---|
| **Wire protocol (peer)** | **A2A** (JSON-RPC 2.0 + SSE + push) | Vendor-neutral, 150+ orgs, native in MAF/AG2/CrewAI/MCP-side |
| **Wire protocol (tools/resources)** | **MCP** | Already spoken by every IDE agent we target |
| **Transport (LAN)** | **NATS JetStream** | Single binary, embeddable, sub-3 ms p99, built-in heartbeats/discovery |
| **Bidirectional channel (clients)** | **WebSocket** + **SSE** hybrid | Browser/IDE-friendly; SSE has free resumability |
| **Worker-pool / durable execution** | **Hatchet** (optional) | Postgres-only ops, TS SDK, capability-based routing |
| **Knowledge graph** | **Graphiti on Kuzu (embedded)** + **LanceDB** for vectors | Bi-temporal, hybrid retrieval, no server tax |
| **Identity** | **SPIFFE/SPIRE** + **Biscuit** capability tokens | Rotating SVIDs for connection auth; attenuable Biscuits for delegation |
| **Registry / discovery** | NATS micro + A2A Agent Cards at `/.well-known/agent-card.json` | Reuse, don't reinvent |
| **Audit** | Existing JSONL **promoted to Hatchet journal** | One write path, two consumers (audit + replay) |

### 8.2 Architectural view

```
┌─────────────────────────────────────────────────────────────────────┐
│ AutoClaw Orchestrator (per LAN, on user's primary machine)          │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────┐ │
│ │ NATS server  │ │ SPIRE server │ │ Hatchet      │ │ Graphiti +  │ │
│ │ + JetStream  │ │ (trust dom.) │ │ engine (opt) │ │ Kuzu+Lance  │ │
│ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬──────┘ │
│        │                │                │                │        │
│ ┌──────┴────────────────┴────────────────┴────────────────┴──────┐ │
│ │ Bridge (HTTP/WS/SSE + JSON-RPC over A2A + 4 MCP servers)      │ │
│ │  /.well-known/agent-card.json   /a2a   /mcp/*   /messages     │ │
│ └────────────────────────────────┬───────────────────────────────┘ │
└──────────────────────────────────┼─────────────────────────────────┘
                                   │ mTLS (SPIFFE SVID)
   ┌───────────────────────────────┼───────────────────────────────┐
   │                               │                               │
┌──┴───────────┐         ┌─────────┴────────┐           ┌──────────┴────┐
│ Laptop 1     │         │ Laptop 2         │           │ HW worker     │
│ Claude Code  │         │ Cursor           │           │ Python bot    │
│ (3 windows)  │         │ Windsurf         │           │ pinned GPU    │
│ Codex CLI    │         │ Kilo Code        │           │               │
└──────────────┘         └──────────────────┘           └───────────────┘
```

### 8.3 Phased rollout

#### v2.2 — "Live channel" (target ~3 weeks)

Goal: Replace filesystem polling with real-time channels without breaking
existing adapters.

- Add embedded NATS server alongside the bridge. Configurable port (default
  4222). All `sendMessage()` writes both to filesystem (durability) **and**
  publishes to `autoclaw.agent.<id>.inbox`.
- Add WS endpoint `/ws` to bridge that proxies NATS subjects to/from the
  client. SSE endpoint `/events` for read-only state streams.
- Enrich heartbeat schema (Section 7.2). Update `RegisteredAgent` to include
  `capabilities` and `load`.
- Update `cross-agent-protocol.md` rule files: agents that support WS open
  one; the rest keep filesystem polling — both routes deliver the same
  message because of dual-write.
- Touched files: `src/bridge.ts` (WS/SSE), `src/comms.ts` (heartbeat schema +
  NATS dual-write), new `src/fabric/nats.ts`.

#### v2.3 — "Standard protocols" (target ~4 weeks after v2.2)

Goal: Speak A2A and MCP natively so any vendor's agent can join with zero
custom adapter code.

- Bridge publishes `/.well-known/agent-card.json` per registered agent and
  one for the orchestrator itself.
- Implement A2A JSON-RPC 2.0 endpoint at `/a2a` with task lifecycle
  (`tasks/send`, `tasks/sendSubscribe`, `tasks/get`, `tasks/cancel`).
- Wrap registry, knowledge, consensus, and tasks as four MCP servers
  (`autoclaw-registry`, `autoclaw-knowledge`, `autoclaw-consensus`,
  `autoclaw-tasks`) using `@modelcontextprotocol/sdk`. Existing agents
  (Claude Code, Cursor, Windsurf, etc.) consume these as MCP clients via
  one config-file edit.
- Add **handoff** primitive (OpenAI Agents SDK pattern): `transfer_to(agent,
  scope, deadline)` returns a typed result. Implemented as an A2A task with
  attenuated Biscuit token attached.
- Touched files: new `src/fabric/a2a.ts`, `src/fabric/mcp-servers.ts`;
  `src/orchestrate.ts` (handoff primitive).

#### v3.0 — "Distributed Agent Fabric" (target ~8 weeks after v2.3)

Goal: True multi-machine, durable, identity-rooted fabric.

- **SPIFFE/SPIRE:** Bundle a small SPIRE server with the orchestrator. Issue
  SVIDs on agent registration. mTLS becomes default; static bearer tokens
  remain as `--insecure` opt-in.
- **Biscuit capability tokens:** Replace today's `RemoteAgentToken.scopes`
  array with a Biscuit per token. Subagent dispatch attenuates the parent's
  Biscuit before passing.
- **Graphiti on Kuzu:** Wire `autoclaw-knowledge` MCP server backend to a
  Graphiti instance. Migrate existing `finding_report` messages into
  episodes. Add `query`, `upsert_fact`, `time_travel(at: Date)` tools.
- **Hatchet (optional):** If `HATCHET_POSTGRES_URL` is set, sprints execute
  as Hatchet workflows. Each task = a step; resumable across orchestrator
  restarts. Comms log becomes the workflow journal.
- **Capability-based routing:** `orchestrate.ts`'s task assignment switches
  from sprint-author-decides to dynamic routing using the heartbeat
  capability vector + queue depth + Biscuit-attestable scope. Pattern from
  Kubernetes scheduler + BOINC pool.
- **Federation:** Trust-bundle exchange with peer AutoClaw orchestrators on
  other LANs (e.g. user has a workstation and a build server). Foundation
  for future multi-tenant deploys.
- Touched files: new `src/fabric/spire.ts`, `src/fabric/biscuit.ts`,
  `src/fabric/graphiti.ts`, `src/fabric/hatchet.ts`, `src/fabric/router.ts`;
  significant edits in `src/orchestrate.ts`.

### 8.4 Backward compatibility commitments

- The filesystem mailbox protocol (`.autoclaw/orchestrator/comms/inboxes/...`)
  remains the **durability fallback** at every phase. Any new transport is
  additive.
- The HTTP bridge endpoints `/messages`, `/heartbeat`, `/status`,
  `/consensus/vote` remain functional; new endpoints are added beside them.
- Existing `cross-agent-protocol.md` rule files keep working unchanged
  through v3.0; richer rules are documented separately.

### 8.5 What we explicitly are not building

- A custom message broker (use NATS).
- A custom identity system (use SPIFFE).
- A custom knowledge graph (use Graphiti).
- A custom durable workflow engine (use Hatchet, optional).
- W3C DIDs / blockchain identity (over-spec).
- Kafka or RabbitMQ infrastructure (over-spec for LAN).

---

## Sources (consolidated)

- [Agent2Agent (A2A) Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [Announcing the Agent2Agent Protocol — Google Developers Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [What Is Agent2Agent (A2A) Protocol? — IBM](https://www.ibm.com/think/topics/agent2agent-protocol)
- [A2A Streaming & Asynchronous Operations](https://a2a-protocol.org/latest/topics/streaming-and-async/)
- [A2A Protocol — 150+ orgs adoption — Stellagent](https://stellagent.ai/insights/a2a-protocol-google-agent-to-agent)
- [Model Context Protocol Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25)
- [Anthropic — Introducing the MCP](https://www.anthropic.com/news/model-context-protocol)
- [Code execution with MCP — Anthropic engineering](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [MCP Wikipedia](https://en.wikipedia.org/wiki/Model_Context_Protocol)
- [LangGraph repo](https://github.com/langchain-ai/langgraph)
- [Mastering LangGraph Checkpointing 2025 — Sparkco](https://sparkco.ai/blog/mastering-langgraph-checkpointing-best-practices-for-2025)
- [LangGraph multi-agent orchestration 2025 — Latenode](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-multi-agent-orchestration-complete-framework-guide-architecture-analysis-2025)
- [LangGraph + Redis persistence](https://redis.io/blog/langgraph-redis-build-smarter-ai-agents-with-memory-persistence/)
- [AutoGen distributed runtime docs](https://microsoft.github.io/autogen/dev//user-guide/core-user-guide/framework/distributed-agent-runtime.html)
- [Microsoft Agent Framework 1.0 — DevBlog](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/)
- [Microsoft AF A2A integration docs](https://learn.microsoft.com/en-us/agent-framework/integrations/a2a)
- [VentureBeat — AutoGen 0.4 cross-language](https://venturebeat.com/ai/microsofts-autogen-update-boosts-ai-agents-with-cross-language-interoperability-and-observability)
- [microsoft/agent-framework GitHub](https://github.com/microsoft/agent-framework)
- [CrewAI docs — Agents](https://docs.crewai.com/en/concepts/agents)
- [crewAIInc/crewAI GitHub](https://github.com/crewaiinc/crewai)
- [CrewAI 2025 review — Latenode](https://latenode.com/blog/ai-frameworks-technical-infrastructure/crewai-framework/crewai-framework-2025-complete-review-of-the-open-source-multi-agent-ai-platform)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [OpenAI Agents SDK — Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- [OpenAI Cookbook — Orchestrating agents](https://cookbook.openai.com/examples/orchestrating_agents)
- [OpenAI Agents SDK review — Mem0](https://mem0.ai/blog/openai-agents-sdk-review)
- [AG2 — Build Systems Not Prompts](https://www.ag2.ai/)
- [ag2ai/ag2 GitHub](https://github.com/ag2ai/ag2)
- [Native A2A in AG2 — Google Discuss](https://discuss.google.dev/t/introducing-native-a2a-protocol-support-in-ag2-building-interoperable-multi-agent-systems-at-scale/286168)
- [AutoGen split explained — DEV.to](https://dev.to/maximsaplin/microsoft-autogen-has-split-in-2-wait-3-no-4-parts-2p58)
- [NATS vs Kafka vs Redis — Java Code Geeks 2026](https://www.javacodegeeks.com/2026/03/nats-vs-kafka-vs-redis-streams-for-java-microservices-when-simpler-actually-wins.html)
- [Real-Time Event Streaming 2026 — DEV.to](https://dev.to/young_gao/real-time-event-streaming-kafka-vs-redis-streams-vs-nats-in-2026-34o1)
- [NATS and Kafka Compared — Synadia](https://www.synadia.com/blog/nats-and-kafka-compared)
- [Heterogeneous agents, one fabric — Synadia](https://www.synadia.com/blog/heterogeneous-agents-one-fabric)
- [NATS JetStream docs](https://docs.nats.io/nats-concepts/jetstream)
- [NATS by Example](https://natsbyexample.com/)
- [NATS micro-services guide — oneuptime](https://oneuptime.com/blog/post/2026-02-02-nats-microservices/view)
- [Redis vs Kafka vs NATS — Salfarisi](https://salfarisi25.wordpress.com/2024/06/07/redis-streams-vs-apache-kafka-vs-nats/)
- [WebSocket vs HTTP/SSE/MQTT comparison](https://websocket.org/comparisons/)
- [Real-time messaging deep dive — Charles Sieg](https://www.charlessieg.com/articles/real-time-messaging-protocols-grpc-websocket-sse-deep-dive.html)
- [GetStream — Which protocol is best?](https://getstream.io/blog/communication-protocols/)
- [gRPC India panel — AI streaming](https://tldrecap.tech/posts/2025/grpconf-india/ai-protocols-hybrid-approach/)
- [Letta vs Mem0 vs Zep vs Cognee — Letta forum](https://forum.letta.com/t/agent-memory-letta-vs-mem0-vs-zep-vs-cognee/88)
- [Best AI agent memory frameworks 2026 — Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- [Survey of AI agent memory — Graphlit](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks)
- [Agent Memory & Knowledge Systems — Fountaincity](https://fountaincity.tech/resources/blog/agent-memory-knowledge-systems-compared/)
- [Top 10 AI Memory Products 2026 — Medium](https://medium.com/@bumurzaqov2/top-10-ai-memory-products-2026-09d7900b5ab1)
- [getzep/graphiti GitHub](https://github.com/getzep/graphiti)
- [Graphiti — Neo4j Developer Blog](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [Graphiti agent memory store review](https://codex.danielvaughan.com/2026/03/30/graphiti-agent-memory-store/)
- [Graphiti story — Presidio](https://www.presidio.com/technical-blog/graphiti-giving-ai-a-real-memory-a-story-of-temporal-knowledge-graphs/)
- [Zep arXiv paper — temporal KG architecture](https://arxiv.org/html/2501.13956v1)
- [GraphRAG with Qdrant + Neo4j](https://qdrant.tech/documentation/examples/graphrag-qdrant-neo4j/)
- [Building knowledge graph RAG on Databricks](https://www.databricks.com/blog/building-improving-and-deploying-knowledge-graph-rag-systems-databricks)
- [Graph vs Vector RAG 2026 — AgentMarketCap](https://agentmarketcap.ai/blog/2026/04/07/graph-rag-vs-vector-rag-agent-memory-neo4j-pgvector)
- [Neo4j GraphRAG context provider for MAF](https://learn.microsoft.com/en-us/agent-framework/integrations/neo4j-graphrag)
- [SPIFFE concepts](https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/)
- [Zero to Trusted: SPIFFE/SPIRE — Spletzer](https://www.spletzer.com/2025/03/zero-to-trusted-spiffe-and-spire-demystified/)
- [SPIFFE for agentic AI — HashiCorp](https://www.hashicorp.com/en/blog/spiffe-securing-the-identity-of-agentic-ai-and-non-human-actors)
- [SPIFFE + OAuth + MCP — Riptides](https://riptides.io/blog/bringing-spiffe-to-oauth-for-mcp-secure-identity-for-agentic-workloads/)
- [SPIFFE JWT-SVID — Curity](https://curity.io/resources/learn/oauth-client-credentials-spiffe-jwt-svids/)
- [JWT-SVID spec](https://spiffe.io/docs/latest/spiffe-specs/jwt-svid/)
- [Agent Identity Protocol (AIP) — arXiv 2603.24775](https://arxiv.org/html/2603.24775)
- [Durable Execution Patterns for AI Agents — Zylos](https://zylos.ai/research/2026-02-17-durable-execution-ai-agents)
- [Temporal for AI](https://temporal.io/solutions/ai)
- [Why Temporal for AI agents](https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai)
- [DBOS vs Temporal 2026](https://www.tiarebalbi.com/en/blog/dbos-vs-temporal-postgres-durable-execution)
- [Render — durable workflow platforms](https://render.com/articles/durable-workflow-platforms-ai-agents-llm-workloads)
- [hatchet-dev/hatchet GitHub](https://github.com/hatchet-dev/hatchet)
- [Inngest vs Temporal](https://www.inngest.com/compare-to-temporal)
- [Temporal — agentic flows distributed systems](https://temporal.io/blog/from-ai-hype-to-durable-reality-why-agentic-flows-need-distributed-systems)
- [Temporal cookbook — OpenAI Agents SDK](https://docs.temporal.io/ai-cookbook/openai-agents-sdk-python)
