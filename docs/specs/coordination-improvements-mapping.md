# COORDINATION_IMPROVEMENTS → Distributed Agent Fabric Mapping

> Status: **Housekeeping**, 2026-05-09. Reconciles
> [`COORDINATION_IMPROVEMENTS.md`](../COORDINATION_IMPROVEMENTS.md) (Kiro,
> 2026-05-08) and [`CROSS_AGENT_ARCHITECTURE.md`](../CROSS_AGENT_ARCHITECTURE.md)
> with the new phasing in [`DISTRIBUTED_AGENT_FABRIC.md`](../DISTRIBUTED_AGENT_FABRIC.md).
> Companion specs: [agent-card-schema.md](./agent-card-schema.md),
> [nats-topic-conventions.md](./nats-topic-conventions.md),
> [biscuit-token-attenuation.md](./biscuit-token-attenuation.md),
> [program-plane-registry.md](./program-plane-registry.md).

## 1. COORDINATION_IMPROVEMENTS items (§2.1 – §2.12)

| Original ID | Title | Original priority | New phase in DAF | Status | Notes |
|---|---|---|---|---|---|
| 2.1 | Inbox state machine (`_state/<msg-id>.json` with read/replied/archived) | P0 | **Phase 1 (v2.2.0)** | partially in another spec | Listed verbatim in DAF Phase 1 checklist. No standalone spec yet — to be drafted alongside `registered-agent-v2.md`. |
| 2.2 | Session-level heartbeats (`session_id` dimension) | P0 | **Phase 1 (v2.2.0)** | partially in another spec | Heartbeat field added in `heartbeat-v2.md`; UI work in DAF Phase 2 panel checklist. |
| 2.3 | Reconciliation sweep (tasks.md ↔ sprint YAML ↔ comms-log) | P0 | **Phase 1 (v2.2.0)** | not started | DAF Phase 1 lists this; needs a small `reconcile.ts` job + panel surface. |
| 2.4 | Drop `parallel-execution-plan.md`, generate `sprints/sprint-N.md` from YAML | P0 | **Phase 1 (v2.2.0)** | not started | Mechanical change; one PR's worth. |
| 2.5 | Claim tokens (UUID + 10s contention) | P1 | **Phase 1 (v2.2.0)** | partially in another spec | Listed in DAF Phase 1 checklist. Contention semantics overlap with Biscuit `task_id` attenuation in [biscuit-token-attenuation.md §3](./biscuit-token-attenuation.md) — claim tokens are the lighter-weight Phase 1 form. |
| 2.6 | Review-round-robin timeout (`sla_seconds` → broadcast on stall) | P1 | **Phase 2 (v2.3.0)** | not started | Reframed: Phase 2 wires SSE/WS push so timeouts are detectable in real time; the broadcast becomes a `review_request_broadcast` on `ac.review.request.shared`. |
| 2.7 | "Awaiting You (N)" panel section | P1 | **Phase 2 (v2.3.0)** | not started | UI feature; explicitly listed in DAF Phase 2 acceptance. |
| 2.8 | Agent cards in panel (per-agent expand: claimed tasks, last 5 outbound, ping) | P1 | **Phase 2 (v2.3.0)** | partially in another spec | Card data shape covered by [agent-card-schema.md](./agent-card-schema.md); rendering is Phase 2 panel work. |
| 2.9 | Program scope above orchestrator (`program/registry.json` + multi-repo panel) | P2 | **Phase 4 (v3.0.0)**; **pull-forward candidate** | fully covered | Now spec'd in [program-plane-registry.md](./program-plane-registry.md) including a 3-trigger pull-forward matrix. |
| 2.10 | Subcontract protocol (`subcontract_request/accept/deliver/ack`) | P2 | **Phase 1 (message types) + Phase 4 (security)** | partially in another spec | Message types added in DAF Phase 1; capability-attenuation enforcement in [biscuit-token-attenuation.md §3](./biscuit-token-attenuation.md). |
| 2.11 | VoidSpec: spec-diffable tasks (`tasks.yaml` with stable IDs + per-task changelog) | P2 | **VoidSpec, separate roadmap** | not started | Out of AutoClaw's tree; AutoClaw consumes the YAML when it lands. Cross-pollination noted in [DAF §4 (OpenSpec lift)](../DISTRIBUTED_AGENT_FABRIC.md). |
| 2.12 | VoidSpec: per-task acceptance criteria → auto-review checklist | P2 | **VoidSpec, separate roadmap** | not started | Same boundary as 2.11. AutoClaw's consensus engine ([DAF Phase 0](../DISTRIBUTED_AGENT_FABRIC.md)) is ready to consume `acceptance_criteria` once VoidSpec emits it. |

P3 items (§3 of COORDINATION_IMPROVEMENTS) are also accounted for:

