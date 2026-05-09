# AutoClaw Ideas Log — Distributed Agent Fabric

_Started 2026-05-09. Append-only. The DISTRIBUTED_AGENT_FABRIC.md is the
selected proposal; this is the broader idea space behind it — including
what was considered, what was dropped, and what's parked for later._

## A. The user's stated goal (verbatim themes from 2026-05-09)

The user wants AutoClaw to host a fabric of many agents and subagents that:

1. **Identify themselves** — any agent (Claude Code, Codex, ChatGPT desktop,
   Kilo, Cursor, Void, Windsurf, OpenClaw, Hermes, custom Python/Node bots,
   hardware-pinned workers) registers and announces what it is.
2. **Advertise capabilities** — context-window, LLMs available, tools they
   can call, languages they're good at, cost budgets, trust level, machine
   they live on.
3. **Join a worker pool** — accept work routed to them based on capability,
   load, and scope; ack with results.
4. **Stay alive on heartbeats** — but smarter than a 30 s ping; track
   queue depth, token budget, last error, current llm.
5. **Spawn/manage other agents** — managers of subagents; subcontract
   tasks down a tree of workers.
6. **Track message layers** — bidirectional open channels, intelligent
   routing, not just file-poll.
7. **Track codebase changes** — agents observe what other agents did and
   adjust; conflict detection across branches.
8. **Share a knowledge graph / data store of thoughts** — collective
   working memory, queryable for context when starting a task.
9. **Span the user's network** — multiple machines on one LAN; many windows
   per machine; eventually multi-LAN / WAN.
10. **Coexist with heterogeneous agent architectures** — AutoClaw is the
    local extension layer; another fabric layer sits above and connects
    to OpenClaw / Hermes / VoidSpec etc. without forcing them all into
    one stack.

This is bigger than what AutoClaw v2.1.0 is today (a per-workspace VS Code
extension). The synthesis at `DISTRIBUTED_AGENT_FABRIC.md` proposes the
program-plane that covers points 1-10 with concrete protocol picks.

## B. Defaults chosen on 2026-05-09 (proceed-as-planned guidance)

The user said "proceed as planned" without answering the three open
questions in `DISTRIBUTED_AGENT_FABRIC.md §6`. I'm adopting these defaults
for the next wave:

1. **Phase 0 first as a patch on top of 2.1.3.** Wire dead code, ship it, then
   start Phase 1 schema work as a minor bump. Smaller blast radius per
   release. (CORRECTED 2026-05-09: target is v2.1.4 patch or v2.2.0 minor,
   NOT v2.1.1. Master is already at 2.1.3 — see §J.)
2. **Bridge default-on at `127.0.0.1`** when a manifest exists. Localhost
   binding only; user can disable via `autoclaw.bridge.enabled = false`.
3. **Program-scope stays in Phase 4.** Don't pull cross-repo forward yet —
   the user does work across multiple repos, but Phase 0/1 must stabilize
   single-repo first, otherwise we ship two half-built things.

These are reversible. If the user disagrees we re-pick before code lands.

## C. Ideas considered and parked (not in DISTRIBUTED_AGENT_FABRIC.md)

These are real options that didn't make the synthesis but should not be
forgotten:

- **Use the host LLM client as the message bus.** I.e., have every agent
  embed its messages inside the user's chat stream. **Why parked:** the
  user explicitly wants headless / non-interactive coordination; bus must
  not require a human in the loop.

- **Embed Temporal as the durable workflow runtime.** Temporal is the
  industry standard. **Why parked:** Java + Postgres + complex deploy
  story; Hatchet is Postgres-only and ships TS SDK. We'd revisit if scale
  exceeds Hatchet.

- **CRDT-based shared memory (Yjs / Automerge).** Tempting for live
  collaboration. **Why parked:** thoughts/findings aren't conflict-y in
  the same way collaborative documents are; append-only with vector
  search wins on simplicity. Could revisit if we want a live shared
  whiteboard panel.

- **Drop filesystem mailbox in favor of NATS-only.** **Why parked:** FS
  is the durable record + offline fallback + works on any host without
  network. Keep it as the canonical audit log forever.

