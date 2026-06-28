# Design: One Outcome Event → { Reputation Row + KG Edge }

Status: draft (coordinator half) · 2026-06-28 · Owner: claude-code (Phase-C coordinator)
Co-author: KG-viewer track (fills the KG-edge half, marked TODO below)

This is the design for backlog item **A — "orchestrator auto-creating real edges"**
(dispatch→completion progressions in the Knowledge Graph). It exists to prevent
the trap the KG agent correctly flagged: building a *second* event-pairing
pipeline inside the ~30s orchestrator tick.

## The key insight (why A is not a hot-loop task)

A task's completion is **already an event** in AutoClaw — the consensus
evaluation path records it via `recordOutcomeOnce` / `recordTaskOutcome`
(`src/reputation/ledger.ts`, called from `src/bridge.ts` and `src/extension.ts`).
That same event is exactly what the KG wants to turn into an edge.

So we do **not** add a poller that re-reads state every 30s to pair
dispatch with completion. We fan the **one existing outcome event** out to
**two sinks**:

```
                         ┌─────────────────────────────┐
  task completes  ──▶    │  outcome event (1 source)   │
  (consensus evaluate)   │  recordOutcomeOnce(outcome) │
                         └──────────────┬──────────────┘
                                        │ fan-out (synchronous, best-effort)
                    ┌───────────────────┴────────────────────┐
                    ▼                                          ▼
        ┌───────────────────────┐                 ┌───────────────────────┐
        │ REPUTATION SINK (DONE) │                 │ KG SINK (this design)  │
        │ recordTaskOutcome →    │                 │ recordRelation(edge)   │
        │ ledger → aggregate →   │                 │ → durable KG edge      │
        │ reputationFactor →     │                 │ (deduped, det-id)      │
        │ dispatch routing       │                 └───────────────────────┘
        │ (BL-6/BL-7/cap-route)  │
        └───────────────────────┘
```

**Event-driven, not loop-driven.** The fan-out runs in the same call that
already records the outcome — no new orchestrator-tick work, no KG reads inside
the hot loop. Both sinks are best-effort and MUST NOT block or throw into the
outcome path (mirror `CostLedger.append`'s swallow-on-failure contract).

## Reputation sink — DONE (this session)

Already wired and proven:
- `recordTaskOutcome(workspaceRoot, outcome)` → `.../reputation/` ledger.
- `aggregateReputation` / `reputationFactor` → per-agent + per-capability scores.
- `buildReputationPreference` / `dispatchPreferredByReputation` (BL-7) and
  `dispatchPreferredForCapability` (capability routing) → routing.
- Recursive-learning-loop integration test proves routing flips after outcomes.

No change needed here beyond the fan-out call site.

## KG sink — RATIFIED (see companion `kg-edge-outcome-contract.md`)

> **Status 2026-06-28:** The KG-viewer track delivered + the coordinator ratified the
> KG-edge half in `docs/specs/kg-edge-outcome-contract.md`. Key resolution to the open
> schema question below: KG `edges` connect **thought ids**, so entity nodes
> `agent:<id>` / `task:<project>:<taskId>` / `capability:<cap>` are materialized via
> `ensureNode` (best-effort `recordThought`, swallow-dup). Taxonomy = `completed` /
> `reviewed` / `demonstrated`, idempotent by the `(from,kind,to)` PK. `recordOutcomeEdge`
> ships on `feat/kg-viewer` (→3.6.10); the fan-out wrapper + call site below ship in
> Phase-C (→3.6.11). All three open questions resolved (single `recordOutcome` entry:
> yes; structural edges, no factor snapshot: yes; landing order: function vs call site,
> no shared edit). Implementation green-lit; landing waits for 3.6.9.

The original TODO sketch (now superseded by the companion contract):

The single integration point is the existing outcome call site (consensus
evaluate). Add ONE best-effort call alongside `recordTaskOutcome`:

```ts
// pseudocode at the existing outcome recording site
await recordTaskOutcome(workspaceRoot, outcome);      // reputation (done)
await recordOutcomeEdge(workspaceRoot, outcome).catch(() => {}); // KG (new, best-effort)
```

`recordOutcomeEdge` lives next to `recordLearningsToKg` in
`src/intelligence/kgRecord.ts` (the KG agent's module) and must be:
- **degrade-safe** (no KG configured → no-op, never throws),
- **deterministic id** (re-recording the same outcome dedupes — same contract as
  `recordLearningsToKg`),
- **content-free of secrets** (counts/ids/verdict only).

### KG-edge half — to be specified by the KG agent

> KG agent: fill these in this doc, then we merge halves.

- **Edge kinds** (proposed starting set — refine):
  - `agent --completed--> task` (verdict, gate_passed, timestamp)
  - `task --reviewed-by--> agent` (when a distinct reviewer voted)
  - `agent --demonstrated--> capability` (from `outcome.capabilities[]`, so the
    graph mirrors the per-capability reputation the router now uses)
- **Dedup id scheme**: `<edge-kind>:<task_id>:<agent_id>[:<capability>]` (TODO confirm).
- **`recordRelation` contract**: exact signature, node-upsert behavior, and how
  it shares the 768-dim store the viewer's unified search already spans.
- **Backfill**: optional one-shot to edge the existing reputation ledger rows
  (decide separately; not required for v1).

## Why this is safe to land incrementally

- The reputation half already ships and is tested.
- The KG half is a single additive best-effort call at one site — no hot loop,
  no new poller, no orchestrator-tick reads.
- Each half is independently testable: reputation via the existing
  recursive-learning-loop test; KG via a `recordOutcomeEdge` unit test mirroring
  the `kgRecord` tests.

## Open questions

1. Fan-out site: the consensus-evaluate path in `bridge.ts`/`extension.ts` — do
   we wrap both sinks in one helper `recordOutcome(workspaceRoot, outcome)` that
   calls reputation + KG, so callers have a single entry point? (Recommended.)
2. Should the KG edge also carry the computed `reputationFactor` at record time
   (a snapshot), or stay structural and let the viewer compute on read? (Lean
   structural — reputation is already its own queryable store.)
3. Landing order: this rides the serialized train after 3.6.9 (reputation half
   already in Phase-C; KG half in the feat/kg-viewer line) — reconcile at merge.
