# AutoClaw Workflow Lab Tasks

Date: 2026-06-27

Companion requirements:
[requirements.md](requirements.md)

Status keys: `open`, `blocked`, `in-progress`, `done`.

## Milestone Overview

| Milestone | Theme | Outcome |
|---|---|---|
| WL-0 | Foundations | Shared taxonomy, run ledger, workflow DSL parser/validator |
| WL-1 | Headless Runner | Execute workflow graphs from CLI/command with bounded loops |
| WL-2 | Model + Hardware Routing | Discover, benchmark, score, and route local/LAN/cloud models |
| WL-3 | Failure-Aware Context and Skill Routing | Diagnose failures and choose rewrite/decompose/focus/exit |
| WL-4 | Structured Action Lanes | Safer schemas for tests, mutants, release, refactor, coordination |
| WL-5 | Visual Workflow Lab | Full-tab webview editor and run playback |
| WL-6 | Workflow Packs | Built-in packs and import/export |
| WL-7 | Control/Pro/Teams Surfaces | Cost analytics, cross-machine view, policies, hosted/team value |
| WL-8 | Design Review Hardening | Contracts, simulation, replay, resource scheduling, pack trust, policy center |

## WL-0 — Foundations

### WL-0.1 — Shared Failure Taxonomy

Status: open

Scope:

- Add a shared diagnostic taxonomy for workflow loops, context packs, gates, and
  reputation.
- Use a TypeScript enum or string union, not prompt prose.

Suggested files:

- `src/diagnostics/failureTypes.ts`
- `src/diagnostics/index.ts`
- `src/test/failureTypes.test.ts`
- Update imports in future workflow modules.

Requirements:

- Define the failure types listed in `requirements.md`.
- Provide helper functions:
  `isRetryableFailure`, `isEscalationCandidate`, `isHumanRequired`,
  `failureTypeFromGateResult`, `failureTypeFromToolError`.
- Preserve unknown external failure strings as `unknown_external` plus original.

Acceptance:

- Unit tests cover every failure type.
- Gate/tool mapping tests cover compile, test, schema, budget, scope, and context
  failures.
- No existing behavior changes.

### WL-0.2 — Workflow DSL Types

Status: open

Scope:

- Add versioned workflow definition and run-event types.

Suggested files:

- `src/workflows/types.ts`
- `src/workflows/index.ts`
- `src/test/workflow-types.test.ts`

Requirements:

- Implement `WorkflowDefinition`, `WorkflowNode`, `WorkflowEdge`,
  `WorkflowRunEvent`, `WorkflowPolicies`, `RetryPolicy`, `WorkflowCondition`.
- Add parse helpers that preserve unknown future fields.
- Add stable schema strings:
  `autoclaw.workflow.v1`, `autoclaw.workflowRunEvent.v1`.

Acceptance:

- Valid fixture parses.
- Unknown future fields survive round-trip.
- Missing required IDs fail validation.

### WL-0.3 — Workflow Validator

Status: open

Scope:

- Validate graph shape before execution.

Suggested files:

- `src/workflows/validate.ts`
- `src/test/workflow-validate.test.ts`

Requirements:

- Validate unique node/edge IDs.
- Validate edge endpoints exist.
- Validate required node config by type/kind.
- Detect cycles unless they are explicitly declared loop nodes.
- Validate budget/time/iteration policies.
- Validate edition/policy requirements without enforcing licensing in the core
  validator.

Acceptance:

- Invalid graph reports all actionable validation errors.
- Loop graph with explicit loop node passes.
- Accidental cycle without loop node fails.
- Validation output is machine-readable and UI-friendly.

### WL-0.4 — Run Ledger

Status: open

Scope:

- Persist workflow run events and artifacts.

Suggested files:

- `src/workflows/runLedger.ts`
- `src/test/workflow-runLedger.test.ts`

Requirements:

- Write JSONL events under `.autoclaw/workflows/runs/<runId>/events.jsonl`.
- Write run metadata to `run.json`.
- Provide append-only writes with no prompt/secret payload in cost-oriented rows.
- Provide `readRun`, `appendRunEvent`, `listRuns`, `summarizeRun`.

