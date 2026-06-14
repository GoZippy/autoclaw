---
inclusion: auto
name: intelligence
description: Local-first intelligence layer that learns from past AI coding sessions, does RAG over your codebase, and cuts token waste. Trigger on "learn from my sessions", "index my code", "retrieve context", "/learn", "/index-code", "/retrieve", or "intelligence layer".
---

# AutoClaw Intelligence — Learning & Retrieval Layer

A local-first "second brain" for AutoClaw. It ingests past AI coding sessions
from any tool (plus AutoClaw's own logs), distills what was kept vs. discarded,
indexes your real codebase, and serves that context back to cut token waste.

> **Status: core loop implemented.** The module skeleton, configuration, on-disk
> contract, and packaging are in place, and the four core-loop commands `/learn`,
> `/index-code`, `/retrieve`, and `/search` are now **implemented** and wired into
> activation and the `@autoclaw` chat surface. The remaining commands below are
> still **not yet implemented** and arrive in later phases. This skill documents
> the full planned surface so the capability stays discoverable. Do not claim a
> command ran when it is marked *Planned*; say it is not available yet.

## Operating Rules (read before any sub-command)

1. **Use file tools, not shell, for directories and files.** Create folders and
   files with the host's file/write tool (e.g. Write, create_file, edit_file). Do
   NOT use `mkdir -p`, `touch`, `New-Item`, or shell redirection — they fail
   across the Bash/PowerShell/cmd.exe mix you may be running on. If you must shell
   out, detect the platform first.
2. **Always use forward slashes in paths** (e.g. `.autoclaw/vector/config.json`).
   Node, git, and every supported shell accept them.
3. **Be idempotent.** Creating a contract directory that already exists is a
   no-op. Never overwrite `.autoclaw/kdream/memory/MEMORY.md` or
   `preferences.json` — append or merge only.
4. **Output discipline.** When confirming an action, output ≤3 short lines: what
   was done, current counts, next step. Do not narrate your reasoning, repeat
   headings, or invent style rules. No emojis unless the user asked.
5. **Never invent files, sessions, learnings, or metrics.** Only report what you
   actually read from disk. If a store is empty or a command is unimplemented,
   say so plainly.
6. **Local-only and consent-first.** Third-party session sources are opt-in;
   AutoClaw-native logs are on by default. Redact secrets/PII before embedding,
   storing, or logging.

## On Invocation

Determine the sub-command from the user's message and route to the matching
section. If the command is marked *Planned*, tell the user it is not implemented
yet and point to what foundation provides (config + on-disk contract).

## Command surface

| Command | Status | Purpose |
|---------|--------|---------|
| `/learn` | Implemented (core-loop) | Sweep discovered sessions, distill kept-vs-discarded learnings, write stores. Args: `--last N` (limit to the most recent N sessions), `--focus "area"` (bias distillation toward a topic). Output: counts of sessions swept and learnings written. |
| `/index-code` | Implemented (core-loop) | Chunk + embed the workspace codebase into the vector store. Args: `--force` (re-index everything, ignoring the last-index watermark). Output: files indexed and chunk count. |
| `/retrieve` | Implemented (core-loop) | Retrieve the most relevant code/learning chunks for a query. Usage: `/retrieve <query>`. Output: the top matching chunks with their source paths. |
| `/search` | Implemented (core-loop) | Semantic search over distilled learnings. Usage: `/search <query> [--limit N]` (cap results at N). Output: ranked learnings with scores. |
| `/sources` | Planned (universal-ingestion) | List every discovered session source, its tier, availability, and enabled state. |
| `/scaffold` | Planned (core-loop) | Create the `.autoclaw/` contract dirs and a default `vector/config.json`. |
| `/rag-generate` | Planned (signal-and-rag) | Build a RAG prompt from retrieved context. |
| `/metrics` | Planned (metrics-dashboard) | Show token usage, savings, and learning counts. |
| `/service` | Planned (automation-reach) | Run the continuous watch service that ingests new sessions as they land. |

## Configuration

Single configuration surface at `.autoclaw/vector/config.json`. When absent, the
layer uses validated defaults without writing a file:

- `backend`: `sqlite-vec` (default) or `postgres`.
- `embedding`: provider `transformers` (default, `Xenova/nomic-embed-text-v1.5`,
  768-dim), `ollama`, or `none`. The `none` provider is the always-available
  degraded fallback that needs no native modules.
- `rag`, `search`, `tokenLogging`, and per-`sources` enablement.

Invalid fields fall back to their default with a warning rather than failing.

## On-disk contract

The layer owns only paths under `.autoclaw/` and never collides with `.cursor/`,
`CLAUDE.md`, or other tools:

```
.autoclaw/vector/      config.json, db.sqlite, last-index.json
.autoclaw/learnings/   distilled learnings
.autoclaw/metrics/     token/usage metrics
.autoclaw/history/     per-source extraction watermarks
.autoclaw/.locks/      advisory file locks
.autoclaw/kdream/memory/MEMORY.md   owned by KDream — appended, never overwritten
```

Generated data (`db.sqlite`, `.locks/`, `history/`) is gitignored.

## Reuse, don't fork

This layer builds on existing AutoClaw subsystems rather than duplicating them:
`src/runners` for session discovery, `src/llm` (cost ledger) for token logging,
`src/memory` for memory records, `src/mcp` for retrieval exposure, and the
`autoclaw-kdream` activity-bar container for any UI. Learnings feed the KDream
dream pipeline.
