# AutoClaw v3.1 — Synthesis & Roadmap

_Status: draft, 2026-05-22. Pulls together [V3_PLAN.md](V3_PLAN.md) (v3.0 GA),
the new [cross-project survey](research/2026-05-22-cross-project-survey.md),
the [LLM-provider RFC](rfc/llm-provider-abstraction.md), and the
[specialized-agents RFC](rfc/specialized-agents.md) into one ordered plan._

> Authoritative for v3.1 scope. Where this contradicts an earlier doc, this
> wins.

---

## 0. Where v3.0 actually landed

Two sessions cooperated on `feat/v3-sprint-1-2-coordination` (now 12 commits
ahead of `master`):

- **claude-code (session 95a97ab9) — Sprints 1-4** — orchestrator core +
  LMD, 8 vendor runners + Kilo bridge, MCP server + write tools, memory
  tiers + `/dream` pipeline, fleet panel, trust/subcontract/SLA, VoidSpec
  sync + LMD gossip, program scope + status bar, AutoGPT/desktop runners,
  computer-use keep-alive, cloud relay MVP. 11 commits, reviewed.
- **kilo-main (session 2026-05-21) — perpetual loop & test wiring**
  ([commit `1653976`](../)) — `orchestratorLoop.ts` (perpetual
  health→work→dispatch→log), `handoff_factory.ts`, `eternal_loop.ts`,
  `extension.ts` activation wiring, `tsconfig` `downlevelIteration`,
  `package.json` `test:unit` registration, MCP write-tool gate test fix.
  **625 tests passing, clean compile.**

What was *missing* from the v3.0 plan and is filled by this roadmap:

1. **No coherent persona/skill specialization** beyond `/mateam`'s generic
   Researcher→Coder→Reviewer→Verifier — every agent looked the same.
2. **No LLM-provider abstraction** — runners hard-wire to vendor CLIs;
   local models (Ollama/LM Studio) and the user's ZippyMesh router weren't
   reachable from any code path.
3. **RFC fragmentation** — ten+ docs in `docs/` and three plans that
   contradicted each other on naming/sequencing; survey §1/§5 documents
   the cost.
4. **No formal "primary vs subordinate" model** between concurrent
   orchestrator sessions — Sprint-1-2 ran into it the hard way (the
   `finding-concurrent-session` thread). State.json needs an explicit
   primacy field; the bus needs a `capability_offer/_query` handshake.

---

## 1. Governance — claude-code is primary

Per user directive (2026-05-22): **`agent_id = claude-code` is the
primary orchestrator** on AutoClaw. Other live coordinator sessions
operate as **named work-agents** that announce capabilities and accept
assignments. This is recorded in `state.json` under a new top-level
`governance` block (see §5) so it survives sessions.

```
                         ┌──────────────────────┐
                         │  claude-code (primary)│  ← plans, reviews,
                         │  acts as orchestrator │     sets priorities,
                         └──────────┬───────────┘     dispatches subagents
                                    │
        ┌──────────┬──────────┬─────┴───────┬──────────────┐
        │          │          │             │              │
    kilo-main   kiro      openclaw     local-claude    other peer
   (code-      (spec-    (gov/        (subagent       (per-host
    integrate, driven,    approvals,  fanout via      registration)
    loop,      tasks.md,  consensus)  Agent tool)
    tests)     bridge)
```

**How a peer joins.** Send `capability_offer` to `inboxes/claude-code/`
with `{ agent_id, session_id, capabilities[], scope_preference[],
trust_preset, llm_provider, available_until }`. The orchestrator
acknowledges with `task_assign` or `answer` ("registered, idle for now").
A peer that hasn't beat in `agents.heartbeat_stall_seconds` is dropped
from the active set, same rules as before.

**Subordination is per-task, not global.** A peer is "boss" of the
subagents *it* spawns; the primary is boss of *cross-peer* sequencing.
Multiple PMs coexist — the primary just owns the merge order.

**OpenClaw role.** Per the survey §2.7, OpenClaw Mission Control is the
right shape for a governance/audit layer *over* AutoClaw — approvals,
org-level dashboards, audit log. It registers as a peer with
`capabilities: ["governance","approval","audit"]` and **does not** dispatch
work itself; it gates merges and signs off on security-tier findings.

---

## 2. The three new pillars (already drafted as RFCs)

### 2.1 LLM-provider abstraction — [`rfc/llm-provider-abstraction.md`](rfc/llm-provider-abstraction.md)

