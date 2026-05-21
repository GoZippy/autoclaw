# AutoClaw 3.0 — Consolidated Plan ("Wake & Sleep")

_Status: draft, 2026-05-19. Source of truth for the v3.0 rebrand and
re-architecture wave._

Consolidates and supersedes the planning fragments scattered across this chat
and the following prior docs. Read this first; the others remain useful for
context and citations.

| Prior doc | Why still useful |
|---|---|
| [AGENT_DAEMON_CRITIQUE.md](AGENT_DAEMON_CRITIQUE.md) | Concrete orchestrator bugs and the state-machine sketch this plan absorbs as Workstream A. |
| [COORDINATION_IMPROVEMENTS.md](COORDINATION_IMPROVEMENTS.md) | P0–P3 backlog from running v2.1 on ZippyPanel. Most P0/P1 items are folded into Workstreams A and C. |
| [CROSS_AGENT_ARCHITECTURE.md](CROSS_AGENT_ARCHITECTURE.md) | Original "filesystem is the bus" design — still the foundation, extended here with MCP + cloud relay. |
| [DISTRIBUTED_AGENT_FABRIC.md](DISTRIBUTED_AGENT_FABRIC.md) | Phase synthesis. v3.0 lands the program-plane that earlier phases were building up to. |
| [IDEAS_LOG.md](IDEAS_LOG.md) | Parked options. Anything in this plan that contradicts a previous "parked" decision is intentional. |

If those docs disagree with this one, **this one wins for v3.0 scope**.

---

## 1. Naming, settled

Skills become **short verbs**. No `Auto*` prefix on each — the umbrella is
already AutoClaw.

| Old | New | Role |
|---|---|---|
| `kdream` (daemon, ps, status, logs) | folded into **AutoClaw core** | Invisible runtime — heartbeats, registry, fleet, inbox bus |
| `kdream dream` | **`/dream`** | Asleep-side consolidation cycle |
| _(new)_ | **`/recall`** | Awake-side memory retrieval, including time-travel queries |
| `kdream work` | **`/work`** | Autonomous pickup of a TODO/follow-up |
| `kdream todo` | **`/todo`** | Workspace TODO/`AI:` spider + classification |
| `kdream add` | **`/note "<x>"`** | Quick capture; `/dream` later promotes to consolidated facts |
| `autobuild` | **`/build`** | Scheduled workflows (behavior unchanged) |
| `mateam` | **`/team`** | Multi-role dispatch (behavior unchanged) |
| `orchestrate` | **`/sprint`** | DAG-based parallel planning (behavior unchanged) |

The lobster stays as AutoClaw's mascot (the runtime/umbrella). The dashboard
view is **AutoClaw Fleet** — no zoological commitment.

Marketing one-liner: _"AutoClaw — your fleet of agents that dream, recall, work, build, team, and sprint."_

### Migration & compat

- All old slash commands stay as **deprecated aliases** for one minor
  release, emit a one-line deprecation notice, removed in v4.0.
- `.autoclaw/kdream/` directory auto-renamed to `.autoclaw/dream/` on
  first v3.0 run; on Windows leave a junction for one cycle.
- Doctor adds a "v3.0 migration" section that surfaces stale paths,
  unsupported commands in workspace state, and remaining aliases.
- Every adapter file regenerated from `skills/*/SKILL.md`; existing
  `npm run adapters:check` CI gate guards against drift.

### Keybindings

- `Ctrl+Alt+K` (Open KDream Dashboard) stays bound to the renamed
  Fleet view for muscle memory.
- `Ctrl+Alt+F` added as the new canonical Fleet shortcut.
- Other shortcuts unchanged.

---

## 2. Runtime model — "Wake & Sleep"

**Awake-side** (the runtime, always on): daemon, heartbeats, agent
registry, fleet view, inbox/outbox bus, capability routing, `/recall`
retrieval, dispatch via runners/bridges.

**Asleep-side** (`/dream`): triggered on idle threshold (configurable,
default 10 minutes) or workspace-close. Pipeline:

1. **Extract** facts from recent session transcripts.
2. **Dedupe** against existing memory tiers.
3. **Conflict-resolve** with bi-temporal supersession.
4. **Drift-check** existing facts against current code (broken file
   refs, renamed symbols, _secrets in MCP env_).
