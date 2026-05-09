# AutoClaw Distributed Agent Fabric

_Authored 2026-05-09 by Claude Code in collaboration with four parallel
research subagents. Synthesizes findings from `docs/research/*.md` and
`docs/otherProjects-catalog.md` into a single phased proposal._

## 0. Where AutoClaw is today (one paragraph)

v2.1.0 is published to VS Code Marketplace + Open VSX. It ships four skills
(KDream, AutoBuild, MAteam, Orchestrate) and 9 IDE adapters, plus a
filesystem mailbox at `.autoclaw/orchestrator/comms/`, a heartbeat protocol,
an agent registry, an HTTP bridge with bearer-token auth, a DAG planner with
bin-packing + scope conflict detection, and a consensus voting engine
(2/3 majority, unanimous on security findings). The architecture is sound —
but the code audit shows a critical pattern: **most of the cross-agent
plumbing is implemented, tested, but never invoked from the activation
path**. The fabric is wired into the walls; the breakers are off.

Concretely, four high-impact features ship as dead code:
1. **HTTP bridge** is opt-in via `autoclaw.bridge.enabled` (off by default).
2. **`resolveAgentId()`** exists but the planner still hard-codes WA-1..WA-4
   slot indices instead of consulting the registry.
3. **`evaluateConsensus()`** is fully tested but no production code calls it;
   the bridge accepts votes and never tallies them.
4. **`mergeFindings()`** for cross-agent deduplication of findings is unused.
5. **Heartbeats** are written every 30 s but no consumer reacts to stalls.
6. **`handoff` / `scope_conflict` / `escalation`** message types are in the
   enum, with zero senders or handlers.

Beyond the activation gap, the user's stated goal — _"a framework for many
agents and subagents on this machine and across the user's network, with
heterogeneous architectures"_ — exposes deeper schema gaps: no agent
capabilities, no LLM/context-window/cost fields, no machine identity, no
push channel, no shared knowledge graph, no subcontract primitive,
no cross-repo "program" scope above orchestrator.

## 1. Target architecture (one diagram)

```
                  ┌──────────────────────────────────────────────────┐
                  │                Program Plane                     │
                  │  (cross-repo, multi-machine, multi-user-later)   │
                  │ ┌─────────────────┐  ┌─────────────────────────┐ │
                  │ │ Agent Registry  │  │ Knowledge Graph Daemon  │ │
                  │ │ + Capability DB │  │ (kg-daemon:localhost)   │ │
                  │ └────────┬────────┘  └──────────┬──────────────┘ │
                  └──────────┼────────────────────────┼────────────────┘
                             │                        │
        ┌────────────────────┼─────────┬──────────────┼───────────────┐
        │                    ▼         ▼              ▼               │
        │           ┌──────────────────────────────────────────┐      │
        │           │       NATS JetStream (LAN bus)            │      │
        │           │  topics: ac.fleet.* / ac.task.* /         │      │
        │           │  ac.review.* / ac.thought.* / ac.hb.*    │      │
        │           └──────────────────────────────────────────┘      │
        │                                                              │
        │  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐     │
        │  │ AutoClaw VS  │   │ OpenClaw     │   │ Hermes /     │     │
        │  │ Code Ext.    │   │ Mission Ctl  │   │ Codex / etc. │     │
        │  │ (host node)  │   │ Bridge       │   │ Bridge       │     │
        │  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘     │
        │         │                  │                  │             │
        │  ┌──────▼──────┐    ┌──────▼──────┐    ┌──────▼──────┐     │
        │  │ Local agents│    │ Remote pool │    │ Custom bots │     │
        │  │ Claude/Kilo │    │ over WAN    │    │ in Python   │     │
        │  │ /Cursor/Kiro│    │ (mTLS+SVID) │    │ (worker SDK)│     │
        │  └─────────────┘    └─────────────┘    └─────────────┘     │
        │                                                              │
        │             Filesystem mailbox (durability fallback)         │
        │             .autoclaw/orchestrator/comms/                    │
        └──────────────────────────────────────────────────────────────┘
```