Acceptance:

- Appending events is deterministic and newline-safe.
- Corrupt event line is skipped with warning, not fatal.
- Summary computes duration, status, cost, failure types, artifact count.

### WL-0.5 — Built-In Workflow Fixture Set

Status: done

Scope:

- Add canonical workflow fixtures for tests and docs.

Suggested files:

- `docs/specs/recursive-workflow-lab/fixtures/*.workflow.json`
- `src/test/fixtures/workflows/*.workflow.json`

Initial fixtures:

- `cheap-fix-loop.workflow.json`
- `context-repair-loop.workflow.json`
- `adversarial-test-loop.workflow.json`
- `release-gate.workflow.json`
- `model-benchmark.workflow.json`

Acceptance:

- Every fixture validates.
- Fixtures are small enough for unit tests but representative enough for UI.

### WL-0.6 — Workflow Contracts

Status: open

Scope:

- Add explicit contracts to every workflow.

Suggested files:

- `src/workflows/contracts.ts`
- `src/test/workflow-contracts.test.ts`

Requirements:

- Contract fields:
  inputs, outputs, invariants, required tools, required model capabilities,
  required permissions, success criteria, privacy constraints, recovery behavior.
- Validate contracts separately from graph structure.
- Surface missing requirements before execution.

Acceptance:

- Workflow with missing required tool fails preflight.
- Workflow with declared no-touch invariant blocks a write node targeting that
  scope.
- Contract summary is available to UI and run ledger.

### WL-0.7 — Workflow Tests

Status: open

Scope:

- Let workflow packs ship tests.

Suggested files:

- `src/workflows/tests.ts`
- `src/test/workflow-tests.test.ts`

Requirements:

- Define `WorkflowTestCase` fixtures with inputs, mocks, and expectations.
- Support mocked model/tool outputs.
- Support expectations for chosen route, failure type, artifacts, and policy
  decisions.

Acceptance:

- A fixture workflow test runs fully with mocked tools.
- Expected route/profile assertion passes.
- Failed expectation prints actionable diff.

## WL-1 — Headless Runner

### WL-1.1 — Execution Engine Skeleton

Status: done

Scope:

- Execute workflow DAGs without visual UI.

Suggested files:

- `src/workflows/runner.ts`
- `src/workflows/state.ts`
- `src/test/workflow-runner.test.ts`

Requirements:

- Topologically execute non-loop graphs.
- Track per-node state: pending, running, completed, failed, skipped.
- Write run events to ledger.
- Pass outputs between nodes by edge/port.
- Halt on validation error before execution.

Acceptance:

- Simple input -> tool -> artifact graph executes.
- Failed node stops downstream nodes unless edge condition handles failure.
- Run ledger reconstructs final state.

### WL-1.2 — Loop Node Execution

Status: done

Scope:

- Add bounded recursive/reinforcement loops.

Suggested files:

- `src/workflows/loops.ts`
- `src/test/workflow-loops.test.ts`

Requirements:

- Implement loop policies:
  max iterations, max depth, max duration, max cost, success condition,
  no-progress condition.
- Support loop patterns:
  retry, generate-verify-revise, retrieve-diagnose-reretrieve, best-of-N,
  mutation-test-strengthen.
- Emit `retrying`, `escalated`, `halted`, and `human_required` events.

Acceptance:

- Successful loop exits on gate pass.
- Repeated identical failure exits with `no_progress`.
- Budget ceiling exits before starting another expensive node.

### WL-1.3 — Gate Node Adapter

Status: done

Scope:

- Reuse existing acceptance gate and test command machinery in workflows.

Suggested files:

- `src/workflows/nodes/gateNode.ts`
- `src/workflows/nodes/index.ts`
- Extend tests near `src/test/gateLogic.test.ts` or add
  `src/test/workflow-gateNode.test.ts`.

Requirements:

- Support schema, compile, test, acceptance, budget, scope, mutation, review
  gate kinds.
