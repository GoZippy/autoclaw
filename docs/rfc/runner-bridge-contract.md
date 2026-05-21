# RFC: Runner / Bridge Contract

_Status: draft, 2026-05-19. Owner: Workstream B of [V3_PLAN.md](../V3_PLAN.md)._

## 1. Problem

AutoClaw's orchestrator today writes JSON files into `comms/inboxes/<agent>/`
and hopes the human happens to be looking at the right IDE chat window.
For four out of seven supported hosts that's no longer necessary — they
expose a headless CLI we can drive directly. We need one common contract
the orchestrator can speak, with per-vendor adapters underneath, and a
clearly-scoped fallback shape for the one host (Kilo Code) that still
needs a VS Code companion extension to relay messages into chat.

## 2. The Runner interface

A **Runner** is anything that takes a prompt and turns it into work
without a human-typed chat message. All runners implement:

```ts
interface Runner {
  readonly id: string;                       // "claude-code", "cursor", "kiro", "gemini-cli"
  readonly capabilities: Capabilities;

  detect(): Promise<DetectionResult>;        // is this runner usable on this machine?
  dispatch(opts: DispatchOptions): Promise<DispatchResult>;
  resume(sessionId: string, prompt: string, opts?: Partial<DispatchOptions>): Promise<DispatchResult>;
  listSessions(): Promise<SessionSummary[]>;
  health(): Promise<HealthReport>;           // exit-code-3 / API-key-missing / etc.
  cancel(sessionId: string): Promise<void>;
}

interface DispatchOptions {
  prompt: string;
  sessionId?: string;                        // resume an existing thread if set
  trust: TrustPreset;                        // "off" | "auto" | "turbo"
  trustAllowList?: string[];                 // per-host tool category names
  trustDenyList?: string[];
  agentProfile?: string;                     // custom agent name (Kiro --agent etc.)
  requireMcp?: boolean;                      // fail-fast if MCP servers don't start
  workingDir: string;                        // absolute path
  env?: Record<string, string>;              // appended to runner subprocess env
  timeoutMs?: number;                        // soft cap; orchestrator hard-kills past 2×
  scope?: ScopeDeclaration;                  // see §4
}

interface DispatchResult {
  ok: boolean;
  sessionId: string;                         // newly created or echoed back
  exitCode: number;
  finishedAt: string;                        // ISO timestamp
  durationMs: number;
  tokens?: { input: number; output: number };
  artifacts?: ArtifactRef[];                 // produced during this dispatch
  rationale?: string;                        // "because:" — what the agent decided and why
  errorClass?: "mcp_startup" | "auth" | "timeout" | "tool_denied" | "internal";
  stdoutTail?: string;                       // last ~4 KB for debugging
}

interface Capabilities {
  resumableSessions: boolean;
  jsonStructuredOutput: boolean;
  mcpServers: boolean;
  browser: boolean;
  customAgents: boolean;
  toolTrustGranularity: "all-or-nothing" | "categories" | "fine-grained";
}
```

`detect()` returns:

```ts
type DetectionResult =
  | { found: true; version: string; path: string }
  | { found: false; reason: "not_installed" | "no_auth" | "version_too_old"; hint: string };
```

The orchestrator calls `detect()` once at startup and again on
`autoclaw doctor`. Runners that aren't found go into the registry as
`disabled` with the hint surfaced to the user.

## 3. Trust presets

Borrowed from Antigravity's terminal execution policy. Three named
levels, mapped per-runner. The orchestrator stores the preset on
`agents/<agent>/scope.json`; the runner translates at dispatch time.

| Preset | Semantics |
|---|---|
| `off` | Every tool call requires human approval. CI-unfriendly; demo-friendly. |
| `auto` | Read-only tools auto-approved (read, grep, ls, list-sessions). Mutations prompt. |
| `turbo` | Everything auto-approved except items on `trustDenyList`. CI-friendly. |

Per-runner translation:

| Runner | `off` | `auto` | `turbo` |
|---|---|---|---|
| Claude Code | `permissionMode: "default"` | `permissionMode: "acceptEdits"` for read tools | `permissionMode: "bypassPermissions"` |
| Cursor (`cursor-agent`) | default approval prompts | `--auto-approve=read,grep` | `--auto-approve=all` (deny list inverted) |
| Kiro (`kiro-cli`) | _(no flag)_ | `--trust-tools=read,grep` | `--trust-all-tools` |
| Gemini CLI (`gemini`) | default | `--yolo=read,grep` | `--yolo` |

A runner that can't honor a preset (e.g. an older CLI without granular
flags) downgrades to the closest stricter option and reports the
downgrade in `DispatchResult.errorClass = "tool_denied"` if a mutation
gets blocked.

## 4. Scope declaration

`agents/<agent>/scope.json` declares what an agent is allowed to touch:

```json
{
  "trust": "auto",
  "trustAllowList": ["read", "grep", "search"],
  "trustDenyList": ["delete_branch", "force_push"],
  "pathScope": ["src/**", "test/**"],
  "branchScope": ["feature/wa-*"],
  "browserAllowed": false,
  "maxTokensPerDispatch": 200000,
  "maxWallClockMs": 600000
}
```

Runners enforce what they can (tool trust, path scope where the host
supports it); the orchestrator enforces the rest via post-dispatch
audit. Violations get reported on the bus as `scope_violation` messages
and gate the agent's future dispatches.

## 5. Per-runner implementation notes

### 5.1 `runner-claude-code`

- Detection: `claude --version` from `$PATH`. Auth via `ANTHROPIC_API_KEY`
  env or existing keychain.
- Dispatch: spawns Claude Agent SDK headless subprocess; not a CLI shell.
  Prompt passed as initial user message; structured tool-call events
  streamed via SDK callback.
- Sessions: SDK provides stable session IDs; resume by passing
  `--continue <sessionId>` (or the SDK equivalent).
- JSON output: structured tool-call events natively; final response
  serialized to `dispatch-result.json` next to the outbox.
- MCP: reads `~/.claude/settings.json` (user) and
  `.claude/settings.json` (workspace) for MCP servers.

### 5.2 `runner-cursor`

- Detection: `cursor-agent --version`.
- Dispatch: `cursor-agent --no-interactive --prompt "<text>" --workdir <abs>`.
- Sessions: `--resume <id>` (TBD — verify against current cursor-agent docs).
- MCP: reads `~/.cursor/mcp.json`.

### 5.3 `runner-kiro` (Kiro CLI 2.0)

- Detection: `kiro-cli --version` and presence of `$KIRO_API_KEY`.
- Dispatch:

  ```bash
  kiro-cli chat --no-interactive \
    --trust-tools=<list>  \
    --require-mcp-startup \
    [--agent <name>] \
    [--resume-id <uuid>] \
    "<prompt>"
  ```

- Sessions: `--resume-id <uuid>`, `--list-sessions`, `--delete-session <id>`.
- MCP: `kiro-cli mcp add --name <n> --command <c> --scope workspace|global`.
  Runner installs the AutoClaw MCP server here as part of `mcp install`
  (see [mcp-server.md](mcp-server.md) §6).
