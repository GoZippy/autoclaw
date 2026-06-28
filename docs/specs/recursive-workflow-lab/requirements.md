---
spec_id: recursive-workflow-lab
title: AutoClaw Workflow Lab — recursive agent loops, model routing, and visual flow authoring
status: draft
owner: architect
created: 2026-06-27
updated: 2026-06-27
supersedes: []
superseded_by: null
references:
  - ../../V4_PLAN.md
  - ../../BACKLOG.md
  - ../../research/2026-06-27-agentic-ai-workflows/synthesis.md
  - design-review-addendum.md
  - ../../ideas/COORDINATION-LAYER-V2.md
  - ../../ideas/MULTI-AGENT-WORKSPACE-VISIBILITY-AND-CONTROL-PLANE.md
  - ../../ideas/AUTOCLAW-CONTROL-TAURI-PLAN.md
  - ../llm-provider-s1/spec.md
  - ../llm-provider-s2-autoclaw-side/spec.md
  - ../orchestrate-gates-and-routing.spec.md
acceptance:
  - given: a workspace with Ollama, LM Studio, or ZippyMesh configured
    when: a user creates a workflow using the visual editor or JSON DSL
    then: AutoClaw validates the graph, selects models by intent/cost/capability, executes bounded loops, and records every decision, tool call, gate, retry, and cost row
  - given: a workflow step fails due to context, tool format, tests, cost, or scope
    when: the loop runner diagnoses the failure
    then: it routes to an explicit remediation skill or exits with a typed stop reason instead of retrying blindly
  - given: a workflow has a budget ceiling or premium-model policy
    when: local and network models are sufficient
    then: AutoClaw avoids paid SOTA models; when they are insufficient, it escalates only through an auditable policy decision
  - given: the user opens the Workflow Lab panel
    when: a workflow is running
    then: the UI shows node status, data movement, current agent/model, cost, gates, artifacts, and review blockers without requiring the user to read raw logs
non_goals:
  - Training or fine-tuning local models in v1
  - Hiding chain-of-thought or model-private reasoning in logs; AutoClaw records concise decision summaries and observable evidence only
  - Replacing VS Code, Cursor, Kiro, Claude Code, Codex, Ollama, LM Studio, or ZippyMesh
  - Centralizing all execution through cloud services
---

# AutoClaw Workflow Lab Requirements

## Summary

AutoClaw Workflow Lab is a new layer for defining, visualizing, executing, and
improving recursive multi-agent workflows. It lets a user wire together agents,
models, tools, gates, context packs, retries, reviews, and escalation policies
into reusable process graphs. The runner executes those graphs with local-first
model routing, typed failure diagnosis, reinforcement-style feedback loops, and
cost-aware escalation to premium models only when policy says they are needed.

The goal is to make AutoClaw shine as the neutral, heterogeneous control plane
for agentic development: local models on this PC, LAN models on other machines,
ZippyMesh-routed models, Ollama, LM Studio, hosted APIs, MCP tools, IDE agents,
and human review all participate in one observable workflow.

## Product Principles

1. **Local-first, policy-escalated.** Prefer local/LAN/free models when they meet
   task requirements. Escalate to Opus, GPT-class, or other premium providers
   only through an explicit policy decision with a logged reason.
2. **Loops are bounded.** Every recursive/reinforcement loop has stop criteria:
   max iterations, budget, time, no-progress detection, acceptance gate, or human
   escalation.
3. **Failures are typed.** A failed step must report why it failed, not just that
   it failed. Retrying without diagnosis is a bug.
4. **Tools judge agents.** Deterministic commands, tests, compilers, linters,
   schema validators, mutation scores, and reviewer gates are primary signals.
5. **Small action spaces beat free-form drift.** Where possible, agents choose
   among structured actions; AutoClaw tools enforce legal execution.
6. **Visual does not mean vague.** The visual editor is a faithful rendering of a
   versioned workflow DSL that can be diffed, reviewed, tested, and run headless.
7. **No silent automation.** Every dispatch, model choice, retry, escalation,
   spawned agent, and control action is auditable and stoppable.
8. **Edition fit.** Personal/local use remains excellent. Commercial value is
   packaged through Pro/Teams/Enterprise licensing, hosted relay, cross-machine
   management, templates, governance, and support rather than crippling the local
   core for hobbyists.

## User Outcomes

### Solo Developer

- Build a reusable "fix failing test" loop that tries local models first, runs
  tests, diagnoses failures, retrieves better context, and escalates to a stronger
  model only after cheap attempts fail.
- Use a visual board to see why an agent is stuck: missing context, failing gate,
  model cannot follow tool schema, budget exceeded, or needs human input.