A new `src/llm/` module with one `LlmProvider` interface and adapters for
**OpenAI-compatible** (the base), **Ollama**, **LM Studio**, and
**ZippyMesh** (the user's router at `:20128/v1`). Routes per workspace
policy (`local | private | cost | latency`) and exposes
`llm.chat`/`llm.models`/`llm.health` as MCP tools. Sequencing in §6.

### 2.2 Specialized agent personas — [`rfc/specialized-agents.md`](rfc/specialized-agents.md)

A roster of ~14 long-lived personas (architect, security-auditor,
doc-writer, refactor-specialist, test-author, performance-analyst,
debug-specialist, usability-auditor, devops, creative/ideator,
supply-chain-auditor, code-reviewer, …) each with: persona profile
(mission, tool allowlist, trust preset, preferred provider), bi-temporal
memory at `.autoclaw/memory/personas/<id>/`, and global cross-project
memory at `~/.autoclaw/personas/<id>/` with privacy rules.

**First three to ship**: architect → security-auditor → doc-writer.

### 2.3 Cross-project survey — [`research/2026-05-22-cross-project-survey.md`](research/2026-05-22-cross-project-survey.md)

20+ adjacent repos catalogued. Headline borrowings:

- **Ralph's six tenets** (`ralph-orchestrator`) — short loop-discipline
  overlay. Becomes `skills/ralph-tenets/SKILL.md`.
- **Spec-as-contract workflow** (`Spec → Review → Dogfood → Implement →
  Verify → Done`) — adopt under `docs/specs/<feature>/`.
- **Sub-agent role files** (`AgentWise`'s `.claude/agents/*.md` with
  `tools:` frontmatter) — exactly the format §2.2 personas use.
- **Plugin architecture** (`KiroAutomation`) — for AutoClaw's runner/skill
  extension points.
- **Mateam scratchpad layout** (`Factory-Registry-v1`) — already a real
  in-the-wild artifact; canonicalise.
- **Plane separation** (`ZippyVoice`: control / conversation / media /
  integration) — clarifies AutoClaw's runner/orchestrator/UI split.
- **STFU.md overlay** — optional verbose-mode counter for chatty hosts.

Plus a 10-item anti-pattern "don't-do" list.

---

## 3. v3.1 phases — one sprint each

> Each phase ≈ 1 calendar week. Phase A unblocks B/C/D; B/C/D can fan out.

### Phase A — Architect persona + spec discipline _(land first)_

**Why first.** Closes the survey's #1 finding (RFC fragmentation costs us
a re-read per session) and the personas RFC's #1 pick.

| Tasks | Scope |
|---|---|
| `PersonaProfile` loader + `/persona <id>` slash command | `src/personas/`, `skills/architect/` |
| `skills/architect/SKILL.md` + seeded `bibliography.md` (the 14 existing RFCs/plans) + 3 exemplars | `skills/architect/`, `.autoclaw/memory/personas/architect/` |
| `skills/ralph-tenets/SKILL.md` — one-page overlay | `skills/ralph-tenets/` |
| `docs/specs/_template.spec.md` — Given/When/Then frontmatter + `status:` | `docs/specs/` |
| RFC index cleanup — single `docs/INDEX.md`, deprecate the contradicting plans noted in survey §5 | `docs/INDEX.md`, header notes |
| Adopt `.claude/agents/<id>.md` format (from AgentWise) for personas | `.claude/agents/` |

**Exit gate.** Running `/persona architect "draft RFC for X"` produces a
real `docs/rfc/X.md` with the spec-as-contract frontmatter, using only
context loaded from `skills/architect/`.

### Phase B — LLM provider layer (S1+S2 from the RFC)

| Tasks | Scope |
|---|---|
| `src/llm/types.ts`, `registry.ts`, `openai-compatible.ts` base | `src/llm/` |
| `ollama.ts` adapter (no auth, local first) | `src/llm/` |
| `lmstudio.ts` adapter (one-line subclass) | `src/llm/` |
| `zippymesh.ts` adapter — `:20128/v1`, `X-Intent` header thread-through | `src/llm/`, `adapters/zippymesh/` |
| `.autoclaw/llm/config.yaml` parser + `autoclaw llm install` | `src/llm/install.ts` |
| Extend `LoopServiceAdapter` with an optional `provider?: LlmProvider` | `src/runners/loop-service-adapter.ts` |
| `LocalCoderRunner` — worked example: a runner that is *just* a local model + the AutoClaw tool surface | `src/runners/local-coder.ts` |

**Exit gate.** `autoclaw llm install` writes a working config; a
`LocalCoderRunner` can complete a no-op task via Ollama on the user's
machine; ZippyMesh routing verified with one curl against a live ZM.

### Phase C — Security-auditor persona + persona memory engine

