# AutoClaw Doc Index

_Last updated: 2026-06-12. Maintained by the **architect** persona —
edit this file when you add or supersede any doc under `docs/`._

This is the canonical, **first** doc to load when working on AutoClaw.
Everything else is reachable from here.

---

## Canonical (load before any sprint)

| Doc | Purpose |
|---|---|
| [V3_PLAN.md](V3_PLAN.md) | v3.0 plan — Wake & Sleep model, runner/bridge dispatch table, MCP install hero. Authoritative for v3.0 scope. |
| [V3_1_ROADMAP.md](V3_1_ROADMAP.md) | v3.1 plan — governance, four phases (architect → LLM providers → security-auditor → doc-writer + peer slots). Where v3.1 contradicts an earlier doc, this wins. |
| [V4_PLAN.md](V4_PLAN.md) | v4 blueprint (2026-06-12) — "agent dev organization in a box": onboarding (ONB), org model (ORG), fleet visibility (VIS), federation (FED), reputation routing (REP), memory overhaul (MEM), trigger hooks (HKS), quality substrate (QLT). Governs the arc after v3.x; V3_1 still rules in-flight work. |
| [AGENT_SESSION_PROTOCOL.md](AGENT_SESSION_PROTOCOL.md) | Six-phase cross-agent coordination contract (REGISTER→SYNC→CLAIM→WORK→REPORT→LOOP). Read this *before* writing anything that touches `.autoclaw/orchestrator/`. |
| [RELEASE-3.6.5.md](RELEASE-3.6.5.md) | Current manual release checklist for publishing 3.6.5 to VS Code Marketplace and Open VSX. |

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
| [research/2026-06-27-agentic-ai-workflows/synthesis.md](research/2026-06-27-agentic-ai-workflows/synthesis.md) | 2026-06-27 | active — informs Workflow Lab, failure-aware routing, verifier loops, and model-routing work |
| [research/2026-05-22-cross-project-survey.md](research/2026-05-22-cross-project-survey.md) | 2026-05-22 | active — informs v3.1 roadmap |
| [research/2026-06-11-fable-5-agent-patterns.md](research/2026-06-11-fable-5-agent-patterns.md) | 2026-06-11 | active — informs V4_PLAN P5–P8 + the gates spec |
| [research/2026-06-11-loss-function-development.md](research/2026-06-11-loss-function-development.md) | 2026-06-11 | active — rubric/harness design playbook; informs QLT epics |
| [research/distributed-orchestration-prior-art.md](research/distributed-orchestration-prior-art.md) | 2026-05-09 | historical — folded into V3_PLAN |
| [research/knowledge-graph-stack.md](research/knowledge-graph-stack.md) | 2026-05-09 | historical |
| Older `phase-*-execution-report.md` and `v2-*-report.md` files | various | **archive candidates** — per [survey §4 don't-do #1](research/2026-05-22-cross-project-survey.md), consolidate into a rolling `IDEAS_LOG.md` and move dated reports to `docs/research/archive/`. Phase A task. |

## Specs

| Path | Purpose |
|---|---|
| [specs/_template.spec.md](specs/_template.spec.md) | Spec-as-contract template. Use for every Phase-A onward feature. |
| `specs/<feature>/spec.md` | One per feature. Written by the architect persona; consumed by implementer personas. |
| [specs/recursive-workflow-lab/requirements.md](specs/recursive-workflow-lab/requirements.md) + [tasks.md](specs/recursive-workflow-lab/tasks.md) + [design-review-addendum.md](specs/recursive-workflow-lab/design-review-addendum.md) | Workflow Lab: recursive/reinforcement agent loops, local/LAN/cloud model routing, visual flow authoring, workflow packs, and Pro/Teams surfaces. Status: draft. |
| [specs/orchestrate-gates-and-routing.spec.md](specs/orchestrate-gates-and-routing.spec.md) | Evidence-grounded review gates (reviewer≠author, acceptance commands) + tier×phase routing. Status: pilot — A live, C/B lib landed. |
| [specs/agent-trigger-hooks.spec.md](specs/agent-trigger-hooks.spec.md) | Event→action hooks (wake agents on comms/build events) + fleet HALT kill switch + audit. Status: draft (V4 HKS pillar). |

## Reviews

`.autoclaw/orchestrator/reviews/sprint-{N}-review.md` — one per shipped
sprint. Not in this tree (in `.autoclaw/` runtime state). Index here as
they merge.

---

## Operator's reading order

1. [V3_1_ROADMAP.md §0-1](V3_1_ROADMAP.md) — where we are.
2. [AGENT_SESSION_PROTOCOL.md §1-3](AGENT_SESSION_PROTOCOL.md) — how the bus works.
3. The RFC matching your task — see the table above.
4. [skills/loop-discipline/SKILL.md](../skills/loop-discipline/SKILL.md) before opening any loop.
5. Your persona's `SKILL.md` under `skills/<persona>/`.
