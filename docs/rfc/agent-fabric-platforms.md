---
status: draft  # draft | review | pilot | implement | verify | done
owner: claude-code
created: 2026-06-09
updated: 2026-06-09
extends: docs/DISTRIBUTED_AGENT_FABRIC.md
---

# RFC: Multi-Platform Agent Fabric — adapters, agent types, and org controls

**Read first:** [docs/DISTRIBUTED_AGENT_FABRIC.md](../DISTRIBUTED_AGENT_FABRIC.md)
(the fabric initiative this extends — do NOT spawn a parallel architecture),
[docs/MONETIZATION.md](../MONETIZATION.md), and the live relay in `src/cloud/`.

> **Section 7 (integration with existing AutoClaw code) is being filled from a
> code-infra survey in progress.** The requirements + model below come from the
> product vision and are stable.

## 1. Goal
Turn AutoClaw from "coordinates a few coding agents in one repo" into a
**control plane that can direct work to, and request reviews from, many kinds
of agents on many platforms** — each spoken to in its own dialect, under
explicit organizational controls. The agents people already run become
interchangeable, governable *workers*.

## 2. The platforms to speak (the adapter matrix)
Each platform gets an **adapter**: a translator between AutoClaw's internal
task/▸review contract and that platform's native invocation + response shape.

| Platform | Form | How we direct work | How we get a response/review |
|---|---|---|---|
| **Claude Code** (Anthropic) | CLI + desktop app | spawn CLI / MCP tools / file-bus | task_complete + review vote on the bus |
| **OpenAI Codex** | CLI (+ agents) | CLI invocation / MCP | structured result |
| **Cursor** | IDE + agent | MCP / file-bus / rules files | edits + status |
| **Kilo Code** | IDE agent | file-bus modes + MCP | bus messages (already a peer today) |
| **OpenClaw** | agent service | SSH/HTTP to the openclaw service | model-oracle / service reply |
| **Hermes** (hermes-agent, desktop-os1) | personal-assistant agent OS | HTTP/A2A to the Hermes service | assistant reply / task ack |
| **Generic A2A** | any A2A-speaking agent | the A2A bridge (clawbridge-a2a) | A2A task lifecycle |

Design rule: **adapters are thin and uniform.** They translate; they do not
hold orchestration logic. One internal contract in, one platform dialect out.

## 3. The agent-type taxonomy (beyond "coding agent")
AutoClaw must address agents by *what they do*, not just *where they run*. Each
type has a capability tag, a default trust preset, and a review posture:

| Type | What it is | Direction | Review posture |
|---|---|---|---|
| **coder** | edits a repo | task + scope + verify | peer review (majority) |
| **runner** | a simple callable task agent (one job, returns a result) | request/response, no session | result-validated, no consensus |
| **auditor** | security / quality audit of submitted work | given an artifact, returns findings | its findings gate merges (**unanimous** for security) |
| **supervisor** | manages/dispatches *other* bots | given an objective, fans out + reports | reviewed on outcome, not steps |
| **assistant** | personal assistant (Hermes-style) — schedules, drafts, answers | natural-language request | human-in-the-loop confirm |
| **governance** | corp/org-level actor — approves, sets policy, signs off | escalation + approval requests | IS the control, not the controlled |

These map onto the existing **persona** model (a persona already has a role,
tool allow/deny, trust preset, and provider chain) — the taxonomy is the set of
persona *archetypes* the fabric ships, each with platform-appropriate skills.

## 4. Organizational control levels
Work and reviews flow through tiers, so a solo dev and a 200-person org use the
same primitives at different strictness:

1. **Individual** — you direct your own agents; no approval gates.
2. **Team** — work needs peer review (the existing quorum: majority for tasks).
3. **Security-tier** — auditor sign-off, **unanimous** (already wired:
   `SECURITY_TIER_PERSONAS` + `quorumRuleForPersona`).
4. **Governance** — a governance actor must approve before work is dispatched
   or merged (policy gate); escalations route to it.

Controls are **per-task and per-platform**: directing a `governance` approval to
a Hermes assistant uses Hermes's dialect; the *control semantics* are uniform.

## 5. Onboarding per platform
Onboarding = "make platform X a usable worker in this fabric." For each
platform the fabric installs:
- an **adapter** (the translator),
- a **skill/tooling pack** appropriate to that platform (mine the user's skill
  libraries — `Enterprise-Crew-skills`, `oh-my-codex`, `everything-claude-code`
  — rather than write from scratch),
- a **capability advertisement** (what this agent can do, its trust, its LLM),
- a **health/identity** registration so the orchestrator can route to it.

A one-command `autoclaw fabric onboard <platform>` should detect the platform,
install its adapter + skills, register it, and run a smoke check.

## 6. Non-goals / guardrails
- Don't reinvent the comms/orchestrator primitives — extend them (memory:
  "reference/extend the fabric initiative, don't spawn parallel architectures").
- Don't make adapters smart — orchestration stays central; adapters translate.
- Local-first holds: an agent on the same machine never needs the cloud relay;
  cross-machine routing is the relay's job and stays opt-in.
- Personal-assistant + governance actors are **human-in-the-loop by default** —
  they propose/approve; they don't silently act outside scope.

## 7. Integration with existing AutoClaw infra
*(Pending the in-progress code-infra survey — will map adapters onto
`src/runners/`, the capability router, `src/personas/`, subcontract/reviewSla,
the comms agent registry, and the A2A bridge, with concrete extension points.)*

## 8. Sequencing (smallest reversible first)
1. Define the **AgentAdapter** interface + a registry (extends `src/runners/`).
2. Ship **two reference adapters** end-to-end (Claude Code CLI + Kilo — already a
   peer) to prove the contract.
3. Add the **agent-type taxonomy** as persona archetypes + capability tags.
4. Add **OpenClaw + Hermes** adapters (service/HTTP/A2A) — the assistant + service tier.
5. **Onboarding command** + per-platform skill packs.
6. **Governance controls** (approval gate before dispatch/merge).
7. Cursor / Codex adapters fill in.

## 9. Open questions (for the user)
- Transport for push-to-agent: reuse the relay, adopt A2A (clawbridge-a2a), or both?
- Is the hosted cross-machine fabric a paid tier (per [MONETIZATION.md](../MONETIZATION.md)), with per-platform adapters free?
- Which two platforms matter most to wire *first* (beyond Claude Code + Kilo)?
