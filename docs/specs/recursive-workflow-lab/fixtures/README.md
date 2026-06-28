# Workflow Lab Fixtures — WL-0.5

This directory contains the canonical workflow DSL fixtures for the AutoClaw
Workflow Lab. They are the acceptance gate for task WL-0.5 and are consumed by
`src/test/workflow-fixtures.test.ts`.

## How to add a fixture

1. Author the workflow in JSON following the `WorkflowDefinition` type in
   `src/workflows/types.ts`. Required fields:
   - `schema: 'autoclaw.workflow.v1'`
   - `id`, `name`, `description`
   - `contract` with `inputs`, `outputs`, `successCriteria`
   - `policies.budget` and `policies.routingProfile`
   - `nodes` (each with `id`, `type`, `kind`, `config`)
   - `edges` (each with `id`, `from.node`, `to.node`)
   - `metadata.packId`, `metadata.tags`
2. Save as `<workflow-id>.workflow.json`.
3. Copy to `src/test/fixtures/workflows/`.
4. Run `npm run test:unit` — the fixture test validates every file.

## Validation contract

`src/workflows/validate.ts` exports `validateWorkflow(unknown)` which enforces:

- `schema === 'autoclaw.workflow.v1'`
- `id` and `name` are non-empty strings
- `nodes` and `edges` are arrays
- Each node has `id`, `type`, `kind`, `config` (object); no duplicate ids
- Each edge has `id`, `from.node`, `to.node`; both endpoints exist
- Gate nodes have `config.criterion | config.check | config.command`
- Tool nodes have `config.command | config.toolId | config.action`
- Agent nodes have `config.provider | config.providerId | config.model`
- Budget and iteration policies are positive numbers
- Cycles are rejected unless they pass through an explicit `loop` node

The fixture test additionally requires:

- `contract.inputs`, `contract.outputs`, `contract.successCriteria` are
  non-empty arrays
- `policies.budget` and `policies.routingProfile` are present
- `metadata.packId` and `metadata.tags` are present
- Every gate / tool / agent node satisfies the validator config rules

## What is intentionally NOT validated here

- Contract field-level semantics (e.g. that `requiredTools` actually map to
  installed tools) — that is the preflight/simulation step (WL-1.6).
- Runtime correctness of edge expressions — that is the runner's job (WL-1.1).
- Pack-trust / signature verification — that is WL-6.7.

## Files

- `cheap-fix-loop.workflow.json` — local-first fix-failing-test loop
- `context-repair-loop.workflow.json` — failure-aware context repair
- `adversarial-test-loop.workflow.json` — test/mutant adversarial loop
- `release-gate.workflow.json` — release gate with human approval
- `model-benchmark-routing.workflow.json` — model benchmark + routing profile
