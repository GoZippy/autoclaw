# Adaptive Workflow Learning Tasks

Date: 2026-06-30

Companion spec: [spec.md](spec.md)

Status keys: `open`, `claimed`, `in-progress`, `review`, `complete`,
`blocked`.

## Milestone Overview

| Milestone | Theme | Outcome |
|---|---|---|
| NAM | Naming and migration | Product-safe language replaces research codenames in new public surfaces. |
| CS | Context Spine | Hierarchical context index shared by memory, routing, review, and playbooks. |
| TL | Trace Ledger | Verified run episodes become replayable and exportable. |
| AWL | Adaptive Workflow Learning | Playbooks select, tune, verify, score, and improve. |
| BENCH | Model Canary Benchmarks | Candidate models and agent mixtures are measured before adoption. |
| VFY | Verifier Fleet integration | Reviewers become a reward source without silent approval. |
| SPEC | ZippySpec/TaskSpec cleanup | Canonical task-spec contracts are documented and parsed robustly. |
| PUB | Research/paper package | Methods are publishable without claiming copied model architecture. |

## Tasks

### NAM-1 - Product Naming Guide

Status: complete

Scope:

- `docs/BRAND_NAMING_GUIDE.md`

Acceptance:

- Public names are defined for Adaptive Workflow Learning, Context Spine, Trace
  Ledger, Workflow Playbooks, Playbook Tuning, Outcome Scoring, Reward Guard,
  Verifier Fleet, and ZippyMesh Router.
- Research names are explicitly restricted to citations and historical notes.
- Free/Pro/Teams/Enterprise naming guidance is captured.

### NAM-2 - Public Language Sweep

Status: open

Scope:

- `docs/specs/ornith-scaffold-learning/**`
- `docs/specs/adaptive-workflow-learning/**`
- `docs/V3_1_ROADMAP.md`
- `docs/V4_PLAN.md`
- `README.md`
- Marketplace-facing copy when touched

Acceptance:

- New public docs prefer Adaptive Workflow Learning and Workflow Playbook terms.
- Legacy OSL/Ornith names are marked as historical codenames, not product names.
- No command, setting, paid tier, or marketplace copy uses third-party research
  names.

### CS-1 - Context Spine Contracts and Store

Status: review

Scope:

- `src/intelligence/contextSpine.ts`
- `src/intelligence/contextIndex.ts`
- `src/test/intelligence-contextSpine.test.ts`
- `docs/specs/adaptive-workflow-learning/spec.md`

Acceptance:

- Defines stable context block IDs for project, spec, run, file, symbol, and
  span levels.
- Supports append/update/read of block metadata without storing raw prompts.
- Provides coarse-to-fine retrieval APIs that can return references before
  snippets.
- Degrades safely when vector/KG backends are unavailable.

### CS-2 - Context Pack v2 Modes

Status: open

Scope:

- `src/intelligence/contextPack.ts`
- `src/test/intelligence-contextpack.test.ts`
- `docs/specs/recursive-workflow-lab/tasks.md`

Acceptance:

- Adds `minimal`, `balanced`, `full`, `kg-heavy`, and `episode-replay` modes.
- Context packs include Context Spine block IDs and provenance notes.
- Existing context-pack output remains backward compatible by default.
- Review Fleet and workflow routing can request a mode without duplicating
  retrieval logic.

### CS-3 - Streaming Run Context Cache

Status: open

Scope:

- `src/intelligence/contextSpine.ts`
- `src/workflows/runLedger.ts`
- `src/test/intelligence-contextSpine.test.ts`

Acceptance:

- Run episodes can append contiguous event windows for later replay.
- Cache entries reference claim, inbox, gate, diff, and review evidence.
- Consumers can request the last N relevant windows by task, file, playbook, or
  failure type.

### TL-1 - Trace Ledger Schema and Writer

Status: open

Scope:

- `src/workflows/traces/types.ts`
- `src/workflows/traces/ledger.ts`
- `src/workflows/scaffolds/score.ts`
- `src/reviewfleet/prod.ts`
- `src/test/workflow-traceLedger.test.ts`

Acceptance:

- Defines verified trace rows with task/run/session/agent IDs, playbook ID,
  model/provider/harness, context block IDs, tool-call summaries, changed-file
  summaries, tests, verifier verdicts, reward, cost, duration, retries, and
  Reward Guard findings.
- Writes JSONL rows under `.autoclaw/workflows/traces/`.
- Never stores prompt bodies, hidden chain-of-thought, or raw private response
  bodies by default.
- Can be joined with existing scaffold scores and cost ledger rows.

### TL-2 - Trace Export for Evals and Distillation

Status: open

Scope:

- `src/workflows/traces/export.ts`
- `src/test/workflow-traceExport.test.ts`
- `docs/specs/adaptive-workflow-learning/spec.md`

Acceptance:

- Exports filtered traces for local evals and opt-in distillation datasets.
- Supports redaction of paths, secrets, raw diffs, and private project names.
- Produces dataset manifests with license/provenance fields.
- Requires explicit user action for export.

### AWL-1 - Workflow Playbook Alias Layer

Status: review

Scope:

- `src/workflows/scaffolds/types.ts`
- `src/workflows/scaffolds/index.ts`
- `src/test/workflow-scaffolds.test.ts`
- `docs/specs/adaptive-workflow-learning/tasks.md`

Acceptance:

- Adds product-safe type aliases or comments for Workflow Playbook terminology
  while preserving existing scaffold APIs.
- Public docs use Playbook terminology.
- Existing tests and code remain backward compatible.

### AWL-2 - Playbook Experiment Runner

Status: open

Scope:

- `src/workflows/playbooks/experiment.ts`
- `src/workflows/scaffolds/mutate.ts`
- `src/workflows/scaffolds/select.ts`
- `src/workflows/scaffolds/score.ts`
- `src/test/workflow-playbookExperiment.test.ts`

Acceptance:

- Executes one bounded loop: select playbook, optionally tune child variant,
  run/evaluate injected executor, score outcome, apply Reward Guard result, and
  append Trace Ledger row.
- Uses injectable seams so tests run without live model calls.
- Never auto-promotes a child playbook without passing policy, reward, and
  verifier thresholds.

### AWL-3 - Playbook Promotion Policy

Status: open

Scope:

- `src/workflows/playbooks/promotion.ts`
- `src/test/workflow-playbookPromotion.test.ts`

Acceptance:

- Defines conservative promotion/demotion decisions from outcome history.
- Requires minimum sample count and verifier confidence.
- Penalizes scope violations, false accepts, reward-guard findings, and high
  cost without corresponding quality gain.
- Emits concise audit reasons.

### BENCH-1 - Model Canary Benchmark Harness

Status: open

Scope:

- `src/llm/bench/canary.ts`
- `src/llm/bench/types.ts`
- `src/test/llm-canaryBenchmark.test.ts`
- `docs/specs/adaptive-workflow-learning/tasks.md`

Acceptance:

- Replays a fixed set of task fixtures through candidate providers/models with
  no private secrets.
- Scores routing, tool-use, review quality, false accept/reject, latency, cost,
  and harness failures.
- Supports local-only, BYO provider, and ZippyMesh Router candidates.
- Produces a report suitable for deciding whether to add or demote a model.

### BENCH-2 - Stale Consensus Replay Pack

Status: open

Scope:

- `src/llm/bench/consensusReplay.ts`
- `src/test/llm-consensusReplay.test.ts`
- `.autoclaw/orchestrator/comms/consensus/**` only through tests/mocks

Acceptance:

- Replays stale consensus/review items through mock or local reviewers at zero
  cost by default.
- Produces verdict-quality and routing-quality metrics.
- Does not move or mutate live consensus files unless explicitly configured.

### VFY-1 - Verifier Fleet Reward Integration

Status: open

Scope:

- `src/reviewfleet/service.ts`
- `src/reviewfleet/prod.ts`
- `src/workflows/scaffolds/score.ts`
- `src/test/reviewfleet-service.test.ts`
- `src/test/workflow-scaffoldScore.test.ts`

Acceptance:

- Verifier Fleet verdicts are recorded as reward evidence for Outcome Scoring.
- Human-required outcomes never silently approve.
- Cross-provider reviewer independence is represented in trace rows.
- Existing dormant-by-default cost gates remain intact.

### VFY-2 - Reward Guard Finding Reports

Status: open

Scope:

- `src/workflows/scaffolds/monitor.ts`
- `src/orchestrator/findings.ts`
- `src/test/workflow-antiHackingMonitor.test.ts`

Acceptance:

- Reward Guard violations emit structured finding reports with playbook,
  task, agent, path, severity, and remediation fields.
- Findings can be consumed by board/review surfaces.
- Score penalties remain deterministic.

### SPEC-1 - TaskSpec Contract Document

Status: review

Scope:

- `docs/specs/taskspec/tasks-yaml.md`
- `docs/VOIDSPEC_FOLLOWUPS.md`
- `src/voidspec/types.ts`

Acceptance:

- Documents the canonical task YAML shape field-by-field.
- States the conflict rule: external spec owns "what"; AutoClaw owns execution
  state and "how far".
- Uses TaskSpec/ZippySpec language for new public docs while preserving
  VoidSpec compatibility.

### SPEC-2 - YAML Parser Hardening

Status: open

Scope:

- `src/voidspec/sync.ts`
- `src/test/voidspec.test.ts`
- `src/test/voidspec-yaml.test.ts`

Acceptance:

- Replaces brittle hand-rolled YAML parsing with the existing `js-yaml`
  dependency.
- Keeps `VoidSpecDocument` and `VoidSpecTask` output shapes unchanged.
- Adds nested map, quoted string, inline list, and multiline scalar fixtures.
- Does not change sync conflict rules.

### PUB-1 - Research Method Package

Status: open

Scope:

- `docs/research/adaptive-workflow-learning-method.md`
- `docs/specs/adaptive-workflow-learning/spec.md`

Acceptance:

- Frames AutoClaw's method as middleware-level Adaptive Workflow Learning, not
  copied model architecture.
- Cites outside research and models in a clear references section.
- Defines publishable claims, ablations, and benchmarks based on Trace Ledger
  and Model Canary Benchmark data.
- Explicitly avoids claiming hidden chain-of-thought training or third-party
  model ownership.