- Map gate failures to shared failure taxonomy.
- Include command, exit code, duration, and pass/fail in run event.

Acceptance:

- Failing shell/test gate blocks downstream approve path.
- Passing gate permits downstream artifact.
- Timeout maps to `budget_exhausted` or tool timeout subtype.

### WL-1.4 — CLI/Command Surface

Status: open

Scope:

- Run workflow definitions headlessly.

Suggested files:

- `src/workflows/command.ts`
- `scripts/workflow-run.js`
- `package.json` command contribution
- `src/extension.ts`
- `src/test/intelligence-toolscaffold.test.ts` or new command registration test

Requirements:

- Command Palette: `AutoClaw: Workflow Lab — Run Workflow`.
- Script:
  `node scripts/workflow-run.js --workflow <path> --task "<task>"`.
- Print run ID and final summary.
- Respect workspace policy and HALT.

Acceptance:

- CLI runs fixture workflow.
- Command registration test sees new command.
- Missing workflow path gives useful error.

### WL-1.5 — Run Replay and Rerun From Node

Status: done

Scope:

- Make workflow runs inspectable and reproducible enough for debugging.

Suggested files:

- `src/workflows/replay.ts`
- `src/test/workflow-replay.test.ts`

Requirements:

- Replay a run from `events.jsonl`.
- Rerun entire workflow.
- Rerun from a selected node when inputs/artifacts are available.
- Rerun a node with edited inputs in dry-run mode.
- Compare two run summaries.

Acceptance:

- Replay reconstructs node states from fixture log.
- Rerun-from-node skips completed upstream nodes.
- Compare reports changed model, cost, duration, and gate results.

### WL-1.6 — Workflow Simulation Planner

Status: open

Scope:

- Preflight a workflow before executing it.

Suggested files:

- `src/workflows/simulate.ts`
- `src/test/workflow-simulate.test.ts`

Requirements:

- Report likely execution path, missing tools, eligible models, estimated cost,
  estimated duration, write permissions, human approvals, and policy blocks.
- Do not call models or mutate project files.

Acceptance:

- Local-only policy simulation excludes cloud models.
- Missing tool appears as actionable blocker.
- Estimated premium escalation path is visible before run.

## WL-2 — Model + Hardware Routing

### WL-2.1 — Endpoint Discovery for Ollama, LM Studio, ZippyMesh

Status: open

Scope:

- Extend LLM discovery beyond current provider basics into a model capability
  inventory usable by workflows.

Suggested files:

- `src/llm/discovery.ts`
- `src/llm/capabilityInventory.ts`
- `src/test/llm-discovery.test.ts`

Requirements:

- Probe configured endpoints:
  Ollama `/api/tags`, OpenAI-compatible `/v1/models`, ZippyMesh `/v1/models`.
- Support LAN endpoints from `.autoclaw/llm/config.yaml`.
- Store health and metadata in memory and optionally
  `.autoclaw/llm/capabilities.json`.
- Mark locality: local, LAN, cloud.

Acceptance:

- Mock Ollama, LM Studio, and ZippyMesh endpoints are discovered.
- Unreachable endpoint degrades to unhealthy, not thrown.
- Capabilities file omits secrets.

### WL-2.2 — Model Benchmark Runner

Status: open

Scope:

- Benchmark connected models against project-relevant probes.

Suggested files:

- `src/llm/benchmarks.ts`
- `src/test/llm-benchmarks.test.ts`
- `scripts/benchmark-models.js`

Requirements:

- Probes:
  JSON schema following, short summary, code review, patch planning,
  tool-format following, context use, test generation.
- Record latency, success/failure, tokens, cost, and notes.
- Allow quick and full benchmark modes.
- Write `.autoclaw/llm/benchmarks.jsonl`.

Acceptance:

- Mock provider benchmark produces a row per probe.
- Bad JSON/tool format is recorded as failure type.
- Benchmark summary ranks models by intent.

### WL-2.3 — Intent Router

Status: open

Scope:

- Map workflow node intent to provider/model/agent choice.

Suggested files:

- `src/workflows/intentRouter.ts`
- `src/test/workflow-intentRouter.test.ts`

