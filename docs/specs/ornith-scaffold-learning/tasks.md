# Ornith Scaffold Learning Tasks

Date: 2026-06-28

Companion spec: [spec.md](spec.md)

Status keys: `open`, `claimed`, `in-progress`, `review`, `done`.

## Milestone Overview

| Milestone | Theme | Outcome |
|---|---|---|
| OSL-0 | Spec and Board | Formatted spec, manifest, and boardable work items |
| OSL-1 | Data Model | Scaffold and score contracts plus JSONL store |
| OSL-2 | Scoring | Workflow run summaries become reward rows |
| OSL-3 | Selection and Mutation | Router can choose and mutate scaffold variants |
| OSL-4 | Prompt Harness Registry | Model-specific chat/tool/reasoning formats become routable |
| OSL-5 | Anti-Hacking Monitor | Deterministic boundary monitor guards scaffold experiments |
| OSL-6 | VoidSpec and ZMLR Integration | Task ingress and model router become scaffold-aware |

## Tasks

### OSL-0.1 - Research-to-Spec Conversion

Status: review

Owner: codex

Scope:

- `docs/research/2026-06-28-ornith-self-scaffolding-analysis.md`
- `docs/specs/ornith-scaffold-learning/spec.md`
- `docs/specs/ornith-scaffold-learning/tasks.md`
- `.autoclaw/orchestrator/manifests/ornith-scaffold-learning.yaml`
- `.autoclaw/orchestrator/boards/ornith-scaffold-learning.*`

Acceptance:

- The Ornith research note is converted into a formatted AutoClaw spec.
- The work is split into assignable tasks with disjoint scopes.
- A focused board file exists for the initiative.

### OSL-1.1 - Scaffold Types and Store

Status: review

Owner: codex

Scope:

- `src/workflows/scaffolds/types.ts`
- `src/workflows/scaffolds/store.ts`
- `src/workflows/scaffolds/index.ts`
- `src/test/workflow-scaffolds.test.ts`
- `src/workflows/index.ts`
- `package.json`

Acceptance:

- `ScaffoldVariant`, `ScaffoldScore`, `PromptHarnessContract`, and monitor
  violation types compile.
- JSONL store appends and reads score rows deterministically.
- Unknown future fields survive round-trip where appropriate.
- Score rows never persist prompt or response content.

Verification:

- `npm run compile`
- `npx mocha --ui tdd --timeout 30000 out/test/workflow-scaffolds.test.js`
- `npx mocha --ui tdd --timeout 30000 out/test/reviewfleet-roster.test.js`

### OSL-2.1 - Scaffold Scorer

Status: review

Owner: codex

Scope:

- `src/workflows/scaffolds/score.ts`
- `src/workflows/runLedger.ts`
- `src/test/workflow-scaffoldScore.test.ts`
- `src/workflows/scaffolds/types.ts`
- `src/workflows/scaffolds/index.ts`
- `package.json`

Acceptance:

- Mocked workflow run summaries produce reward rows.
- Gates, failure types, retry count, cost, duration, and review verdict affect
  reward.
- Anti-hacking violation forces zero or negative reward.
- Corrupt or incomplete runs degrade to a typed warning, not a crash.

Verification:

- `npm run compile`
- `npx mocha --ui tdd --timeout 30000 out/test/workflow-scaffoldScore.test.js out/test/workflow-scaffolds.test.js`
- `npx mocha --ui tdd --timeout 30000 out/test/reviewfleet-router.test.js out/test/reviewfleet-roster.test.js`
- `npx mocha --ui tdd --timeout 30000 out/test/workflow-runLedger.test.js`

### OSL-3.1 - Scaffold Selector

Status: review

Owner: codex

Scope:

- `src/workflows/scaffolds/select.ts`
- `src/workflows/intentRouter.ts`
- `src/test/workflow-scaffoldSelector.test.ts`
- `src/workflows/scaffolds/index.ts`
- `package.json`

Acceptance:

- Selector ranks by intent, profile, locality/privacy constraints, failure type,
  model/harness, historical reward, cost, and recency.
- Passing low-cost scaffold outranks a costly failing one.
- Local-only and air-gapped profiles never select cloud-only harnesses.
- Selection reason is concise and ledger-safe.

Verification:

- `npm run compile`
- `npx mocha --ui tdd --timeout 30000 out/test/workflow-scaffoldSelector.test.js out/test/workflow-intentRouter.test.js out/test/workflow-scaffolds.test.js out/test/reviewfleet-router.test.js`
- GitHub Actions CI run `28369948693` on `f6765cb`

### OSL-3.2 - Scaffold Mutations

Status: open

Scope:

- `src/workflows/scaffolds/mutate.ts`
- `src/workflows/loops.ts`
- `src/intelligence/contextPack.ts`
- `src/test/workflow-scaffoldMutations.test.ts`

Acceptance:

- Supported mutation kinds cover context mode, loop policy, router profile,
  best-of-N count, tool lane, and reviewer independence.
- Mutation output is bounded and validates before execution.
- No mutation may widen file scope or bypass policy without human approval.

### OSL-4.1 - Prompt Harness Registry

Status: open

Scope:

- `src/llm/promptHarness.ts`
- `src/llm/modelCatalog.ts`
- `src/test/llm-promptHarness.test.ts`

Acceptance:

- Harness contracts represent OpenAI tools, Qwen XML tools, Anthropic-style
  tool use, reasoning fields, think tags, and tool response wrapping.
- Providers can advertise supported harnesses.
- Unsupported harness/model combinations are rejected with an actionable reason.

### OSL-5.1 - Anti-Hacking Monitor

Status: open

Scope:

- `src/workflows/scaffolds/monitor.ts`
- `src/workflows/contracts.ts`
- `src/orchestrator/scopeLease.ts`
- `src/test/workflow-antiHackingMonitor.test.ts`

Acceptance:

- Monitor blocks reads of hidden verifier paths.
- Monitor blocks writes to verifier, hidden tests, run ledger, score ledger, and
  policy files unless explicitly allowed.
- Out-of-scope edits map to `scope_conflict` or a specific monitor violation.
- Violation emits a finding_report payload shape and zeroes reward.

### OSL-6.1 - VoidSpec Scaffold Metadata

Status: open

Scope:

- `src/voidspec/types.ts`
- `src/voidspec/sync.ts`
- `src/voidspec/dispatch.ts`
- `src/test/voidspec.test.ts`
- `src/test/voidspec-yaml.test.ts`

Acceptance:

- VoidSpec tasks can carry `intent`, `success.gates`, constraints, and
  `preferred_scaffold`.
- Sync preserves the metadata into mirrored AutoClaw tasks.
- Dispatch can invoke scaffold selection before native task conversion.
- Existing VoidSpec fixtures continue to pass.

### OSL-6.2 - ZMLR Scaffold-Aware Recommendation

Status: open

Scope:

- `src/llm/zippymesh.ts`
- `src/workflows/intentRouter.ts`
- `docs/specs/llm-provider-s2-zmlr-mcp-route/spec.md`
- `src/test/llm-zippymesh.test.ts`
- `src/test/workflow-intentRouter.test.ts`

Acceptance:

- ZMLR recommendation requests can include failure type, harness requirements,
  and scaffold score hints.
- Responses can identify a `harnessId` alongside the model.
- Older ZMLR responses still parse and fall back cleanly.
- Intent router reasons mention scaffold/harness only when present.
