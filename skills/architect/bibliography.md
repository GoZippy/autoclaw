# Architect Persona — Bibliography

_Seeded set of prior decisions the architect persona MUST consider before
drafting a new RFC. Maintained by the architect persona itself; new
entries land here when a new RFC is accepted or a prior decision is
superseded. Latest entries on top within each section._

## v3 canonical

- [docs/V3_1_ROADMAP.md](../../docs/V3_1_ROADMAP.md) — v3.1 plan, governance, four phases.
- [docs/V3_PLAN.md](../../docs/V3_PLAN.md) — v3.0 plan, Wake & Sleep, runner/bridge table.
- [docs/AGENT_SESSION_PROTOCOL.md](../../docs/AGENT_SESSION_PROTOCOL.md) — six-phase coordination contract.

## RFCs

- [docs/rfc/specialized-agents.md](../../docs/rfc/specialized-agents.md) — persona roster + memory model. **You are the first persona shipped from this RFC.**
- [docs/rfc/llm-provider-abstraction.md](../../docs/rfc/llm-provider-abstraction.md) — Ollama / LM Studio / ZippyMesh provider layer. The architect default is `ollama:llama3.1:70b` per Phase B.
- [docs/rfc/runner-bridge-contract.md](../../docs/rfc/runner-bridge-contract.md) — `Runner` / `Bridge` interfaces.
- [docs/rfc/mcp-server.md](../../docs/rfc/mcp-server.md) — `autoclaw-mcp` stdio server contract.

## Research

- [docs/research/2026-05-22-cross-project-survey.md](../../docs/research/2026-05-22-cross-project-survey.md) — 20+ adjacent repos surveyed; 11 adoptable patterns + 10 don't-dos. Heavy reference for any new design.

## Critique / decision-history

- [docs/AGENT_DAEMON_CRITIQUE.md](../../docs/AGENT_DAEMON_CRITIQUE.md) — orchestrator-redesign sketch that Sprint 1 absorbed. Useful for understanding *why* Sprint 1's `src/orchestrator/` exists in its current shape.

## External anchors (cited often)

- `ralph-orchestrator/CLAUDE.md` — six tenets of loop discipline. Vendored as [skills/ralph-tenets/SKILL.md](../ralph-tenets/SKILL.md).
- `AgentWise/.claude/agents/*.md` — sub-agent role file format (`tools:` frontmatter). Adopted as the persona file shape.
- `Factory-Registry-v1` mateam scratchpad layout. Canonicalised at `skills/mateam/_templates/`.
- `KiroAutomation/.kiro/plugins/` — plugin architecture pattern (read-only reference for v3.2+).

---

## Three exemplars (good RFCs to mimic)

1. **[V3_PLAN.md §1 naming table](../../docs/V3_PLAN.md)** — how to refactor a public surface (skill rename) with a deprecation window and a migration tool. Note the explicit "compat" subsection.
2. **[rfc/runner-bridge-contract.md §2-3](../../docs/rfc/runner-bridge-contract.md)** — how to write a type contract with per-vendor translation tables and a downgrade rule when a vendor can't honor the preset.
3. **[rfc/mcp-server.md](../../docs/rfc/mcp-server.md)** — how to ship a read-only base before adding writes, with a single install command that handles every host.

When drafting a new RFC, read these three and answer:
- Does my RFC have the equivalent compat/migration story?
- Does it have a per-host translation/downgrade rule where relevant?
- Does it ship a read-only/inert default before the side-effectful tool?
