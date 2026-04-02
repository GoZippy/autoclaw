---
name: kdream
description: KDream persistent background agent with memory consolidation. Activate when user asks to start a background agent, run daemon mode, or consolidate memory.
trigger: model_decision
---

# KDream — Persistent Background Agent

Sub-commands: `start`, `ps`/`status`, `logs`, `stop`, `dream`.

## start
1. Create `.autoclaw/kdream/logs/` and `.autoclaw/kdream/memory/`.
2. Write `.autoclaw/kdream/state.json`: `{ "status": "running", "started": "<ISO>", "tick": 0, "lastDream": null }`.
3. Append start entry to `.autoclaw/kdream/logs/YYYY-MM-DD.md`.
4. Run first tick: check git status, scan TODOs, review MEMORY.md follow-ups.
5. Confirm: "KDream is running."

## Tick Cycle
Check git + recent commits. Scan TODO/FIXME in recently changed files. If stale uncommitted work or flagged items → notify user. Increment tick; if tick % 20 == 0 or 24h elapsed → autoDream.

## autoDream
1. List memory files. 2. Read last 7 days of logs. 3. Merge into MEMORY.md, remove contradictions, convert dates. 4. Archive oldest 20% if >200 lines. 5. Update lastDream.

## ps / logs / stop
Read/append state.json and log file accordingly.
