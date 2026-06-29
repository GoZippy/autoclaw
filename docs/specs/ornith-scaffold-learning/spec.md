---
spec_id: ornith-scaffold-learning
title: Scaffold Learning Loop for AutoClaw, VoidSpec, and ZMLR
status: draft
owner: architect
created: 2026-06-28
updated: 2026-06-28
supersedes: []
superseded_by: null
references:
  - ../../research/2026-06-28-ornith-self-scaffolding-analysis.md
  - ../recursive-workflow-lab/requirements.md
  - ../recursive-workflow-lab/tasks.md
  - ../llm-provider-s2-zmlr-mcp-route/spec.md
  - ../llm-provider-s2-autoclaw-side/spec.md
  - ../../rfc/llm-provider-abstraction.md
  - ../../ideas/STANDARDIZED-ADAPTER-A2A-PLATFORM.md
acceptance:
  - given: a Workflow Lab run with a selected scaffold
    when: the run completes, fails, escalates, or is vetoed
    then: AutoClaw writes a sanitized ScaffoldScore row that joins gate results, cost, failures, reviewer state, and anti-hacking monitor outcome
  - given: two scaffold variants for the same intent and comparable context
    when: a new workflow or VoidSpec task is routed
    then: AutoClaw prefers the higher-scoring eligible scaffold and logs a concise selection reason
  - given: a scaffold experiment attempts to modify verifier, hidden tests, score ledger, or out-of-scope files
    when: the monitor observes the attempt
    then: the run receives zero reward, the workflow halts or routes to human review, and a finding_report is emitted
  - given: ZMLR is available
    when: AutoClaw requests a model recommendation for a workflow node
    then: the request can include task intent, failure type, harness requirements, and scaffold score hints, and the response can identify both model and prompt harness
  - given: a VoidSpec task declares intent, gates, constraints, and optional preferred scaffold
    when: AutoClaw syncs the task
    then: the task can enter Workflow Lab through the scaffold selector before normal runner dispatch
non_goals:
  - Fine-tuning or RL-training models in the first implementation slice
  - Letting a model edit verifier code, hidden tests, scoring code, or scope policy
  - Standardizing every provider on Ornith/Qwen XML tool-call formatting
  - Replacing ZMLR; ZMLR remains the provider/model router and becomes scaffold-aware
---

# Scaffold Learning Loop

## Summary

Ornith-1.0's portable lesson is not "use one specific model." The useful
architecture pattern is to make the scaffold part of the policy: select or
mutate the task scaffold, run the task under that scaffold, score observable
outcomes, then reuse or mutate the scaffolds that work.

For AutoClaw, a scaffold is a versioned combination of:

- workflow graph and node kinds;
- prompt harness contract;
- context-pack plan;
- loop policy;
- tool/action lanes;
- model routing profile;
- verifier, review, and anti-hacking policy.

The first AutoClaw implementation should learn scaffolds without training a
model. It should use deterministic gates, run ledgers, reviewer state, cost,
failure taxonomy, and anti-hacking monitors as the reward source.

## Product Fit

AutoClaw already has the substrate:

- Workflow Lab graph definitions, bounded loops, run ledgers, replay, and intent routing.
- ZMLR recommendation hooks and LLM provider abstractions.
- VoidSpec sync/dispatch as a high-level task ingress seam.
- Intelligence effectiveness metrics and reputation-ledger wiring.
- Scope leases, claim files, finding reports, and consensus review.

This spec fills the missing middle layer: scaffold selection, scoring,
mutation, and monitor-enforced safety.

## Core Concepts

### Scaffold Variant

A scaffold variant is a stable, scored process wrapper for a class of tasks.

```ts
export interface ScaffoldVariant {
  schema: 'autoclaw.scaffold.v1';
  id: string;
  taskIntent: WorkflowIntent;
  workflowId: string;
  contextPlanId?: string;
  promptHarnessId?: string;
  loopPolicyId?: string;
  toolLaneIds: string[];
  routerProfile: 'cheap' | 'balanced' | 'quality' | 'local-only' | 'air-gapped' | 'release-critical';
  parentScaffoldId?: string;
  mutation?: ScaffoldMutationKind;
  createdAt: string;
  createdBy?: string;
  tags?: string[];
}
```

### Scaffold Score

The score is a row derived from observable outcomes. Prompt and response content
must not be persisted in score rows.

```ts
export interface ScaffoldScore {
  schema: 'autoclaw.scaffoldScore.v1';
  scaffoldId: string;
  runId: string;
  workflowId: string;
  taskIntent: WorkflowIntent;
  pass: boolean;
  reward: number;
  failureType?: FailureType;
  verifierPass: boolean;
  judgeVeto: boolean;
  costCents: number;
  durationMs: number;
  retryCount: number;
  reworkCount: number;
  scopeViolation: boolean;
  antiHackingViolation?: AntiHackingViolation;
  createdAt: string;
}
```

Recommended starting reward:

```txt
reward =
  +1.00 final acceptance gate passed
  +0.30 tests passed
  +0.20 independent review had no blocking findings
  -0.30 per repeated failure type
  -0.20 retry budget exhausted
  -0.15 normalized cost over estimate
  -0.15 normalized duration over estimate
  -1.00 anti-hacking monitor violation
  -1.00 human veto or unsafe action
```

Keep the reward formula explicit, versioned, and test-covered. It should be
simple enough that a user can audit why a scaffold won.