Each agent **identifies itself** via an A2A Agent Card published at
`/.well-known/agent-card.json`, declaring: agent_id, machine_id, llms,
context_window, capabilities, tools, max_parallel_tasks, trust_level,
cost_budget. The orchestrator reads cards (not slot indices) when routing.

Each agent **registers** with the local AutoClaw extension (or any
AutoClaw-fabric host node it can reach) and is issued an SVID (SPIFFE
verifiable identity) plus attenuated **Biscuit capability tokens** scoped to
the project, sprint, and file-glob it's allowed to modify.

Each agent **subscribes** to NATS topics for its inbox, fleet announcements,
shared thoughts, and consensus polls — one subscription replaces hundreds
of file-system poll cycles. Filesystem inboxes remain as the durability
fallback so any agent without networking still works.

Each agent **records thoughts** to the Knowledge Graph daemon
(`POST /thoughts`, scoped by project + agent + sprint). The daemon owns one
SQLite database per project (Tier 1) or KuzuDB graph (Tier 2). Any agent
queries `GET /thoughts/search?q=&similar=&since=` to recall what the fleet
already learned.

## 2. Concrete protocol shape

### 2.1 A2A Agent Card (one per agent, served by the host extension)

```json
{
  "schema_version": "0.2.5",
  "agent_id": "claude-code-eric-laptop-window2",
  "name": "Claude Code (Sonnet 4.6) — Eric's laptop / TS expert",
  "machine_id": "eric-laptop",
  "machine_ip": "10.0.0.42",
  "transport": ["nats", "ws", "fs"],
  "endpoints": {
    "nats": "nats://10.0.0.42:4222",
    "ws":   "ws://10.0.0.42:9876/api/v1/messages/stream",
    "http": "http://10.0.0.42:9876/api/v1/"
  },
  "llms_available": ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
  "context_window": 1000000,
  "capabilities": ["typescript", "node", "react", "test", "security-review"],
  "tools_supported": ["bash", "edit", "grep", "glob", "agent", "webfetch"],
  "trust_level": "high",
  "cost_budget":   { "daily_usd": 100, "hourly_usd": 10 },
  "max_parallel_tasks": 3,
  "human_in_loop_required": false,
  "skills_loaded": ["kdream", "autobuild", "mateam", "orchestrate"],
  "version": "2.1.0",
  "last_seen": "2026-05-09T12:32:00Z"
}
```

### 2.2 Heartbeat (extended)

Adds: `token_budget_remaining`, `queue_depth`, `current_llm`, `last_error`,
`network_latency_ms`, `error_rate_1m`. Backwards-compatible — old fields
remain, new fields optional.

### 2.3 New message types

- `subcontract_request` / `subcontract_accept` / `subcontract_deliver` /
  `subcontract_ack` — Kiro-proposed subcontract pattern from
  `docs/COORDINATION_IMPROVEMENTS.md §2.10`.
- `thought_record` — agent broadcasts an observation/finding into the KG.
- `capability_query` — orchestrator asks the fleet "who can do X?"
- `capability_offer` — agent answers with current load + estimated cost.
- The existing `handoff`, `scope_conflict`, `escalation` get handlers
  (currently dead — see code audit §8).

### 2.4 Knowledge Graph TS interface (Tier-1 + Tier-2 share one shape)

```ts
interface KnowledgeGraph {
  recordThought(t: Thought): Promise<string>;       // returns thought_id
  recordRelation(from: string, kind: string, to: string, meta?: object): Promise<void>;
  searchSimilar(text: string, opts?: { k?: number; project?: string;
                                       agent?: string; since?: string;
                                       includeText?: boolean }): Promise<Thought[]>;
  traverseFrom(seed: string, edgeKinds: string[], depth?: number): Promise<Thought[]>;
  forAgent(agent: string, opts?: { since?: string }): Promise<Thought[]>;
  forProject(project: string, opts?: { since?: string }): Promise<Thought[]>;
  since(iso: string): Promise<Thought[]>;
  export(opts?: { project?: string; format?: "jsonl" | "md" }): AsyncIterable<string>;
}
```

