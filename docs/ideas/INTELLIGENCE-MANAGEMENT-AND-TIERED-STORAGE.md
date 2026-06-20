# Intelligence: visibility, storage control, and a two-tier (project + system) model

> AutoClaw design idea — 2026-06-16. Driven by user asks: no visibility into what
> the intelligence layer indexed/learned/saved; want control over WHERE data lives
> (project root, not C:); easy backend install with pre/post customization; a
> local-project + system-wide intelligence that cross-reference and point at each
> other; and tooling to turn the data into steering / MCP / tools.
> Companion to the separate distillation project (memory: session_distillation_new_project).

## Where things stand today (grounding)

- The **vector index already lives in the project root**: `intelligencePaths()` →
  `<workspace>/.autoclaw/vector/db.sqlite` (+ `config.json`, `last-index.json`).
  Learnings/metrics/history are also under `<workspace>/.autoclaw/`. **So project
  data is already project-local — good.** Verified working: 658 files / 7889 chunks
  indexed into a 37.7 MB `db.sqlite` after the node:sqlite + sqlite-vec fix.
- The **one thing on C:** is the `sqlite-vec` native peer installed by
  `autoclaw.intelligence.installBackend` → `context.globalStorage/native` (under
  `%APPDATA%`/C:). That's the drive gripe, and it's the easy win to fix.
- Data the layer ALREADY has but doesn't surface well: index stats (files/chunks/
  stale), learn stats (sessions, patterns, avg-kept-rate, tokens, est-cost — the
  panel shows 1588 sessions / 86 patterns / 51.8% / 61.4M tokens), and the active
  vector driver + remediation (doctor's new "Vector Backend" section).

## A. Storage control (the #1 pain: stop forcing C:)

New settings (all optional; sensible project-local defaults):
- `autoclaw.intelligence.dataDir` — override the per-project data root
  (default `<workspace>/.autoclaw`). Put project stores on any drive.
- `autoclaw.intelligence.backendDir` — where the `sqlite-vec` native peer installs
  (default **per-project** `<dataDir>/native`, **not** C:/globalStorage). The
  install command + the `AUTOCLAW_SQLITE_VEC_DIR` loader read it.
- `autoclaw.intelligence.backend` — `node-sqlite` (default) | `pgvector` | `none`,
  with `autoclaw.intelligence.pg.connectionString` for the pgvector path.

Install UX:
- **Pre-install customization:** the "Install Vector Backend" command first asks
  (or reads settings) WHERE to install + which backend, then installs there.
- **Post-install relocate:** "AutoClaw: Intelligence — Relocate Data" moves an
  existing store to a new dir/drive and rewrites the pointers (atomic copy → swap).
- One-click default + an "Advanced" path for power users.

## B. Visibility & management (the "no visibility" pain)

New command **"AutoClaw: Intelligence — Status / Manage"** + a panel section:
- **Where it lives:** every store path + drive + size (project data dir, backend
  dir, system store).
- **Index:** files, chunks, last-index time, stale count, embedding model/dims.
- **Learn:** sessions ingested, patterns, kept-rate, tokens, est-cost, per-source
  watermarks (which tools, how recent).
- **Backend:** active driver (node-sqlite / better-sqlite3 / pgvector / none) +
  remediation.
- **Controls:** Re-index · Clear index · Clear learnings · Relocate · Open data dir ·
  Export. A search box that runs `retrieveCode`/`search` and shows hits with
  provenance (file, score, source session).

## C. Two-tier intelligence: Local (project) + System (cross-project)

- **Local** (exists): `<workspace>/.autoclaw/` — code RAG + session signals scoped
  to the project.
- **System** (new): a single user-level store at a **user-chosen** dir
  (`autoclaw.intelligence.systemDir`, default e.g. `~/.autoclaw-intelligence` but
  fully relocatable — never silently C:). Holds **generally-useful** knowledge:
  tool-use patterns, environment/OS facts, cross-project conventions, reusable
  workflows.
- **Routing at index/learn time:** classify each learning as project-specific vs
  broadly-useful and write to the right tier. Heuristics: the same pattern seen
  across ≥N projects, generic library/CLI/tool usage, machine/OS/setup facts,
  "how I like things done" preferences → system tier; project APIs, file layout,
  domain logic → local tier.
- **Cross-referencing:** a project↔store registry (the existing beacon/fleet idea
  fits) so the system store knows "project Y has intelligence about X / a tool for
  Z." Retrieval falls back local → system → "see project Y," and can surface
  pointers to other projects' tooling. This is the on-ramp to the distillation
  project (per-project optimized models that cross-reference).

## D. Make use of the data (steering · MCP · tools)

- **Steering generation:** from the index + learnings, generate `CLAUDE.md` /
  steering snippets / RAG-prompt context for any agent (extends the existing
  `ragGenerate`/`scaffold`). "Create steering from intelligence."
- **Per-project MCP server:** generate an MCP server exposing `retrieveCode` /
  `search` over the project's vectors so ANY LLM/agent can query the project's own
  data (AutoClaw already ships MCP infra — wrap the retrieval). Points the
  standardized-adapter/A2A work (docs/ideas/STANDARDIZED-ADAPTER-A2A-PLATFORM.md).
- **Tool/skill generation:** scaffold tools/skills from learned workflow sequences
  (the workflow miner already finds them).
- **Intelligence manifest:** a machine-readable per-project manifest other agents
  discover (what's indexed, what tools/MCP exist, where).

## Suggested phasing

1. **Phase 1 — Storage control + visibility** (highest value, mostly surfacing what
   already exists): the settings above, backend install honoring `backendDir`
   (default project-local, never forced to C:), the Status/Manage command, relocate.
2. **Phase 2 — Two-tier local+system** routing + the project↔store registry +
   local→system retrieval fallback.
3. **Phase 3 — Generation:** steering files, per-project MCP server, tool scaffolds,
   intelligence manifest.