Requirements:

- Implement intent taxonomy.
- Accept routing profile:
  cheap, balanced, quality, local-only, air-gapped, release-critical.
- Use:
  provider health, capabilities, benchmark results, reputation, cost ceiling,
  privacy/locality policy, context-window requirement.
- Call ZippyMesh `recommendModel` when available.
- Produce a concise selection reason.

Acceptance:

- Local-only profile never selects cloud.
- Quality profile escalates after configured failure.
- Tool-use intent excludes model without tool/JSON capability unless no alternative
  exists and policy allows fallback.

### WL-2.4 — Premium Escalation Policy

Status: open

Scope:

- Make expensive model calls deliberate and auditable.

Suggested files:

- `src/workflows/escalationPolicy.ts`
- `src/test/workflow-escalationPolicy.test.ts`

Requirements:

- Define policy fields:
  allowed providers, max cost, max attempts before escalation, allowed failure
  triggers, human approval requirement, release/security overrides.
- Emit `escalated` run event with reason and previous attempts.
- Respect budget HALT.

Acceptance:

- Local failures escalate only after threshold.
- Disallowed provider is never selected.
- Human approval requirement blocks automatic escalation.

### WL-2.5 — Resource Leases and Endpoint Queues

Status: open

Scope:

- Avoid overloading local and LAN model endpoints.

Suggested files:

- `src/llm/resourceScheduler.ts`
- `src/test/llm-resourceScheduler.test.ts`

Requirements:

- Track in-process resource leases per endpoint/model/machine.
- Track observed queue depth and recent latency.
- Expose scheduler decisions to the intent router.
- Expire stale leases safely.

Acceptance:

- Two concurrent 70B tasks do not route to an endpoint configured for one active
  heavyweight job.
- Expired lease is reclaimed.
- Scheduler records selection reason.

### WL-2.6 — Machine Policy Windows and Hardware Constraints

Status: open

Scope:

- Let users control when and how local/LAN machines are used.

Suggested files:

- `src/llm/machinePolicy.ts`
- `src/test/llm-machinePolicy.test.ts`

Requirements:

- Support policy fields:
  allowed hours, max concurrent jobs, batch-only, interactive-only, prefer/avoid
  on battery, max estimated runtime, allowed workflow tags.
- Use hardware metadata when available, but degrade if unavailable.

Acceptance:

- Endpoint outside allowed window is skipped for new batch work.
- Interactive task may still use endpoint when policy allows.
- Missing hardware metadata does not crash routing.

## WL-3 — Failure-Aware Context and Skill Routing

### WL-3.1 — Context Pack v2 Modes

Status: open

Scope:

- Add failure-aware context retrieval modes.

Suggested files:

- `src/intelligence/contextPack.ts`
- `src/test/intelligence-contextpack.test.ts`
- `src/test/intelligence-remediation-v2.test.ts`

Requirements:

- Add modes:
  normal, rewrite, decompose, focus, exit.
- Add summary fields:
  mode, failure type, retrieval rounds, unchanged top-K count, hits, degraded,
  suggested next skill.
- Use observable proxies, not hidden model states.

Acceptance:

- Existing context pack tests still pass.
- Rewrite/decompose/focus modes produce distinct query plans.
- Exit mode writes a clear stop reason and does not retrieve again.

### WL-3.2 — Skill Index

Status: open

Scope:

- Create a searchable skill catalog for workflow routing.

Suggested files:

- `src/skills/catalog.ts`
- `src/skills/retrieve.ts`
- `src/test/skills-catalog.test.ts`

Requirements:

- Index built-in skills and workflow pack skills.
- Store tags, host requirements, tools, failure modes, examples, expected
  artifacts, last updated, trust level, and historical utility.
- Rank by semantic match plus utility/reputation.

Acceptance:

- Catalog loads current `skills/*/SKILL.md`.
- Query for `test_failure` returns test/debug-oriented skills.
- Utility score changes ranking when history exists.

### WL-3.3 — Failure Router Node

Status: open

Scope:

- Route failures to remediation actions inside workflows.

Suggested files:

- `src/workflows/nodes/failureRouterNode.ts`
- `src/test/workflow-failureRouterNode.test.ts`

Requirements:

- Inputs: failure type, previous node output, gate result, run policy.
- Outputs: next action:
  retry, rewrite context, decompose, focus evidence, invoke skill, escalate,
  human, exit.
- Record selection reason.

Acceptance:

- `context_missing` routes to context focus/rewrite.
- repeated `tool_format_invalid` routes to stronger model or human after limit.
- `irreducible_or_needs_human` exits without retry.

## WL-4 — Structured Action Lanes

### WL-4.1 — Action Schema Registry

Status: open

Scope:

- Define schemas for structured agent outputs.

Suggested files:

- `src/workflows/actions/types.ts`
- `src/workflows/actions/registry.ts`
- `src/test/workflow-actionRegistry.test.ts`

Initial schemas:

- `test.generate`
- `mutation.generate`
- `refactor.plan`
- `release.check`
- `coordination.repair`
- `skill.update`
- `context.repair`
- `dependency.upgrade`
- `security.review`
- `docs.changelog`

Acceptance:

- Each schema validates a valid fixture and rejects malformed output.
- Unknown action schema fails closed.

### WL-4.2 — Test + Mutant Loop Lane

Status: open

Scope:

- Implement the first high-value structured lane: adversarial test generation.

Suggested files:

- `src/workflows/actions/testGenerate.ts`
- `src/workflows/actions/mutationGenerate.ts`
- `src/workflows/nodes/mutationGateNode.ts`
- `src/test/workflow-adversarialTest.test.ts`

Requirements:

- Generate tests for selected target.
- Generate constrained mutants:
  one mutation, one line, no comments/whitespace-only changes.
- Run tests against mutants where feasible.
- Record mutation score and surviving mutants.

Acceptance:

- Fixture mutant is killed by generated/provided test.
- Surviving mutant maps to `mutation_survived`.
- Invalid mutant output maps to `tool_format_invalid`.

### WL-4.3 — Release Gate Lane

Status: open

Scope:

- Make release prep a structured workflow pack candidate.

Suggested files:

- `src/workflows/actions/releaseCheck.ts`
- `src/test/workflow-releaseCheck.test.ts`

Requirements:

- Check version, changelog, compile, unit tests, adapters, secret scan, VSIX size,
  package dry-run, and publish dry-run when configured.
- Require human approval before actual publish.

Acceptance:

- Dry-run fixture produces release packet.
- Missing changelog maps to `artifact_invalid`.
- Publish node cannot run without human approval.

### WL-4.4 — Coordination Repair Lane

Status: open

Scope:

- Tie Workflow Lab to Coordination Layer v2.

Suggested files:

- `src/workflows/actions/coordinationRepair.ts`
- `src/test/workflow-coordinationRepair.test.ts`

Requirements:

- Detect stale claims, dead sessions, telemetry noise, scope overlaps.
- Propose reaper/evict/nudge actions.
- Require ack for evict/control actions.

Acceptance:

- Dead session stale claim proposes reaper.
- Live overlapping scope proposes human/reassign, not automatic eviction.
- No action is marked done until ack.

## WL-5 — Visual Workflow Lab

### WL-5.1 — Full-Tab Webview Shell

Status: open

Scope:

- Add a full-tab Workflow Lab webview in VS Code.

Suggested files:

- `src/views/workflowLab.ts`
- `media/workflow-lab/workflow-lab.html`
- `media/workflow-lab/workflow-lab.css`
- `media/workflow-lab/workflow-lab.js`
- `src/test/workflow-lab-rendering.test.ts`
- `package.json`

Requirements:

- Open command:
  `AutoClaw: Workflow Lab`.
- Load workflow fixtures and run summaries.
- Render dense, utilitarian node graph and side inspector.
- No nested cards; no marketing copy.
- Stable node dimensions; no text overlap.

Acceptance:

- Command registered.
- Empty state renders without errors.
- Fixture workflow renders all nodes and edges.