- Benchmark local models on the user's own workflows and route future tasks to
  the models that actually performed well.

### Power User With Multiple Machines

- Register Ollama or LM Studio endpoints across the LAN and route by hardware:
  small fast laptop model for summarization, workstation 70B model for planning,
  ZippyMesh for provider-aware routing, cloud SOTA only for hard review or final
  arbitration.
- See cross-machine workflows in AutoClaw Control or the panel, including cost,
  queue depth, model health, and current task state.

### Team / Commercial User

- Standardize workflows for review, release, test generation, refactor planning,
  security review, documentation, and multi-agent implementation.
- Apply governance policies: which models may see which files, which workflows
  need human approval, which agents can write, and when hosted relay/team sync is
  allowed.
- Use Pro/Teams workflow packs and visual diagnostics to reduce the review and
  coordination burden of many agents working in parallel.

## Capability Areas

### 0. Workflow Contracts, Simulation, and Replay

These are mandatory foundations, not polish. Workflow Lab should be an
evidence-grounded runtime with a visual surface, not a generic node editor.

Requirements:

- Every workflow declares a contract: inputs, outputs, invariants, required
  tools, required permissions, required model capabilities, success criteria,
  privacy constraints, and recovery behavior.
- The runner supports simulation/preflight before execution:
  eligible models, missing tools, estimated cost, write permissions, human
  approval nodes, policy blocks, and likely execution path.
- Every run is replayable from its ledger and artifacts.
- Users can rerun a full workflow, rerun from a node, or rerun a node with edited
  inputs when policy allows.
- Visual Workflow Lab supports three modes:
  Build, Run, and Inspect.
- The graph distinguishes dataflow, controlflow, and evidence/provenance edges.
- Policy decisions are explainable with machine-readable `PolicyDecision`
  records and user-readable remediation.

Minimum data contracts:

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

