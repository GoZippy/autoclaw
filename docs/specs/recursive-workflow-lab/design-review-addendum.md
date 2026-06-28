# Workflow Lab Design Review Addendum

Date: 2026-06-27

This is a pressure-test pass on
[requirements.md](requirements.md) and [tasks.md](tasks.md). The short version:
the original plan has the right skeleton, but Workflow Lab will only become a
durable AutoClaw advantage if we design for contracts, replay, scheduling,
evaluation, policy, and marketplace trust from the beginning.

## Stronger Product Thesis

Workflow Lab should not be "LangChain UI inside VS Code." That market is already
crowded, and generic node graphs become impressive demos that are brittle in
real work.

AutoClaw's advantage is narrower and stronger:

> A local-first, heterogeneous AI development operations engine that turns agent
> work into bounded, observable, replayable, cost-aware workflows across local
> models, LAN models, paid models, IDE agents, tools, gates, and human review.

The visual editor is the control surface. The product is the runtime, policy
engine, evidence ledger, model router, and reusable workflow library.

## Cross-Cutting Improvements

### 1. Add Workflow Contracts Before Fancy Nodes

Every workflow should declare a contract, not just a graph:

- Inputs: expected task shape, required files, optional context, required tools.
- Outputs: expected artifacts, changed files, reports, review packets.
- Invariants: files or scopes the workflow must not touch.
- Gates: required checks before success.
- Budget: max cost, time, iterations, premium calls.
- Privacy: whether cloud models are allowed to see task data.
- Recovery: what happens on failure, timeout, or HALT.

Why it matters:

- Contracts let workflows be tested.
- Contracts make workflow packs safe to import.
- Contracts let AutoClaw warn before a workflow cannot run on the user's machine.
- Contracts are the unit of Teams/Enterprise governance.

Add to DSL:

```ts
export interface WorkflowContract {
  inputs: WorkflowInputContract[];
  outputs: WorkflowOutputContract[];
  invariants?: WorkflowInvariant[];
  requiredTools?: ToolRequirement[];
  requiredModels?: ModelRequirement[];
  requiredPermissions?: WorkflowPermission[];
  successCriteria: SuccessCriterion[];
}
```

### 2. Treat Run Replay as a First-Class Feature

If a user cannot replay and inspect a run, recursive loops become spooky. The
run ledger should support:

- Rerun entire workflow.
- Rerun from a node.
- Rerun a node with edited inputs.
- Compare two runs.
- Export a run packet for review/support.
- Redact sensitive artifacts before export.
- Pin a run as a benchmark example.

This is also a Pro/Teams feature: "why did this AI workflow cost $4 and fail?"
needs a trace viewer, not a log file.

Add tasks:

- `WL-1.5` Run replay and rerun-from-node.
- `WL-5.5` Trace viewer with compare mode.

### 3. Add a Resource Scheduler

Model routing alone is not enough. The system needs resource scheduling:

- Do not overload one workstation GPU with five parallel 70B jobs.
- Detect queue depth per endpoint.
- Reserve premium model calls for gates/review/arbitration.
- Avoid routing long-context tasks to low-VRAM local models.
- Consider thermal/battery state on laptops when available.
- Respect "do not use this machine during work hours" windows.

New concept:

```ts
export interface ResourceLease {
  id: string;
  providerId: string;
  model?: string;
  machineId?: string;
  workflowRunId: string;
  nodeId: string;
  estimatedTokens?: number;
  estimatedSeconds?: number;
  expiresAt: string;
}
```

Add tasks:

- `WL-2.5` Endpoint queue and resource lease manager.
- `WL-2.6` Machine policy windows and hardware constraints.

### 4. Add Workflow Simulation

Before a workflow executes, users should be able to simulate:

- What nodes will run?
- What tools are missing?
- What models are eligible?
- What is the estimated cost range?
- Which steps require human approval?
- Which steps can write files?
- Which policies will block execution?

This is the fastest way to make visual workflows feel trustworthy.

Add tasks:

- `WL-1.6` Workflow simulation planner.
- `WL-5.6` Visual dry-run path highlighting.

### 5. Separate Dataflow, Controlflow, and Evidence

The visual editor should distinguish:

- Dataflow edges: artifact/context/result movement.
- Controlflow edges: execution order and conditions.
- Evidence edges: which gate or result justifies a decision.

Generic node editors blur these. AutoClaw should make them explicit because its
core promise is evidence-grounded automation.

UI implication:

- Data edges: normal solid connectors.
- Control edges: thinner directional connectors.
- Evidence edges: dotted connectors from gate/artifact to decision node.

Runtime implication:

- Evidence edges become provenance links in the run ledger and review packets.

### 6. Make Human Nodes Richer

Human approval is not binary. We need multiple human interaction modes:

- Approve/deny.
- Choose among options.
- Provide missing secret or environment fact.
- Edit generated plan.
- Set WIP limit.
- Pick model/provider for a step.
- Mark evidence insufficient.
- Convert failure into a backlog task.

This will make Workflow Lab useful for noobs and experts.

Add human node kinds:

- `human.approve`
- `human.choose`
- `human.edit_plan`
- `human.provide_context`
- `human.review_packet`
- `human.resolve_conflict`
- `human.set_budget`

### 7. Build "Workflow Tests" as a Feature

Users should be able to test a workflow like code:

- Unit test a node with fixtures.
- Integration test a whole workflow with mocked models/tools.
- Golden test a workflow pack.
- Regression test that a workflow still chooses local models under a profile.

This is valuable for Teams/Enterprise and will keep packs from rotting.

Add:

```ts
export interface WorkflowTestCase {
  id: string;
  workflowId: string;
  inputs: Record<string, unknown>;
  mocks?: WorkflowMocks;
  expect: WorkflowExpectation[];
}
```

### 8. Add Policy Explainability

When a node is blocked, the UI should say exactly why:

- "Cloud model denied by workspace profile local-only."
- "Publish requires human approval."
- "Model lacks JSON mode required by action schema."
- "Scope lease overlaps with session X."
- "Budget remaining $0.18 below estimated $0.42."

Do not just show "policy denied."

This requires policy decisions to be first-class records:

```ts
export interface PolicyDecision {
  allowed: boolean;
  policyId: string;
  reason: string;
  remediation?: string;
  evidence?: string[];
}
```

### 9. Make Workflow Packs Trustworthy

Workflow packs are a monetization lane and a supply-chain risk. Add:

- Trust levels: local, built-in, signed, team-approved, untrusted.
- Manifest permissions.
- Static linting for risky nodes.
- Version pinning.
- Update diff viewer.
- Known-compatible AutoClaw versions.
- Pack deprecation and migration.
- Signed pack catalog for Teams/Enterprise.

Add tasks:

- `WL-6.6` Pack permission model and linter.
- `WL-6.7` Pack signing and trust metadata.
- `WL-6.8` Pack update diff and migration notes.

### 10. Add Workflow Migrations

The DSL will evolve. Add migrations from v1 to later versions at the start.

Requirements:

- Each workflow has `schema`.
- Loader can read older schemas.
- Migration is explicit and reversible where possible.
- Visual editor offers "upgrade workflow" with diff preview.

This prevents the marketplace/packs story from becoming a support burden.

## Component-by-Component Improvements

## A. Workflow DSL

Current plan: versioned graph format.

Improve with:

- Contracts.
- Type-safe ports.
- Distinct data/control/evidence edges.
- Subgraphs/components.
- Secrets/environment references by handle, never raw value.
- Workflow tests.
- Workflow migrations.
- Compatibility matrix for AutoClaw version and required tools.

Add these node/edge concepts:

- `subworkflow` node: call another workflow.
- `map` node: run a subworkflow over a list of files/tasks.
- `join` node: aggregate parallel outputs.
- `switch` node: branch by failure type, gate result, intent, or policy.
- `checkpoint` node: explicit resume boundary.
- `cache` node: reuse result when inputs/tool versions match.

Important design choice:

- Keep the graph declarative. Avoid embedding arbitrary JS functions in workflow
  files. Custom logic should be a registered tool/action, not inline code.

## B. Recursive / Reinforcement Loop Runner

Current plan: bounded execution with feedback.

Improve with:

- Checkpoints at every loop boundary.
- Replay and rerun-from-node.
- Loop progress score.
- "Exploration budget" separate from total budget.
- Best-of-N arbitration that includes cost/latency, not just quality.
- Parallel fan-out with WIP caps.
- Run cancellation and pause/resume.
- Idempotency keys per node execution.