- Exit code 3 → `errorClass: "mcp_startup"`.
- Limitations: Kiro Pro+ subscription required; full machine-readable
  JSON output is on the Kiro roadmap (issue #5423) but not GA yet, so
  we parse `stdoutTail` for the response text in the interim.
- Env: `KIRO_API_KEY` from a workspace-scoped secret. `KIRO_HOME`
  optionally pointed at `.autoclaw/runtime/kiro-home/` for full
  isolation if the user wants per-workspace Kiro state.

### 5.4 `runner-gemini-cli`

- Detection: `gemini --version`.
- Dispatch: `gemini -p "<prompt>" --workdir <abs>`. Non-interactive
  when piped or `-p` flag present.
- Sessions: TBD — pin against current Gemini CLI docs.
- MCP: reads `~/.gemini/antigravity/mcp_config.json` when running in
  Antigravity context; reads `~/.gemini/settings.json` otherwise.
- Browser: Gemini CLI exposes a browser sub-agent in Antigravity
  installs; respect `~/.gemini/antigravity/browserAllowlist.txt`.

### 5.5 Detection conflicts

When two runners can both handle a request (e.g. user has both
Claude Code and Cursor installed and the agent profile doesn't pin
one), preference order defaults to:

1. The runner the user explicitly invoked (`/team --runner kiro`).
2. The runner matching the workspace's primary chat host.
3. The cheapest by cost ledger (rolled-up tokens/$).
4. The fastest by recent p50 dispatch latency.

Tiebreaker order is configurable in
`autoclaw.runner.preferenceOrder`.

## 6. Bridge contract (for Kilo)

A **Bridge** is a VS Code companion extension for hosts that have no
headless mode. The contract:

```ts
interface Bridge {
  readonly id: string;                       // "kilocode"
  watch(): void;                             // begins watching agents/<id>/ready
  onReadyFlip(callback: (msg: OutboxMessage) => Promise<void>): void;
  postToHostChat(text: string): Promise<void>;  // host-specific submit
}
```

Lifecycle:

1. Orchestrator writes `outboxes/kilocode/<msg-id>.json` and touches
   `agents/kilocode/ready`.
2. The Kilo bridge extension's `chokidar` watcher fires; bridge reads
   the outbox message.
3. Bridge calls `vscode.commands.executeCommand(<kilo-chat-submit>,
   text)` to post into Kilo's chat panel.
4. Bridge writes `processed/<msg-id>.json` (audit trail) and clears
   the `ready` flag.
5. The Kilo agent's actual reply (a chat message it composes) is
   picked up by AutoClaw's session heartbeat (`session_id` carried
   through) and routed back into the inbox bus as usual.

The bridge is a thin shim — it does not interpret the message body, just
relays. All policy lives in the orchestrator + scope.json.

### 6.1 Antigravity IDE bridge (optional, deferred)

Same shape as the Kilo bridge, but bound to Antigravity's Manager view
auto-submit. Deferred because:

- Gemini CLI runner already covers all automation use cases.
- Manager view is for human-attended parallel work; automating it
  defeats the design intent.
- If users demand it, build later as `bridge-antigravity` v3.x.

## 7. Health and exit codes

Every runner maps host-specific failure modes into a small enum:

| `errorClass` | Triggered by |
|---|---|
| `mcp_startup` | Kiro exit code 3, equivalent on other hosts |
| `auth` | Missing/invalid API key, expired token |
| `timeout` | Soft cap exceeded; orchestrator may retry or escalate |
| `tool_denied` | Trust preset blocked a needed tool; user action required |
| `internal` | Runner subprocess crash, panic, unparseable output |

`HealthReport` returned by `health()`:

```ts
interface HealthReport {
  ok: boolean;
  authPresent: boolean;
  cliVersion: string;
  mcpServersConfigured: number;
  lastDispatchAt?: string;
  recentErrors: { class: ErrorClass; count: number }[];
}
```

Doctor surfaces this per-runner.

## 8. Test matrix

Each runner ships with:

1. **Unit tests** for flag-translation (preset → CLI args).
2. **Integration test** that dispatches a no-op prompt ("respond with
   the literal text OK and nothing else") against a mocked or live
   host; gates CI.
3. **Doctor smoke** invocation that verifies detection + auth in CI.

The orchestrator-level test suite covers cross-runner scenarios
(spawn three runners in parallel, verify ledger idempotency, etc.) —
those live with Workstream A.

## 9. Open issues

1. **`cursor-agent` resumable session flag name** — verify against
   current docs before B.3 lands; placeholder above.
2. **Gemini CLI session API** — same.
3. **JSON output for Kiro** is roadmap, not GA. Plan: parse text now,
   switch to JSON when issue #5423 ships.
4. **Path scope enforcement** in runners — most hosts don't expose
   this natively; current plan is post-dispatch audit only. Worth
   revisiting if a runner adds the surface (Antigravity-side
   sandboxing might).
5. **Trust preset for `/dream` cycles** — recommend default `auto`,
   but the micro-PR opt-in step needs `turbo` on a tight allow list.
   Concrete preset to be defined in `/dream` skill spec.