- **Adopt LangGraph as the orchestrator engine.** **Why parked:** Python-
  centric, and AutoClaw's planner is already DAG-based and TypeScript.
  Borrow ideas (checkpointer pattern), don't adopt the framework.

- **Use Discord / Slack as the message transport.** Funny. **Why parked:**
  the user wants this to work offline / on-LAN / behind firewalls.

- **Ship a separate web dashboard outside VS Code.** Already in
  `COORDINATION_IMPROVEMENTS.md §P3` as nice-to-have. **Status:** Phase 4
  candidate; depends on KG daemon existing first so the dashboard has a
  backend to talk to.

## D. Open research questions (for a later wave)

- How do we **price-route** between local Ollama, ZippyMesh, Anthropic API,
  OpenAI API based on the task's complexity + the agent's `cost_budget`?
  (Phase 3 router needs a cost model.)

- What's the **minimum viable trust model** for an unknown agent that
  shows up on the LAN? Do we trust `agent_id = "claude-code"` from
  192.168.1.50 the same as from 192.168.1.10? Probably not — needs human
  approval first time, then SVID issuance.

- How does **kg-daemon survive a crash**? SQLite WAL mode handles single-
  writer durability, but if the user kills VS Code mid-write, do we
  replay from a journal? (Tier 1 deferred answer: SQLite WAL + a write-
  ahead JSONL stream the daemon flushes batch-style.)

- **Cross-vendor consensus voting** — what if Claude approves and Codex
  vetoes? Today the consensus engine treats votes as scalar. We may want
  a vendor-weighting matrix (security findings: trust security-tuned
  models more) — but that's a research ethics question, not a code
  question. Park for v3.

## E. Cross-pollination not yet acted on

From `docs/otherProjects-catalog.md`:

- **Hindsight's Retain/Recall/Reflect API** — copy the API shape into the
  kg-daemon's HTTP surface. Note: catalog flags Hindsight as worth lifting
  the API but writing our own implementation in TS — don't vendor.

- **OpenSpec's stable-IDs-with-changelog** for tasks — folds into
  `COORDINATION_IMPROVEMENTS.md §2.11`. Kill the anonymous telemetry on
  any port.

- **clawbridge-a2a's criticality tiers** (1-CRITICAL / 2-NORMAL /
  3-ROUTINE) — map to `unanimous-required` vs `2/3-majority` vs
  `single-approver` consensus rules. Shape only; license is study-only.

- **acc-agent-command-center's radial-hub dashboard** — the look-and-feel
  for the AutoClaw panel's Phase 2 redesign. Don't lift code; lift design.

- **zippy-mcp-kit's `doctor`/`supervise`/`metrics` CLIs** — extend
  `autoclaw.doctor` with `--supervise` (live tail of fleet) and
  `--metrics p95` (latency percentiles). Borrow CLI shape.

## F. Risks the user should know about

- **Token leak blast radius.** Bridge tokens are 30-day. If one leaks,
  attacker can fake task_complete and consensus votes. Phase 1 revocation
  list is the bandaid; Phase 4 SPIFFE rotating SVIDs are the real fix.

- **Skill markdown is untrusted input.** Any agent that ingests another
  agent's `cross-agent.md` rules is exposed to prompt injection. Need a
  sanitizer for skill content before adapters install across hosts. Add
  to Phase 1.

- **kg-daemon multi-tenant.** If multiple users share a dev box (rare,
  but possible), one user's thoughts could leak into another's project.
  Tier-1 SQLite per-project gives natural isolation; Tier-2 KuzuDB needs
  schema tenancy.

- **Heartbeat storm.** With 50 agents on the LAN @ 30 s, that's ~100
  heartbeats/min. NATS handles it trivially; FS mailbox would not. Don't
  ship Phase 1 capability fields without the NATS opt-in path ready.

- **Marketplace policy.** AutoClaw is published under
  `ZippyTechnologiesLLC` on VS Code Marketplace and Open VSX. Auto-binding
  a port (Phase 0 default-on) needs a marketplace.json review check —
  ports may need user consent on first run on some platforms.

## G. The "if we had infinite time" version