Add loop stop reasons:

- `success_gate_passed`
- `max_iterations`
- `max_depth`
- `max_cost`
- `max_wall_time`
- `no_progress`
- `same_failure_repeated`
- `policy_denied`
- `human_required`
- `halt_requested`
- `resource_unavailable`

Key risk:

- Recursive loops can become expensive fast. The runner should estimate next-step
  cost before executing another iteration.

## C. Intent and Policy Router

Current plan: intent taxonomy plus model/agent requirements.

Improve with:

- Confidence score and fallback path per intent classification.
- Multi-intent tasks: e.g. "security-sensitive code review" is not one label.
- Policy preflight before model selection.
- Router learning from outcomes.
- Router explanations that are short and auditable.
- Privacy classifier for inputs before cloud routing.

Add routing dimensions:

- `dataSensitivity`: public, project-private, secret-adjacent, regulated.
- `writeRisk`: read-only, generated artifact, code edit, destructive, publish.
- `verificationStrength`: none, schema, test, acceptance, independent review.
- `latencyClass`: interactive, batch, overnight.
- `contextNeed`: small, medium, long, repository-wide.

Key improvement:

- The router should choose a workflow path, not just a model. For example:
  "cheap-fix-loop" vs "long-horizon-feature" vs "release-gate."

## D. Model and Hardware Registry

Current plan: endpoint discovery and benchmarks.

Improve with:

- Hardware inventory per machine: CPU, RAM, GPU, VRAM, OS, battery/thermal when
  available.
- Endpoint queue depth.
- Per-model context window verified empirically.
- Tool/JSON support verified by probes, not assumed.
- Model aliases and deprecation handling.
- Model warm/cold latency.
- Local model storage size and install status.
- Benchmark drift: rerun after model/provider changes.
- "Good at" tags derived from successful workflow runs.

Add "model cards" inside AutoClaw:

- name, provider, endpoint, locality
- capabilities
- measured strengths
- known failures
- cost/latency
- privacy posture
- recommended use cases

This turns local models into a managed fleet, not a list of strings.

## E. Failure-Aware Context and Skill Routing

Current plan: typed failures and rewrite/decompose/focus/exit.

Improve with:

- Context quality metrics:
  hit diversity, symbol coverage, file recency, top-K churn, citation density,
  overlap with files changed, stale index indicator.
- Evidence sufficiency check before dispatch.
- Query plan artifact:
  what did we search for, why, and what did it return?
- Skill usefulness feedback:
  did invoking the skill improve the next gate result?
- Context cache keyed by task, files, index signature, and workflow node.

Add failure modes:

- `evidence_conflict`
- `index_stale`
- `symbol_not_found`
- `long_context_overflow`
- `citation_missing`
- `retrieval_loop_no_progress`

Key product feature:

- "Why did I get this context?" inspector in the UI. This will differentiate
  AutoClaw from generic RAG systems.

## F. Structured Action Lanes

Current plan: schemas for tests, mutants, release, refactor, coordination.

Improve with:

- Action preview before execution.
- Risk score per action.
- Reversible action plans where possible.
- Patch boundaries and affected files.
- Preconditions and postconditions.
- Action result confidence.
- Tool legality vs semantic correctness separated.

Add more lanes:

- `migration.plan`: database/config/API migration.
- `api.contract.update`: OpenAPI/JSON schema/type contract changes.
- `dependency.security.update`: update package with CVE context and tests.
- `perf.optimize`: benchmark, change, compare, revert if regression.
- `docs.sync`: docs must match code/API changes.
- `ui.visual.verify`: screenshot/canvas checks for frontend work.
- `license.compliance`: third-party notice and license compatibility checks.

Important:

- Structured lanes should be optional accelerators, not a straitjacket. Let
  agents fall back to normal edits when no lane fits, but record that the work
  was unstructured and needs stronger review.

## G. Visual Workflow Editor

Current plan: full-tab webview graph editor.

Improve with:

- Three modes:
  - Build: edit graph.
  - Run: live execution.
  - Inspect: replay/debug.