### WL-5.2 — Graph Editing

Status: open

Scope:

- Create/edit workflows visually and save DSL.

Requirements:

- Add node from palette.
- Connect ports.
- Edit config in inspector.
- Validate before save.
- Save to `.autoclaw/workflows/<id>.workflow.json`.

Acceptance:

- User can create a valid three-node workflow.
- Invalid edge is visibly rejected and not saved.
- Saved file validates through headless validator.

### WL-5.3 — Live Run Playback

Status: open

Scope:

- Render run state and event playback.

Requirements:

- Show node status, iteration count, current model, cost, gate result, artifact
  links, and failure type.
- Playback historical run from ledger.
- Update live during active run.

Acceptance:

- Fixture run event log renders completed/failed nodes.
- Cost and model badges appear where present.
- Artifact links open local files.

### WL-5.4 — Node-Level Dry Run

Status: open

Scope:

- Test individual nodes with mocked or sample inputs.

Requirements:

- Run selected node in dry-run mode.
- Do not write project files unless explicitly allowed.
- Show input/output/failure preview.

Acceptance:

- Context node dry-run returns summary.
- Tool node dry-run respects write/execute policy.

### WL-5.5 — Trace Viewer and Run Compare

Status: open

Scope:

- Add the Inspect mode for run debugging.

Requirements:

- Timeline of node events.
- Data/control/evidence edge display.
- Artifact drawer.
- Route explanation panel.
- Compare two runs side-by-side.

Acceptance:

- Fixture event log renders a timeline.
- Evidence edge from gate to decision is visible in inspect data model.
- Run comparison highlights cost/model/gate differences.

### WL-5.6 — Visual Preflight Path Highlighting

Status: open

Scope:

- Show simulation results on the graph before execution.

Requirements:

- Highlight likely path.
- Badge blocked nodes.
- Show missing tool/model/policy denial reasons.
- Show estimated cost/duration range.

Acceptance:

- Simulation blocker appears on relevant node.
- Local-only toggle updates eligible model path.
- No workflow execution occurs during preflight.

## WL-6 — Workflow Packs

### WL-6.1 — Pack Format

Status: open

Scope:

- Define package format for reusable workflows and skills.

Suggested files:

- `src/workflows/packs/types.ts`
- `src/workflows/packs/manifest.ts`
- `src/test/workflow-packManifest.test.ts`

Requirements:

- Pack manifest includes ID, version, title, author, license, edition, workflows,
  skills, schemas, docs, trust level, and required tools.
- Validate manifest and referenced files.

Acceptance:

- Valid pack fixture loads.
- Missing referenced workflow fails validation.

### WL-6.2 — Built-In Pack: Fix Failing Tests

Status: open

Scope:

- First practical pack.

Suggested files:

- `resources/workflow-packs/fix-failing-tests/`

Requirements:

- Context pack -> local model patch -> test gate -> failure router -> retry or
  escalate -> review artifact.

Acceptance:

- Pack imports.
- Fixture dry run validates.

### WL-6.3 — Built-In Pack: Adversarial Tests

Status: open

Scope:

- Pro showcase candidate.

Suggested files:

- `resources/workflow-packs/adversarial-tests/`

Requirements:

- Test generation -> mutant generation -> mutation gate -> strengthen tests ->
  review artifact.

Acceptance:

- Pack imports.
- Mutation score shown in run summary.

### WL-6.4 — Built-In Pack: Release Gate

Status: open

Scope:

- Commercially valuable workflow.

Suggested files:

- `resources/workflow-packs/release-gate/`

Acceptance:

- Human approval node required before publish.
- Dry-run report includes all release checks.

### WL-6.5 — Pack Import/Export UI

Status: open

Scope:

- Workflow Lab can import/export packs.

Requirements:

- Import from folder or zip.
- Export selected workflow as pack skeleton.
- Show trust/provenance and required tools.

Acceptance:

- Import built-in fixture.
- Exported pack validates after re-import.

### WL-6.6 — Pack Permission Model and Linter

Status: open

Scope:

- Prevent unsafe workflow packs from becoming a supply-chain risk.

Requirements:

- Static lint for shell nodes, network access, cloud-model access, file writes,
  destructive commands, publish actions, secret references, and unsigned custom
  tools.
- Pack manifest declares permissions.
- Install preview shows requested permissions.

Acceptance:

- Pack with publish node requires publish permission and human approval.
- Pack with shell node but no permission fails lint.
- Built-in packs pass lint.

### WL-6.7 — Pack Signing and Trust Metadata

Status: open

Scope:

- Support trusted pack catalogs for Teams/Enterprise.

Requirements:

- Trust levels:
  local, built-in, signed, team-approved, untrusted.
- Store signature metadata when present.
- Do not require signatures for local personal packs.

Acceptance:

- Unsigned third-party pack installs as untrusted.
- Built-in pack installs as built-in.
- Signature verification failure blocks team-approved status.

### WL-6.8 — Pack Migrations and Update Diff

Status: open

Scope:

- Keep workflow packs maintainable across DSL versions.

Requirements:

- Pack lockfile.
- Version compatibility matrix.
- Update preview diff.
- Migration notes.
- Workflow schema migration hook.

Acceptance:

- Older workflow fixture migrates to current schema.
- Update preview lists changed workflows, permissions, and policies.

## WL-7 — Pro / Teams / Enterprise Surfaces

### WL-7.1 — Edition and Entitlement Mapping

Status: open

Scope:

- Define how Workflow Lab features map to existing licensing without breaking
  personal/local-free posture.

Suggested files:

- `docs/editions.md`
- `PRICING.md`
- `src/licensing/features.ts`
- `src/test/premium-advanced.test.ts`

Recommendation:

- Personal/educational: full local core workflow execution.
- Pro commercial: visual editor, advanced packs, benchmark dashboard, local
  Control personal dashboard.
- Teams: hosted relay sync, shared packs, shared policies, audit, WIP/review
  queue, team benchmark registry.
- Enterprise: SSO/RBAC, signed pack catalogs, self-hosted control plane,
  air-gapped policies, compliance export.

Acceptance:

- Feature names are explicit and tested.
- Personal/free messaging does not claim local core is crippled.

### WL-7.2 — Token/Cost Analytics Dashboard

Status: open

Scope:

- Pro/Teams value surface that benefits all workflow execution.

Suggested files:

- `src/views/workflowAnalytics.ts`
- `media/workflow-analytics/*`
- `src/test/workflow-analytics.test.ts`

Requirements:

- Show local vs LAN vs cloud usage.
- Show premium escalation rate.
- Show cost by workflow, agent, model, and project.
- Label inferred/unverified usage.

Acceptance:

- Reads workflow run ledger and LLM cost ledger.
- No prompt/response content displayed.

### WL-7.3 — Shared Team Workflow Catalog

Status: open

Scope:

- Teams feature built on hosted relay/shared policy infrastructure.

Requirements:

- Sync approved workflow packs.
- Enforce team policy on allowed providers, tools, and approval nodes.
- Audit workflow runs and pack versions.

Acceptance:

- Local-only without Teams remains functional.
- Team policy denies disallowed cloud model in test fixture.

### WL-7.4 — AutoClaw Control Integration

Status: open

Scope:

- Reuse Workflow Lab run state in the standalone Control plan.

References:

- `docs/ideas/AUTOCLAW-CONTROL-TAURI-PLAN.md`

Requirements:

- FLEET-DIGEST includes active workflow runs.
- Control can render workflow run cards and open run playback.
- Control dispatches workflow intents as request envelopes, not direct execution.

Acceptance:

- Digest fixture includes workflow run summary.
- Control-side renderer can consume same model.

### WL-7.5 — Bench Arena

Status: open

Scope:

- Productize model benchmarking as a user-facing surface.

Requirements:

- Quick/full benchmark modes.
- Compare local/LAN/cloud models by intent.
- Generate recommended routing profile.
- Detect benchmark drift after model/provider changes.

Acceptance:

- Benchmark dashboard ranks models by at least three intents.
- Generated routing profile can be saved to workspace config.

