# v2.5.0 — Capability-Aware Router (Phase 3) Execution Report

Date: 2026-05-10
Branch: `worktree-agent-a45d5723d4add3a74`
Baseline: master `94729c3` (v2.4.0, 259 unit tests)

## Mission

Replace the orchestrator's slot-index round-robin agent assignment in
`src/orchestrate.ts` (`for (let agentIdx = 0; agentIdx < agentCount; ...)
→ WA-${agentIdx + 1}`) with a capability-aware scorer per
`docs/DISTRIBUTED_AGENT_FABRIC.md` §3 Phase 3:

```
score(agent, task) = capability_match × trust_score × idle_factor / estimated_cost
```

## Files touched

| File | Change |
| --- | --- |
| `src/orchestrate.ts` | +330 / -77 — `scoreAgent`, `jaccardIndex`, `trustWeight`, `ScorableAgent`, `PlannedTask`, `EFFORT_HOURS`, `ManifestTask.required_capabilities`, `Sprint.notes`, scoring fields on `AgentRegistryEntry`, refactored `planSprints` inner loop to a slot-state model that branches on `useScorer`. |
| `src/test/orchestrate.test.ts` | +326 / -1 — three new suites: helpers, scorer, planSprints-with-capability-aware-registry. |
| `skills/orchestrate/SKILL.md` | +3 / -1 — Phase 1 documents `required_capabilities`; Phase 5 documents the routing branch and the `notes` fallback warning. |

LOC delta (vs baseline `94729c3`): **+649 / -88** across 3 files.

## Tests

- Baseline: **259 passing**
- After commit 1 (`scoreAgent`): 273 passing (+14: 5 helpers + 9 scorer)
- After commit 2 (`planSprints` integration): 278 passing (+5)
- After commit 3 (manifest field): 278 passing (docs-only)

**Final: 278 passing**, 0 failing, 0 skipped. `npm run test:unit` green
on every commit.

### New tests added (19 total)

`jaccardIndex / trustWeight helpers` (5):
- empty/empty = 1; disjoint = 0; identical = 1; partial = intersection/union;
  trust map (untrusted=0, low=0.4, medium=0.7, high=1.0, missing=0.5).

`scoreAgent` (9):
- untrusted ⇒ 0; zero-cap-overlap on typed task ⇒ 0;
  saturated agent (in_flight=max) ⇒ 0; high-trust > low-trust on equal fit;
  language overlap is a 2× multiplier on capability_match (1.0 vs 0.5);
  idle_factor scales linearly with remaining capacity;
  cheaper hourly_usd outscores expensive on equal fit;
  blank-registry agent on no-cap task still scores > 0;
  effort hours scale: S vs XL = 8× ratio.

`planSprints with capability-aware registry` (5):
- Go-capable agent wins a Go task over a TypeScript-only agent;
  high-trust slot wins the security-tagged task over equal-cap low-trust;
  no-positive-score path falls back to round-robin AND writes a `notes`
  warning naming the task; legacy registry (no v2 fields) produces
  output identical to the no-registry baseline (regression-locked);
  scoring path with empty caps + no-cap tasks safely assigns everything.

## Worked formula examples

All using `EFFORT_HOURS = { S: 2, M: 4, L: 8, XL: 16 }`,
`trustWeight = { untrusted: 0, low: 0.4, medium: 0.7, high: 1.0 }`.

### Example 1 — Specialist beats generalist on a typed task

Task `t1`: `effort='M'` (4h), `required_capabilities=['go']`.

- Agent A: caps `['go']`, trust `high`, max_parallel 1, in_flight 0,
  languages_supported `['go']`, hourly $1.
  - jaccard = 1/1 = 1; langFactor = 1.0 → capability_match = 1.0
  - trust = 1.0; idle = (1-0)/1 = 1.0; cost = max(0.01, 4 × 1) = 4
  - **score = 1.0 × 1.0 × 1.0 / 4 = 0.25**
- Agent B: caps `['typescript']`, trust `high`, max_parallel 1,
  in_flight 0, languages_supported `['typescript']`, hourly $1.
  - jaccard({ts}, {go}) = 0 → capability_match = 0
  - **score = 0**

Router picks A. Verified by test
`Go-capable agent gets the Go task; TS-only agent does not`.

### Example 2 — Trust tiebreaks equal capability

Task `t2`: `effort='M'`, `required_capabilities=['security-review']`.

Both agents fully capable, both idle, both hourly $1. Difference: trust.

- Agent A: trust `low`, langs `['security-review']`.
  - capability_match = 1.0 × 1.0 = 1.0; trust = 0.4; idle = 1.0; cost = 4
  - **score = 1.0 × 0.4 × 1.0 / 4 = 0.10**
