---
inclusion: manual
name: kdream
description: KDream persistent background agent with memory consolidation. Reference with #kdream when asking to start a background agent, run daemon mode, or consolidate memory.
---

# KDream — Persistent Background Agent

When the user invokes kdream, determine the sub-command: `start`, `ps`/`status`, `logs`, `stop`, or `dream`.

## start
1. Create `.autoclaw/kdream/logs/` and `.autoclaw/kdream/memory/` directories.
2. Write `.autoclaw/kdream/state.json`: `{ "status": "running", "started": "<ISO>", "tick": 0, "lastDream": null }`.
3. Append start entry to `.autoclaw/kdream/logs/YYYY-MM-DD.md`.
4. Run first tick: check git status, scan TODO/FIXME, review MEMORY.md follow-ups. Notify if action needed.
5. Confirm: "KDream is running."

## Routing (each tick)
Check `.autoclaw/routing/reroute-kdream-main.md` for pending switch. On `fetch failed`/`429`: append `[RATE_LIMIT: <model>]` to reroute file, retry via ZMLR `POST http://localhost:20128/v1/chat/completions { "model": "auto", "messages": [...] }`.

## Tick Cycle
Check routing health. Then: check git status + recent commits. Glob for TODO/FIXME in recently changed files. If stale uncommitted changes or flagged follow-ups → notify user. Increment tick; if tick % 20 == 0 or 24h elapsed → autoDream.

## autoDream
1. Orient: list memory files.
2. Gather: read last 7 days of logs, extract observations.
3. Consolidate: merge into MEMORY.md, remove contradictions, convert dates to ISO, deduplicate.
4. Prune: if > 200 lines or 25KB → archive oldest 20%.
5. Finalize: update lastDream in state.json.

## ps / logs / stop
- `ps`: read state.json, report status/tick/last dream.
- `logs`: show last 30 lines of today's log.
- `stop`: set status=stopped, append stop entry.