### Prompt Harness Contract

ZMLR and AutoClaw should route by model plus harness, not model alone.

```ts
export interface PromptHarnessContract {
  schema: 'autoclaw.promptHarness.v1';
  id: string;
  modelFamily?: string;
  roleFormat: 'openai' | 'qwen_xml' | 'anthropic' | 'custom';
  toolCallFormat: 'openai_tools' | 'xml_function' | 'json_block' | 'none';
  reasoningFormat: 'separate_field' | 'think_tags' | 'hidden' | 'none';
  toolResponseFormat: 'tool_role' | 'user_wrapped_xml' | 'custom';
  supportsVisionInSystem: boolean;
  requiresReasoningParser?: string;
  requiresToolParser?: string;
  maxContextTokens?: number;
}
```

The Ornith/Qwen XML template becomes one harness contract. It is not the global
default.

## Anti-Hacking Boundary

The model may mutate inner strategy. It may not mutate the outer judging
environment.

Hard monitor rules:

- no reads of hidden verifier paths;
- no edits to verifier scripts, hidden tests, score ledgers, run ledgers, or policy files unless a workflow explicitly grants that scope;
- no literal expected-output hardcoding when expected artifacts are visible;
- no writes outside claim and scope lease;
- no privilege escalation outside declared workflow permissions;
- no model-executed node may edit scaffold scores for its own run.

Violations produce:

- zero reward for that rollout;
- `finding_report` to shared inbox;
- run halt or human review depending on severity;
- rejection from advantage/scaffold-selection statistics.

## Workflow Lab Integration

Workflow run events should carry optional scaffold metadata:

```ts
interface WorkflowRunEvent {
  scaffoldId?: string;
  promptHarnessId?: string;
  scaffoldMutation?: ScaffoldMutationKind;
}
```

The selector should run before a workflow starts and before a failure router
chooses a remediation scaffold.

Initial mutation operators:

- context plan: `normal`, `rewrite`, `decompose`, `focus`, `exit`;
- loop policy: retry count, wall-time, cost, no-progress threshold;
- routing profile: cheap, balanced, quality, local-only, release-critical;
- best-of-N count and judge policy;
- tool lane format: free-form patch vs structured action;
- reviewer independence: same model, different provider, human required.

## ZMLR Integration

ZMLR should become scaffold-aware without owning AutoClaw's workflow runner.

Recommended MCP input extension:

```json
{
  "tool": "recommend_model",
  "input": {
    "intent": "code",
    "failureType": "tool_format_invalid",
    "constraints": {
      "prefer_local": true,
      "min_context_window": 128000,
      "tool_call_format": "xml_function",
      "reasoning_format": "separate_field"
    },
    "scaffoldScoreHints": [
      { "harnessId": "qwen-xml-tools-v1", "score": 0.82 },
      { "harnessId": "openai-tools-v1", "score": 0.71 }
    ]
  }
}
```

Recommended response extension:

```json
{
  "success": true,
  "model": "Ornith-1.0-35B",
  "harnessId": "qwen-xml-tools-v1",
  "fallbackChain": ["qwen-coder", "local-failsafe"],
  "reason": "tool-use coding task with prior qwen_xml success on this workflow"
}
```

ZMLR should expose model metadata for:

- chat-template/tool-call format;
- reasoning parser behavior;
- verified context window;
- JSON/tool-call reliability;
- known failure modes by intent;
- benchmark scores by intent and harness.

## VoidSpec Integration

VoidSpec stays declarative. It can carry enough metadata to feed scaffold
selection.

```yaml
tasks:
  - id: VS-42
    title: Fix flaky integration test
    intent: debug
    risk: medium
    success:
      gates: [compile, test]
    constraints:
      locality: local-first
      max_cost_cents: 50
      no_touch:
        - secrets/**
        - .github/workflows/**
    preferred_scaffold: cheap-fix-loop
```

AutoClaw should sync this into workflow inputs, select a scaffold variant, run
Workflow Lab, then write evidence and status back to VoidSpec.

## Implementation Milestones

### OSL-0: Spec and Board

Create this spec, a task manifest, and boardable tasks. No runtime behavior
changes.

### OSL-1: Scaffold Data Model

Add scaffold and score types, JSONL stores, and tests.

### OSL-2: Scoring

Convert workflow run summaries into scaffold scores using gates, failures,
cost, duration, retry count, review state, and anti-hacking monitor outcome.

### OSL-3: Selection and Mutation

Select scaffolds by intent, repo, failure type, profile, model/harness, and
historical reward. Add bounded mutation operators.

### OSL-4: Prompt Harness Registry

Represent provider-specific prompt templates and wire harness requirements into
LLM/ZMLR routing.

### OSL-5: Anti-Hacking Monitor

Add deterministic policy checks around scaffold experiments and fail closed on
boundary violations.

### OSL-6: VoidSpec and ZMLR Integration

Route VoidSpec tasks through scaffold selection and extend ZMLR recommendation
metadata to include harness/scaffold hints.

## First Useful Slice

The first implementation PR should include:

1. `src/workflows/scaffolds/types.ts`
2. `src/workflows/scaffolds/store.ts`
3. `src/workflows/scaffolds/score.ts`
4. `src/test/workflow-scaffolds.test.ts`
5. score rows written from mocked run summaries;
6. selection test proving a passing low-cost scaffold outranks a costly failing one;
7. monitor test proving an anti-hacking violation forces zero reward.