- Agent B: trust `high`, langs `['security-review']`.
  - **score = 1.0 × 1.0 × 1.0 / 4 = 0.25**

Router picks B. Verified by test
`high-trust agent gets the security task over low-trust on equal capability fit`.

### Example 3 — All-zero scores trigger the round-robin fallback

Task `t3`: `effort='M'`, `required_capabilities=['rust']`.

- Agent A: caps `['go']`, langs `['go']`, hourly $1, trust `high`.
  - jaccard({go}, {rust}) = 0 → score = 0
- Agent B: caps `['typescript']`, langs `['typescript']`, hourly $1,
  trust `high`.
  - jaccard({typescript}, {rust}) = 0 → score = 0

`anyPositive` is false → fallback path: pick the lowest-numbered slot
that satisfies capacity + scope + mutex (here WA-1) and append to the
sprint's `notes`:

```
task t3: no agent had positive capability score; fell back to round-robin (assigned WA-1)
```

Verified by test
`falls back to round-robin and emits a notes warning when no agent has positive score`.

## Backwards compatibility statements

1. **Manifest forwards-compat.** `required_capabilities` is optional
   with default `[]`. Any pre-existing manifest plans identically
   (empty-set jaccard against any agent = 1, dampened to 0.5 by missing
   languages_supported, but still strictly positive — so the legacy
   ordering is preserved when the registry is unpopulated).
2. **Registry forwards-compat.** `AgentRegistryEntry` gains five
   optional v2 scoring fields (`capabilities`, `trust_level`,
   `cost_budget`, `max_parallel_tasks`, `languages_supported`). Entries
   that set ONLY the legacy v1 fields trigger the legacy round-robin
   path — `useScorer` is false. Verified by the dedicated regression
   test `no registry → output identical to legacy round-robin`.
3. **planSprints API unchanged.** Signature is identical; the new
   behaviour is gated entirely on the contents of `agents`.
4. **Sprint.notes is optional.** Existing serialisers / readers ignore
   the field; the YAML/Markdown emitters only render it when present.
   Existing tests asserting Sprint shape (e.g. `Sprint Markdown rendering`)
   continue to pass with no changes.
5. **Excluded slots still work.** The existing `excludedSlots: Set<string>`
   contract is honoured in both paths via the per-slot `excluded` flag.

## Deviations from the spec

- The spec sketch's `agent.languages_supported_overlap` reads as a
  precomputed boolean. Implementation treats it as a runtime check
  against the agent's `languages_supported` array vs the task's
  `required_capabilities`. When `languages_supported` is undefined or
  empty, the multiplier is `0.5` (the spec's "uncertain" default). This
  is consistent with the formula intent and avoids a second
  configuration surface that callers would have to compute themselves.
- `effort_estimate` is sourced from the existing `effort` field via a
  new `EFFORT_HOURS` map (S=2, M=4, L=8, XL=16) rather than a new
  task-level number. Keeps the manifest schema additive.

## Suggested CHANGELOG entry (v2.5.0)

```
### Added
- Capability-aware sprint router (Phase 3 of the distributed agent
  fabric). `planSprints` now consults `scoreAgent(agent, task) =
  capability_match × trust_score × idle_factor / estimated_cost` when
  the agent registry populates v2 scoring fields (capabilities,
  trust_level, cost_budget, max_parallel_tasks, languages_supported).
- `ManifestTask.required_capabilities?: string[]` — optional capability
  tags consumed by the router.
- `Sprint.notes?: string[]` — populated when the router falls back to
  round-robin because no agent scored > 0 for a task.
- `scoreAgent`, `jaccardIndex`, `trustWeight`, and the `ScorableAgent`
  / `PlannedTask` types are exported from `src/orchestrate.ts`.

### Changed
- `planSprints` inner loop refactored to a slot-state model. The
  legacy slot-index round-robin path is preserved verbatim and is
  selected automatically when the agent registry has no v2 scoring
  fields populated, so older manifests, plans, and tests are
  unaffected.

### Tests
- 19 new unit tests (`scoreAgent` × 9, helpers × 5, planSprints with
  capability-aware registry × 5). 259 → 278 passing.
```

## Commits

1. `feat(orchestrate): scoreAgent — capability-aware scoring (jaccard × trust / cost)`
2. `feat(orchestrate): planSprints uses scoreAgent when registry supplied; falls back to round-robin otherwise`
3. `feat(orchestrate): PlannedTask.required_capabilities field + manifest parsing`

No version bump, no tag, no push (per mission constraints).