## 3. Phased roadmap

Each phase is independently shippable and reversible.

### Phase 0 — Activation (v2.1.1, this week)

Wire up the dead code identified in the audit. **Zero new dependencies.**

- [ ] Auto-start bridge when orchestrator initializes (audit Tier-1 #1).
  Touchpoint: `extension.ts:300` — call existing `bridgeStartCommand()` if
  the user has at least one task manifest. Default to `127.0.0.1` so it
  stays local-only unless explicitly opened.
- [ ] Call `resolveAgentId()` during `planSprints()` and persist the
  resolved platform ID alongside the WA-N slot in sprint YAMLs (audit
  Tier-1 #2). Touchpoint: `orchestrate.ts:465–471`.
- [ ] Wire `evaluateConsensus()` into the review command and the bridge
  vote endpoint (audit Tier-1 #3). New endpoint:
  `POST /api/v1/consensus/{task_id}/evaluate` returning `ConsensusResult`.
- [ ] Heartbeat-aware planning: when `assign` runs, skip slots whose mapped
  agent has stalled > 5 min (audit Tier-1 #4). Touchpoint: extension.ts
  orchestrate-assign command — call `getAgentStatuses()` first.
- [ ] Call `mergeFindings()` inside `evaluateConsensus()` so duplicates
  collapse (audit Tier-3 #10).
- [ ] Add `bridge.test.ts` and `comms.test.ts` (currently zero coverage).

Acceptance: existing tests stay green, 8-12 new unit tests, `npm run
adapters:check` clean, no behavior change unless a manifest exists.

### Phase 1 — Schema & Identity (v2.2.0)

Extend registries and tokens; add inbox state; ship the COORDINATION_-
IMPROVEMENTS P0 list.

- [ ] Inbox state machine — `inboxes/<agent>/_state/<msg-id>.json` with
  `read_at` / `replied_at` / `archived_at` (COORDINATION §2.1).
- [ ] Session-level heartbeats — `session_id` dimension on every heartbeat
  (COORDINATION §2.2). Render per-session rows in panel.
- [ ] Reconciliation sweep — every 5 min reconcile tasks.md ↔ sprint
  YAML ↔ comms-log (COORDINATION §2.3).
- [ ] Drop `parallel-execution-plan.md`; generate `sprints/sprint-N.md` from
  YAML (COORDINATION §2.4).
- [ ] Extend `RegisteredAgent` with optional fields: `capabilities`,
  `llms_available`, `context_window`, `machine_id`, `trust_level`,
  `cost_budget`, `max_parallel_tasks`, `tools_supported`. Populate from
  detection + an `~/.autoclaw/agent-card.json` override file.
- [ ] Extend `Heartbeat` with optional ops fields (token budget, queue
  depth, current llm, last error).
- [ ] Token revocation list (`tokens.json` gains `revoked_at`); scope check
  per endpoint; replay protection via `(timestamp, nonce)`.
- [ ] Claim tokens (COORDINATION §2.5) — UUID with 10s contention window.
- [ ] `subcontract_*` message types and a default handler in extension that
  routes deliver→requester inbox.

Acceptance: panel shows capability chips per agent and per-session
heartbeats; the audit's Tier-1+Tier-2 gaps are closed.

### Phase 2 — Push & Bus (v2.3.0)

Replace polling with bidirectional channels and add NATS as opt-in LAN bus.

- [ ] `GET /api/v1/messages/stream` SSE endpoint on the bridge.
- [ ] `WS /api/v1/messages/stream` WebSocket endpoint on the bridge.
- [ ] Optional NATS JetStream sidecar (`autoclaw.fabric.busDriver` =
  `"fs" | "ws" | "nats"`, default `"fs"` so installs stay zero-config).
  Embed `nats-server` as a child process the extension can launch when
  the user opts in via Command Palette → `AutoClaw: Start LAN Fabric`.
- [ ] Topic conventions: `ac.fleet.announce`, `ac.fleet.heartbeat.<agent>`,
  `ac.task.assign.<sprint>`, `ac.task.complete.<task>`,
  `ac.review.request.<agent>`, `ac.review.vote.<task>`,
  `ac.thought.record`, `ac.subcontract.<request_id>`.
- [ ] `Awaiting You (N)` panel section (COORDINATION §2.7).
- [ ] Agent cards UI in panel (COORDINATION §2.8).

Acceptance: round-trip latency for cross-agent message ≤ 2 s on the same
LAN (vs ~30 s today via fs poll). FS mailbox stays canonical for durable
record; NATS is the fast path.

### Phase 3 — Knowledge Graph & Routing (v2.4.0)

Ship the shared thought-store and a real capability-aware router.

- [ ] Vendor `kg-daemon` (Node binary + `better-sqlite3` + `sqlite-vec` +
  FTS5 + `edges` table) as a separate, optional companion process.
  Localhost-only HTTP, one `.db` per project.
- [ ] Embedding via ZippyMesh on :20128 (no Python pipeline).
- [ ] `KnowledgeGraph` TS interface implemented for Tier 1 (SQLite). Tier 2
  KuzuDB swap-in is a single class, deferred until concurrency demands.
- [ ] Capability-aware router: replace the WA-N round-robin in
  `orchestrate.ts:392` with a scorer:
  `score(agent, task) = capability_match × trust_score × idle_factor /
   estimated_cost` and pick the top agent for each task in topo order.
- [ ] `capability_query` / `capability_offer` flow: orchestrator broadcasts
  on `ac.fleet.capabilities.query`; agents answer with their card +
  current load; planner picks the best.
- [ ] Reviewer agent uses `searchSimilar()` to find prior decisions on the
  same kind of finding before re-litigating it.

Acceptance: an agent with `capabilities: ["go"]` is preferred for a task
tagged `language: go`; the KG returns ≥ 1 prior thought relevant to the
task in ≥ 50% of sprints after a one-week soak.

### Phase 4 — Identity, Trust & Program Plane (v3.0.0)

- [ ] SPIFFE/SPIRE issuer running on the user's primary machine; agents
  obtain rotating SVIDs (5-min TTL); bridge validates SVID instead of /
  alongside bearer.
- [ ] Biscuit capability tokens for attenuated subagent delegation
  (parent agent attenuates its own scope when issuing a subcontract; the
  child cannot exceed it).
- [ ] Program scope (`program/registry.json`) stitching multiple repos
  (COORDINATION §2.9). One panel renders fleet across linked workspaces.
- [ ] Optional **Hatchet** durable workflow runtime (Postgres-only ops;
  good TS SDK) for long-running pipelines that survive editor restarts.
- [ ] **Graphiti** layered on top of the kg-daemon (Tier-2 swap to KuzuDB)
  to give thoughts bi-temporal validity ("what did agent X believe at
  sprint Y").

## 4. Cross-pollination from `docs/otherProjects-catalog.md`

Top adoption candidates (ranked by fit × license safety):

1. **Hindsight (Retain/Recall/Reflect API)** — drop-in shape for the KG
   daemon's `searchSimilar` + multi-strategy parallel recall (semantic +
   keyword + graph + temporal, cross-encoder reranked). License OK; lift
   the API shape, write our own minimal impl in TS.
2. **agentflow** — DAG-based orchestrator with shared scratchboard memory.
   The scratchboard pattern is exactly what `mateam`'s
   `.autoclaw/mateam/scratch/<session>/` already gestures at; formalize.
   License unclear — confirm before vendoring code.
3. **pve-gateway** — plan→approve→apply state machine with append-only
   audit. Borrow the state-machine shape for our consensus-gated merges.
4. **clawbridge-a2a** (study only — proprietary license per catalog) —
   criticality tiers (1-CRITICAL ... 3-ROUTINE) and NCR/IV workflow. Add
   a `criticality` field to tasks; map to the unanimous-vs-2/3 rule.
5. **acc-agent-command-center** — radial-hub fleet dashboard. Inspiration
   for the AutoClaw panel's Phase-2 redesign.
6. **zippy-mcp-kit** — `doctor`/`supervise`/`test`/`metrics` (p50/p95/p99)
   CLIs and mcp-proxy observability. Borrow shape for our `autoclaw.doctor`
   + new `autoclaw.fleet.metrics`.
7. **OpenSpec** — task-yaml-with-stable-IDs idea (matches COORDINATION
   §2.11). Disable the anonymous telemetry before any port.
8. **hermes-agent / hermes-workspace** — capability advertising patterns;
   audit diffs from solo upstream maintainers before lifting code.

Skip / domain-only (do not pull): ZippyVerse_DJ_Live_v1, OpenRoom,
playcanvas_engine, orbit-3d-showcase, gradient-bang, hyperframes —
domain demos, not infrastructure.

## 5. What NOT to do

- **Do NOT replace the filesystem mailbox.** It's the durable record and
  the lowest-common-denominator for agents that can't speak NATS/WS. It
  stays as the canonical audit log forever.
- **Do NOT pull GraphRAG, Letta, or Neo4j Community as the system of
  record.** GraphRAG indexing is 10-40× our budget; Letta has the wrong
  abstraction; Neo4j Community is GPLv3 and contaminates embedding paths.
- **Do NOT make Phase 2 NATS the default.** Zero-config is a core promise;
  NATS is opt-in until install is proven invisible.
- **Do NOT extend the bridge with new tool execution endpoints.** Tools
  belong on **MCP servers**; the bridge is for agent-to-agent coordination
  (A2A). Keep that boundary clean.
- **Do NOT auto-vendor any otherProjects/* repo's code without a license
  audit.** Several are proprietary, NOASSERTION, or AGPL.
- **Do NOT ship telemetry by default.** AutoClaw's value proposition
  includes local-first / no-phone-home; preserve it.

## 6. Open questions for the user

These are the only decisions blocking Phase 0:

1. **Bridge default.** Auto-start on `127.0.0.1` when a manifest exists — OK
   to ship as default? (Easy to revert; binds one port.)
2. **Phase ordering.** Do you want Phase 0 (activation) shipped on its own
   as v2.1.1 patch, or bundled with Phase 1 schema work as v2.2.0?
3. **NATS opt-in surface.** Embed `nats-server` as a managed child process,
   or require the user to install it themselves via `winget`/`brew`?
4. **KG daemon location.** Bundle as a separate `autoclaw-kg` package that
   the extension launches, or in-process inside the extension host?
   (Separate is more reliable; in-process is easier to install.)
5. **Program plane priority.** Phase 4 lists program-scope last. If you
   regularly work across `autoclaw` + `ZippyPanel` + ZippyVoice today,
   we should pull this forward.

## 7. References

- `docs/research/code-audit-cross-agent.md` — what's wired vs not, with
  file:line citations and Tier-1/2/3 prioritized fixes.
- `docs/research/distributed-orchestration-prior-art.md` — A2A, MCP, NATS,
  WebSocket+SSE, SPIFFE, Biscuit, Hatchet, Graphiti — with sources.
- `docs/research/knowledge-graph-stack.md` — 14-candidate KG comparison;
  Tier-1 SQLite+vec / Tier-2 KuzuDB recommendation.
- `docs/otherProjects-catalog.md` — 47 GoZippy repos catalogued; top-8
  cross-pollination targets.
- `docs/COORDINATION_IMPROVEMENTS.md` — Kiro's P0/P1/P2 list (most folded
  into Phases 1-3 above).
- `docs/CROSS_AGENT_ARCHITECTURE.md` — original vision (Phase 1-4); this
  doc supersedes its phasing with concrete protocol choices.
