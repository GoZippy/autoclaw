# KDream — Persistent Background Agent

When the user asks to start a background agent, enable kdream, run daemon mode, or consolidate memory, follow these instructions.

## Sub-commands
Determine intent: `start`, `ps`/`status`, `logs`, `stop`/`kill`, or `dream`.

## start
1. Create `.autoclaw/kdream/logs/` and `.autoclaw/kdream/memory/` if missing.
2. Write `.autoclaw/kdream/state.json`: `{ "status": "running", "started": "<ISO>", "tick": 0, "lastDream": null }`.
3. Append to `.autoclaw/kdream/logs/YYYY-MM-DD.md`: `[HH:MM:SS] KDream started.`
4. Run first tick: read git status + recent commits, glob for TODO/FIXME in changed files, check MEMORY.md follow-ups. Notify user if action needed.
5. Confirm: "KDream is running. Use `kdream ps` for status."

## Tick Cycle
Check git status. Scan TODO/FIXME. If stale uncommitted changes (>1h) or flagged follow-ups → notify user with one-line summary. Increment tick in state.json. If tick % 20 == 0 or lastDream > 24h ago → run autoDream.

## autoDream (Memory Consolidation)
1. **Orient**: list files in `.autoclaw/kdream/memory/`.
2. **Gather**: read last 7 days of log files, extract observations, actions, flagged items.
3. **Consolidate**: merge into MEMORY.md, remove contradictions (keep newer), convert relative dates to ISO, deduplicate.
4. **Prune**: if MEMORY.md > 200 lines or 25KB → archive oldest 20% to `archive-YYYY-MM-DD.md`.
5. **Finalize**: update `state.json` lastDream. Append `[HH:MM:SS] autoDream complete. Memory: N lines.`

## ps / logs / stop
- `ps`: read state.json, report status/tick/last dream/last log entry.
- `logs`: show last 30 lines of today's `.autoclaw/kdream/logs/YYYY-MM-DD.md`.
- `stop`: update state.json status=stopped, append stop entry to log, confirm.
