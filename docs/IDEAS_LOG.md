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

## L. External validation — Fable 5 agent patterns (2026-06-11)

User flagged @0xCodez's "Build self-improving agent system with Fable 5 in
14 steps: loops, dynamic workflows, routines" and later pasted the full
article text. Full synthesis + 14-step→surface map + gap-analysis in
`research/2026-06-11-fable-5-agent-patterns.md`. It largely *validates*
AutoClaw's shape (orchestrate→delegate→verify→persist) rather than
introducing new architecture.

Core reframe: **self-improving ≠ self-learning** — the model is stateless;
the *system around it* compounds (memory + skills + state files + eval
loops). The 4-layer compound stack (Primitives → Orchestration → Memory →
Self-improvement) maps 1:1 onto AutoClaw's layers; what's thin is the
"write the graded lesson back" arc that closes the loop. Net-new discipline:

- **4-tier model routing** as a first-class decision (route by complexity,
  not default): orchestrator → Fable 5 / Opus 4.8; high-volume workers →
  **Sonnet 4.6**; verifier/grader sub-agents → **Haiku 4.5**; classifier-
  block fallback → **Opus 4.8**. Fable ≈ 5× Opus per token of real work.
  Record tier + cost budget in the capability advert (ties to §A.2). [P0]
- **Checkable rubrics** (command + pass-condition) per task; review gate
  *runs* them before consensus — votes grounded in evidence, not opinion. [P0]
- **Fresh-context verifier sub-agents** (reviewer ≠ author session); order:
  deterministic checks → adversarial review → human gate on irreversible
  actions. [P1]
- **STATE.md discipline** — read-at-start / write-at-end in spawned +
  cross-agent cycles; `Verified-by:` provenance on consolidated memories
  (the 5-stage Fail→Investigate→Verify→Distill→Consult progression). [P1]
- **Default parallel sub-agents to worktree isolation** (Agent tool already
  supports `isolation: worktree`) instead of scope-honesty. [P1]
- **Refusal/fallback + 30-day-retention handling** on any Fable call site
  (cyber/bio/chem/distillation classifiers fall back to Opus 4.8). [P1]
- **Routines fire goal-loops, not one-shots** (autobuild/schedule → rubric
  loop). [P2]
- **Compounding skills** — write confirmed lessons back into AutoClaw's own
  skill files (Known-failure-modes / Anti-patterns sections). [P2]
- **Vision-verify gate** for UI-producing tasks (screenshot vs design
  tokens). [P2]
- **Spawned-agent prompt library** — ship Anthropic's authoritative Fable/
  Opus behavioral fragments (anti-overplanning, no-tidying, grounded
  progress, boundaries, async sub-agents, memory, autonomous-loop guard,
  send_to_user) as reusable system-prompt blocks. [P2]

None require a rewrite — refinements to existing surfaces.

**Companion (2026-06-11): Loss-Function Development.** User also flagged
@elvissun's "/goal + Loss Functions" playbook (full text pasted). Synthesis
in `research/2026-06-11-loss-function-development.md`. Where the Fable piece
says "use checkable rubrics," this is the manual for writing a rubric an
*optimizing* agent can't game — directly upgrades our review-gate/consensus
design. Net-new:

- **Spec-driven (finite, "make tests pass") → loss-function (descend toward a
  1,000-case eval, never "done").** AutoClaw does the inner test-pass loop;
  the outer outcome-metric loop is the gap. [P2]
- **The 4-part loss function = the task/gate template:** target (large +
  *blind the answer key*) · constraints (time / money / surface / methodology)
  · instruments (a runnable CLI per constraint — "a constraint without an
  instrument is a vibe") · forced entropy (overfit-reflection each cycle;
  non-obvious jump on stall; iteration log). [P0 template]
- **Reward-hacking is a bug in the target, not the agent** — the 3-cheats→
  fences saga (memorize eval → blind it; learn-by-miss → widen; enumerate →
  hard caps). Bake a reward-hacking checklist into the gate; blind the grader.
  [P0/P2]
- **Constraints need instruments** → concrete schema for cost-cap + per-step
  token/$/time telemetry the agent can *query*; add wall-clock + spend HALT
  ceilings (agents have no sense of time). [P1]