5. **Spider** new TODOs and `// AI:` / `# AI:` comments.
6. **Pre-summarize** files likely needed next session.
7. _(opt-in)_ **Micro-PR** queue: pick one well-scoped TODO under an
   N-line budget, open a PR for review on wake.

---

## 3. Per-vendor dispatch — runner/bridge table

Updates [AGENT_DAEMON_CRITIQUE.md §4](AGENT_DAEMON_CRITIQUE.md) — Kiro CLI
2.0 (April 2026) shipped headless mode, so Kiro moves from "bridge required"
to a native runner.

| Agent | Dispatch path | Status (May 2026) |
|---|---|---|
| Claude Code | Claude Agent SDK headless subprocess | runner |
| Cursor | `cursor-agent` CLI headless | runner |
| Kiro | `kiro-cli chat --no-interactive` | runner |
| Gemini CLI / Antigravity headless | `gemini -p "<prompt>"` | runner |
| Antigravity IDE (Manager view) | Gemini CLI runner covers automation; GUI bridge only if interactive auto-submit demanded | optional bridge |
| Kilo Code | VS Code chat-only, no headless mode | **bridge required** |
| Windsurf | Cascade CLI not shipped | blocked on vendor |

Net: **four native runners + one mandatory bridge (Kilo) + one optional bridge (Antigravity IDE) + one blocked**. Substantially smaller bridge surface than the May 19 critique implied.

Full runner contract and bridge spec live in [rfc/runner-bridge-contract.md](rfc/runner-bridge-contract.md).

---

## 4. Antigravity on-disk surface (spike findings, 2026-05-19)

Confirmed by direct inspection of an Antigravity install on this machine.

**User-global (under Gemini's home, NOT VS Code's user data):**

```
~/.gemini/GEMINI.md                          # global rules
~/.gemini/antigravity/
  mcp_config.json                            # MCP server registry, mcpServers shape
  browserAllowlist.txt                       # browser sub-agent allowlist
  browserOnboardingStatus.txt
  installation_id                            # 36-byte UUID, stable per install
  user_settings.pb                           # protobuf user settings
  annotations/<uuid>.pbtxt                   # per-session metadata (~56 bytes)
  brain/<uuid>/                              # per-conversation persistent state
  browser_recordings/<uuid>/                 # browser sub-agent recordings
  code_tracker/{active,history}/             # file change tracking
  context_state/                             # session context cache
  conversations/<uuid>.pb                    # protobuf chat transcripts (KB–MB)
  html_artifacts/                            # HTML output artifacts
  implicit/<uuid>.pb                         # derived/inferred knowledge
  knowledge/<project-slug>/                  # per-project knowledge base (markdown likely)
  playground/                                # experiments
  prompting/browser/                         # browser sub-agent prompts
  scratch/                                   # scratch work
```

**Workspace-scoped** (Antigravity reads from any opened folder):

```
.agent/rules/         # short rule snippets (current AutoClaw adapter target)
.agent/workflows/     # workflow definitions
.agent/skills/<name>/SKILL.md + scripts/ + resources/   # full skill packages
```

**Antigravity executable**: a Microsoft VS Code fork
(`bin/antigravity` is the verbatim VS Code wrapper). The `antigravity` /
`antigravity.cmd` CLI is the **VS Code-style CLI** — open workspaces,
install extensions, not agent dispatch. Headless agent dispatch goes
through Gemini CLI.

**Format friction**: conversations and implicit knowledge are **protobuf**
(`.pb` / `.pbtxt`). The `.proto` schema is not public, so AutoClaw should
**not** adopt Antigravity's wire format as its canonical Artifact format.
Instead, publish AutoClaw's own JSON/markdown Artifact schema and translate
at the adapter layer.

### Interop angles unlocked by this spike

1. **`knowledge/<project-slug>/`** is Antigravity's per-project memory.
   Likely accepts markdown drops (consistent with how it reads
   `.agent/rules/`). Worth a smoke test: AutoClaw writes its `MEMORY.md`
   into `knowledge/<project>/` so Antigravity has instant context next
   session.
2. **Antigravity's adapter target is wrong**. We currently write to
   `.agent/rules/`. The richer `.agent/skills/<name>/SKILL.md` + `scripts/`
   + `resources/` shape is closer to a real skill package. Adopt this as
   the AutoClaw canonical packaging; flat-only vendors flatten it.
