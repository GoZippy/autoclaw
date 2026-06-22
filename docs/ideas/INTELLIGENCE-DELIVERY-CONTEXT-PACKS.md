# Intelligence Layer — Delivery & Context Packs

_Status: Channels A + B + the orchestrator auto-hook shipped. Channels C–D proposed._
_Created 2026-06-21 on `feat/intel-context-packs`._

## The problem this solves

AutoClaw's intelligence layer is a strong **producer** of grounded knowledge but
had weak **delivery**. It generates a lot — a vector index of the codebase,
distilled learnings, a learned style guide, project memory, and a knowledge
graph — yet almost none of it reached the agents who actually do the work:

- The orchestrator shipped **zero** intel in task assignments. A `task_assign`
  payload carried `{ assignments, branch, brief, acceptance }` and nothing about
  the code or patterns the assignee should know.
- Only **MCP-capable** runners (Claude Code, Kiro, Claude Desktop) could reach
  live intel at all (via `intelligence.retrieve` / `kg.search`). File-only
  runners (Cursor, Windsurf, Continue, Cline) and CLI runners (Codex) got static
  skill files with no project-specific context.

The fix mirrors what AutoClaw already does well for adapters: **one source of
truth, many rendered outputs.** Define one *context pack* producer, then fan it
out across delivery channels.

## Produce → Store → Deliver

| Stage | What | Where (code) | Where (disk) |
|-------|------|--------------|--------------|
| Produce | learn / index / KG record | `src/intelligence/{learn,ragCode}.ts`, `src/intelligence/kg/` | — |
| Store | vectors, learnings, metrics, KG | `src/intelligence/{vector,paths}.ts` | `.autoclaw/vector/db.sqlite`, `.autoclaw/learnings/*.md`, `.autoclaw/vector/preferences.json`, `.autoclaw/metrics/*.json`, `.autoclaw/kg/kg.db` |
| **Deliver** | **context packs** | **`src/intelligence/contextPack.ts`** | **`.autoclaw/orchestrator/sprints/sprint-<N>-<agent>.context.md`** |

A **context pack** is the single bundle handed to a newly-assigned agent so it
starts grounded: real code (RAG-retrieved), proven patterns/learnings, the
learned style guide, recent memory, and durable KG facts. It is built on top of
`generateRAGPrompt` + the in-process Knowledge Graph and is **degrade-safe** —
with no embeddings backend it still emits a useful pack from `preferences.json`
+ style + memory, and the KG falls back to full-text.

## Channel A — orchestrator context packs (shipped)

Delivery is **file-based** so every runner can consume it (no MCP required):

1. `buildContextPack(scope, opts)` in `src/intelligence/contextPack.ts` returns
   `{ markdown, ragPrompt, kgFacts, summary, ... }`. The `markdown` is a clean
   single-H1 document; `summary` is a compact JSON object for a task payload.
2. The orchestrate `assign` flow (skills/orchestrate/SKILL.md) builds one pack
   per agent and writes `sprint-<N>-<agent>.context.md`, referenced from the
   assignment brief via the `{{context_pack_path}}` token
   (templates/sprint-assignment.md).
3. The pack `summary` (incl. `context_file`) is attached under the `task_assign`
   `payload.intelligence` so MCP-aware runners can pull it without re-reading.

### How to invoke it

- **In-editor:** Command Palette → `AutoClaw: Intelligence — Build Context Pack`
  (`autoclaw.intelligence.contextPack`).
- **Headless / any runner / CI:**
  ```
  node scripts/context-pack.js --task "<sprint goal + task names>" \
       --agent claude-code --sprint 2 --tasks B1,B2 --role coder
  ```
  Writes the `.context.md` and prints the payload JSON to stdout. Requires
  `npm run compile` first (reads from `./out`).

### Verified

- Unit tests: `src/test/intelligence-contextpack.test.ts` (assembly, single-H1
  fence-aware demotion, payload summary, degraded propagation, KG cap/empty,
  KG-throw resilience).
- End-to-end: the CLI against this repo's real index returned 5 code chunks + 4
  learnings and wrote a clean pack (one H1; embedded `agent-style.md`'s `#`
  heading correctly demoted; code-fence `#` comments preserved).

## Channel B — MCP `intelligence.contextPack` tool (shipped)

On-demand pull for MCP runners (Claude Code, Kiro, Cursor, …). Registered in
`src/mcp/tools.ts` `READ_ONLY_TOOLS` as a read-only tool: it computes and
returns `{ markdown, summary, ... }` but writes nothing (file-writing stays with
Channel A). Degrade-safe. Input: `task` (required) + optional `agent`, `sprint`,
`role`, `task_ids`, `max_*`. Tests: `src/test/intelligence-toolscaffold.test.ts`
+ the tool-list assertion in `src/test/mcp.test.ts`.

## Orchestrator auto-hook (shipped)

The work-loop dispatcher (`src/orchestratorLoop.ts`) now grounds every dispatched
agent:

- `buildWorkLoopPrompt` always emits a **"Grounding — Context Pack"** section. If
  a pack was generated it says *read this file first*; otherwise it tells the
  agent to pull one via the `intelligence.contextPack` MCP tool or the CLI.
- `dispatchWork(.., { generateContextPack: true })` best-effort builds + writes
  `.autoclaw/orchestrator/sprints/<taskId>.context.md` and sets
  `pkg.contextPackPath`. Failures are journaled (`context_pack_failed`), never
  block dispatch. `runTick` enables this on the production loop.

## Proposed next channels

- **Channel C — per-host `CONTEXT.md`.** Generate a refreshed context file into
  each host's adapter dir (like `scripts/build-adapters.ts`) so file-only
  runners get *current* project intel even outside an orchestrated task.
- **Channel D — HTTP bridge `/a2a/context`.** Serve the pack to remote /
  cross-machine agents; advertise in the Agent Card extension fields.

## Notes / gotchas

- **Embeddings on a fresh machine.** The in-process transformers provider
  (`Xenova/nomic-embed-text-v1.5`) needs its model downloaded once (Hugging Face
  access). If that's blocked, the layer degrades to the `none` provider
  (deterministic hashed vectors, lower retrieval quality) — packs still build.
  Use `AutoClaw: Intelligence — Set Embedding Provider` to pick Router/Ollama/
  offline, then `Index Codebase --force`.
- **Stale index after a provider switch.** Changing the embedding provider/model
  changes the signature; the existing index is flagged stale until a
  `/index-code --force` reindex. Don't switch providers without planning the
  reindex.