- **Strategic:** distillation moved to prompt-time (public artifacts only);
  the new moat is **information asymmetry** — the private eval set / edge-case
  list / ground truth nobody else can score against (cal.com went closed in
  Apr 2026 citing exactly this). Keep AutoClaw's eval/ground-truth private
  even where code is open; note for security-review + MONETIZATION framing.
- **Tool to study:** `github.com/elvisun/loss-function-development` (`/lfd-
  design` generates the harness+goal) — model for an AutoClaw rubric/harness-
  designer skill. [P2]

**Comment harvest (read live from X via CDP-attached Chrome).** Folded into
the two research-doc addenda. Keepers:
- **Phase × model × effort routing** (practitioners @daniel_mac8, @cjzafir):
  Fable orchestrator (Max) + Opus reasoning phases; or Fable-high plan →
  Codex-xhigh execute → Fable-max review. Route *per phase*; workers can be
  cross-vendor (Codex). Sharpens the [P0] routing item.
- **@steipete orchestrator recipe:** orchestrator skill + triage + autoreview +
  computer-use skills, **wake every 5 min, dispatch to threads** — AutoClaw's
  shape as a recipe. Adds: fixed wake cadence + composable specialist skills.
- **Two reference repos:** `serenakeyitan/awesome-agent-loops` (nested-loop
  arch — "timer outside, condition inside, skill innermost") and
  `yucai0302/memory-loop` (productized STATE.md: hot/cold `.claude/memory/`,
  SessionStart/Stop hooks, `/save` + `/compress` at ~8K chars — near-drop-in
  reference for kdream; adopt auto hot/cold compaction). [P2 refs]
- **Bounded-autonomy add (@ToolRadarAI):** ship **audit logs + diffs + a kill
  switch** (operator stop for the whole fleet, beyond cycle-ceiling HALT). [P1]
- **Unverified rumor:** "Mythos system prompt leak" (Fable = agentic harness,
  not raw model) — do not build on; noted only as it echoes the thesis.

**Verified current-state + spec (2026-06-12).** Two read-only code sweeps
confirmed the gaps are real (not speculation): router scores
capability×trust×idle/cost but ignores model tier (`orchestrate.ts:482`);
`evaluateConsensus` (`:1404`) is votes-only — quality-gate commands not wired;
no reviewer≠author rule (`:1310`); heartbeat-v2 budgets specced but not
implemented; no fleet kill switch / `max_cycles` not runtime-enforced; kdream
has read/write discipline but no provenance/hot-cold; no per-task work-state
resume; no worktree isolation; no goal/outcome loop. **Verdict:** the articles
aren't a better *architecture* (ours is right, in places richer) — they're the
*operating discipline* to finish what we spec'd + ~3 net-new ideas (goal loop,
reward-hacking fences, work-state resume).

**The top-3 (lowest-effort/highest-ROI) are now specced:**
`docs/specs/orchestrate-gates-and-routing.spec.md` (draft) — (A) reviewer≠author
self-vote exclusion, (B) tier×phase routing as a soft multiplier on the existing
scorer, (C) acceptance-command gate that blocks green votes over a red check.
All opt-in / backward-compatible.

**Pilot (A) LANDED 2026-06-12** (dev-beta, not yet committed). `evaluateConsensus`
now takes optional `ctx?:{author_agent_id?}`; author self-votes are excluded
from the tally (fresh-context verifier), full list preserved on result +
`excluded_self_review`. Spec → status `pilot`, step 1 done. +4 tests, 106
orchestrate tests green, `tsc` clean, CHANGELOG `[Unreleased]` entry added.
Next: spec step 2 (wire callers in `bridge.ts`/`extension.ts` to pass the
claimant as `author_agent_id` + exclude the author from review-request
targeting), then features (C) acceptance-command gate and (B) tier×phase routing.

**Steps 2 + C + B LANDED 2026-06-12** (dev-beta, uncommitted) — ran concurrently
via the mateam pattern: a background `Agent` subagent did GR-2 (disjoint files:
`comms.ts`+`bridge.ts`+`extension.ts`) while the main agent did GR-C+GR-B in
`orchestrate.ts`. Dogfooded the comms tree: `task_assign`→`inboxes/shared`,
`task_complete`→shared, `review_request`→kilocode; mateam scratch at
`.autoclaw/mateam/scratch/2026-06-12-orchestrate-gates/`.
- **GR-2 (live):** `readClaimAuthor` in comms.ts; both consensus call sites pass
  `author_agent_id`; `computeReviewers` already excluded the author.
