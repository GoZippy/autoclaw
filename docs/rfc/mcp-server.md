# RFC: `autoclaw-mcp` Server

_Status: draft, 2026-05-19. Owner: Workstream B+ of [V3_PLAN.md](../V3_PLAN.md)._

## 1. Why this exists

Every host AutoClaw cares about speaks the Model Context Protocol with the
same `mcpServers` JSON shape. That makes MCP a universal in-tool interop
surface: an agent on Claude Code, Cursor, Kiro, or Antigravity can call
into AutoClaw _during_ a session — read fleet status, look up a memory,
claim a task — without going through the file-based inbox bus.

The file-based bus stays authoritative for **durability** (every
write hits disk and a ledger). MCP is the **in-tool reader** that lets
sessions stay context-aware without polling files themselves.

The user-visible payoff: one command (`autoclaw mcp install`) wires the
AutoClaw MCP server into every detected host. After that, any agent on
the machine can say "what's the fleet doing right now?" and get a real
answer.

## 2. Transport

**stdio** only for v3.0.

- Universally supported (Claude Code, Cursor, Kiro, Antigravity, Gemini
  CLI, Continue, Cline, Windsurf).
- No network surface; auth is implicit (whoever can read the
  workspace can read AutoClaw state).
- Server lifecycle managed by the host — no AutoClaw-side daemon
  required for MCP.

SSE / HTTP transport deferred to v3.x when the cloud relay (Workstream
D) wants to expose the same tool set remotely.

## 3. Tool surface

Split into **read-only** (ship in 3.0) and **write** (gated behind a
config flag, ship later in 3.0 or 3.1 depending on testing).

### 3.1 Read-only tools

| Tool | Parameters | Returns |
|---|---|---|
| `recall.query` | `{ query: string; topK?: number; tier?: "core" \| "recall" \| "archive"; asOf?: ISO8601 }` | `[{ fact: string; source: string; valid_from: ISO8601; recorded_at: ISO8601; score: number }]` |
| `recall.timeline` | `{ subject: string }` | bi-temporal history of a fact (when did it become true, when was it recorded, supersessions) |
| `fleet.status` | `{ scope?: "workspace" \| "program" }` | `[{ agent: string; sessionId: string; host: string; lastHeartbeat: ISO8601; status: "idle" \| "working" \| "stalled" \| "dead"; currentTask?: string }]` |
| `fleet.cards` | `{}` | richer per-agent cards: capabilities, scope, recent messages, parent/subagents |
| `inbox.read` | `{ agent?: string; unread?: boolean; awaiting_me?: boolean }` | list of messages; defaults to caller's session if `agent` omitted |
| `todo.list` | `{ filter?: "open" \| "all"; classify?: boolean }` | TODO/`AI:` items from the spider with priority and age |
| `doctor.run` | `{}` | structured doctor report (same shape as `AutoClaw: Doctor (JSON)`) |
| `artifact.list` | `{ kind?: "plan" \| "diff" \| "screenshot" \| "recording" \| "test_result"; sinceSprintId?: string }` | known artifacts in `.autoclaw/artifacts/` |
| `program.repos` | `{}` | list of repos in the program-scope registry (cross-repo workflows) |

All read tools must complete in < 250 ms for cached data; `recall.query`
can take up to 2 s when crossing into archive tier.

### 3.2 Write tools (gated, ship after read suite stabilizes)

| Tool | Parameters | Effect |
|---|---|---|
| `note.add` | `{ text: string; tags?: string[] }` | Append to `.autoclaw/dream/MEMORY.md` Follow-ups section. `/dream` later promotes to consolidated facts. |
| `inbox.send` | `{ to: string; type: string; body: object; requires_response?: boolean }` | Write a message to the recipient's inbox. Idempotent: caller supplies `client_id`, server dedupes. |
| `inbox.archive` | `{ msg_id: string }` | Move to `processed/`, update `_state/`. |
| `claim.task` | `{ task_id: string; sprint_id?: string }` | Atomic claim with contention check (matches the file-side `claim_token` protocol). |
| `dream.run` | `{ now?: boolean }` | Trigger a `/dream` cycle out-of-band. Returns when consolidation completes. |
| `consensus.vote` | `{ task_id: string; vote: "approve" \| "reject" \| "request_changes"; findings?: Finding[] }` | Cast a consensus vote; mirrors today's `consensus/active/<task_id>-<agent>.json`. |

Write tools require:

- Workspace-scoped MCP server (not user-global) — see §5.
- `autoclaw.mcp.allowWrites = true` in workspace config.
- Every write produces a corresponding entry in
  `.autoclaw/orchestrator/state.json` ledger keyed by `msg.id`.

## 4. Auth and identity

stdio = no auth challenge. Identity comes from two sources:

1. **Caller's working directory** — the host launches the MCP server
   with `cwd` set to the workspace; AutoClaw uses that to scope reads
   and writes.
2. **Caller's session ID** — passed via an explicit `_session` parameter
   on tools where it matters (`inbox.read` defaulting to caller's
   session). Hosts that don't expose session IDs get a synthetic one
   based on stdio pipe identity.

This is intentionally weaker than the cloud-relay auth (Workstream D),
which uses personal access tokens. Local stdio assumes the workspace
is a trust boundary; if you can read the workspace, you can read its
AutoClaw state.

## 5. Scoping

Two install modes:

| Mode | Where | When to use |
|---|---|---|
| **Workspace** (recommended default) | Each host's per-workspace MCP config | Project-specific state; write tools allowed |
| **User-global** | Each host's user MCP config | Cross-project recall queries; read-only by default |

The `autoclaw mcp install` command installs in workspace mode unless
`--global` is passed. The MCP server discovers which mode it's running
in via cwd vs HOME and adjusts the tool surface (write tools only in
workspace mode).

## 6. The `autoclaw mcp install` writer

Single command that updates every detected host's MCP registry in
one shot. Idempotent. Reports what got wired.

### 6.1 Detection

Same logic as `autoclaw doctor`'s adapter detection. A host counts as
"installed" if its CLI is on `$PATH` _or_ its app config dir exists.

### 6.2 Registry write per host

| Host | Path | Action |
|---|---|---|
| Claude Code | `~/.claude/settings.json` (user) or `.claude/settings.json` (workspace) | Merge `mcpServers.autoclaw` |
| Cursor | `~/.cursor/mcp.json` | Merge `mcpServers.autoclaw` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | Merge `mcpServers.autoclaw` |
| Kiro | _(no direct file edit)_ | Run `kiro-cli mcp add --name autoclaw --command node --args <path-to-autoclaw-mcp> [--scope workspace\|global]` |
| Gemini CLI (non-Antigravity) | `~/.gemini/settings.json` | Merge `mcpServers.autoclaw` |
| Continue | `~/.continue/config.json` | Merge per Continue's MCP schema |
| Cline | `~/.cline/mcp_settings.json` (TBD: confirm path) | Merge |
| Windsurf | `~/.windsurf/mcp_config.json` (TBD: confirm path) | Merge |

### 6.3 Standard server entry

What gets written into `mcpServers.autoclaw` for stdio hosts:

```json
{
  "command": "node",
  "args": ["<absolute-path>/out/mcp/server.js"],
  "env": {
    "AUTOCLAW_MCP_SCOPE": "workspace"
  }
}
```

The `<absolute-path>` is resolved at install time to the running
AutoClaw extension's `out/` directory. If the extension moves, the
user re-runs `autoclaw mcp install` (or the doctor flags it). Future:
ship `autoclaw-mcp` as a published npm package so `npx -y autoclaw-mcp`
works everywhere and `command: "npx"` is portable.

### 6.4 Idempotency

The writer:

1. Reads existing config.
2. If `mcpServers.autoclaw` exists with the same `command` and `args`,
   no-op and report `unchanged`.
3. If it exists with different values, prompt before overwriting
   (unless `--force`).
4. If absent, add it and report `added`.
5. Preserves all other servers and unknown keys (round-trip safe).

### 6.5 Report format

```
$ autoclaw mcp install
Detected hosts:
  claude-code  ✓  added       ~/.claude/settings.json
  cursor       ✓  added       ~/.cursor/mcp.json
  antigravity  ✓  unchanged   ~/.gemini/antigravity/mcp_config.json
  kiro         ✓  added       (via kiro-cli mcp add)
  continue     -  not installed
  cline        -  not installed
  windsurf     -  not installed
  gemini-cli   -  not installed (no separate Gemini CLI; using Antigravity entry)

3 hosts wired, 1 already present, 4 not detected.
Restart your chat sessions for the changes to take effect.
```

## 7. Lifecycle and configuration

The MCP server is spawned by each host on demand (host owns the
process). It must:

1. Start in < 500 ms cold.
2. Tolerate concurrent invocations from multiple hosts (each host
   spawns its own subprocess).
3. Treat the file-based bus as authoritative — if a tool can't reach
   `.autoclaw/orchestrator/state.json`, return an error rather than
   serve stale cached data.
4. Honor `AUTOCLAW_MCP_SCOPE` env: `workspace` enables write tools;
   `global` (or absent) restricts to read-only.
5. Log to `.autoclaw/mcp/log/<host>-<pid>.log` with rotation at 1 MB.

## 8. Telemetry

Each tool invocation logs to the cost ledger:

```json
{ "ts": "...", "tool": "recall.query", "host": "kiro", "session": "...",
  "duration_ms": 47, "result_size_bytes": 1340, "cache_hit": true }
```

Rolled up into `fleet.cards` so users can see "Kiro hit AutoClaw 240
times in the last hour, p50 31ms, 92% cache hits."

## 9. Open issues

1. **Path resolution** for the server `args` — absolute paths break
   if the user moves the extension; npx fixes it but adds a startup
   cost. Recommendation: publish `autoclaw-mcp` as a separate npm
   package once read tools stabilize.
2. **Cline / Windsurf MCP config paths** — verified-TBD.
3. **`recall.timeline`** depends on bi-temporal facts (C.4) being
   wired up. Ship `recall.query` first; add `timeline` after C.4 lands.
4. **`artifact.list`** depends on Artifact schema (C+.1). Ship as
   stub returning empty list until then.
5. **`program.repos`** depends on program scope (C.14). Same — stub.
6. **Write-tool authorization beyond `allowWrites = true`** — should
   `inbox.send` require an explicit per-tool allow list? Possible
   v3.1 feature; v3.0 ships with the single boolean.
7. **Resource exposure** — MCP supports `resources/` alongside
   `tools/`. We could surface `MEMORY.md`, `state.json`, and recent
   artifacts as readable resources. Defer to 3.1; not blocking.