Idea backlog that won't ship in v2 or v3 but is worth keeping:

- **Federated agent reputation** across users — a user can opt to publish
  anonymized success/failure rates for their agents; new users picking
  agents see community ratings. Built atop Verifiable Credentials.

- **Live agent-pair-programming**. Two agents on the same task in real
  time, one suggesting, one verifying, with a side-channel CRDT for the
  joint scratchpad.

- **Hardware-pinned workers** for things like model fine-tuning or video
  generation — agent declares `hardware: ["cuda:rtx4090", "ram:64gb"]` and
  the router prefers it for matching tasks.

- **Knowledge-graph diff between projects.** "What did the kg-daemon for
  ZippyVoice learn that's relevant to ZippyPanel's similar feature?" —
  cross-project semantic transfer.

- **Agent autobiography**. Periodic LLM call summarizes what each agent
  has been doing all week into a one-paragraph memo, stored in KG.
  Accountability loop.

- **Agent-driven retrospectives.** After every sprint, the fleet runs a
  consensus retrospective: what blocked us, what to change, what worked.
  Output appended to KG and surfaces in the next sprint's planner.

## H. Wave 2 results — 2026-05-09

Three parallel agents returned with non-overlapping artifacts:

### Phase 0 implementation plan
- Output: [docs/research/phase-0-implementation-plan.md](research/phase-0-implementation-plan.md).
- Six PRs proposed (parallelisable per audit's parallel-safety analysis).
- Trickiest calls per item: (1) bridge auto-start trigger = "any manifest
  exists" (stateless, reversible by removing the dir); (2) platform ID
  stamped into each `SprintAssignment` rather than just agents.json so
  plans are self-describing post-drift; (3) `/api/v1/consensus/{task}/
  evaluate` is idempotent — log+broadcast only, do NOT move files in
  Phase 0 (sweep is a Phase 1 concern); (4) when ALL slots are stalled,
  emit empty assignment + sidecar JSON rather than error so the skill can
  decide; (5) `mergeFindings` currently mutates input votes — accepted
  for Phase 0 (no reuse), clone in Phase 1; (6) bridge tests use random
  port within a 1000-port window to keep CI parallel-safe.

### kg-daemon Tier 1 prototype
- Output: [packages/kg-daemon/](../packages/kg-daemon/) — 11 files, ~830 LOC.
- Graceful degradation: ZippyMesh down → embeds=null, search falls to
  FTS5 BM25 (or LIKE if FTS5 missing). sqlite-vec missing → caps.vec=false,
  search uses FTS5 only. Smoke test forces ZMLR-down path.
- Promote-to-prod next steps documented: (1) shared-secret auth + helmet
  headers + scope checks, (2) embedding-model versioning + dim validation
  + re-embed migration, (3) redaction hook + Tier-2 KuzuDB adapter behind
  the same `KnowledgeGraph` interface + extension lifecycle integration.
- Note: `npm install` deliberately not run; the package is standalone
  until we choose to promote it to a workspace.

### A2A Agent Card + RegisteredAgent v2 + Heartbeat v2 specs
- Output: [docs/specs/agent-card-schema.md](specs/agent-card-schema.md),
  [docs/specs/registered-agent-v2.md](specs/registered-agent-v2.md),
  [docs/specs/heartbeat-v2.md](specs/heartbeat-v2.md).
- A2A v0.2.5 fields adopted; AutoClaw extensions live under `x-autoclaw.*`
  to avoid namespace collision with the spec.
- A2A field set NOT verified against the live spec — WebFetch was denied
  at runtime; flagged at the top of the spec for human verification before
  any code merges. **Action: confirm against https://a2a-protocol.org/
  before code uses these field names.**
- Three risk fields documented with mitigations:
  - `x-autoclaw.machine_ip` — only PII; gated behind A2A's
    `supportsAuthenticatedExtendedCard`. Alternative (drop entirely + dial
    via bridge NAT) was rejected because Phase 2 NATS needs a routable
    address self-advertised.
  - `trust_level` — coarse single enum; gates auto-merge. A misconfigured
    `"high"` is a security risk. Documented as a Phase-1 stopgap; replaced
    by Biscuit attenuated capability tokens in Phase 4.
  - `last_error.message` — only field where user text could leak (paths,
    prompts, credentials in stack traces). Mandatory redactor: truncate,
    strip ANSI, replace `$HOME`, never log tokens.
- New status `overloaded` proposed in three-stage inference algorithm
  (alongside existing active/idle/stalled/offline). Triggers when
  queue_depth or error_rate_1m exceed thresholds even if heartbeat is
  fresh.

### What's NOT done in wave 2 (deliberate)
- No source files under `src/` were modified.
- No git commits, no pushes, no marketplace publishes.
- No `npm install` in `packages/kg-daemon/`.
- The kg-daemon is not yet wired into the AutoClaw extension's lifecycle.

### Suggested wave 3 (not auto-launched — needs explicit go)
Two paths, mutually exclusive:

**Path A — Execute Phase 0 in a worktree.** Spawn 6 parallel agents
(one per Phase 0 item) with `isolation: "worktree"`, each lands its
diff + tests on the worktree branch, runs `npm test`, returns a
review-ready bundle. Nothing pushed. Output: a single branch +
`docs/research/phase-0-execution-report.md` summarizing test deltas,
LOC, regressions. Reviewable before merge.

**Path B — More specs first.** Draft (a) the NATS topic conventions doc
(Phase 2 prep), (b) the Biscuit token attenuation spec (Phase 4 prep),
(c) the program-plane registry.json schema (Phase 4 prep), (d) a doc
mapping each `COORDINATION_IMPROVEMENTS.md` P0/P1/P2 item into the new
phase numbering. No code changes anywhere.

Recommendation: Path A. The Phase 0 plan is concrete, the diffs are
small, the tests are well-bounded, and the worktree isolation makes
it reviewable rather than committed. Path B can run after Path A on
the master branch while Path A is in review.

## I. Wave 3 results — 2026-05-09

Both paths ran in parallel.

### Path A — Phase 0 executed in worktree

- **Worktree:** `k:/Projects/autoclaw/.claude/worktrees/agent-ac6b45f2597da4b6f`
- **Branch:** `worktree-agent-ac6b45f2597da4b6f` — branched from `8a44446`
  (one commit behind master's `a8ac62c`; needs rebase before merge).
- **Diff:** +878 / -11 across 9 files (4 new, 5 modified).
- **Tests:** 196/196 passing (was 153 at baseline). +43 new tests.
- **Commits:** 6 feature + 1 docs, conventional-commit messages.
- **Execution report:** `docs/research/phase-0-execution-report.md` on the
  worktree branch.

| # | Commit | Item | Tests added |
|---|---|---|---|
| 6 | `7ae62a7` | bridge.test.ts + comms.test.ts pin v2.1 behavior | 25 |
| 2 | `7deb45d` | SprintAssignment.platform/inbox; planSprints + generatePlan accept registry | 4 |
| 5 | `64bc7ab` | evaluateConsensus calls mergeFindings; ConsensusResult.merged_findings | 2 |
| 1 | `7be7245` | autoclaw.bridge.autoStart (default true); manifest-probe gating | 5 |
| 3 | `ab08919` | POST /api/v1/consensus/{tid}/evaluate; review broadcasts consensus_result | 4 |
| 4 | `6f6cf24` | autoclaw.orchestrate.heartbeatStallSeconds (300); stalled-slot exclusion; excludedSlots param | 3 |

**One deviation from the plan:** the manifest-probe helper that gates
bridge auto-start was extracted to `src/manifest-probe.ts` rather than
living inside `extension.ts`, because importing `vscode` would have made
the helper untestable in Mocha. Documented in the execution report.

**Latent bug fix bonus:** `planSprints()` had an outer-while-loop infinite-
loop hazard when every slot is excluded or scope conflicts make progress
impossible. Fixed defensively with a break-if-no-progress guard. Tests
cover the guard.

**Skipped / out of scope (deliberate):**
- Skill prompt update (`skills/orchestrate/SKILL.md`) — per worktree
  mission's "don't touch skills" rule. 1-line follow-up flagged in
  report.
- Bridge port fallback (9877..9880) — was explicitly Phase-1, not Phase-0.

### Path B — four forward-looking specs

All under `docs/specs/`, all flagged `[needs verification]` (WebFetch was
not available at runtime; protocol details are internal-best-effort
until human verification against live specs).

| Spec | Lines | Risk-of-record | Rejected alternative |
|---|---|---|---|
| `nats-topic-conventions.md` | 277 | Dual-write FS+NATS doubles I/O on hot path | NATS-only durability (would break offline-agent + audit-log promise) |
| `biscuit-token-attenuation.md` | 342 | 5-min TTL → constant mint cadence; orchestrator hiccup stalls fleet | Long-lived JWTs (no holder-attenuation, no local-first) |
| `program-plane-registry.md` | 274 | Explicit Cmd-Palette join → users forget; silent single-repo behaviour | mDNS zeroconf (multicast perms, trust model, cross-platform fragility) |
| `coordination-improvements-mapping.md` | 84 | Declaring CROSS_AGENT_ARCHITECTURE.md historical may break stale references in CLAUDE.md / rules / README | Keep old phase numbers as aliases (two phasings invite drift) |

### What the user must decide before wave 4

1. **Rebase + fast-forward the Phase 0 worktree onto master?** Master is
   at `a8ac62c`, worktree branched from `8a44446` (one BOM-strip commit
   behind). Conflict-free in spirit, but needs explicit user authorisation
   before any push.
2. **Pull the program-plane spec forward into Phase 1?** Spec doc has a
   trigger matrix; if user actively orchestrates ≥2 repos in 7 days,
   pull-forward criteria is met.
3. **Verify the A2A + Biscuit protocol details against the live specs.**
   Currently flagged `[needs verification]`. WebFetch was denied earlier;
   either retry or human-verify.
4. **Decide whether the next release contains Phase 0 only, or also picks
   up the kg-daemon prototype as an opt-in companion package.** The
   prototype is isolated and can ship behind a feature flag.

## J. Version-tracking correction — 2026-05-09

I spent most of this session assuming master was at v2.1.0. Wrong.
- `package.json` is at **2.1.3** (verified: master HEAD `a8ac62c`).
- The worktree branch was forked at `8a44446` which had 2.1.2.
- Master's BOM-strip commit `a8ac62c` silently bumped to 2.1.3.
- CHANGELOG.md tops out at `[2.1.0]` — there are NO entries for
  2.1.1 / 2.1.2 / 2.1.3, and no git tags past v1.2.5.

User flagged: "we are at 2.1.3 already in other chats and builds."

**Implications for the Phase 0 worktree:**
- Target version for Phase 0 is **NOT** v2.1.1. It's v2.1.4 (patch) or
  v2.2.0 (minor). Decision pending.
- Rebasing the worktree onto master will hit a `package.json` conflict
  (worktree bumps from 2.1.2 base; master bumped to 2.1.3). Trivial to
  resolve manually.
- Two settings the Phase 0 worktree adds (`autoclaw.bridge.autoStart`,
  `autoclaw.orchestrate.heartbeatStallSeconds`) plus the new bridge
  endpoint argue for v2.2.0 minor; the audit framing as "wiring dead
  code with tests only" argues for v2.1.4 patch. Defer to user.

**CHANGELOG hygiene gap to address before any further release:**
- 2.1.1, 2.1.2, 2.1.3 each need a CHANGELOG entry (or, at minimum, one
  combined "[2.1.1–2.1.3] interim fixes" entry that lists what changed).
  Otherwise any further release looks like it skipped versions.
- Tagging policy: nothing tagged past v1.2.5. If the 2.0.x and 2.1.x
  releases were published to Marketplace, the published versions are
  un-reproducible from git without tag → commit linkage. Decision:
  retroactively tag, or accept the gap and tag from here forward.

## K. How this log gets used

- Every research wave appends a section here.
- Anything in §G that gets promoted to a real plan moves into
  `DISTRIBUTED_AGENT_FABRIC.md` (or replaces a phase).
- Anything that gets killed stays here with a "killed: <date> because <X>"
  line — preserves the reasoning trail.