- Breakpoints and pause-before-node.
- Rerun node/subtree.
- Compare run A vs run B.
- Visual policy preflight.
- Minimap and search.
- Node templates.
- Collapsible subworkflows.
- Data inspector panel.
- Artifact drawer.
- Cost/time estimate preview.
- "Local-only" and "write-safe" global toggles.
- "Explain route" panel for model/agent decisions.

Avoid:

- Overly decorative canvas.
- Giant node cards with marketing labels.
- Hidden critical data in hover-only UI.
- Letting graph layout become the workflow source of truth.

The editor should feel like a serious operational dashboard, not a toy builder.

## H. Workflow Packs and Marketplace

Current plan: built-in packs plus import/export.

Improve with:

- Pack quality score based on tests, usage, success rate, and maintainer trust.
- Pack compatibility checks.
- Pack install preview.
- Pack lockfile.
- Approved team catalog.
- Pack telemetry opt-in: local summary only unless Teams sync is enabled.
- Revenue path later: official Pro packs and enterprise-certified packs.

High-value paid packs:

- Release Manager Pack.
- Adversarial QA Pack.
- Security Reviewer Pack.
- Enterprise Policy Pack.
- Migration Pack.
- Multi-Repo Change Pack.
- Local Model Benchmark Pack.
- Long-Horizon Feature Team Pack.

Keep free:

- Basic local runner.
- Simple fix/test loop.
- Basic context pack workflow.
- User-created local packs.

## I. Pro / Teams / Enterprise

Current plan: Pro visual editor/advanced packs; Teams shared governance.

Improve with clearer value boundaries:

### Pro Value

- Visual editor.
- Advanced local workflow packs.
- Model benchmark dashboard.
- Cost analytics.
- Run replay/compare.
- Personal AutoClaw Control dashboard.
- Workflow pack import/export.
- Premium local support workflows such as Release Gate and Adversarial QA.

### Teams Value

- Shared workflow catalog.
- Shared model benchmark registry.
- Hosted relay and cross-machine fleet sync.
- Team policy enforcement.
- Review queue and WIP limits.
- Signed packs and approvals.
- Team audit trail.
- Shared memory and context packs.

### Enterprise Value

- SSO/RBAC.
- Air-gapped mode.
- Self-hosted Control/relay.
- Signed internal pack catalogs.
- Compliance export.
- Custom connector SDK/support.
- Org-wide policy reporting.

Do not paywall:

- Local safety gates.
- HALT.
- Basic local execution.
- Personal/educational local use.
- Privacy controls.

## New Feature Lanes Worth Adding

### 1. Workflow Observatory

A run analytics surface:

- Active runs.
- Failed runs by failure type.
- Cost/time charts.
- Premium escalation reasons.
- Top workflows by value.
- Model/agent scorecards.
- Verifier false-accept/false-reject proxies.

This is a natural Pro/Teams feature and directly supports commercial users.

### 2. AutoClaw Bench Arena

A benchmarking surface for local/LAN/cloud models against actual AutoClaw tasks.

Features:

- Quick benchmark.
- Full benchmark.
- Compare models.
- "Recommended routing profile" generator.
- Regression after model update.
- Share benchmark summary to Teams catalog.

This is very aligned with the user's local hardware/network model vision.

### 3. Policy Center

A workspace/team policy editor:

- Allowed providers.
- Local-only directories.
- Cloud-denied file globs.
- Max budget.
- Approval requirements.
- Tool permissions.
- Signed pack policy.
- Machine availability windows.

This becomes essential once workflows can call tools and paid models.

### 4. Artifact Review Packets

Every non-trivial workflow should produce a review packet:

- Goal.
- Plan.
- Files touched.
- Diff.
- Gates run.
- Failures encountered.
- Model/agent decisions.
- Cost.
- Remaining risk.
- Human decision.

This connects Workflow Lab to Review Queue and Control.

### 5. Workflow-to-Skill Distillation

When a workflow succeeds repeatedly, AutoClaw should propose:

- Convert repeated node sequence into a reusable subworkflow.
- Update a skill's known failure modes.
- Add a workflow test fixture.
- Add a routing hint.
- Add a memory/KG fact.

This is the "system compounds" piece.

### 6. Multi-Repo and Multi-Project Workflows

Eventually support:

- Coordinated changes across related repos.
- API producer/consumer updates.
- Shared package release.
- Docs site plus extension release.
- Cross-project context lookup.

This pairs with AutoClaw Control and is strong Teams/Enterprise value.

### 7. Workflow Inbox

A place where workflows wait for:

- Human approval.
- Missing credentials.
- Missing model/tool.
- Failed policy preflight.
- Review packet.
- Merge decision.

This prevents blocked workflows from disappearing into logs.

### 8. Workflow Suggestions

AutoClaw can recommend workflows based on intent:

- User says "fix this test" -> Cheap Fix Loop.
- User says "ship 3.6.7" -> Release Gate.
- User says "make this safer" -> Security Reviewer Pack.
- User says "compare my local models" -> Bench Arena.

This is onboarding and monetization: users discover paid/high-value workflows at
the moment they need them.

## Missing Hard Problems

### Workflow Determinism

Runs will not be deterministic because models are stochastic and external tools
change. We need reproducibility controls:

- Store model, endpoint, parameters.
- Store tool versions.
- Store git SHA.
- Store relevant config.
- Store context index signature.
- Store random seed where supported.

### Workflow Concurrency

Two workflows can fight over the same files or models. Need:

- Scope leases.
- Resource leases.
- WIP limits.
- Conflict detector.
- Queueing.
- Human override.

### Workflow Security

Workflow packs can be dangerous. Need:

- Static linting.
- Permission prompts.
- Trust levels.
- Signed packs.
- Sandboxed dry runs.
- Secret redaction.
- Cloud egress policy.

### Workflow UX Complexity

Node editors get complex fast. Need:

- Templates first.
- Visual editor second.
- Advanced editor hidden until needed.
- Searchable node palette.
- Good defaults.
- Headless runner always canonical.

### Workflow Evaluation

Without evaluation, "reinforcement loop" becomes vibes. Need:

- Hard gates.
- Mutation scores.
- Review outcomes.
- User acceptance.
- Cost/time.
- Rework count.
- Regression tracking.

## Revised Build Order

The first plan was close, but this is the safer order:

1. Failure taxonomy.
2. Workflow contracts + DSL.
3. Run ledger.
4. Validator and simulation preflight.
5. Headless runner.
6. Gate node adapter.
7. Replay/rerun.
8. Model capability inventory.
9. Benchmark runner.
10. Intent/policy router.
11. Failure-aware context pack v2.
12. First workflow pack: Cheap Fix Loop.
13. Second workflow pack: Adversarial Tests.
14. Visual playback/trace viewer.
15. Visual editor.
16. Pack trust/linting.
17. Pro analytics and Bench Arena.
18. Teams shared catalog/policy.

Reason:

- Headless correctness comes before visual editing.
- Simulation/replay come before complex loops.
- Pack trust comes before marketplace.
- Analytics come before commercial claims.

## What To Add To `requirements.md`

Add these sections:

- Workflow Contracts.
- Simulation and Preflight.
- Run Replay and Debugging.
- Resource Scheduling.
- Policy Explainability.
- Pack Trust and Migration.
- Workflow Tests.
- Artifact Review Packets.

## What To Add To `tasks.md`

Add these task groups:

- `WL-0.6` Workflow contracts.
- `WL-0.7` Workflow tests.
- `WL-1.5` Replay and rerun-from-node.
- `WL-1.6` Simulation planner.
- `WL-2.5` Resource leases and endpoint queue.
- `WL-2.6` Hardware/machine policy windows.
- `WL-5.5` Trace viewer and run compare.
- `WL-5.6` Visual preflight path highlighting.
- `WL-6.6` Pack permissions and linter.
- `WL-6.7` Pack signing/trust metadata.
- `WL-6.8` Pack migrations.
- `WL-7.5` Bench Arena.
- `WL-7.6` Policy Center.
- `WL-7.7` Artifact Review Packets.
- `WL-7.8` Workflow Inbox.

## Bottom Line

The core idea is strong. The main improvement is to bias away from "visual
automation builder" and toward "evidence-grounded workflow runtime with a visual
control surface." Build contracts, replay, simulation, resource scheduling,
policy, and pack trust early. Those are the pieces that will make AutoClaw feel
like a serious multi-agent development operations product rather than a clever
graph editor.
