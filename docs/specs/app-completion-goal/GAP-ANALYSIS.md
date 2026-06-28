# AutoClaw Gap Analysis & Build Backlog

Generated: 2026-06-27 from feature-inventory survey (Workflow wf_8527469f-c7f).
Companion: [FEATURE-STATUS.csv](FEATURE-STATUS.csv) (324 features).

## ★ Key insight: the gap is WIRING, not missing features

Of 324 surveyed features, **226 are complete and only ~6 are stub/missing** — yet
**92 are "partial."** The dominant partial pattern is **built-and-unit-tested
subsystems that are never called from `extension.ts` / `package.json` / the live
dispatch path.** Examples (all from the P0/P1 backlog): the fleet panel + status
bar are never registered (BL-3), reputation scoring is never passed into dispatch
(BL-7 — the flagship multi-provider routing capability is *inert*), no production
code writes the LLM cost ledger (BL-6), the cloud-login and persona commands are
absent from `package.json` (BL-16/BL-9), run ledgers bypass the secret-scrubber
(BL-2 — a real leak risk). **Completion is mostly a wiring + activation effort,
which is cheaper than net-new features — but it concentrates on a few HOT shared
files (`extension.ts`, `package.json`), so it MUST be serialized through the
Coordination Kernel below rather than fanned out naively.**

## ★ BL-0 — Coordination Kernel (P0 substrate, BUILT this cycle)

The enforced-scope merge gate + isolated worktree harness — layer 1 of the
heterogeneous-coordination answer. Agents work on isolated branches/worktrees;
a branch lands ONLY through a gate that mechanically rejects any diff touching
files outside its claimed scope (and, optionally, a non-building/failing branch).
The advisory lease becomes an enforced merge precondition.

- `src/orchestrator/mergeGate.ts` — precise glob→path matcher (NOT the loose
  advisory heuristic in scopeLease.ts), scope partition, pure `evaluateMerge`
  decision, and `landBranch` (gate-before-merge; conflicts auto-aborted).
- `src/orchestrator/worktree.ts` — worktree lifecycle (create/remove/list,
  deterministic `wt/<agent>-<task>-<frag>` branch names, porcelain parsing,
  path-traversal hardening).
- `src/test/mergeGate.test.ts` + `src/test/worktree.test.ts` — **43 tests green.**

Status: built → adversarially verified (found **11 real scope-bypass/git-IO
defects**) → **hardened + re-tested**. Fixes: segment-based glob compiler
(`foo**`/`**.ts` no longer escape their dir), fail-closed `normalizePath`
(`..` segments + absolute paths are out-of-scope, not silently relativized),
`landBranch` guards (empty-diff no-op, base-SHA pin, detached-HEAD refusal,
post-merge re-diff + reset for TOCTOU, optional post-merge build), and
git-ref-safe worktree branch names. NEXT: make it the mechanism for all Phase-C
build sprints (each backlog item → worktree → gated land).

## Phase-C build progress

| Item | Status | Evidence |
|---|---|---|
| BL-0 Coordination Kernel | ✅ DONE | mergeGate.ts + worktree.ts + gitRunner.ts; 51 unit + 3 e2e; 3 verify rounds |
| BL-7 Reputation-aware dispatch | ✅ DONE | src/runners/reputationPreference.ts; 5 tests; F-325. *Flagship multi-provider routing now LIVE* (was inert). Follow-up: adopt at an un-targeted dispatch call site. |
| BL-6 cost ledger writer | ✅ DONE | LlmRegistry.chat() → CostLedger.append; 4 tests + 26 regression; F-326. Lights up budget/agentCost/fleetMetrics/ledgerBridge (were dormant for lack of data). |
| BL-14 loop-service runners | ✅ DONE (Sonnet→Opus-reviewed) | createDefaultRunnerRegistry registers loop_services[]; 9 tests; F-327 |
| BL-20 VoidSpec js-yaml parser | ✅ DONE (Sonnet→Opus-reviewed) | parseVoidSpecYaml on js-yaml; 14+26 tests; F-328 |
| Recursive learning loop | ✅ PROVEN | end-to-end test: routing flips after observed outcomes; F-329. Open: invoke reputation selection on an un-targeted production dispatch |
| Capability-aware routing | ✅ DONE (Sonnet→Opus-reviewed) | src/runners/capabilityRouting.ts; 10 tests; F-330. Routes by per-capability track record. ⚠ test:unit wiring DEFERRED until 3.6.9 commit lands |