| Item | Disposition |
|---|---|
| `/autoclaw handoff <agent>` slash command | Subsumed by **Phase 1** `subcontract_*` plus Phase 4 capability tokens — handoff is just a subcontract with full context attached. |
| Conflict-detection hook (`git diff --stat` between agent branches) | Phase 1 / Phase 2 — the `scope_conflict` message type already exists ([DAF §0 audit item 6](../DISTRIBUTED_AGENT_FABRIC.md)) and gets a handler in Phase 1. |
| Web dashboard outside VS Code | **killed: deferred.** IDEAS_LOG.md §C explicitly parks this as Phase-4-or-later candidate, contingent on the KG daemon existing first. |

## 2. CROSS_AGENT_ARCHITECTURE.md "Implementation Phases" — supersession

The original phasing in
[`CROSS_AGENT_ARCHITECTURE.md`](../CROSS_AGENT_ARCHITECTURE.md) §"Implementation
Phases" predates the synthesis and is now historical context. Mapping into
the new phasing:

| Old phase | Old version | Old scope (one line) | Superseded by |
|---|---|---|---|
| **Phase 1 — Local Multi-Agent** | v1.3.x ✅ "Mostly Done" | Detect IDE agents; provision filesystem mailboxes; per-agent inboxes. | **DAF Phase 0 (v2.1.1)** wires the dead code from this phase into actual activation. The mailbox itself remains canonical at all subsequent phases ([DAF §5 "What NOT to do"](../DISTRIBUTED_AGENT_FABRIC.md)). |
| **Phase 2 — Dashboard + Comms Log** | v1.4.0 | Panel; JSONL audit log. | **DAF Phase 1 (v2.2.0)** for inbox state + capability rendering; **DAF Phase 2 (v2.3.0)** for "Awaiting You" + agent-card panels. The comms log persists, augmented per [nats-topic-conventions.md §4](./nats-topic-conventions.md). |
| **Phase 3 — Git Time-Travel** | v1.5.0 | Worktrees; sprint-level revert. | **Re-scoped.** Worktree isolation is Phase 0 plumbing today. Sprint-level revert is now part of the comms-log-as-journal idea ([DAF §3 / Phase 3 KG section](../DISTRIBUTED_AGENT_FABRIC.md), and the journal/replay pattern from [research §6.3](../research/distributed-orchestration-prior-art.md)). |
| **Phase 4 — OpenClaw Bridge + Remote Agents** | v2.0.0 | Webhook bridge; remote agents register over HTTP. | **DAF Phase 2 (v2.3.0)** ships SSE/WS/NATS bus that subsumes the OpenClaw-specific bridge. **DAF Phase 4 (v3.0.0)** adds SPIFFE/Biscuit identity for cross-LAN remote agents ([biscuit-token-attenuation.md](./biscuit-token-attenuation.md)) and program scope ([program-plane-registry.md](./program-plane-registry.md)). The OpenClaw-specific term is retired in favour of vendor-neutral "remote bridge". |

The **Gaps and Mitigations** table in CROSS_AGENT_ARCHITECTURE.md §"Gaps"
remains directionally correct, but each row now points to a richer
mechanism:

| Old gap | Old mitigation | New mechanism |
|---|---|---|
| Agent compliance | Validate messages, dashboard last-check | Heartbeat-v2 + capability advertisement (DAF Phase 1). |
| Concurrent writes | Unique filenames | Same + claim tokens (§2.5) and Biscuit `task_id` attenuation. |
| Large workspaces | 7-day retention | JetStream stream retention per [nats-topic-conventions.md §2](./nats-topic-conventions.md). |
| Identity spoofing | Low risk locally | SPIFFE SVIDs + Biscuit capability tokens (DAF Phase 4). |
| Revert cascades | Dependency chains | KG-aware impact analysis (DAF Phase 3) + journal replay. |
| Network reliability | Local queue + heartbeat timeout | FS-mailbox dual-write rule + degraded-mode banner ([nats-topic-conventions.md §7](./nats-topic-conventions.md)). |

## 3. Conclusion (three lines)

`COORDINATION_IMPROVEMENTS.md` and `CROSS_AGENT_ARCHITECTURE.md` are now
**historical context only** — preserved for trace, not for execution.
All new work follows the phasing and protocol picks in
[`DISTRIBUTED_AGENT_FABRIC.md`](../DISTRIBUTED_AGENT_FABRIC.md) and the
companion specs in this directory.
Any future improvement should land as a new spec under `docs/specs/` and
reference the master synthesis directly, not the two superseded docs.

## 4. Cross-references

- Master synthesis: [../DISTRIBUTED_AGENT_FABRIC.md](../DISTRIBUTED_AGENT_FABRIC.md).
- Superseded inputs: [../COORDINATION_IMPROVEMENTS.md](../COORDINATION_IMPROVEMENTS.md),
  [../CROSS_AGENT_ARCHITECTURE.md](../CROSS_AGENT_ARCHITECTURE.md).
- Companion specs:
  [agent-card-schema.md](./agent-card-schema.md),
  [nats-topic-conventions.md](./nats-topic-conventions.md),
  [biscuit-token-attenuation.md](./biscuit-token-attenuation.md),
  [program-plane-registry.md](./program-plane-registry.md).
- Idea space and parked options: [../IDEAS_LOG.md](../IDEAS_LOG.md).
