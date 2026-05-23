# AutoClaw Doc Index

_Last updated: 2026-05-23. Maintained by the **architect** persona —
edit this file when you add or supersede any doc under `docs/`._

This is the canonical, **first** doc to load when working on AutoClaw.
Everything else is reachable from here.

---

## Canonical (load before any sprint)

| Doc | Purpose |
|---|---|
| [V3_PLAN.md](V3_PLAN.md) | v3.0 plan — Wake & Sleep model, runner/bridge dispatch table, MCP install hero. Authoritative for v3.0 scope. |
| [V3_1_ROADMAP.md](V3_1_ROADMAP.md) | v3.1 plan — governance, four phases (architect → LLM providers → security-auditor → doc-writer + peer slots). Where v3.1 contradicts an earlier doc, this wins. |
| [AGENT_SESSION_PROTOCOL.md](AGENT_SESSION_PROTOCOL.md) | Six-phase cross-agent coordination contract (REGISTER→SYNC→CLAIM→WORK→REPORT→LOOP). Read this *before* writing anything that touches `.autoclaw/orchestrator/`. |

## RFCs

| Doc | Topic | Status |
|---|---|---|
| [rfc/runner-bridge-contract.md](rfc/runner-bridge-contract.md) | The `Runner` / `Bridge` interfaces every per-vendor adapter implements. | implemented (Sprint 2) |
| [rfc/mcp-server.md](rfc/mcp-server.md) | `autoclaw-mcp` stdio server, tool surface, install paths per host. | implemented (Sprint 2, polished Sprint 3) |
| [rfc/llm-provider-abstraction.md](rfc/llm-provider-abstraction.md) | `src/llm/` provider interface + Ollama / LM Studio / ZippyMesh adapters. | accepted, scheduled for Phase B |
| [rfc/specialized-agents.md](rfc/specialized-agents.md) | Long-lived persona roster + per-persona bi-temporal memory. | accepted, scheduled for Phase A (architect) → C (memory engine) → C/D (security-auditor + doc-writer). |

## Critique & history

| Doc | Why kept |
|---|---|
| [AGENT_DAEMON_CRITIQUE.md](AGENT_DAEMON_CRITIQUE.md) | The orchestrator-redesign sketch that Sprint 1 absorbed. Useful as a decision-history reference; do not act on directly — superseded by V3_PLAN §6 Workstream A. |

## Research

| Doc | Date | Status |
|---|---|---|
| [research/2026-05-22-cross-project-survey.md](research/2026-05-22-cross-project-survey.md) | 2026-05-22 | active — informs v3.1 roadmap |
| [research/distributed-orchestration-prior-art.md](research/distributed-orchestration-prior-art.md) | 2026-05-09 | historical — folded into V3_PLAN |
| [research/knowledge-graph-stack.md](research/knowledge-graph-stack.md) | 2026-05-09 | historical |
| Older `phase-*-execution-report.md` and `v2-*-report.md` files | various | **archive candidates** — per [survey §4 don't-do #1](research/2026-05-22-cross-project-survey.md), consolidate into a rolling `IDEAS_LOG.md` and move dated reports to `docs/research/archive/`. Phase A task. |

## Specs

| Path | Purpose |
|---|---|
| [specs/_template.spec.md](specs/_template.spec.md) | Spec-as-contract template. Use for every Phase-A onward feature. |
| `specs/<feature>/spec.md` | One per feature. Written by the architect persona; consumed by implementer personas. |

## Reviews

`.autoclaw/orchestrator/reviews/sprint-{N}-review.md` — one per shipped
sprint. Not in this tree (in `.autoclaw/` runtime state). Index here as
they merge.

---

## Operator's reading order

1. [V3_1_ROADMAP.md §0-1](V3_1_ROADMAP.md) — where we are.
2. [AGENT_SESSION_PROTOCOL.md §1-3](AGENT_SESSION_PROTOCOL.md) — how the bus works.
3. The RFC matching your task — see the table above.
4. [skills/ralph-tenets/SKILL.md](../skills/ralph-tenets/SKILL.md) before opening any loop.
5. Your persona's `SKILL.md` under `skills/<persona>/`.
