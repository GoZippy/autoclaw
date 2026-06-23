# Evict / Kick an Agent — Lifecycle Design

_2026-06-22 — finishes the missing half of `dismiss()` and specifies the two
gates (authorization + ack-envelope) that the review flagged as blocking before
this becomes a remote-kill primitive._

## Why this is the one risky primitive

Spawn, invite, recall, pause all **add** capacity or are reversible doorbells.
**Evict removes a running participant** — it releases held work, revokes trust,
and tears down presence. Done wrong it orphans dependents (a task waiting on the
evicted agent's claim never advances), strands consensus (a vote that needed the
evicted agent's ballot never tallies), or — once a relay/HTTP lane exists —
becomes a **forgeable remote-kill** because the file bus has no transport auth.

Today the kick is half-built: `dismiss()` at
[`src/fleet/recall.ts:165`](../../src/fleet/recall.ts) only marks the pool worker
`retired` and explicitly defers "releasing leases / revoking trust" to "the
wiring layer." This doc is that wiring layer, specified as a **correct,
idempotent, re-runnable transaction**.

## TL;DR — what's safe to ship now vs what blocks remote

| | In-IDE, single operator (NOW) | Cross-machine / remote (BLOCKED) |
|---|---|---|
| Evict transaction (steps 1–7 below) | **Ship.** Same-host operator, same filesystem mutex everyone already trusts. | Ship, but only after the auth gate. |
| Authorization | Operator identity = the human at the IDE; the only writer to the comms tree is already trusted. Replace the hardcoded `SELF_AGENT_ID` with the resolved fleet operator id. | **Blocker.** Any inbox-writer can forge an `evict` message — needs the signing/token gate (§5). |
| Ack envelope | **Ship.** Local `intent_id` record lets the Manager panel show `requested→acting→done`. | Ship; same record relays unchanged. |
| Hard-kill (no drain) | Allowed only when the owner heartbeat is already stale (§3). | Same rule; auth gate still required first. |

**One-line rule:** the eviction *transaction* and *ack envelope* are safe to ship
in-IDE today; turning eviction into anything a **remote** party can trigger is
gated on §5 (signing) — do not build the relay/HTTP `evict` lane without it.

---

## 1. The EVICT transaction (the missing half of `dismiss()`)

Eviction is a **multi-step teardown over independent filesystem resources**, not
a single write. There is no cross-file atomic commit on a plain filesystem, so
correctness comes from **idempotency + a fixed order + an intent record**, not
from a lock. Each step is individually re-runnable and a no-op when already done;
the whole transaction is safe to re-run to completion after a partial teardown.

**Inputs:** `{ target_agent_id, target_session_id?, mode, requested_by, intent_id }`
where `mode ∈ {graceful, hard}` (default `graceful`).

### Ordered steps

> Order matters: **quiesce before you reclaim, reclaim before you revoke, revoke
> before you tear down presence.** Reversing this can let the target re-claim
> work after you released it, or hold trust after its claims are gone.

**Step 0 — Open the intent record (ack envelope).**
Write `intents/<intent_id>.json` with `state: "requested"` (see §6). Every
subsequent step updates this record. Re-running an evict with the same
`intent_id` resumes the existing record rather than starting a second teardown.
Set `state: "acting"` before Step 1.

**Step 1 — Quiesce (graceful drain, the default).**
Send a `task_assign`-style **stand-down doorbell** (reuse the `recallMessage`
envelope shape from [`recall.ts:122`](../../src/fleet/recall.ts), `type:
"evict_notice"`) into the target's inbox so a *cooperating* agent finishes its
current claim and stops claiming new work. Record `drain_deadline` on the intent.
- **graceful:** wait up to `drain_deadline` for the target's own
  `task_complete`/claim-release, polling its heartbeat. A cooperative agent
  releases its own claim; the orchestrator never has to force it.
- **hard:** skip the wait. **Hard-kill is permitted ONLY when the owner
  heartbeat is already stale** (older than `BEACON_TTL_MS`,
  [`beacons.ts:72`](../../src/fleet/beacons.ts) = 5 min) — i.e. the protocol's
  existing "stale claim may be stolen" condition
  ([cross-agent-protocol.md](../../.claude/rules/cross-agent-protocol.md) "Claiming
  work"). If the heartbeat is **fresh** and the operator still requested hard,
  treat it as graceful-with-zero-grace **only after** the operator re-confirms;
  never silently force-kill a live, working agent — that is how you corrupt a
  half-written file the agent was mid-edit on.

**Step 2 — Release the evicted agent's claims (the protocol's steal rule, applied
to self).**
Scan `comms/claims/*.json` (shape per
[`orchestratorLoop.ts:402`](../../src/orchestratorLoop.ts):
`{ claimed_by, session_id?, expires_at }`). For each claim where
`claimed_by === target_agent_id` (and `session_id === target_session_id` when one
was given — so you only evict the *one* session, not a sibling Claude Code
window):
- **graceful:** if the agent already released it in Step 1, nothing to do
  (idempotent). Otherwise, after the drain deadline, delete the claim file — this
  is exactly the "stale claim may be stolen by deleting it" rule, now triggered
  deliberately. Record each released `task_id` on the intent.
- **hard:** delete immediately (heartbeat already stale ⇒ the steal precondition
  already holds).

  Deleting the claim file IS the mutex release — the filesystem mutex
  ([protocol](../../.claude/rules/cross-agent-protocol.md): "the filesystem is the
  mutex") frees the moment the file is gone. Re-running Step 2 after the file is
  already deleted is a no-op.

**Step 3 — Reconcile downstream so dependents aren't orphaned.**
Releasing a claim is necessary but **not sufficient** — the released tasks must
re-enter the dispatchable pool or a dependent waits forever.
- Mark each released `task_id` back to `unclaimed` in the board/state (the
  reconciliation the orchestrator loop already does for expired claims — reuse
  that path, do not invent a second one).
- For any task whose `depends_on` included a released task: it does **not**
  become satisfied (its dependency was *abandoned*, not completed). Leave it
  blocked but emit a `finding_report` to `shared/` so the operator sees the chain
  that just stalled — surfacing drift, never silently rewriting the DAG (Hard
  Rule 5).
- If a released task **was complete** but unreviewed, keep its `task_complete` —
  completion is durable; only the *claim* is being torn down.

**Step 4 — Reconcile open consensus votes the agent owed.**
A 2/3-majority (or unanimous-for-security) tally
([protocol](../../.claude/rules/cross-agent-protocol.md): "Consensus") can hang
forever waiting on a ballot the evicted agent will now never cast.
- Scan `consensus/active/*` for items the target was an expected voter on but had
  not yet filed `{task_id}-{target}.json`.
- **Do not forge a vote.** Instead **shrink the quorum**: record on the consensus
  item that `target_agent_id` is `evicted` and recompute the threshold against
  the *remaining* expected voters (2/3 of the survivors). If the remaining voters
  already meet the recomputed threshold, let the existing auto-tally
  (`resolvePendingConsensus`, [`orchestratorLoop.ts:31`](../../src/orchestratorLoop.ts))
  resolve it. If they don't, the item stays open for the survivors — but it is no
  longer **blocked on a ghost**.
- **Security findings are unanimous** — evicting an expected voter there must
  raise a `finding_report`, never auto-shrink a security quorum to a rubber stamp.

**Step 5 — Revoke trust.**
Now that the agent holds no claims and owes no votes, drop its ability to act:
- Set the worker's `trust` to `off` (the `Worker.trust` field,
  [`workforce.ts:54`](../../src/fleet/workforce.ts); mirrors the invite default
  `trust: 'off'` = "visible but non-acting", [`invites.ts:60`](../../src/fleet/invites.ts)).
- Revoke any **invite** the agent joined under so a copied token can't be
  replayed to re-admit it: `revokeInvite(token)`
  ([`invites.ts:266`](../../src/fleet/invites.ts)) for the token recorded in the
  invite's `consumed_by`. Re-running on an already-revoked invite returns
  `false` harmlessly (idempotent).

**Step 6 — Tear down presence (beacon + registry).**
- Delete the target's beacon file(s) in **both** homes
  (`machineBeaconDir` and `workspaceBeaconDir`,
  [`beacons.ts:79`](../../src/fleet/beacons.ts)), keyed by
  `agent_id[-session_id]` so a sibling session's beacon survives. A missing file
  is success (idempotent).
- Mark the agent's `registry.json` row `evicted` (or remove it) so
  `getAgentRegistry` ([`orchestratorLoop.ts:958`](../../src/orchestratorLoop.ts))
  stops surfacing it as a live row. Keep the **résumé** in `workforce/<id>.json`
  — eviction ends a *session/engagement*, it does not erase earned history (that
  is `dismiss()`'s original "keep the résumé for the record" intent).

**Step 7 — Mark the worker `retired` and close the intent.**
Call the existing `setWorkerStatus(target, 'retired')`
([`recall.ts:165`](../../src/fleet/recall.ts)) — this is the part `dismiss()`
already does; it now runs **last**, as the capstone of a completed teardown
rather than the whole story. Set the intent `state: "done"` with a summary of
released tasks, reconciled votes, and torn-down beacons.

### Idempotency & re-runnability (the correctness contract)

- Every step is **check-then-act**: claim already gone → skip; trust already off
  → skip; beacon already deleted → skip; intent already `done` → no-op.
- A crash between any two steps leaves a partial teardown that **re-running the
  same `intent_id` completes** — the intent record says how far it got
  (`state: "acting"` + a per-step checklist), and each step is convergent.
- Because steps target **independent** resources in a fixed order, a partial run
  never leaves a *contradictory* state (e.g. trust revoked but claims still held)
  for longer than one re-run; the worst partial state is "more torn down than the
  record admits," which the next run reconciles by skipping completed steps.
- **Never** delete a claim owned by a *different* session of the same agent_id
  unless the operator targeted the whole agent (no `target_session_id`).

---

## 2. Graceful vs hard — the decision rule (skimmable)

```
mode == graceful (DEFAULT)
  → send evict_notice, wait drain_deadline, let the agent release its own claim,
    THEN reclaim leftovers + reconcile.

mode == hard
  → ALLOWED IFF owner heartbeat is already stale (> BEACON_TTL_MS).
    Reclaim immediately (the steal precondition already holds).
  → If heartbeat is FRESH: refuse to silently force-kill; require operator
    re-confirm; treat as graceful-with-zero-grace at most. Never yank a file a
    live agent is mid-write on.
```

Default to **graceful** everywhere. Hard is the cleanup path for an agent that
is *already gone but didn't clean up*, not a faster way to kill a live one.

---

## 3. Why the order is load-bearing (one example each)

- **Quiesce before reclaim:** if you delete the claim first, a still-running
  cooperative agent may re-`task_complete` against a task you already returned to
  the pool → a double-completed / re-dispatched task.
- **Reclaim before revoke trust:** if you revoke trust first, the agent's own
  in-flight claim-release write may be rejected by a trust-gated lane and the
  claim leaks.
- **Revoke before presence teardown:** delete the beacon first and the agent
  still has `trust` + a copied invite token → it re-beacons and re-admits itself,
  and you're evicting a ghost that keeps coming back.

---

## 4. Reconciliation — "don't orphan dependents" in one picture

```
Evicted agent held claim on  T1  (in progress)
                             T2  (complete, unreviewed)
            owed a vote on   C9  (2/3 consensus, 3 expected voters)

Step 3: T1 → unclaimed (re-dispatchable). T2's completion KEPT.
        Tasks with depends_on:[T1] stay BLOCKED + finding_report (dep abandoned).
Step 4: C9 quorum recomputed over the 2 survivors (2/3 of 2). If met → auto-tally
        resolves it. Security-tier C9 → finding_report, never auto-shrunk.
```

The invariant: **after evict, no task and no vote is waiting on the evicted
agent.** Either it's been reassigned/recomputed, or it's explicitly surfaced as a
stalled chain for the operator — never a silent orphan.

---

## 5. AUTHORIZATION gate (the cross-machine blocker)

**Today's hole.** Eviction authority rests on `SELF_AGENT_ID`, a hardcoded
constant ([`managerPanel.ts:28`](../../src/manager/managerPanel.ts):
`const SELF_AGENT_ID = 'claude-code'`). The file bus has **no transport auth** —
any process that can write into `comms/inboxes/<agent>/` can drop a forged
`evict` message, and an inbox-writer is *anyone on the same filesystem*. In-IDE,
single-host, that writer is already the trusted human, so it's acceptable **only
because the trust boundary is the machine itself**. The moment a relay or HTTP
lane forwards an `evict` from *another* machine, that constant authorizes a
**remote kill anyone can forge.**

### What MUST exist before any remote/relay/HTTP evict lane

1. **Operator identity, not a constant.** Resolve the authorized operator from
   `fleet.json` (the manifest the panel already reads), not from a literal.
   `SELF_AGENT_ID` becomes "the operator id resolved for this install," and only
   ids on the manifest's operator/owner list may author an `evict`.

2. **Signed evict intents.** An `evict` message (and its ack updates) MUST carry
   a signature the receiver can verify:
   - **Local/in-IDE:** the operator id + a per-install secret is sufficient
     (same-host trust). No new infra; ship now.
   - **Cross-machine:** a **token/keypair gate**. The cleanest fit is to reuse
     the **invite trust model already in the repo**
     ([`invites.ts`](../../src/fleet/invites.ts)): an operator holds a signing key;
     `evict` envelopes carry an HMAC/asymmetric signature over
     `{intent_id, target, mode, issued_at, expires}`; the receiving orchestrator
     **rejects any unsigned or expired or wrong-key `evict`** the same way
     `consumeInvite` rejects an unknown/expired/already-consumed token
     ([`invites.ts:240`](../../src/fleet/invites.ts)).
   - Single-use + TTL on the signed intent (mirror `INVITE_TTL_MS`,
     [`invites.ts:73`](../../src/fleet/invites.ts)) so a captured evict envelope
     can't be replayed.

3. **Reject-by-default.** Deny-by-default is the house style
   ([`invites.ts`](../../src/fleet/invites.ts) header: "deny-by-default on
   anything malformed"). An evict with no valid operator signature is **dropped
   and logged as a `scope_violation`**, never executed.

**Blocking statement:** the §1 transaction is safe in-IDE without (2)'s
cross-machine half, because the only authorized writer is the local human. **Do
not expose `evict` over relay/HTTP until the signing gate (2) and reject-by-default
(3) are in place** — without them, eviction is a forgeable remote-kill primitive.

---

## 6. ACK ENVELOPE (real progress, not just "requested")

A Command Center / Manager panel today can only show that an evict was
*requested* — it has no visibility into whether the teardown actually ran. Define
a small **intent record** that every lifecycle action updates, so the panel shows
true progress.

### Shape — `intents/<intent_id>.json`

```json
{
  "intent_id": "evict-<uuid>",
  "kind": "evict",
  "target_agent_id": "kilocode",
  "target_session_id": "…",
  "requested_by": "<operator-id>",
  "mode": "graceful",
  "state": "acting",
  "requested_at": "<iso>",
  "updated_at": "<iso>",
  "steps": {
    "quiesce": "done", "release_claims": "done", "reconcile_tasks": "done",
    "reconcile_consensus": "acting", "revoke_trust": "pending",
    "teardown_presence": "pending", "retire": "pending"
  },
  "released_tasks": ["T1"], "blocked_dependents": ["T7"],
  "reconciled_votes": ["C9"],
  "error": null,
  "signature": "<see §5>"
}
```

### State machine

```
requested ──▶ acting ──▶ done
                  └─────▶ failed   (error set; re-runnable with same intent_id)
```

- **`requested`** — operator asked; nothing torn down yet.
- **`acting`** — at least one step in flight; `steps` shows the live checklist
  the panel renders as a progress bar.
- **`done`** — all steps converged; `released_tasks` / `blocked_dependents` /
  `reconciled_votes` are the receipt the operator reviews.
- **`failed`** — a step errored; `error` explains; **re-running the same
  `intent_id` resumes** from the first non-`done` step (idempotency from §1).

### One envelope serves the whole lifecycle

The same record type covers **spawn / invite / pause** by swapping `kind` and the
`steps` map — e.g. `kind: "spawn"` with `steps: {provision, register, beacon}`,
`kind: "invite"` with `{issue, deliver, consume, admit}`, `kind: "pause"` with
`{notice, ack}`. The Command Center then renders one uniform
`requested→acting→done` lane for *every* operator action, and the auth signature
(§5) protects all of them with one mechanism. Build the envelope once for evict;
the other three lifecycle controls inherit it.

---

## 7. What to build, in order

1. **Now (in-IDE, single operator):** the §1 transaction (Steps 0–7) + the §6
   intent record, driven from the Manager panel. Replace the hardcoded
   `SELF_AGENT_ID` with the resolved operator id from `fleet.json`. Default
   `graceful`; hard only on stale-heartbeat.
2. **Now:** wire `dismiss()` to call the full transaction instead of only
   `setWorkerStatus(... 'retired')` — keep `retire` as the final step.
3. **Before any remote lane:** the §5 signing/token gate + reject-by-default;
   only then expose `evict` over relay/HTTP.
4. **Fast follow:** generalize the §6 envelope to spawn/invite/pause so the
   Command Center has one progress model for all operator actions.

## Files this touches (for the implementer)

- [`src/fleet/recall.ts:165`](../../src/fleet/recall.ts) — `dismiss()` grows the
  full transaction; `setWorkerStatus(... 'retired')` becomes Step 7.
- [`src/fleet/workforce.ts:54`](../../src/fleet/workforce.ts) — `trust` revoke (Step 5).
- [`src/fleet/invites.ts:266`](../../src/fleet/invites.ts) — `revokeInvite` (Step 5);
  the signing model (§5) extends this module's token/TTL pattern.
- [`src/fleet/beacons.ts:79`](../../src/fleet/beacons.ts) — beacon teardown, both homes (Step 6).
- [`src/orchestratorLoop.ts:402`](../../src/orchestratorLoop.ts) — claim scan/release (Step 2);
  [`:31`](../../src/orchestratorLoop.ts)/`resolvePendingConsensus` — consensus reconcile (Step 4);
  [`:958`](../../src/orchestratorLoop.ts) `getAgentRegistry` — registry teardown (Step 6).
- [`src/manager/managerPanel.ts:28`](../../src/manager/managerPanel.ts) — replace
  `SELF_AGENT_ID` constant with resolved operator identity (§5).
- New: `intents/<intent_id>.json` records (§6) under the comms tree.