export interface PolicyDecision {
  allowed: boolean;
  policyId: string;
  reason: string;
  remediation?: string;
  evidence?: string[];
}
```

### A. Workflow DSL

AutoClaw needs a versioned graph format that can be saved in-repo, diffed, and
run headlessly.

Requirements:

- Store workflow definitions under `.autoclaw/workflows/*.workflow.json` by
  default, with export/import to `docs/workflows/` for shared templates.
- Include stable IDs for nodes, edges, ports, parameters, policies, and version.
- Support graph validation before execution.
- Support comments/labels for visual layout without affecting execution.
- Support variables and scoped artifacts:
  `workspaceRoot`, `taskId`, `branch`, `contextPackPath`, `budgetRemaining`,
  `lastGateResult`, `failureType`, `selectedModel`, `reviewVerdict`.
- Support headless CLI execution and visual execution using the same engine.
- Preserve unknown future fields for forward compatibility.
- Support type-safe ports, subworkflows, map/join/switch/checkpoint/cache nodes,
  and schema migrations.
- Keep workflow files declarative; custom logic must live in registered tools or
  structured actions, not arbitrary inline code.

Minimum node categories:

- `input`: task, prompt, file set, issue, VoidSpec task, manual trigger.
- `context`: build context pack, KG search, code RAG, memory recall, web/doc read.
- `router`: intent classifier, model selector, agent selector, skill selector.
- `agent`: local model call, ZippyMesh call, runner dispatch, persona task.
- `tool`: shell command, test command, MCP call, adapter action, structured action.
- `gate`: schema, scope, compile, test, mutation, acceptance, review, budget.
- `loop`: retry, recursive decomposition, best-of-N, evaluator-optimizer.
- `artifact`: write report, diff packet, review packet, KG fact, memory lesson.
- `human`: approval, steering, review, unblock request.
- `control`: HALT, evict, reassign, pause, resume, archive.

### B. Recursive / Reinforcement Loop Runner

The loop runner executes a workflow graph with explicit state and feedback.

Requirements:

- Maintain a run ledger under `.autoclaw/workflows/runs/<runId>/`.
- Record each node execution as an event with:
  timestamp, node ID, inputs, outputs, model/provider, tools called, tokens/cost,
  gate results, failure type, retry count, and artifact paths.
- Support loop shapes:
  - `generate -> verify -> revise`
  - `retrieve -> answer -> diagnose -> reretrieve`
  - `plan -> decompose -> dispatch -> review -> integrate`
  - `best-of-N -> judge -> merge`
  - `mutant -> test -> kill -> strengthen`
  - `benchmark -> score -> route`
- Support recursive decomposition with depth and breadth limits.
- Support reinforcement-style scoring without model training:
  workflow success, acceptance pass, verifier pass, mutation score, rework count,
  runtime, token cost, user approval, and reviewer findings.
- Feed scores into reputation and future routing.
- Detect no-progress loops:
  unchanged outputs, repeated same failure type, unchanged retrieval top-K,
  repeated test failure, or cost/time ceiling approaching.
- Exit with a typed reason when stuck.
- Acquire scope/resource leases before expensive or conflicting nodes.
- Estimate next-step cost before every loop iteration.
- Support idempotency keys per node execution.

### C. Intent and Policy Router

AutoClaw should use intent-based routing internally without exposing private
chain-of-thought. It should record concise decision summaries and evidence.

Requirements:

- Classify task intent into a small taxonomy:
  `plan`, `code`, `debug`, `test`, `review`, `security`, `docs`, `release`,
  `refactor`, `research`, `summarize`, `coordination`, `benchmark`, `vision`,
  `tool-use`, `long-context`, `creative`, `cheap-grade`.
- Map intents to model/agent requirements:
  context window, tool use, JSON mode, latency, local-only, cost ceiling,
  privacy level, preferred skills, reviewer independence.
- Use existing `src/llm` registry and ZippyMesh recommendation when available.
- Route to local/LAN/cloud according to workspace policy.
- Escalate only when local/LAN attempts fail typed gates or policy says the task
  requires a stronger model.
- Log escalation reason:
  `local_model_failed_schema`, `context_window_too_small`, `tool_use_required`,
  `review_independence_required`, `acceptance_failed_after_retries`,
  `security_sensitive_human_required`, `budget_policy_allows_sota`.
- Support user-defined routing profiles per workspace:
  `cheap`, `balanced`, `quality`, `local-only`, `air-gapped`, `release-critical`.

### D. Model and Hardware Capability Registry

The system needs a living registry of connected model endpoints and empirical
performance by workflow.

Requirements:

- Discover and register:
  - Ollama local and LAN endpoints
  - LM Studio local and LAN endpoints
  - ZippyMesh LLM Router
  - AutoClaw peer model servers
  - hosted OpenAI-compatible endpoints through ZippyMesh or configured providers
- Store endpoint metadata:
  URL, locality, machine ID, GPU/CPU notes when known, model list, context window,
  tool-use support, JSON support, embedding support, vision support, latency,
  privacy tier, cost tier, health, last benchmark time.
- Add a benchmark runner with workflow-relevant probes:
  JSON schema following, tool-call following, code patch quality, review quality,
  summarization, long-context retrieval, test generation, fix-loop success,
  latency, tokens/sec, memory pressure, and failure rate.
- Store benchmark results under `.autoclaw/llm/benchmarks.jsonl` and join them
  with the reputation ledger.
- Use benchmark results in routing as a soft factor, never as a hard lockout
  unless the model is unhealthy or policy-disallowed.
- Track endpoint queue depth, model warm/cold latency, verified context window,
  local model storage/install status, and measured strengths/failures by intent.
- Represent each model as an AutoClaw model card with capabilities, known
  failures, privacy posture, cost/latency, and recommended use cases.

### D2. Resource Scheduler

Model routing must account for hardware availability, not only model names.

Requirements:

- Track lightweight resource leases for model endpoints and machines.
- Avoid overloading a single local/LAN endpoint with too many concurrent jobs.
- Support machine availability policies such as working hours, battery/thermal
  constraints when detectable, and "do not use this endpoint for batch work."
- Use queue depth and estimated runtime in routing decisions.

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

### E. Failure-Aware Context and Skill Routing

Build on the context pack/intelligence layer so workflows can recover from
retrieval and context failures.

Requirements:

- Add a shared failure taxonomy used by workflows, gates, and context packs:
  `context_missing`, `context_noisy`, `query_too_broad`,
  `task_needs_decomposition`, `artifact_invalid`, `scope_conflict`,
  `tool_format_invalid`, `tool_action_illegal`, `compile_error`,
  `test_failure`, `mutation_survived`, `acceptance_failure`,
  `perf_regression`, `coordination_stale_claim`, `coordination_dead_session`,
  `budget_exhausted`, `irreducible_or_needs_human`.
- Add context remediation actions:
  query rewrite, task decomposition, evidence focusing, KG traversal, memory
  lookup, cross-project lookup, exit/escalate.
- Add skill routing:
  retrieve applicable skills by task intent, failure type, host capability,
  required tools, historical utility, and cost.
- Record whether skill invocation improved the next gate result.
- Record context quality metrics: hit diversity, symbol coverage, file recency,
  top-K churn, citation density, index staleness, and overlap with touched files.
- Emit a query plan artifact so users can inspect why context was retrieved.

### F. Structured Action Lanes

Inspired by compiler-guided optimization workflows, agents should often choose
structured actions instead of raw free-form edits.

Requirements:

- Define structured action schemas for:
  test generation, mutation generation, refactor planning, release checking,
  coordination repair, skill updates, context-pack repair, dependency upgrade,
  security review, and docs/changelog update.
- Validate action output before execution.
- Feed tool legality errors back as typed failures.
- Keep raw code editing available, but prefer structured lanes for high-risk
  workflows and Pro/Teams workflow packs.
- Add action preview, risk score, preconditions, postconditions, affected files,
  and reversible plans where possible.

### G. Visual Workflow Editor

AutoClaw should expose an n8n/ComfyUI/LangChain-style visual workflow builder
for agentic development workflows.

Requirements:

- Provide a full-tab VS Code webview first; reuse later in AutoClaw Control.
- Show nodes, typed ports, edges, run state, live artifacts, cost, current model,
  failure type, gate result, and loop iteration.
- Allow users to create/edit workflows visually and save the DSL.
- Support palette/search for node types and templates.
- Support "dry run validation" before execution.
- Support node-level test runs with mocked inputs.
- Support import/export of workflow packs.
- Support read-only playback of past runs.
- Support breakpoints, pause-before-node, rerun-node, rerun-subtree, run compare,
  policy preflight highlighting, data inspector, artifact drawer, minimap, and
  route-explanation panel.
- Provide safe defaults and guardrails:
  max iterations, max cost, max wall time, local-only toggle, write permission
  toggle, human approval nodes for risky writes.
- Do not use visible instructional marketing copy in the main tool surface; keep
  the UI functional and dense.

### H. Workflow Marketplace and Packs

Workflow packs are a strong commercial and ecosystem opportunity.

Requirements:

- Package workflows, skills, prompts, structured action schemas, sample gates,
  and documentation into versioned packs.
- Ship built-in packs:
  - Fix failing tests
  - Add feature with review
  - Generate adversarial tests
  - Release prep
  - Security review
  - Refactor safely
  - Build context pack
  - Benchmark local models
  - Multi-agent sprint
  - Research-to-backlog synthesis
- Allow third-party/local packs later.
- Record pack provenance and trust level.
- For Teams/Enterprise, allow approved pack catalogs and policy pinning.
- Add pack permissions, static linting, signed/trusted catalogs, update diffs,
  schema migrations, compatibility matrices, and lockfiles.

### I. Pro / Teams / Enterprise Packaging

This spec should align with current pricing: local individual use remains
excellent; paid tiers monetize commercial use, hosted services, governance, and
high-value management surfaces.

Recommended packaging:

- **Personal / educational:** local workflow runner, basic DSL, core templates,
  local model routing, and local run ledger.
- **Pro commercial license:** visual Workflow Lab editor, advanced workflow
  templates, benchmark dashboard, token/cost analytics, reusable workflow packs,
  AutoClaw Control personal dashboard when shipped.
- **Teams:** hosted relay, shared workflow catalogs, cross-machine fleet sync,
  team policies, shared model benchmarks, shared memory, review queues, WIP
  limits, audit history, hosted model-oracle convenience.
- **Enterprise:** SSO/RBAC, air-gapped policy packs, signed workflow catalogs,
  compliance export, self-hosted control plane, custom connectors, priority
  support, organization-wide audit and policy enforcement.

Avoid monetization traps:

- Do not make single-machine local orchestration feel crippled.
- Do not require subscription for local hobby use.
- Do not force hosted model routing when BYO/local routing works.
- Do not hide safety controls behind a paywall.

## Data Contracts

### Workflow Definition

```ts
export interface WorkflowDefinition {
  schema: 'autoclaw.workflow.v1';
  id: string;
  name: string;
  description?: string;
  edition?: 'core' | 'pro' | 'teams' | 'enterprise';
  variables?: Record<string, WorkflowVariable>;
  policies?: WorkflowPolicies;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  layout?: Record<string, { x: number; y: number }>;
  metadata?: {
    createdAt?: string;
    updatedAt?: string;
    author?: string;
    packId?: string;
    tags?: string[];
  };
}

export interface WorkflowNode {
  id: string;
  type:
    | 'input' | 'context' | 'router' | 'agent' | 'tool' | 'gate'
    | 'loop' | 'artifact' | 'human' | 'control';
  kind: string;
  label?: string;
  config: Record<string, unknown>;
  ports?: {
    inputs?: WorkflowPort[];
    outputs?: WorkflowPort[];
  };
  retry?: RetryPolicy;
  timeoutSeconds?: number;
}

export interface WorkflowEdge {
  id: string;
  from: { node: string; port?: string };
  to: { node: string; port?: string };
  condition?: WorkflowCondition;
}
```

### Run Event

```ts
export interface WorkflowRunEvent {
  schema: 'autoclaw.workflowRunEvent.v1';
  runId: string;
  nodeId: string;
  event:
    | 'queued' | 'started' | 'completed' | 'failed' | 'skipped'
    | 'retrying' | 'escalated' | 'halted' | 'human_required';
  timestamp: string;
  durationMs?: number;
  model?: {
    provider: string;
    model: string;
    locality: 'local' | 'lan' | 'cloud';
    selectionReason?: string;
  };
  tokens?: { input?: number; output?: number; costCents?: number };
  failureType?: string;
  gateResults?: GateResult[];
  artifacts?: string[];
  summary?: string;
}
```

## Safety and Governance Requirements

- Workflows default to read-only until a node explicitly requests write/execute.
- Shell/tool nodes require workspace policy permission.
- Cross-machine control actions require signing before they become actionable.
- Human approval nodes are required for:
  release publish, destructive file operations, external network writes,
  credential changes, paid-model budget override, and cross-machine evict/kill.
- Every workflow supports HALT.
- Every long-running loop supports pause/resume.
- Every run is replayable from its event log and artifacts.
- Prompt and response content must not be written to cost ledgers.
- Sensitive files must respect existing redaction and privacy policies.

## Metrics

Workflow Lab should expose:

- success rate by workflow and pack
- average cost and duration
- local-vs-cloud usage
- model selection distribution
- premium escalation rate
- gate failure distribution
- retry count and no-progress exits
- mutation score where applicable
- verifier false-accept/false-reject proxies
- human intervention count
- rework count after review
- agent/model/skill reputation deltas
- workflow contract pass/fail rate
- simulation estimate vs actual cost/duration
- policy denial reasons
- resource queue time
- run replay/rerun success rate
- pack quality and compatibility score

## Initial Workflow Ideas

1. **Cheap Fix Loop:** local model patches failing test, runs test, diagnoses,
   retrieves context, retries twice, escalates to stronger model only if same
   failure persists.
2. **Adversarial Test Loop:** generate tests, generate plausible mutants, run
   mutation score, strengthen tests until score or budget threshold.
3. **Context Repair Loop:** context pack retrieval, detect noisy/missing context,
   rewrite/decompose/focus, then dispatch.
4. **Best-of-N Review:** run N local/LAN agents, judge by tests and independent
   reviewer, escalate final arbitration only if disagreement persists.
5. **Release Gate:** compile, test, package, secret scan, changelog check, VSIX
   scan, dry-run publish, human approval.
6. **Security Audit:** structured action lane for threat model, file scan,
   finding triage, remediation tasks, verifier review.
7. **Model Benchmark:** run local/LAN models through project-specific probes,
   write benchmark and routing hints.
8. **Research-to-Backlog:** ingest papers/docs, synthesize requirements, create
   tasks, update local docs.
9. **Coordination Repair:** detect stale claims/dead sessions/scope conflicts,
   propose reaper/evict actions, require ack.
10. **Long-Horizon Feature:** decompose, assign subagents, checkpoint, review
    packets, merge queue, memory write-back.
11. **Bench Arena:** compare local/LAN/cloud models against project-specific
    probes and generate a routing profile.
12. **Policy Center:** edit workspace/team rules for providers, tools, approval,
    cloud access, model budgets, and machine windows.
13. **Artifact Review Packet:** produce a manager-readable packet for every
    non-trivial workflow with plan, diff, gates, cost, decisions, and residual
    risk.
14. **Workflow Inbox:** collect approvals, missing tools, missing credentials,
    policy blocks, and review packets in one queue.
15. **Workflow-to-Skill Distillation:** convert repeated successful workflow
    paths into subworkflows, skill updates, test fixtures, routing hints, and
    memory/KG facts.

## Open Questions

- Should the workflow DSL live under `.autoclaw/workflows/` only, or should
  shareable templates live under `docs/workflows/` by convention?
- Should the first visual editor use a dependency such as React Flow, or a
  minimal custom canvas to control VSIX size?
- Which endpoint format should LM Studio LAN discovery use by default:
  OpenAI-compatible `/v1/models`, user-configured endpoints, or both?
- Should benchmark results be per-workspace only, or should there be a user-level
  system store for cross-project model performance?
- Which workflow pack should be the first Pro showcase: Adversarial Test Loop,
  Release Gate, or Long-Horizon Feature?