### WL-7.6 — Policy Center

Status: open

Scope:

- Provide a workspace/team policy editor.

Requirements:

- Edit allowed providers, local-only globs, cloud-denied globs, max budget,
  approval requirements, tool permissions, signed pack policy, and machine
  availability windows.
- Policies produce explainable `PolicyDecision` records.

Acceptance:

- Policy edit updates workspace config.
- Policy denial appears in workflow simulation and run events.

### WL-7.7 — Artifact Review Packets

Status: open

Scope:

- Standardize manager-readable review artifacts.

Requirements:

- Packet includes goal, plan, files touched, diff, gates, failures, model/agent
  decisions, cost, remaining risk, and human decision.
- Link packet from Review Queue and Workflow Lab run.

Acceptance:

- Fixture workflow emits review packet.
- Packet links to run event log and artifacts.

### WL-7.8 — Workflow Inbox

Status: open

Scope:

- Centralize approvals and blocked workflow actions.

Requirements:

- Inbox items for human approval, missing credentials, missing model/tool, policy
  block, failed preflight, review packet, merge decision.
- Render in panel now and Control later.

Acceptance:

- Human approval node creates inbox item.
- Resolving item unblocks workflow run.

## Cross-Cutting Requirements

### Tests

Required test layers:

- Unit tests for DSL, validation, ledger, routing, failure mapping.
- Integration tests for headless runner with fixture workflows.
- Webview rendering tests for Workflow Lab.
- Command registration tests.
- Golden no-op tests for existing orchestrator/intelligence behavior.
- Privacy tests ensuring prompts/responses are not written to cost ledgers.

### Documentation

Docs to update when implementation starts:

- `README.md`: short Workflow Lab overview.
- `docs/INDEX.md`: link spec and packs.
- `docs/V4_PLAN.md`: add Workflow Lab under QLT/MEM/ORG/VIS as appropriate.
- `docs/BACKLOG.md`: add active milestone items.
- `docs/build-editions.md`: describe Pro/Teams mapping once finalized.

### Security / Privacy

Tasks that need security review:

- Shell/tool node execution.
- Cross-machine model endpoints.
- Workflow pack import.
- Hosted/shared catalog sync.
- Control dispatch.
- Human approval bypass prevention.

### Compatibility

Rules:

- No workflow feature should change existing orchestrator behavior unless a
  workflow is explicitly run.
- Existing context pack and LLM registry behavior must remain compatible.
- Workflows must degrade when embeddings, KG, ZippyMesh, Ollama, or LM Studio
  are unavailable.
- All paths must work on Windows.

## Suggested First Sprint

Build the smallest useful slice:

1. WL-0.1 Shared Failure Taxonomy.
2. WL-0.2 Workflow DSL Types.
3. WL-0.3 Workflow Validator.
4. WL-0.4 Run Ledger.
5. WL-1.1 Execution Engine Skeleton.
6. WL-1.3 Gate Node Adapter.
7. WL-0.5 Fixture: `cheap-fix-loop.workflow.json`.
8. WL-1.4 CLI script to run the fixture.

Exit gate:

- A headless `cheap-fix-loop` workflow validates, executes a mock/local tool
  node, runs a gate, writes a run ledger, exits with a typed result, and does not
  affect any existing AutoClaw behavior when unused.

## Suggested Pro Showcase Sprint

Build after the headless runner is stable:

1. WL-2.2 Model Benchmark Runner.
2. WL-2.3 Intent Router.
3. WL-4.2 Test + Mutant Loop Lane.
4. WL-5.1 Full-Tab Workflow Lab.
5. WL-5.3 Live Run Playback.
6. WL-6.3 Built-In Pack: Adversarial Tests.
7. WL-7.2 Token/Cost Analytics Dashboard.

Exit gate:

- A user can open Workflow Lab, run the Adversarial Tests pack, watch node state
  and model choices, see mutation/test results, and view cost/usage. The pack is
  valuable enough to demonstrate why Pro/Teams licensing funds serious commercial
  workflows while preserving local-first use.
