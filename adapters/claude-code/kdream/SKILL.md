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
- `routing` → **Show current routing status and ZMLR health**

---

## Routing Context (read on every tick)

Before starting any tick or long-running operation, check routing health:

1. Read `.autoclaw/routing/stats.jsonl` last 5 lines (if exists) for recent errors.
2. Check if `.autoclaw/routing/reroute-kdream-main.md` exists → if it does AND contains no `[REROUTE COMPLETE]`, read it and follow its instructions before proceeding.
3. If you encounter a `fetch failed`, `429`, or `ECONNREFUSED` error during any LLM call:
   - Immediately append `[RATE_LIMIT: <model_id>]` to the reroute file (or create it).
   - Log `[ROUTE_FAIL] <error> at <timestamp>` in today's kdream log.
   - Wait 30 seconds, then retry using the fallback model listed in the reroute playbook.
   - If no reroute playbook exists, use the ZippyMesh LLM Router at `http://localhost:20128/v1/chat/completions` as the universal fallback.

**ZMLR Universal Fallback:** When any direct provider call fails, route through ZMLR:
```
POST http://localhost:20128/v1/chat/completions
{ "model": "auto", "messages": [...], "stream": false }
```
ZMLR will select the best available provider automatically.

---

## start — Launch Daemon

1. Create directories if missing:
   ```
   .autoclaw/kdream/logs/
   .autoclaw/kdream/memory/
   .autoclaw/routing/
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

### 1. Check routing health
Read reroute playbook if present. Apply model switch if instructed.

### 2. Check git status
If a git repo exists: run `git status` and `git log --oneline -5`.
- If there are uncommitted changes older than 1 hour: log `[WARN] Stale uncommitted changes: <files>` and notify user.
- If recent commits exist: log them silently.

### 3. Scan TODO/FIXME items
Glob all source files for lines matching `TODO`, `FIXME`, `HACK`, `XXX`, `BUG`.
- For each match: record file path, line number, and comment text.
- Compare against previous tick's list (stored in `state.json` under `"todos"`).
- New items since last tick → log `[NEW TODO] <file>:<line> — <text>` and notify user.
- Resolved items (present last tick, gone now) → log `[RESOLVED] <file>:<line>` and update memory.
- Update `state.json` with current todo list.

### 4. Check MEMORY.md follow-ups
Read `.autoclaw/kdream/memory/MEMORY.md`, find all lines under `## Follow-ups`.
- Lines starting with `- [ ]` are open tasks → report them to the user if any exist.
- Lines starting with `- [x]` are done → move to `## Observations` during next autoDream.
- If the user asks KDream to act on a follow-up: work on it, then mark `- [x]`.

### 5. Decide and act
- If ≥1 notification-worthy item: surface a concise summary to the user with options to act.
- If nothing notable: append a silent heartbeat to log only. Do not disturb the user.

### 6. Update state
Increment `tick` in `state.json`. Save current todo list snapshot.
If `tick % 20 == 0` or last dream >24h ago → trigger **autoDream**.

---

## work — Act on an Item with Critique Loop

When the user runs `/kdream work <item description or number>`:

### Step 1 — Research (small model ok)
Identify the matching TODO/FIXME or follow-up item.
Read the relevant file(s) and context.

### Step 2 — Implement
Implement or resolve the item using available tools.
Write initial solution.

### Step 3 — Self-critique (recursive if using a local/free model)
If the current model tier is `local` or `free`:
- Review your own implementation against these criteria:
  1. Does it compile/run without errors?
  2. Does it handle edge cases?
  3. Is it secure (no injection, no hardcoded secrets)?
  4. Is it minimal — no unnecessary complexity?
- Score each criterion 0-2. If total < 6, revise and repeat (max 3 iterations).

### Step 4 — Final review gate
If the item is marked `[priority: high]` or the implementation touches security/auth/payments:
- Summarize the change in `.autoclaw/kdream/review-queue.md` with the format:
  ```
  ## Review Request — <item> — <timestamp>
  **Change:** <one paragraph>
  **Risk areas:** <bullet list>
  **Awaiting:** SOTA model review
  ```
- Log `[REVIEW_QUEUED] <item>` and notify user.

### Step 5 — Complete
Mark the follow-up as `- [x]` in `MEMORY.md` or confirm the code change.
Log the action taken.

---

## routing — Show Routing Status

Report:
- ZMLR availability (try HEAD http://localhost:20128)
- Current model in use
- Recent rate-limit events from `.autoclaw/routing/stats.jsonl`
- Any pending reroute playbooks
- Sessions tracked by the healer

---

## ps — Status

Read `.autoclaw/kdream/state.json` and report:
- Running / stopped, start time, tick count, last dream timestamp
- Number of open TODOs tracked
- Number of open follow-ups in MEMORY.md
- Last log entry
- Active routing: model name, ZMLR status

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
- `[ROUTE_FAIL]` entries → summarize provider health issues in Facts
- `[REVIEW_QUEUED]` entries → check if review was completed, remove if so

### Phase 3 — Consolidate
- Merge gathered items into appropriate MEMORY.md sections.
- Remove contradictions (keep newer fact).
- Convert relative dates to absolute ISO dates.
- Deduplicate identical entries.
- Move `- [x]` completed follow-ups from Follow-ups to Observations.

### Phase 4 — SOTA Final Review (if review-queue.md has pending items)
If `.autoclaw/kdream/review-queue.md` has unreviewed items:
1. Collect all `## Review Request` blocks not yet marked `[REVIEWED]`.
2. Route each through ZMLR with `model: "openrouter/anthropic/claude-opus-4-6"` or `"auto"` with high quality preference.
3. Write the review outcome back to review-queue.md as `**SOTA Review:** <verdict>`.
4. If issues found: create a new follow-up `- [ ] [priority: high] Fix: <issue>`.
5. Mark the request `[REVIEWED]`.

### Phase 5 — Prune
If MEMORY.md exceeds 200 lines or 25KB:
- Archive oldest 20% of Observations to `.autoclaw/kdream/memory/archive-YYYY-MM-DD.md`.
- Remove them from MEMORY.md.
- Compress archived content to key facts only (one sentence per item).

### Phase 6 — Finalize
Update `state.json` `"lastDream"`. Append: `[HH:MM:SS] autoDream complete. Memory: <N> lines.`

---

## Error Handling & Self-Healing

If any operation fails with a network/fetch error:
1. Log `[ERROR] <operation>: <message>` to today's log.
2. Append `[RATE_LIMIT: <model_id_if_known>]` to `.autoclaw/routing/reroute-kdream-main.md`.
3. Retry after 30s via ZMLR universal fallback (`http://localhost:20128`).
4. After 3 consecutive failures, set `state.json` status to `"degraded"` and notify user with healing suggestion.
