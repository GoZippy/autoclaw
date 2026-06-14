# `src/intelligence/` — AutoClaw Intelligence Layer

Local-first module that learns from past AI coding sessions (any tool +
AutoClaw's own logs), does RAG over the real codebase, and cuts token waste.

This directory is the **Phase 0 foundation**: a behavior-neutral skeleton. It
compiles and is exercised by unit tests, but it is **not wired into the extension
activation path** and registers **no commands or views**. Feature behavior lands
in later specs.

## Boundary map (what lands where)

| File | Phase 0 (now) | Filled by later specs |
|------|---------------|------------------------|
| `types.ts` | All contracts declared: `IntelligenceConfig`, `UnifiedSession`, `SourceAdapter`, `LearnedMemory`, `MemoryKind`. | Implementations consume these unchanged. |
| `config.ts` | `DEFAULT_CONFIG`, `loadConfig`, `getActiveEmbeddingSignature`. | Dimension-mismatch guard (Phase 4) uses the signature. |
| `paths.ts` | `.autoclaw/` contract resolver + `ensureDir`. | Stores/metrics/history writers use these paths. |
| `fileLock.ts` | `acquireLock` (atomic mkdir). | Stale-lock cleanup refinement (Phase 6). |
| `index.ts` | Barrel export. | — |
| `learn.ts` *(planned)* | — | core-loop: orchestrates ingest → distill → store. |
| `vectorEngine.ts` *(planned)* | — | core-loop: sqlite-vec store; refactors to `vector/` in Phase 4. |
| `embeddings.ts` *(planned)* | — | core-loop: transformers / ollama / none providers. |
| `ragCode.ts` *(planned)* | — | core-loop: chunk + embed + retrieve over the codebase. |
| `sources/` *(planned)* | — | universal-ingestion: one `SourceAdapter` per tool. |
| `metrics/` *(planned)* | — | metrics-dashboard. |

## Conventions

- **No `vscode` import** in this tree. Pure logic, unit-testable outside the
  extension host (mirrors `src/kg.ts` and `src/skills/`). Callers inject a
  logger (`log(msg)`) instead of using `console`.
- **Forward slashes** in every emitted path.
- **File tools, not shell**, for directory/file creation; `ensureDir` is
  idempotent.
- **Reuse, don't fork** the existing AutoClaw subsystems: `src/memory`,
  `src/llm` (cost ledger), `src/statusbar`, `src/chatparticipant.ts`,
  `src/runners`, `src/mcp`, and the `autoclaw-kdream` activity-bar container.
- **Local-only**; third-party ingestion is opt-in; redact secrets/PII before
  embed/store/log (enforced in later specs, declared here).

## On-disk contract (`.autoclaw/`)

Created lazily (never on activation):

```
.autoclaw/
  vector/
    config.json        # the single configuration surface
    db.sqlite          # sqlite-vec store (gitignored)
    last-index.json    # incremental index watermark
  learnings/           # distilled learnings
  metrics/             # token/usage metrics
  history/             # per-source extraction watermarks (gitignored)
  .locks/              # advisory file locks (gitignored)
  kdream/memory/MEMORY.md   # owned by KDream — appended, never overwritten
```

## Native dependency strategy

The vector/embedding backends (`better-sqlite3`, `sqlite-vec`,
`@xenova/transformers`, optional `pg`) follow the `packages/kg-daemon`
native-peer model: declared as exact-pinned `optionalDependencies`, excluded
from the packaged `.vsix`, and **lazy-required only when a vector backend is
actually used**. The `embedding.provider = 'none'` + no-vector path is always
available and requires no native modules, so the extension never fails to
activate. See the spec completion notes and
`docs/planning/07-open-questions-and-decisions.md` (R1).
