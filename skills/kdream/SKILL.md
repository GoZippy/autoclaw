---
name: kdream
description: Persistent always-on background agent with automatic memory consolidation. Trigger on "start background agent", "enable kdream", "/kdream start", "persistent daemon", or "auto-dream memory".
---

# KDream — Persistent Background Agent

## On Invocation

Determine the sub-command from the user's message:

- `start` / no sub-command → **Start the daemon**
- `ps` / `status` → **Report status**
- `logs` → **Show recent log entries**
- `stop` / `kill` → **Shut down**
- `dream` → **Run an autoDream cycle now**
- `add <note>` → **Add a task or note to MEMORY.md**
- `todo` → **List all open TODO/FIXME items found in workspace**
- `work <item>` → **Actively work on a specific TODO or follow-up item**

---

## start — Launch Daemon

1. Create directories if missing:
   ```
   .autoclaw/kdream/logs/
   .autoclaw/kdream/memory/
   ```
2. Write `.autoclaw/kdream/state.json`:
   ```json
   { "status": "running", "started": "<ISO timestamp>", "tick": 0, "lastDream": null }
   ```
3. Create `.autoclaw/kdream/memory/MEMORY.md` if missing with this structure:
   ```markdown
   # KDream Memory
   
   ## Follow-ups
   <!-- KDream checks this section on every tick. Add tasks here. -->
   
   ## Facts
   <!-- Consolidated knowledge about this workspace. -->
   
   ## Observations
   <!-- Notable events and patterns observed over time. -->
   ```
4. Append to today's log (`.autoclaw/kdream/logs/YYYY-MM-DD.md`):
   ```
   [HH:MM:SS] KDream started. Workspace: <cwd>
   ```
5. Run the first **tick** immediately.
6. Inform the user: "KDream is running. Add tasks to `.autoclaw/kdream/memory/MEMORY.md` under `## Follow-ups`, or use `/kdream add <note>`. Use `/kdream ps` for status."

---

## Tick Cycle

On each tick:

### 1. Check git status
If a git repo exists: run `git status` and `git log --oneline -5`.
- If there are uncommitted changes older than 1 hour: log `[WARN] Stale uncommitted changes: <files>` and notify user.
- If recent commits exist: log them silently.

### 2. Scan TODO/FIXME items
Glob all source files for lines matching `TODO`, `FIXME`, `HACK`, `XXX`, `BUG`.
- For each match: record file path, line number, and comment text.
- Compare against previous tick's list (stored in `state.json` under `"todos"`).
- New items since last tick → log `[NEW TODO] <file>:<line> — <text>` and notify user.
- Resolved items (present last tick, gone now) → log `[RESOLVED] <file>:<line>` and update memory.
- Update `state.json` with current todo list.

### 3. Check MEMORY.md follow-ups
Read `.autoclaw/kdream/memory/MEMORY.md`, find all lines under `## Follow-ups`.
- Lines starting with `- [ ]` are open tasks → report them to the user if any exist.
- Lines starting with `- [x]` are done → move to `## Observations` during next autoDream.
- If the user asks KDream to act on a follow-up: work on it, then mark `- [x]`.

### 4. Decide and act
- If ≥1 notification-worthy item: surface a concise summary to the user with options to act.
- If nothing notable: append a silent heartbeat to log only. Do not disturb the user.

### 5. Update state
Increment `tick` in `state.json`. Save current todo list snapshot.
If `tick % 20 == 0` or last dream >24h ago → trigger **autoDream**.

---

## add — Add a Follow-up

When the user runs `/kdream add <note>`:
1. Append `- [ ] <note>` under `## Follow-ups` in `MEMORY.md`.
2. Confirm: "Added to KDream follow-ups: `<note>`"

This is the fastest way to give KDream something to watch or act on.

## todo — List Open Items

1. Read current `todos` array from `state.json`.
2. Read open `- [ ]` items from `MEMORY.md ## Follow-ups`.
3. Report both lists clearly, grouped by source (code TODOs vs manual follow-ups).

## work — Act on an Item

When the user runs `/kdream work <item description or number>`:
1. Identify the matching TODO/FIXME or follow-up item.
2. Read the relevant file(s) and context.
3. Implement or resolve the item using available tools.
4. Mark the follow-up as `- [x]` in `MEMORY.md` or confirm the code change.
5. Log the action taken.

---

## ps — Status

Read `.autoclaw/kdream/state.json` and report:
- Running / stopped, start time, tick count, last dream timestamp
- Number of open TODOs tracked
- Number of open follow-ups in MEMORY.md
- Last log entry

## logs — Show Logs

Read the last 30 lines of today's log at `.autoclaw/kdream/logs/YYYY-MM-DD.md`.

## stop — Shutdown

1. Update `state.json`: `{ "status": "stopped", "stopped": "<ISO timestamp>" }`
2. Append to log: `[HH:MM:SS] KDream stopped.`
3. Confirm to user.

---

## autoDream Cycle (Memory Consolidation)

Triggered automatically (tick % 20 or 24h elapsed) or via `/kdream dream`.

### Phase 1 — Orient
List all files in `.autoclaw/kdream/memory/`. Note current MEMORY.md line count.

### Phase 2 — Gather
Read last 7 days of log files. Extract:
- `[NEW TODO]` entries → add to Facts if not already there
- `[RESOLVED]` entries → move matching Follow-ups to Observations
- `[WARN]` entries → surface any recurring patterns

### Phase 3 — Consolidate
- Merge gathered items into appropriate MEMORY.md sections.
- Remove contradictions (keep newer fact).
- Convert relative dates to absolute ISO dates.
- Deduplicate identical entries.
- Move `- [x]` completed follow-ups from Follow-ups to Observations.

### Phase 4 — Prune
If MEMORY.md exceeds 200 lines or 25KB:
- Archive oldest 20% of Observations to `.autoclaw/kdream/memory/archive-YYYY-MM-DD.md`.
- Remove them from MEMORY.md.

### Phase 5 — Finalize
Update `state.json` `"lastDream"`. Append: `[HH:MM:SS] autoDream complete. Memory: <N> lines.`