- **GR-C (lib):** `runAcceptanceChecks`/`acceptanceMet`/`applyAcceptanceGate` +
  `AcceptanceCheck`/`GateCheckResult`/`gate_checks` — red check blocks green votes.
- **GR-B (lib):** `MODEL_TIER`/`PHASE_PREF`/`tierFactor` soft multiplier in
  `scoreAgent`; no-op when phase/llms absent.
- **Verified:** `tsc` clean; **197 tests passing** (+13 new). Spec steps 2/3/4
  marked DONE/LIB-DONE.
- **Remaining (next slice):** live activation of B/C — populate `task.phase`, map
  registry `llms_available` into the planner's ScorableAgent, invoke the gate
  (`runAcceptanceChecks`→`applyAcceptanceGate`) at the review call sites.

## M. V4 vision + plan (2026-06-12)

User steering (captured in memory `project_v4_vision_steering`): onboarding for
all skill levels; dev-team org model; heterogeneous fleet visibility;
**delegated autonomy, not hub-and-spoke**; reputation-based spawning; memory
overhaul. Clarified: `/loop`+`/schedule` are Claude Code natives — AutoClaw
supplies prompts/config for them, never reimplements.

Deliverables this wave:
- **`docs/V4_PLAN.md`** — 8 pillars (ONB/ORG/VIS/FED/REP/MEM/HKS/QLT) with
  epics, grounded in a full repo inventory (FleetPanel, 9 runners, subcontract
  machine, personas, tiered bi-temporal memory all already exist — v4 is mostly
  closing loops between existing systems). Sequenced v3.4 → v3.5/3.6 → v4.0.
- **`docs/specs/agent-trigger-hooks.spec.md`** — event→action hooks (wake agents
  on comms/build events) + fleet HALT kill switch + audit + no-self-amplification.
- INDEX.md + BACKLOG.md updated (v3.4 wave: QLT-0, HKS-1..3, REP-1, ONB-2, MEM-1).
- GR-LIVE (live activation of gates+routing) running via background subagent.

## N. Cross-pollination — openclaw/crabbox (2026-06-13)

User: "consider crabbox and what we can learn from it … validate methods and
borrow the ideas and useful stuff — add to ours and keep building."

**What crabbox is.** A remote test/command execution control plane for
maintainers + AI agents (Go CLI + Cloudflare-Worker broker + SSH runners). Core
move: **control plane / data plane split** — the broker only does leasing,
credentials, cost caps, observability; sync (rsync)/SSH/exec go CLI→runner
direct. Same openclaw org as our model-oracle ([[reference_claw002]]), so
ecosystem-aligned, not a random import.

**Methods validated (read live from the repo, not memory):**
- **Run handles** — every coordinator-backed run gets an early `run_…` id;
  `attach`/`events`/`logs` query it during + after completion. ✓
- **Failure capsules** — `capsule from-actions <run-url>` → portable replayable
  bundle → `capsule replay` re-runs a broken CI run. Failed runs auto-save
  `.crabbox/captures/*.tar.gz`. ✓
- **Evidence** — history/logs/events/telemetry/JUnit/screenshots/recordings/
  artifacts; `--timing-json` = one machine-readable sync/command/total schema. ✓
- **Cost** — per-lease + monthly spend caps reject over-budget leases;
  `crabbox usage` rolls spend up by user/org/provider/type. ✓

**What maps onto what we already have (read-only sweep confirmed):** our
`ConsensusResult.gate_checks` + `runAcceptanceChecks` are the *inputs*; the
reputation ledger (`src/reputation/`) and cost ledger (`src/llm/costLedger.ts`)
are the *rollups*; the relay (`src/relay-server/` + `src/cloud/relay.ts`) is
already a **broker(control)/direct(data) split** — relay carries heartbeats +
encrypted inboxes only; work stays local. So crabbox isn't a better
architecture; it's a working reference for **three things we'd specced but not
closed**: durable run handles, replayable failure capsules, cost-as-instrument.