> **Coordination hold (3.6.9):** another Claude Code session is committing 3.6.9 on master. While that commit is in flight, this session does **new-files-only** work and touches **no** `package.json`/`extension.ts`/existing files and makes **no** commits. PENDING after 3.6.9: wire `out/test/capability-routing.test.js` into `test:unit`; resume the existing-file Sonnet pipeline.
| BL-2 secret-scrub run ledger | ⬜ next | leak fix (src/workflows — HOT, serialize) |

### Cost-efficient delegation model (active)
Mechanical/well-specified wirings are delegated to **Sonnet subagents** (≈3× cheaper than Opus), each on a disjoint scope with no hot-file edits; **Opus reviews** (reads the diff + re-runs compile/tests/regressions) and approves or sends back, then wires `test:unit` + records. First batch: 3 tasks, ~169k Sonnet tokens, all approved on first pass, 64/64 verified.
| BL-3 fleet panel wiring | ⬜ | hot: extension.ts + package.json (serialize) |

## Status rollup

| Status | Count |
|---|---|
| complete | 226 |
| partial | 92 |
| stub | 4 |
| missing | 2 |
| unknown | 0 |
| **total** | **324** |

## By area (partial+stub+missing = work remaining)

| Area | complete | partial | stub | missing | remaining |
|---|--:|--:|--:|--:|--:|
| agents-glue | 16 | 6 | 0 | 0 | 6 |
| distributed | 14 | 6 | 1 | 1 | 8 |
| extension | 30 | 5 | 0 | 0 | 5 |
| fleet | 16 | 7 | 0 | 0 | 7 |
| intelligence | 29 | 2 | 0 | 0 | 2 |
| interop | 13 | 5 | 1 | 0 | 6 |
| llm | 11 | 7 | 0 | 0 | 7 |
| monetization | 15 | 5 | 2 | 0 | 7 |
| orchestrator | 25 | 2 | 0 | 0 | 2 |
| platform | 6 | 6 | 0 | 0 | 6 |
| runners | 12 | 9 | 0 | 0 | 9 |
| skills | 13 | 8 | 0 | 0 | 8 |
| state-plane | 6 | 13 | 0 | 0 | 13 |
| ui | 10 | 5 | 0 | 0 | 5 |
| workflows | 10 | 6 | 0 | 1 | 7 |

## Missing components

