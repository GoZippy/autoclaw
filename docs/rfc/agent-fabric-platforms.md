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

> **Key finding (code survey, 2026-06-09):** the per-platform *runners already
> exist* — `src/runners/` ships real implementations for claude-code,
> claude-desktop, codex, cursor, kiro, gemini-cli, hermes (466 lines), openclaw
> (629 lines), autogpt, plus a loop-service adapter. Capability routing also
> exists (`orchestrate.ts` `broadcastCapabilityQueries` + a jaccard match). So
> this is **wire + extend, not build-from-scratch.** The one missing conceptual
> layer — the agent-TYPE taxonomy — is now implemented (`src/fabric/agentTypes.ts`).

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

## 7. Integration with existing AutoClaw infra (the real seams)
Each plug-in point already exists; the fabric layer threads the agent-type
taxonomy through them.

| Seam | Where it lives | What it already does | What the fabric adds |
|---|---|---|---|
| **Runner registry** | `src/runners/registry.ts` (`RunnerRegistry`, `translateTrust`), `src/runners/types.ts` (`Runner`, `DispatchOptions`) | registers + selects per-platform runners; 9 implemented | tag each runner with an `AgentType`; add a `taskType` discriminant to `DispatchOptions` for non-coding (callable) dispatch |
| **Agent registry schema** | `src/comms.ts` (`RegisteredAgent` v2: capabilities, machine_id, trust_level, llms_available, human_in_loop_required) | identity + capability advertisement | add `agent_type` + `can_orchestrate` so discovery filters by kind |
| **Capability routing** | `orchestrate.ts` `broadcastCapabilityQueries` + jaccard match (`required_capabilities`) | "who can do X?" exists | match also on `AgentType.capabilityTags`; route reviews to the required *kind* |
| **Personas** | `src/personas/types.ts`, `src/personas/loader.ts` | role layer (14 archetypes) | `agentTypeForPersona()` (done) classifies each; add governance/supervisor/assistant archetypes |
| **Controls** | `src/orchestrator/subcontract.ts` (`persona_id`), `reviewSla.ts` (`SECURITY_TIER_PERSONAS`, `quorumRuleForPersona`) | subcontract phases + unanimous-for-security | `consensusRuleForAgentType()` (done) derives the rule per type; add a governance approval gate before dispatch/merge |
| **A2A identity** | `docs/specs/agent-card-schema.md`, `/.well-known/agent.json`, `x-autoclaw` ext | A2A v0.2.5 card published | publish `agent_type` in the card; consume external A2A agents via the bridge |
| **Bridge** | `src/bridge-ws.ts` (WS), `src/bridge.ts` (HTTP `/api/v1/*`) | external agents register + stream (opt-in, local-only) | cross-machine delivery rides the relay / bridge |

**The taxonomy keystone is in:** `src/fabric/agentTypes.ts` —
`AgentType`, per-type profiles (trust, consensus rule, human-in-loop,
canOrchestrate, capability tags), `agentTypeForPersona()`, and
`consensusRuleForAgentType()` (consistent with `reviewSla`).

## 8. Sequencing (revised — adapters already exist)
1. ✅ **Agent-type taxonomy** (`src/fabric/agentTypes.ts`) — the missing layer.
2. **Tag runners + RegisteredAgent with `agent_type`**; add `taskType` to
   `DispatchOptions` so runners can be dispatched as callable tasks, not just prompts.
3. **Route by type** — capability match also keys on `AgentType.capabilityTags`;
   review requests route to the required *kind* (auditor ⇒ unanimous, etc.).
4. **Onboarding command** — `autoclaw fabric onboard <platform>`: detect runner,
   install its skill pack, register with `agent_type`, smoke-check. (Runners +
   skill libraries exist; this wires them.)
5. **Governance controls** — an approval gate before dispatch/merge for
   `governance`-classified flows + an audit log every dispatch writes.
6. **OpenClaw + Hermes** brought fully live as `assistant`/`service` workers
   (their runners exist — verify + register + skill packs).
7. Cross-machine routing rides the relay; A2A agents via the bridge.

## 9. Open questions (for the user)
- Transport for push-to-agent: reuse the relay, adopt A2A (clawbridge-a2a), or both?
- Is the hosted cross-machine fabric a paid tier (per [MONETIZATION.md](../MONETIZATION.md)), with per-platform adapters free?
- Which two platforms matter most to wire *first* (beyond Claude Code + Kilo)?