**Borrowed + SHIPPED this wave (dev-beta, uncommitted): evidence capsules.**
The gap was that `evaluateConsensus` computed a verdict and **threw it away** —
a fresh-context verifier (reviewer≠author, §L) had nothing to re-inspect. New
`src/evidence/capsule.ts` (mirrors the `reputation/` module shape):
- `EvidenceCapsule` = stable `run-<isoZ>-<6hex>` handle + verdict + vote counts +
  `excluded_self_review` + the acceptance **recipe** (`acceptance_checks`, for
  replay) AND **results** (`gate_checks`) + `gates_passed` + machine-readable
  `timing` + artifact pointers.
- `bridge.ts` `…/consensus/{tid}/evaluate` now persists a capsule to
  `comms/consensus/results/<task>-<run>.json` (atomic tmp+rename) and returns
  `run_id`. New `GET /api/v1/capsules?task=` (list, newest-first) +
  `GET /api/v1/capsules/<run_id>` (fetch) = our `events`/`logs` analog.
- `replayFailedGates(capsule)` = our `capsule replay` — re-runs **only** the red
  checks via `runAcceptanceChecks`, reports pass/fail, so a verifier confirms a
  fix from the durable record without redoing the whole review.
- Local-first, best-effort (write never blocks eval), zero-config no-op when no
  gate ran. **+14 tests; 1039 passing; tsc clean.** CHANGELOG `[Unreleased]`.

**Deliberately NOT borrowed (recorded so we don't relitigate):**
- The **stack** (Go + Cloudflare Workers/Durable Objects) — conflicts with
  TS/VS-Code + local-first; same "borrow shape, not framework" rule as LangGraph/
  Hindsight (§C/§E). The Worker-broker is at most an optional WAN tier.
- **`tar.gz` capture bundles** — our evidence is small JSON; revisit only if we
  start capturing large artifacts (screenshots/recordings) for the vision-verify
  gate (§L [P2]).
- **License** — verify crabbox's license before lifting any *code* (we lifted
  only the pattern/shape, wrote our own TS).

**Next slices:**
1. **Cost-as-instrument** — ✅ SHIPPED 2026-06-13. `src/budget/ceiling.ts`:
   opt-in `.autoclaw/orchestrator/budget.json` (`max_spend_usd`/`max_wallclock_ms`)
   → `checkBudget` (queryable instrument: cost-ledger spend rollup + wall-clock
   from an armed epoch that survives restarts) → `enforceBudget` engages the
   existing fleet HALT switch once on breach. Wired into `dispatchWork`
   (journaled `dispatch_over_budget`). Zero-config no-op. +18 tests.
2. **Reputation join** — ✅ SHIPPED 2026-06-13. Evaluate path records a task
   outcome (`recordOutcomeOnce`, dedup by task_id+agent_id since evaluate is
   polled) feeding the capsule's `gates_passed`+verdict into the reputation
   ledger the router prefers; commsDir-relative ledger helpers added. +3 tests.
   Limitation: records the *first* terminal verdict per task; a later re-review
   of the same task id isn't re-recorded (acceptable for v1).
3. **`from-actions` analog** — ✅ SHIPPED 2026-06-13. `captureCapsule` /
   `captureFromChecks` (evidence module) mint a replayable capsule from a
   non-consensus run (failed autobuild / ingested CI log / manual), tagged with a
   `source` provenance field; verdict defaults from gate state. Replayable via
   the same `replayFailedGates`. +5 tests. (Wiring a trigger-hook build-failure →
   `captureFromChecks` is the natural follow-on; the primitive is now ready.)
4. **Panel surface** — ✅ SHIPPED 2026-06-13. `BoardModel.recent_capsules`
   (newest-first, capped 10) flows board.json → both panel renderers as a
   read-only "Recent evidence" strip below the kanban (task · verdict · gate ·
   votes · source · run). board.ts/boardWriter.ts/webview-render-board.ts +
   media/panel/fleet.js + CSS. +6 tests.
5. For **other projects** (ZippyVoice/Webster/ZippySwap): crabbox is a *tool*,
   not a lib — could be used directly as the ephemeral remote-test sandbox
   (E2B/Modal providers + spend caps) for agent-run suites. Faster win than any
   AutoClaw integration; no vendoring. **Status: recommendation only — no
   AutoClaw code change; revisit per-project when those test suites need
   ephemeral remote runners.**