- Visual Workflow Lab webview (WL-5): no src/views/workflowLab.ts, no media/workflow-lab/* assets, no full-tab graph editor — only the headless run command exists. BACKLOG QLT/WL-1 is open.
- Hosted (paid) relay with server-side entitlement gate (AF-10b): no tier/subscription/402/429/max_machines logic anywhere in src/relay-server — only comment seams. Spec still draft.
- MCP extended endpoints module (install-extended.ts): EXTENDED_TOOLS (fleet.dispatch, voidspec.sync) never registered into READ_ONLY_TOOLS/WRITE_TOOLS or server tool set — entirely orphaned, no test.
- Real computer-use GUI driver: createPlaywrightDriver is a lazy stub (focus/click/type return 'available', screenshot returns false) — no real Electron/CDP session ever opened. Real GUI automation unbuilt.
- Production LLM CostLedger writer: no `new CostLedger(...).append()` in non-test code — readers (budget/ceiling, agentCost, fleetMetrics, ledgerBridge) consume a file nothing in the LLM flow writes.
- Connector LOADER/factory execution: ConnectorFactory/Connector are types only — runner/source/presence faces are never resolved or run; no npm-scope (@autoclaw/connector-*) discovery.
- out/lmd/daemon.js subprocess entry: fleet-start references a subprocess daemon path that is never built/shipped — subprocess LMD mode is dead and always falls back to in-process.
- Real Claude Agent SDK transport for Claude Code runner: still CLI-based; SDK packages not yet dependencies (TODO swap).
- Streaming/SSE support in OpenAI-compatible base provider despite capabilities.streaming=true (chat always sends stream:false).
- Per-host doctor UI consuming runner HealthReport: no code in src/runners reads health reports into a doctor surface.

## Partial/stub → complete (impact order)

- Wire the dedicated workflow node executors into the runner: runner.ts inlines its own agent/tool executors and never calls runModelNode/runToolNode/routeWorkflowIntent — only runGateNode is wired. Unifies model/tool/intent-router seams that are separately tested but unused in real runs.
- Unify the two ledger implementations: runner uses state.ts WorkflowRunLedger (sync, NO scrubbing) so real-run events bypass scrubSensitive in runLedger.ts. Route runner writes through the scrubbing ledger.
- Enforce workflow contract preflight in real runs: runWorkflow only calls validateWorkflow, not validateWorkflowContract — invariant/permission preflight not enforced live.
- Branch the recursive loop executor on loop 'kind' and evaluate stopOn/noProgress expressions — currently all loop kinds run the same generic loop and the named patterns are documentation only.
- Wire fleet panel + status bar into extension.ts/package.json: registerFleetPanel/registerFleetStatusBar never called, no 'autoclawFleet' view, autoclaw.fleet.refresh/openFleetPanel not contributed. Sidebar is filled by KDreamViewProvider instead.
- Surface remote-agents/cloud section: cloudSection builder is tested but gatherFleetData never calls it and fleet.js render() has no remote-agents section — Manager Surface shows no cloud agents.
- Wire reputation into live dispatch: performance.ts scorer + RunnerRegistry.getPreferred + reputationFactor/aggregateReputation exist but no production caller passes reputationByRunnerId into dispatchViaRegistry; Pro 'reputation-aware assignment' is advertised but locked/unwired.
- Make dispatchViaRegistry / resolveEffectiveTrust the live dispatch path: default extension path uses dispatchWork queue; dispatchViaRegistry only reachable behind AUTOCLAW_RUNNER_DIRECT_DISPATCH env flag and passes flat trust, not scope.
- Register loop_services[] config runners: loopServiceRunnersFromConfig parses config.yaml loop_services but is never registered into createDefaultRunnerRegistry — HTTP loop services never detected at runtime.
- Wire the periodic reconciler: createOrchestratorReconciler scheduler is a standalone API never invoked from orchestratorLoop.ts (loop does inline board write + consensus reconcile).
- Route sprint-status changes through the state machine: no stateMachine.test.ts and unclear the live loop uses it (uses boardAutotransition forward-ranking instead).
- Make driftToOpsTask cover all drift types: task_in_state_not_in_yaml and comms-not-yaml/state return null — they broadcast but never become claimable ops tasks.
- Wire the persona slash command: registerPersonaCommand never called from extension.ts, autoclaw.persona absent from package.json — command unreachable; also route 'claude-code-runner' persona provider to the real src/runners/claude-code.ts instead of the synthetic stub.
- Wire fleet-start + fleet-watch into the extension: watchFleetCommand/'Watch Fleet' and 'Start Fleet' exported but not registered; autoclaw.fleet.start/autoclaw.watchFleet absent from package.json; status-bar items never bound; chains pass no runner seam so 'runner' strategy always skips. Fix solo-sprint template runner 'claude-code' not in KNOWN_RUNNERS.
- Wire bitemporal recall as the single recall path: live recall.query MCP tool reimplements a token scan over dream/MEMORY.md instead of calling recallQuery over the fact store; registerMemorySkills (autoclaw.dream/recall) never called from extension.ts and not in package.json.
- Add LLM CostLedger writes in registry.chat and llm.chat MCP tool: registry.chat does not append to the CostLedger (writer unwired) and retry-after is hardcoded 60s; llm.chat audits message ledger but not the ZICO CostLedger.
- Wire the failsafe installer into registry getPreferred and spawn the :11435 serve process — doc claims it's called on first getPreferred but registry never imports it; only pull+detect ship.
- Wire externalRouterUrl peer server: never instantiated in activation; autoclaw.llm.peerEnabled setting absent from package.json; no production suggest() implementation.
- Wire governance gate + audit log into a real dispatch path (gateDispatch never invoked) and inject real RunnerLookup/ConsensusEngineBridge into LMD stall recovery (defaults are warn-only stubs → re-kick and quorum exclusion are no-ops).
- Instantiate the LMD multi-machine GossipRing in a production code path (defined+tested but dormant); replace NATS gossip transport TODO stubs with real publish/subscribe.
- Wire cloud login command: extension UI says 'Run AutoClaw: Cloud Login' but autoclaw.cloud.login is absent from package.json — reachable only via exported API.
- Wire the program-scope state-plane builders (addRepoToProgram registry, cross-repo comms tail, program-wide Agents table, program scope-leases, cross-project API dependency registry) into a panel/command/MCP consumer; reconcile addRepoToProgram registry vs the separate program-plane.ts used by the live commands.
- Wire capsule replay + capture-from-actions (replayFailedGates/captureFromChecks) behind a command/MCP/HTTP route — only buildCapsule path is live.
- Wire conflictDetection pre-push and browserCapability provisioning into production callers (both tested but no caller); add their tests to CI test:unit.
- Replace hand-rolled VoidSpec parseVoidSpecYaml with a real YAML parser (js-yaml now in deps) and auto-start watchVoidSpecDir from the extension (currently one-shot only); implement runner-voidspec dispatch.
- Wire the workflow simulate/dry-run + test harness behind a command/CLI and reconcile the harness's mock walker with the real runWorkflow engine so semantics don't diverge.
- Add a production scheduler that applies memory tier transitions (core/recall/archive promotion) and persona promoteLessons/mirrorToGlobal — pure planners are tested but nothing writes the on-disk tiers or recall/index.json sidecar.

## Cross-cutting gaps

- Pervasive 'built but unwired' pattern: dozens of tested pure-core modules (workflow node executors, intent router, reputation scorer, governance gate, LMD gossip/recovery, fleet panel/statusbar, persona command, fleet-start/watch, externalRouterUrl, CostLedger writer, program-plane builders, bitemporal recall) have no production caller. The library layer is mature; the activation/wiring layer is the dominant gap.
- Missing command contributions in package.json: many registered or exported commands are absent from contributes.commands (autoclaw.fleet.start, autoclaw.watchFleet, autoclaw.fleet.refresh, autoclaw.openFleetPanel, autoclaw.persona, autoclaw.cloud.login, autoclaw.addRepoToProgram, autoclaw.intelligence.startWatch/stopWatch, autoclaw.dream/recall) — not discoverable in the command palette.
- Test coverage holes at the seams: many command handlers, webviews (dashboard, manager, fleet, support), and runner adapters (cursor/kiro/gemini/codex/openclaw/hermes/lmstudio) have NO dedicated test file; coverage is only at the underlying pure-core layer.
- CI test:unit uses an explicit file list, so several existing tests do NOT run in CI: fleet-watch.test.ts, conflictDetection.test.ts, and any newly added test must be explicitly added or it is silently skipped.
- Monetization enforcement is dormant by design (commercial-use licensing), but several gate seams are dead code (NagService never instantiated, requireHosted/allowByoForHosted have no live caller, withGate is a no-op, 20 of 24 feature ids never checked) — needs an explicit decision: wire or delete to reduce confusion.
- Divergent duplicate implementations that can drift: two run-ledgers (runLedger.ts vs state.ts), two recall paths (recallQuery fact-store vs tools.ts token scan over MEMORY.md), two program-scope registries (state-plane vs program-plane.ts), two scope-lease primitives (program-plane vs orchestrator/scopeLease.ts), local per-runner trust maps (CODEX/OPENCLAW/HERMES) vs central TRUST_PRESET_TABLE.
- Cross-agent adapters are hand-maintained (not generated by scripts/adapters) so they can drift from canonical docs/AGENT_SESSION_PROTOCOL.md; several persona/runner skills are not in SKILL_NAMES/SHIPPED_SKILLS so no per-IDE adapter is generated and the launcher doesn't offer them.
- No husky/pre-commit hook (.husky absent): the secret/private-code guard --staged mode and adapters-drift check rely on manual runs or CI only — local enforcement missing.
- Real GUI/computer-use automation is a stub end-to-end (driver returns 'available', screenshots never written) — the entire computer_use keep-alive strategy and audit screenshots are inert until a real driver lands.

## Prioritized build backlog

| ID | P | Effort | Area | Title | Why | Suggested scope |
|---|---|---|---|---|---|---|
| BL-1 | P0 | L | workflows | Wire dedicated workflow node executors (model/tool/intent) into the runner | The runner inlines its own agent/tool executors and never calls runModelNode/runToolNode/routeWorkflowIntent; only gates are wired. Real runs diverge from the separately-tested seams (mockResponse short-circuit, mcp/action dispatch, intent routing all unused), so the headless engine cannot do real model/tool/MCP work. | src/workflows/runner.ts, src/workflows/nodes/modelNode.ts, src/workflows/nodes/toolNode.ts, src/workflows/router.ts, src/test/workflow-*.test.ts |
| BL-2 | P0 | M | workflows | Route runner ledger writes through the scrubbing ledger | Runner uses state.ts WorkflowRunLedger (sync, no scrubbing) so real-run events bypass scrubSensitive — a secrets-leak risk in run ledgers that ship as evidence. Unify on runLedger.ts. | src/workflows/runner.ts, src/workflows/runLedger.ts, src/workflows/state.ts, src/test/workflow-ledger*.test.ts |
| BL-3 | P0 | M | ui | Wire fleet panel + status bar into extension and package.json | registerFleetPanel/registerFleetStatusBar are never called; no autoclawFleet view, no fleet.refresh/openFleetPanel commands. The dedicated fleet UI is dark and the sidebar role is improvised by KDreamViewProvider — core fleet visibility value is unreachable through its intended surface. | src/extension.ts, package.json, src/views/fleetPanel.ts, src/statusbar/*.ts, src/test/fleet-panel.test.ts |
| BL-4 | P0 | M | ui | Surface remote-agents/cloud section in fleet data + renderer | cloudSection builder is tested but gatherFleetData never calls it and fleet.js has no remote-agents section. Cross-machine/cloud relay agents (a headline distributed feature) are invisible to users. | src/fleet/fleetData.ts, src/views/cloudSection.ts, media/panel/fleet.js, src/manager/*.ts, src/test/cloudSection.test.ts |
| BL-5 | P0 | M | platform | Wire fleet-start and fleet-watch into the extension | 'Start Fleet' and 'Watch Fleet' are exported with explicit TODO(extension) markers but not registered; autoclaw.fleet.start/autoclaw.watchFleet absent from package.json; chains pass no runner seam so revive never re-kicks. Booting/keeping a fleet alive is a primary user action with no in-editor entry point. | src/extension.ts, package.json, src/platform/fleet-templates.ts, src/platform/fleet-watch.ts, src/platform/fleet-start.ts |
| BL-6 | P0 | M | llm | Add a production LLM CostLedger writer and wire registry/MCP cost recording | No `new CostLedger().append()` exists in non-test code, yet budget ceiling, agentCost, fleetMetrics and intelligence ledgerBridge all read it. Cost/budget enforcement and per-agent cost rollups are non-functional because nothing writes the ledger. | src/llm/registry.ts, src/llm/costLedger.ts, src/interop/tools.ts, src/test/llm-*.test.ts |
| BL-7 | P0 | L | runners | Wire reputation scoring into the live dispatch path | performance.ts scorer, RunnerRegistry.getPreferred, and reputationFactor/aggregateReputation all exist and are unit-wired, but no production caller passes reputationByRunnerId into dispatch. Pro 'reputation-aware assignment' is advertised but locked/unwired — a flagship routing capability is inert. | src/extension.ts, src/runners/registry.ts, src/runners/dispatch.ts, src/fleet/performance.ts, src/state-plane/reputation*.ts |
| BL-8 | P1 | M | workflows | Enforce workflow contract preflight in real runs | runWorkflow only calls validateWorkflow, not validateWorkflowContract — invariant/permission/contract preflight is skipped during actual execution, so permission gates and invariants are unenforced live. | src/workflows/runner.ts, src/workflows/contract.ts, src/test/workflow-contract*.test.ts |
| BL-9 | P1 | M | agents-glue | Wire the persona slash command and route to the real Claude Code runner | registerPersonaCommand is never called and autoclaw.persona is absent from package.json — /persona is unreachable for end users. The 'claude-code-runner' persona provider is still a synthetic placeholder instead of the real src/runners/claude-code.ts shell-out. | src/extension.ts, package.json, src/agents/persona/command.ts, src/agents/persona/provider-stub.ts, src/runners/claude-code.ts, src/test/persona-*.test.ts |
| BL-10 | P1 | M | orchestrator | Wire the periodic orchestrator reconciler into the loop | createOrchestratorReconciler is a standalone scheduler never invoked from orchestratorLoop.ts; the loop does inline board+consensus reconcile only, so periodic drift sweeps across truth sources never fire on a cadence. | src/orchestrator/orchestratorLoop.ts, src/orchestrator/reconcile.ts, src/test/orchestrator*.test.ts |
| BL-11 | P1 | S | orchestrator | Make driftToOpsTask cover all drift types | task_in_state_not_in_yaml and comms-not-yaml/state drifts return null — they broadcast but never become claimable ops tasks, so a class of drift is surfaced-but-never-actioned. | src/orchestrator/opsTasks.ts, src/orchestrator/reconcile.ts, src/test/orchestrator-ops*.test.ts |
| BL-12 | P1 | L | workflows | Branch the recursive loop executor on loop kind and evaluate stop/noProgress expressions | LoopNodeConfig declares retry/generate-verify-revise/best-of-N/etc. kinds and stopOn/noProgress expressions, but readPolicy/runLoopNode run one generic loop and never evaluate the expressions — the named recovery patterns are documentation, not behavior. | src/workflows/nodes/loopNode.ts, src/workflows/runner.ts, src/test/workflow-loop*.test.ts |
| BL-13 | P1 | L | state-plane | Unify recall on the bitemporal fact store and wire dream/recall commands | The live recall.query MCP tool reimplements a token scan over dream/MEMORY.md instead of recallQuery over the fact store; archive/as-of return not_implemented; registerMemorySkills (autoclaw.dream/recall) is never called and absent from package.json. Two divergent recall paths and an unreachable time-travel recall. | src/interop/tools.ts, src/state-plane/recall*.ts, src/state-plane/bitemporal*.ts, src/extension.ts, package.json |
| BL-14 | P1 | M | runners | Register loop_services[] config runners into the default registry | loopServiceRunnersFromConfig parses config.yaml loop_services[] but is never registered into createDefaultRunnerRegistry — config-driven HTTP loop services (AutoGPT/LocalCoder/generic) are parseable but never detected or dispatchable at runtime. | src/runners/defaultRegistry.ts, src/runners/loopService.ts, src/test/runner-loopservice*.test.ts |
| BL-15 | P1 | XL | workflows | Build the Visual Workflow Lab webview (WL-5) | Only the headless run command exists; BACKLOG QLT/WL-1 is open. A graph editor/run-visualizer is the user-facing payoff of the whole workflow engine and a likely Pro-Teams surface. | src/views/workflowLab.ts, media/workflow-lab/*, src/extension.ts, package.json, src/test/workflowLab*.test.ts |
| BL-16 | P1 | M | distributed | Wire cloud login command and peerEnabled setting | Extension UI tells users to 'Run AutoClaw: Cloud Login' but autoclaw.cloud.login is absent from package.json (reachable only via API); externalRouterUrl peer and autoclaw.llm.peerEnabled gate are likewise unwired. Relay/peer onboarding is blocked at the entry point. | src/extension.ts, package.json, src/distributed/cloudLogin.ts, src/llm/externalRouter.ts |
| BL-17 | P2 | XL | agents-glue | Implement a real computer-use GUI driver (Playwright/CDP) | createPlaywrightDriver is a stub: focus/click/type return 'available' and screenshot returns false, so no Electron/CDP session is opened and audit screenshots are never written. The entire computer_use keep-alive strategy is inert. | src/agents/keepalive/computerUse.ts, src/agents/keepalive/audit.ts, src/test/computerUse*.test.ts |
| BL-18 | P2 | L | distributed | Wire governance gate + audit and real LMD stall recovery | gateDispatch/audit log are never invoked by a real dispatch path, and LMD RunnerLookup/ConsensusEngineBridge default to warn-only stubs so re-kick and quorum exclusion are no-ops. Self-healing and governance are advertised but do nothing live. | src/distributed/governance.ts, src/distributed/lmd/recovery.ts, src/extension.ts, src/orchestrator/orchestratorLoop.ts |
| BL-19 | P2 | L | runners | Make dispatchViaRegistry the default dispatch path with scope-based trust | Default extension path uses the dispatchWork queue; dispatchViaRegistry (and resolveEffectiveTrust per-agent scope.json) only run behind AUTOCLAW_RUNNER_DIRECT_DISPATCH and pass a flat trust string. Per-agent trust scoping and reputation-weighted dispatch never apply in shipped builds. | src/extension.ts, src/runners/dispatch.ts, src/runners/scope.ts, src/hooks/spawnRunner.ts |
| BL-20 | P2 | M | state-plane | Replace VoidSpec hand-rolled parser with js-yaml and auto-start the watcher | parseVoidSpecYaml is a hand-rolled parser that breaks on nested/multiline YAML (VF-1); watchVoidSpecDir is exported but the command only does a one-shot sync (VF-3 runner not implemented). js-yaml is now a dependency, so the real parser is a cheap correctness win. | src/state-plane/voidspec*.ts, src/extension.ts, src/test/voidspec*.test.ts |
| BL-21 | P2 | L | state-plane | Wire program-scope state-plane builders into a panel/command/MCP consumer | addRepoToProgram registry, cross-repo comms tail, program-wide Agents table, program scope-leases and the cross-project API dependency registry are all tested but have zero production consumers, and the live program commands use a DIFFERENT program-plane.ts. Multi-project orchestration value is stranded and the duplication invites drift. | src/state-plane/program*.ts, src/program-plane.ts, src/extension.ts, src/manager/*.ts, src/interop/tools.ts |
| BL-22 | P2 | M | llm | Wire the failsafe LLM installer and serve process | The failsafe installer (qwen3:0.6b @ :11435) documents 'called from registry on first getPreferred' but registry never imports it, and it never spawns the serve process (pull+detect only). The local-LLM safety net that guarantees a working provider is unwired. | src/llm/registry.ts, src/llm/failsafe.ts, src/test/llm-failsafe*.test.ts |
| BL-23 | P2 | M | llm | Add streaming/SSE support to the OpenAI-compatible base provider | capabilities.streaming=true but chat always sends stream:false, so LM Studio/Ollama/OpenAI-compatible providers never stream — affects responsiveness for any UI consuming token streams. | src/llm/providers/openaiCompatible.ts, src/llm/providers/lmstudio.ts, src/test/llm-provider*.test.ts |
| BL-24 | P2 | M | monetization | Decide and either wire or remove dormant monetization gate seams | NagService is never instantiated, requireHosted/allowByoForHosted/withGate have no live callers, and 20 of 24 feature ids are never checked. Per the commercial-use-licensing decision these are intentionally off, but as shipped they are dead code that confuses reviewers and risks accidental activation. Make the seam explicit (compile-time flag or removal). | src/licensing/nagService.ts, src/gateLogic.ts, src/licensing/entitlement.ts, docs/ideas/PUBLIC-PRIVATE-SPLIT-AND-RELEASE-PLAN.md |
| BL-25 | P2 | M | state-plane | Wire capsule replay + capture-from-actions behind commands/MCP | replayFailedGates and captureFromChecks have no production caller — only buildCapsule is wired. Evidence-replay (a Pro evidence-quality differentiator) is unreachable. | src/state-plane/capsule*.ts, src/extension.ts, src/interop/tools.ts, package.json |
| BL-26 | P2 | L | state-plane | Add a memory-tier scheduler that applies promotions to disk | Hierarchical memory tier planners (core/recall/archive) and persona promoteLessons/mirrorToGlobal are tested but no production scheduler applies transitions to on-disk tiers and the recall/index.json sidecar is never written. Memory promotion is purely theoretical at runtime. | src/state-plane/memoryTiers.ts, src/agents/persona/memory.ts, src/extension.ts, src/orchestrator/orchestratorLoop.ts |
| BL-27 | P2 | S | platform | Add a pre-commit hook (husky) running secret + adapter-drift guards | No .husky present; the secret/private-code guard --staged mode and adapters:check rely on manual runs/CI only. A pre-commit hook closes the local enforcement gap that the steering rules require before any packaging. | .husky/*, package.json, scripts/check-no-secrets.js, scripts/check-adapters.js |
| BL-28 | P2 | S | platform | Add the unrun tests to the CI test:unit explicit file list | CI test:unit uses an explicit list, so fleet-watch.test.ts and conflictDetection.test.ts (and any new test) don't run in CI. Existing coverage isn't protecting against regressions. | package.json, src/test/fleet-watch.test.ts, src/test/conflictDetection.test.ts |
| BL-29 | P2 | M | agents-glue | Wire conflictDetection pre-push and browserCapability provisioning to real callers | conflictDetection (pre-push branch conflict) and browserCapability (Playwright MCP fallback resolution) are self-contained and tested but have no production caller despite docstrings claiming the orchestrator/dispatcher invokes them. | src/agents-glue/conflictDetection.ts, src/state-plane/browserCapability.ts, src/orchestrator/orchestratorLoop.ts, src/runners/dispatch.ts |
| BL-30 | P2 | L | runners | Add dedicated tests for runner adapters (cursor/kiro/gemini/codex/openclaw/hermes/lmstudio) | Seven runner adapters and the LM Studio provider have NO dedicated test file; listSessions/cancel/trust-translation behaviors are unverified. These are the integration surfaces most likely to silently break against external CLI changes. | src/test/runner-cursor.test.ts, src/test/runner-kiro.test.ts, src/test/runner-gemini.test.ts, src/test/runner-codex.test.ts, src/test/runner-openclaw.test.ts, src/test/runner-hermes.test.ts, src/test/llm-lmstudio.test.ts |
| BL-31 | P3 | M | runners | Centralize runner trust on TRUST_PRESET_TABLE | Codex (CODEX_TRUST_FLAGS), OpenClaw (OPENCLAW_TRUST) and Hermes (HERMES_AUTONOMY) use local trust maps instead of the central TRUST_PRESET_TABLE — trust-preset semantics can diverge per runner, undermining the unified trust model. | src/runners/codex.ts, src/runners/openclaw.ts, src/runners/hermes.ts, src/runners/trust.ts |
| BL-32 | P3 | S | extension | Add command contributions for hidden registered commands | autoclaw.intelligence.startWatch/stopWatch are registered but absent from contributes.commands, so they're not discoverable in the palette (callable only programmatically). Same pattern for other registered-but-uncontributed commands. | package.json, src/extension.ts |
| BL-33 | P3 | M | skills | Generate per-IDE adapters for persona/runner/loop skills | architect/doc-writer/security-auditor personas, hermes/openclaw runners and the loop-discipline skill are not in SKILL_NAMES/SHIPPED_SKILLS, so no per-IDE adapter is generated and the launcher doesn't offer them — and cross-agent adapters are hand-maintained and can drift from docs/AGENT_SESSION_PROTOCOL.md. | scripts/adapters/*, skills/**/SKILL.md, src/skills/launch*.ts |
| BL-34 | P3 | M | interop | Register or remove the orphaned MCP extended-endpoints module | install-extended.ts (EXTENDED_TOOLS: fleet.dispatch, voidspec.sync) is entirely orphaned — never added to the server tool set, imported nowhere, untested. Either wire fleet.dispatch/voidspec.sync into the MCP server or delete to avoid dead surface area. | src/interop/install-extended.ts, src/interop/server.ts, src/interop/tools.ts, src/test/mcp-*.test.ts |
| BL-35 | P3 | L | ui | Add webview/command-handler tests for dashboard, manager, fleet and support panels | Dashboard, Manager Surface, fleet panel, support/donate panels, section-search persistence, and snapshot/TODO/mark-complete message handlers have no UI-layer tests — only underlying data providers are covered, leaving render/message-routing regressions unguarded. | src/test/dashboard*.test.ts, src/test/manager*.test.ts, src/test/fleet-panel.test.ts, src/test/support*.test.ts |
| BL-36 | P3 | L | interop | Build a real connector loader/factory and npm-scope discovery | acp/1 ConnectorFactory/Connector are types only — runner/source/presence faces are never resolved or run, and @autoclaw/connector-* npm discovery is absent. The connector platform can validate manifests but cannot actually load or run a connector. | src/connector/loader.ts, src/connector/discovery.ts, src/connector/factory.ts, src/test/connector-*.test.ts |
| BL-37 | P3 | S | extension | Make the Enable-All toggle actually flip feature flags | 'Enable All Autonomous Features' is purely a confirmation toast and toggles nothing — a misleading affordance for the headline autonomy promise. | src/extension.ts, src/config/*.ts |
| BL-38 | P3 | L | distributed | Implement hosted (paid) relay entitlement gate (AF-10b) | src/relay-server has no tier/subscription/402/429/max_machines logic — only comment seams; BACKLOG AF-10b is open and the spec is draft. Required before a hosted relay can be monetized, but blocked on the (separate) pricing/entitlement-backend decision. | src/relay-server/handlers.ts, src/relay-server/auth.ts, src/relay-server/store.ts |
