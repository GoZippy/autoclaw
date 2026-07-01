# AutoClaw Naming Guide

Date: 2026-06-30

This guide keeps AutoClaw product language distinct from outside research,
models, products, and projects that influenced our design. Research names may
appear in cited research notes. They should not become commands, settings,
marketplace copy, paid feature names, or Zippy product names.

## Naming Rules

1. Use Zippy-owned or descriptive names for public surfaces.
2. Keep third-party names in citations, benchmarks, adapters, and provider
   labels only.
3. Prefer function-first names over research codenames.
4. Preserve user trust: do not imply we built, own, or bundle a third-party
   model or codebase unless that is factually true.
5. Migrate public language before internal code namespaces. Compatibility
   aliases are acceptable during transition.

## Approved Product Vocabulary

| Concept | Public name | Internal-friendly name | Notes |
|---|---|---|---|
| Learning workflow policies from verified outcomes | Adaptive Workflow Learning | `workflowLearning` | Replaces public use of OSL/Ornith-style names. |
| Reusable workflow strategy | Workflow Playbook | `playbook` or legacy `scaffold` | "Scaffold" may remain in code where already established. |
| Generating bounded variants | Playbook Tuning | `playbookTuning` or `mutate` | Use for mutation UX/docs. |
| Reward rows from tests/reviews/cost | Outcome Scoring | `outcomeScore` | Replaces "scaffold score" in public copy. |
| Anti-gaming policy boundary | Reward Guard | `rewardGuard` | Softer and more product-safe than "anti-hacking monitor". |
| Automated review agents | Verifier Fleet | `reviewfleet` | "Review Fleet" is acceptable, but Verifier Fleet is clearer for paid tiers. |
| Hierarchical project/run memory index | Context Spine | `contextIndex` | Inspired by sparse/hierarchical retrieval, but not named after outside papers. |
| Verified task/run episodes | Trace Ledger | `traceLedger` | Training/eval/export substrate. |
| Model/tool router | ZippyMesh Router | `zippymesh` | Avoid acronym-first UX such as ZMLR in public copy. |
| Canonical task/spec input | ZippySpec or TaskSpec | `voidspec` legacy | Decide before expanding VoidSpec branding further. |

## Reserved For Research Notes Only

Do not use these as AutoClaw feature names:

- Ornith, OSL, Owl, Owl-Alpha
- LongCat, LongCat Sparse Attention
- HISA or paper-specific method names
- Any third-party model codename unless it is a provider/model label

Acceptable use:

- "Benchmarked against LongCat-2.0 via provider X."
- "Research note: LongCat-style sparse retrieval suggests a Context Spine."
- "Legacy codename OSL appears in old task IDs."

## User-Facing Naming Map

| Legacy wording | Preferred wording |
|---|---|
| OSL | Adaptive Workflow Learning |
| Scaffold Learning | Playbook Learning |
| Scaffold Variant | Workflow Playbook variant |
| Scaffold Mutation | Playbook Tuning |
| Scaffold Score | Outcome Score |
| Anti-Hacking Monitor | Reward Guard |
| Review Fleet | Verifier Fleet or Review Fleet |
| ZMLR | ZippyMesh Router |
| Episode Ledger | Trace Ledger |

## Command And Setting Style

Use lower-case, descriptive command ids:

- `autoclaw.context.index`
- `autoclaw.traces.export`
- `autoclaw.playbooks.tune`
- `autoclaw.verifiers.start`
- `autoclaw.rewards.guard`
- `autoclaw.models.benchmark`

Avoid:

- `autoclaw.osl.*`
- `autoclaw.ornith.*`
- `autoclaw.longcat.*` except provider-specific benchmark labels

## Tier Naming Guidance

Free/Core:

- Local Context Spine basics.
- Local Trace Ledger.
- Manual Workflow Playbooks.
- Manual Verifier Fleet runs with local/free models.

Pro:

- Always-on Playbook Tuning.
- Automated Verifier Fleet escalation.
- Advanced Context Spine modes.
- Model canary benchmarks.
- Dataset export for distillation.

Teams:

- Shared Trace Ledger.
- Cross-agent memory and provenance.
- Org chart and sub-orchestrator policies.
- Cross-machine verifier governance.

Enterprise/Hosted:

- Managed relay, vector/KG backend, private model endpoints, SSO, retention,
  compliance export, and private model training support.

## Migration Policy

1. New public docs and commands use approved names immediately.
2. Existing code may keep legacy names until touched for functional work.
3. When renaming internal modules, ship aliases for at least one minor version.
4. Research docs keep citations and original names for auditability.