3. **`installation_id`** is a clean precedent. Mirror it as
   `.autoclaw/runtime/installation_id` (UUIDv4) for fleet identity.
4. **MCP config path settled** for every host — see Workstream B+.

---

## 5. MCP universal config — install hero feature

Every host AutoClaw cares about speaks the same `mcpServers` JSON shape,
just at different paths:

| Host | MCP registry location |
|---|---|
| Claude Code | `~/.claude/settings.json` (or workspace `.claude/settings.json`) |
| Cursor | `~/.cursor/mcp.json` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` |
| Kiro | managed via `kiro-cli mcp add --name <n> --command <c>` |
| Continue / Cline / Windsurf | tracked in adapter notes |

→ **`autoclaw mcp install`** writes the AutoClaw MCP server entry into every
detected registry in one shot, idempotent, with a report of what got
wired. Quick-start moment: install AutoClaw → run one command → every AI
host on the machine reads AutoClaw state natively via MCP.

Full MCP server surface and writer spec live in [rfc/mcp-server.md](rfc/mcp-server.md).

---

## 6. Workstreams

### Workstream A — Foundation (orchestrator correctness)

Must land before B/C; everything else leans on the bus being correct.
Most items come from [AGENT_DAEMON_CRITIQUE.md](AGENT_DAEMON_CRITIQUE.md) §2–3
and [COORDINATION_IMPROVEMENTS.md](COORDINATION_IMPROVEMENTS.md) P0.

- **A.1** State machine + ledger in `.autoclaw/orchestrator/state.json`,
  keyed by `msg.id`, idempotent.
- **A.2** Atomic message claim via rename-to-`processed/`;
  nanosecond + UUID filenames (`time.time_ns()` / `uuid4()`).
- **A.3** Replace `sleep(30)` polling with `watchdog` filesystem
  events. Keep a 5-min heartbeat tick for stall detection only.
- **A.4** Inbox state machine: `inboxes/<agent>/_state/<msg-id>.json`
  with `read_at`/`replied_at`/`archived_at`. Backwards compatible
  (empty `_state/` ⇒ all unread).
- **A.5** Session-level heartbeats with `session_id` dimension on
  every emitted message. Per-session rows in the Agents panel.
- **A.6** Reconciliation sweep every 5 min: diff `tasks.md` ↔
  `state.json` ↔ sprint YAMLs ↔ `comms-log.jsonl`. Don't auto-fix —
  surface drift loudly via a `system` message to shared inbox.
- **A.7** Single source of truth: `state.json` canonical for state;
  sprint YAMLs are spec; `plan-summary.yaml` and `sprint-N.md` are
  generated. Drop `parallel-execution-plan.md`.

### Workstream B — Autonomy (runners + the one mandatory bridge)

- **B.1** Per-vendor runner contract (`agents/<agent>/ready` flag,
  `outboxes/<agent>/`, exit-code mapping). Full TS spec in
  [rfc/runner-bridge-contract.md](rfc/runner-bridge-contract.md).
- **B.2** `runner-claude-code` — Claude Agent SDK headless subprocess.
- **B.3** `runner-cursor` — `cursor-agent` CLI headless.
- **B.4** `runner-kiro` — `kiro-cli chat --no-interactive` with
  `--resume-id`, `--trust-tools=...`, `--require-mcp-startup`,
  `KIRO_API_KEY` env.
- **B.5** `runner-gemini-cli` — `gemini -p "<prompt>"` non-interactive.
  Covers Antigravity automation today.
- **B.6** `bridge-kilocode` — VS Code companion extension that
  watches `agents/<agent>/ready`, reads outbox, auto-submits to chat
  panel. _Only mandatory bridge._
- **B.7** _(deferred)_ `bridge-antigravity` — only if there's user
  demand for Manager-view auto-submit beyond what Gemini CLI covers.
- **B.8** OS toast on `ready` flip when no runner/bridge available —
  one-click human-tap fallback.
- **B.9** Trust-preset model on `agents/<agent>/scope.json`:
  `off` / `auto` / `turbo` plus optional allow/deny lists. Borrowed
  from Antigravity's terminal execution policy. Translates to
  per-runner flags (`--trust-tools=...` for Kiro, equivalent for
  others).
- **B.10** Subcontract protocol (`subcontract_request` →
  `_accept` → `_deliver` → `_ack` / `_reject_with_fixes`), per
  [COORDINATION_IMPROVEMENTS.md](COORDINATION_IMPROVEMENTS.md) §2.10.
- **B.11** Review SLA + auto-broadcast on timeout
  ([COORDINATION_IMPROVEMENTS.md](COORDINATION_IMPROVEMENTS.md) §2.6).
- **B.12** Claim tokens with contention check
  ([COORDINATION_IMPROVEMENTS.md](COORDINATION_IMPROVEMENTS.md) §2.5).
- **B.13** Dynamic consensus participants — quorum applies to
  recent heartbeats only ([AGENT_DAEMON_CRITIQUE.md](AGENT_DAEMON_CRITIQUE.md) §3).

### Workstream B+ — MCP server (the install hero)

Parallel to B; the in-tool interop surface.

- **B+.1** `autoclaw-mcp` server exposing read-only tools first:
  `recall(query)`, `fleet.status()`, `inbox.read(agent?)`,
  `todo.list()`. Stdio transport (compatible with every host).
- **B+.2** `autoclaw mcp install` command: writes/updates the
  AutoClaw server entry across every detected MCP registry path
  (see §5). Idempotent. Reports what got wired.
- **B+.3** Write tools, gated behind a config flag:
  `claim_task(id)`, `dream.run()`, `note.add(text)`, `inbox.archive(msg_id)`.
- **B+.4** Workspace-scoped vs user-global MCP installation
  (workspace preferred for project-specific state).

Full spec: [rfc/mcp-server.md](rfc/mcp-server.md).

### Workstream C — Memory & UI

- **C.1** Skill split + rename: `/dream`, `/recall`, `/work`,
  `/todo`, `/note`, `/build`, `/team`, `/sprint`. `kdream` alias for
  one minor. Adapter regen across 8 hosts.
- **C.2** `/dream` pipeline: extract → dedupe → conflict-resolve →
  drift-check → spider TODOs/`AI:` → pre-summarize → opt-in micro-PR.
- **C.3** Hierarchical memory tiers — `.autoclaw/memory/`:
  - `core/` (always loaded into agents)
  - `recall/` (searchable index, queryable via `/recall`)
  - `archive/` (compressed older facts)
- **C.4** Bi-temporal facts: every fact carries `valid_from` +
  `recorded_at`. Build on the existing `kg-daemon bi-temporal
  validity` work. `/recall` supports time-travel queries.
- **C.5** Long-lived resumable session IDs across runners (Kiro
  `--resume-id`, Claude session IDs, Cursor sessions, Gemini sessions).
- **C.6** Fleet view dashboard — identity cards (avatar, role,
  host machine, current task, last heartbeat, capabilities,
  parent→subagent tree). Click for inbox + cancel/reroute.
- **C.7** "Awaiting You" panel section:
  `to == me ∧ requires_response ∧ replied_at == null`.
- **C.8** Agent cards click-to-expand — claimed tasks, sprint
  assignments, last 5 outbound messages, "ping" button.
- **C.9** Activity feed (real-time event stream — task started,
  finding raised, consensus passed, agent died).
- **C.10** Cost ledger — per-agent tokens + wall-clock + `because:`
  rationale field on every action; rolled up per task/sprint/project.
- **C.11** Status-bar presence indicator: "3 agents working,
  1 needs review."
- **C.12** Conflict-detection hook — `git diff --stat` between agent
  branches, warn before overlapping pushes.
- **C.13** Browser sub-agent capability flag (`needs_browser: true`
  on agent profile). For Gemini runner, pass through; for others,
  back with a Playwright MCP server.
- **C.14** Program scope — `.autoclaw/program/registry.json` lists
  participating repos. Cross-repo comms tail. Single Agents table
  with a repo column. Natural anchor for the cloud relay.

### Workstream C+ — Artifact interop (parked specifics, lower priority)

- **C+.1** Define `.autoclaw/artifacts/` schema mirroring Antigravity's
  taxonomy (task plans, implementation plans, code diffs, screenshots,
  browser recordings, test results). JSON + markdown, not protobuf.
- **C+.2** Smoke-test writing markdown into
  `~/.gemini/antigravity/knowledge/<project>/` to see if Antigravity
  surfaces it as context next session. If yes → cross-write
  MEMORY.md.
- **C+.3** Antigravity adapter fix: move from `.agent/rules/` flat
  files to `.agent/skills/<name>/SKILL.md` + `scripts/` + `resources/`
  layout.

### Workstream D — Cloud relay (Pro tier preview)

The SaaS-augmented layer. Local stays first-class; cloud is opt-in.

- **D.1** Auth: personal access token, scoped per-machine.
- **D.2** Endpoint: agents POST heartbeats + inbox messages to a
  ZippyTech-hosted endpoint; web dashboard reads them.
- **D.3** Cross-machine fleet view in the web dashboard.
- **D.4** Cross-project rollup (powered by `.autoclaw/program/`).
- **D.5** Encrypted payloads at rest in the relay.
- **D.6** Open-core posture: free tier is fully OSS on GitHub;
  cloud relay is closed-source.

---

## 7. Sequencing

Workstream A is the gate. B / B+ / C can fan out in parallel after A.1–A.4
land.

| Week | Work |
|---|---|
| **1** | A.1–A.7 (orchestrator correctness, inbox state machine, session heartbeats, reconciliation sweep, single-source-of-truth). Land as v3.0.0-alpha. |
| **2 (parallel)** | B.1–B.5 (runner contract + 4 runners) **and** B+.1–B+.2 (MCP server + cross-vendor install) **and** C.1–C.4 (skill split + `/dream` pipeline + memory tiers + bi-temporal). v3.0.0-beta. |
| **3 (parallel)** | C.6–C.10 (Fleet view + Awaiting You + Agent cards + cost ledger + activity feed) **and** B.6–B.13 (Kilo bridge + toast + trust presets + subcontract + SLA + claim tokens) **and** B+.3–B+.4 (MCP write tools, scoping). |
| **4** | C.11–C.14 (status bar, conflict hook, browser capability flag, program scope) + D.1–D.4 (cloud relay MVP) + demo video + AutoClaw 3.0 GA. |

C+ ships in 3.1. D.5–D.6 firm up post-3.0 once usage data drives priorities.

---

## 8. Open questions

1. **Bridge for Antigravity IDE Manager view** — do we ship `bridge-antigravity` in 3.0 or punt to consumers? Recommendation: punt. Gemini CLI covers automation; the GUI Manager view is for human-attended work.
2. **Migration noise** — the kdream alias prints a deprecation notice on every invocation; is that too chatty for users on adapter hosts that auto-prefix the prompt? Consider: notice once per workspace per session.
3. **MCP server scope default** — workspace vs user-global as the install default? Recommendation: workspace, with `--global` flag to opt up.
4. **Trust preset defaults** — `auto` for new workspaces feels right; `off` for production / `.production` / `main` branches? Worth a config knob.
5. **VoidSpec coupling** — should v3.0 require the `tasks.yaml` canonical refactor ([COORDINATION_IMPROVEMENTS.md](COORDINATION_IMPROVEMENTS.md) §2.11–2.12) or stay backward-compatible with current `tasks.md`? Recommendation: stay back-compat; ship VoidSpec changes as a 3.x minor.
6. **Where does `/work` autonomy live?** It's not memory and not a sprint primitive. Standalone skill (`/work`) or fold into `/sprint` as a single-task variant? Current plan: standalone — keeps the verbs orthogonal.

---

## 9. Cross-references for parallel agents

If you're picking up one workstream, you also want:

- Workstream A: [AGENT_DAEMON_CRITIQUE.md](AGENT_DAEMON_CRITIQUE.md) §2–3, [COORDINATION_IMPROVEMENTS.md](COORDINATION_IMPROVEMENTS.md) P0.
- Workstream B: [rfc/runner-bridge-contract.md](rfc/runner-bridge-contract.md), [AGENT_DAEMON_CRITIQUE.md](AGENT_DAEMON_CRITIQUE.md) §4, Kiro CLI 2.0 headless docs at <https://kiro.dev/docs/cli/headless/>.
- Workstream B+: [rfc/mcp-server.md](rfc/mcp-server.md), §5 of this doc.
- Workstream C: §2 of this doc, [DISTRIBUTED_AGENT_FABRIC.md](DISTRIBUTED_AGENT_FABRIC.md).
- Workstream C+: §4 of this doc.
- Workstream D: [CROSS_AGENT_ARCHITECTURE.md](CROSS_AGENT_ARCHITECTURE.md) (the bridge layer), §6.D.
