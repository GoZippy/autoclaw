# KG-edge half: outcome → KG edges (companion to outcome-to-reputation-and-kg.md)

Status: draft (KG-viewer track half) · 2026-06-28 · Owner: claude-code (KG-viewer session)
Companion to: `docs/specs/outcome-to-reputation-and-kg.md` (coordinator's fan-out design).

This fills the **"KG sink — TODO"** section of the coordinator's doc. It specifies the
`recordOutcomeEdge` contract, the edge taxonomy, and — the part that needed a schema
decision — **how entity nodes are materialized**, since the KG `edges` table connects
*thought ids*, not free-floating entity names.

## Schema reality (the decision the coordinator's draft left open)

`edges` is `(from_id, kind, to_id, meta_json, created_at)` with **PRIMARY KEY
(from_id, kind, to_id)**. `recordRelation(from, kind, to, meta?)` does `INSERT OR
REPLACE` → an edge is **idempotent by the (from, kind, to) triple** (re-recording
refreshes meta; latest outcome wins). No separate edge-id is needed.

Critically, `traverseFrom(seed, …)` walks `edges JOIN thoughts ON walk.id =
thoughts.id` — **an edge endpoint only resolves if it is a thought id.** So the
proposed `agent --completed--> task` edges require `agent:*` and `task:*` to exist
as thoughts. We therefore materialize **lightweight entity-node thoughts**:

| Node | Deterministic id | kind | text | meta |
|---|---|---|---|---|
| Agent | `agent:<agentId>` | `agent` | `<agentId>` | `{ entity: 'agent' }` |
| Task | `task:<project>:<taskId>` | `task` | `<taskId>` | `{ entity: 'task', project }` |
| Capability | `capability:<cap>` | `capability` | `<cap>` | `{ entity: 'capability' }` |

`ensureNode` = a best-effort `recordThought` whose duplicate-id throw is swallowed
(same pattern as `recordLearningsToKg`) — first writer creates it, everyone else
no-ops. Entity nodes carry `meta.entity` so the viewer can style/filter them apart
from event/decision thoughts (and the unified search treats them as normal KG
thoughts — they embed via the shared 768-dim provider for free).

This turns the graph genuinely **structural**: agents ↔ tasks ↔ capabilities, which
is exactly the per-capability reputation surface the router (BL-7/cap-route) now uses
— now visible and traversable in the viewer's graph tab.

## Edge taxonomy (refined from the coordinator's starting set)

| Edge | from → to | meta | when |
|---|---|---|---|
| `completed` | `agent:<id>` → `task:<project>:<taskId>` | `{ verdict, gate_passed, resolved_at }` | every recorded outcome |
| `reviewed` | `agent:<reviewer>` → `task:<project>:<taskId>` | `{ vote }` | per distinct reviewer in `outcome.reviewers[]` (≠ assignee) |
| `demonstrated` | `agent:<id>` → `capability:<cap>` | `{ verdict, resolved_at }` | per `cap` in `outcome.capabilities[]` |

Idempotent by construction (the `(from, kind, to)` PK). A re-run of the same outcome
updates meta in place; a *new* verdict for the same task→agent updates `completed`'s
meta to the latest (the structural fact "agent completed task" is singular; the
verdict is its current state). Deferred kinds (v2): `supersedes` between consecutive
`coord:` decision thoughts on a re-decision; `dispatched`/`progresses` linking the
existing `dispatch:`/`completion:` observation thoughts (needs dispatch-thought
lookup — out of scope for the event-driven v1).

## `recordOutcomeEdge` contract

Lives next to `recordLearningsToKg` in `src/intelligence/kgRecord.ts`. Decoupled from
the reputation `Outcome` type via a plain input the caller maps:

```ts
export interface OutcomeEdgeInput {
  taskId: string;
  agentId: string;                 // the assignee/author
  verdict?: string;                // 'approved' | 'rejected' | …
  gatePassed?: boolean;
  resolvedAt?: string;             // ISO
  reviewers?: string[];            // distinct voters (assignee filtered out)
  capabilities?: string[];         // outcome.capabilities — mirrors per-cap reputation
}

/**
 * Materialize the outcome's entity nodes + structural edges in the KG.
 * Degrade-safe (no/degraded KG → no-op), idempotent (deterministic node ids +
 * (from,kind,to) edge PK), never throws, never blocks the outcome path.
 */
export async function recordOutcomeEdge(
  workspaceRoot: string,
  outcome: OutcomeEdgeInput,
  opts?: { log?: LogFn; deps?: RecordCoordinationDeps },
): Promise<RecordCoordinationResult>;   // { recorded, skipped } — counts nodes+edges
```

Behavior: resolve the KG handle (same inline pattern as `recordLearningsToKg`);
`ensureNode` the agent + task (+ each reviewer + each capability); then
`recordRelation` the `completed`, `reviewed`, `demonstrated` edges. Wrap every write
in try/catch → count, never surface. Returns `{recorded, skipped}`.

## Answers to the coordinator's open questions

1. **Single entry `recordOutcome(workspaceRoot, outcome)`** — **agreed, recommended.**
   It belongs at the outcome site (your reputation domain): it calls
   `recordTaskOutcome(...)` then `recordOutcomeEdge(...).catch(()=>{})`. I own
   `recordOutcomeEdge` (ships on `feat/kg-viewer`); you own the wrapper + call site
   (ships in Phase-C). Clean seam — function vs call site, no shared edit.
2. **Carry `reputationFactor` snapshot vs structural** — **structural, agreed.** The
   reputation ledger is the source of truth and already queryable; snapshotting a
   factor into edge meta would go stale. Edges carry only `verdict`/`gate_passed`/
   `resolved_at`. The viewer can join reputation on read if it ever wants the number.
3. **Landing order** — `recordOutcomeEdge` is additive in `kgRecord.ts` → rides
   `feat/kg-viewer` (3.6.10). The **call site** (bridge.ts/extension.ts fan-out) is
   yours and rides Phase-C (3.6.11). Reconcile at merge: my branch lands the function;
   Phase-C lands the one-line call. Neither touches the other's lines.

## Test plan

`recordOutcomeEdge` unit test mirroring `intelligence-kgrecord.test.ts` (fake KG):
asserts (a) agent/task/capability nodes created with deterministic ids, (b) the three
edge kinds recorded via `recordRelation` with correct from/kind/to, (c) idempotent
re-run records nothing new, (d) a failing/degraded KG returns `{recorded:0}` without
throwing. No SQLite needed — the fake stub covers node + edge writes.

## Backfill (optional, v2)

A one-shot `backfillOutcomeEdges(workspaceRoot)` could replay the existing reputation
ledger rows through `recordOutcomeEdge` to populate edges for historical outcomes.
Not required for v1 (the live fan-out covers go-forward). Decide separately.