| Tasks | Scope |
|---|---|
| Per-persona memory loader (extend `src/memory/tiers.ts` with persona namespace) | `src/memory/` |
| Promotion paths: scratch → recall → archive *per persona* | `src/memory/personas.ts` |
| `.autoclaw/memory/personas/<id>/` layout + `~/.autoclaw/personas/<id>/` global mirror with privacy rules | `src/memory/`, docs |
| `skills/security-auditor/SKILL.md` + seeded patterns from `docs/research/` security write-ups | `skills/security-auditor/` |
| Subcontract extension: `subcontract_request.payload.brief.persona_id` | `src/orchestrator/subcontract.ts` |
| First production use: audit cloud-relay MVP (Sprint-4 D-series) before GA | `reviews/cloud-relay-security-audit.md` |
| Wire the unanimous-vote-on-security-findings rule (existing) into the persona's report format | `src/orchestrator/reviewSla.ts` |

**Exit gate.** Running `/persona security-auditor "audit src/cloud/"`
produces a structured finding report, the persona's `lessons.md`
accumulates, and a follow-up audit picks up the prior findings without
re-discovering them.

### Phase D — Doc-writer + MCP `llm.chat` + governance slots

| Tasks | Scope |
|---|---|
| `skills/doc-writer/SKILL.md` + auto-trigger on `task_complete` for public-API diffs | `skills/doc-writer/`, `src/orchestrator/` |
| MCP `llm.chat` / `llm.models` / `llm.health` write-tools (gated, audited) | `src/mcp/writeTools.ts` |
| Cost-ledger rollup: `llm/cost-ledger.jsonl` joinable in `/recall` | `src/mcp/costLedger.ts` |
| `registry.json` capability schema v2 — peers register with `{capabilities, scope_preference, llm_provider, trust_preset, role: primary\|peer\|governance}` | `src/comms/registry.ts` |
| Kiro / OpenClaw slot wiring — capability_offer + capability_query handshake on the bus | `src/orchestrator/registry.ts` |
| AutoClaw `autoclaw fleet onboard <peer-id>` CLI — invites a peer to register | `src/cli/fleet-onboard.ts` |

**Exit gate.** A second IDE session (e.g. kilocode) sends a
`capability_offer`, lands in `registry.json` with the right shape, and
gets a `task_assign` from the primary within one cycle.

---

## 4. Quick-wins folded in (survey's low-risk list)

Independent of A-D, the survey's §5 low-risk items can land any time:

1. `docs/specs/voidspec-tasks-yaml.md` — formalise what `src/voidspec/sync.ts` parses today (no code change).
2. `skills/mateam/_templates/{plan,context,output}.md` — match Factory-Registry layout.
3. Externalise the mateam role prompts to `.claude/agents/*.md`.
4. Add `docs/IDEAS_LOG.md` and consolidate the 15+ stale `docs/research/` files (cap the dated-archive sprawl).
5. Replace `parseVoidSpecYaml` hand-roll with a real YAML parser (already a transitive dep).

---

## 5. State-of-the-bus changes

State.json gains a `governance` block (this is the new schema element —
written by the primary, read by all peers):

```json
"governance": {
  "primary": {
    "agent_id": "claude-code",
    "session_id": "<uuid>",
    "since": "2026-05-22T22:40:00Z",
    "directive": "user, 2026-05-22"
  },
  "peers": [
    { "agent_id": "kilocode", "session_id": "kilo-main-2026-05-21",
      "role": "work-agent",
      "capabilities": ["code-integration","test-wiring","perpetual-loop"],
      "last_heartbeat": "<iso>" }
  ]
}
```

The `loop` block is now per-agent (`loop.<agent_id>`) so two coordinators
don't trample one field. Findings and the ledger are unchanged.

---

## 6. Sequencing summary

```
Week 1   Phase A  ──┐  architect + spec discipline
                    │
Week 2  Phase B    │   LLM providers (S1+S2)
                    │  (independent of A's exit gate)
Week 3  Phase C    │   security-auditor + persona memory
                    │
Week 4  Phase D    ┘   doc-writer + MCP llm.chat + peer slots
```

The architect persona writes Phase B/C/D's per-task spec files as
[`docs/specs/<task>.spec.md`](specs/) — eating its own dog food.

---

## 7. Open questions for the user

1. **Branch policy.** `feat/v3-sprint-1-2-coordination` is 12 commits
   ahead of `master`. Merge to `master` before starting v3.1, or layer
   v3.1 on the same branch? Recommend: merge first.
2. **OpenClaw role split.** Survey §2.7 proposes OpenClaw as the
   approvals/audit layer *over* AutoClaw. Confirm or adjust.
3. **Local-first default for personas.** Should the architect persona
   default to a local Ollama model (preserving privacy and saving cloud
   budget) once Phase B lands? Personas RFC §7.1 leaves this open.
4. **Persona ownership of MEMORY.md.** Should `/dream` continue writing
   to a single workspace `MEMORY.md` or shard by persona? Recommend the
   latter; closes the survey's anti-pattern #10.
5. **Cloud relay gating.** Phase C audits the cloud relay before GA — is
   GA still planned for v3.0, or does it slide to v3.1?
