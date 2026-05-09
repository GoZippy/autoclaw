# `Heartbeat` v2 — Operational Telemetry, Local-Only

> Status: **Proposal**, 2026-05-09. Phase 1 of the
> [Distributed Agent Fabric](../DISTRIBUTED_AGENT_FABRIC.md) roadmap.
> Companion specs: [agent-card-schema.md](./agent-card-schema.md),
> [registered-agent-v2.md](./registered-agent-v2.md).
>
> **Scope:** Extend the `Heartbeat` interface in `src/comms.ts` with optional
> operational fields so the panel and the planner can react to load and
> failure signals — without breaking any v1 writer or consumer. **No
> telemetry leaves the user's machine.** Heartbeats are written to disk
> at `.autoclaw/orchestrator/comms/heartbeats/<agent>.json` exactly as today.

## 1. Current shape (v1)

Verbatim from `src/comms.ts:42-48`:

```ts
export interface Heartbeat {
  agent_id: string;
  timestamp: string;
  status: 'active' | 'idle';
  current_task: string | null;
  sprint: number | null;
}
```

Today's status inference (`agentStatusFromHeartbeat`, `comms.ts:180-188`)
is purely age-of-heartbeat with one assignment-aware branch. It does not
account for queue depth, error rate, or budget exhaustion — the audit
flags this as Tier-1 #4 and #5 in
[DISTRIBUTED_AGENT_FABRIC.md §0](../DISTRIBUTED_AGENT_FABRIC.md).

## 2. Proposed v2 shape

```ts
export interface Heartbeat {
  // --- v1 fields (unchanged) ---
  agent_id: string;
  timestamp: string;
  status: 'active' | 'idle';
  current_task: string | null;
  sprint: number | null;

  // --- v2 additions (every field optional) ---

  /** Remaining tokens in the agent's current LLM session/budget window.
   *  Used by planner to skip near-exhausted agents. default: undefined. */
  token_budget_remaining?: number;

  /** Number of unread messages in this agent's inbox plus claimed-but-not-
   *  -started tasks. default: undefined → treated as 0 by planner. */
  queue_depth?: number;

  /** Identifier of the LLM the agent is currently using (since an agent
   *  with multiple llms_available may switch mid-session).
   *  default: undefined → fallback to first entry of llms_available. */
  current_llm?: string;

  /** Last error the agent surfaced, structured. default: undefined. */
  last_error?: {
    timestamp: string;        // ISO
    code?: string;            // "rate_limit" | "auth" | "tool_failure" | etc.
    message: string;          // human-readable, no PII
  };

  /** Round-trip ms to the bridge or the last peer that messaged this agent.
   *  Local-only; never sent off-machine. default: undefined. */
  network_latency_ms?: number;

  /** Errors over the last 60 seconds, as count / total operations.
   *  default: undefined → planner treats as 0. */
  error_rate_1m?: number;     // 0.0 – 1.0

  /** Optional session dimension — present when the adapter supports
   *  per-session heartbeats (COORDINATION §2.2). default: undefined. */
  session_id?: string;

  /** Optional schema marker. default: undefined → consumer treats as v1. */
  schema_version?: '1' | '2';
}
```

The `AgentStatus` enum gains one value:

```ts
export type AgentStatus =
  | 'active' | 'idle' | 'offline' | 'detected' | 'stalled'
  | 'overloaded';   // NEW: alive but signaling distress (see §3)
```

`'overloaded'` is additive — v1 consumers that don't know the value
should treat it as `'active'` for rendering purposes (string fallback).
The orchestrator panel renders it with a distinct chip color (proposed:
amber) so the user sees that the agent is healthy-but-pushed.

## 3. Status inference v2 — algorithm (described, not coded)

Inputs: latest `Heartbeat`, current wall-clock time, the agent's
`RegisteredAgent` record (for `max_parallel_tasks` and other defaults).
Output: an `AgentStatus`.

The algorithm runs three checks in sequence; the first that fires wins.

### Stage A — liveness (unchanged from v1)

If no heartbeat exists → `offline`.
If the heartbeat timestamp is in the future by more than 60 s → treat as
`offline` (clock skew sentinel).
Compute `age_ms = now - timestamp`.
If `age_ms ≥ 24h` → `offline`.
If `age_ms ≥ 5m` AND the agent had a `sprint` assigned → `stalled`.
If `age_ms ≥ 5m` AND no sprint → `idle` (was `offline` in v1; loosened
because a fresh-but-quiet agent is not actually offline).

### Stage B — distress (new)

Only evaluated when Stage A would have returned `active` or `idle`.

Compute a *distress score*:

```
distress =   weight_q  · clamp01(queue_depth / (2 × max_parallel_tasks))
           + weight_e  · clamp01(error_rate_1m / 0.20)
           + weight_b  · clamp01(1 − token_budget_remaining / 50_000)
           + weight_l  · clamp01(network_latency_ms / 1500)
```

Recommended weights for Phase 1: `weight_q = 0.4`, `weight_e = 0.4`,
`weight_b = 0.1`, `weight_l = 0.1`. Each contributing field is **only
counted when present**; if a field is undefined its weight is redistributed
proportionally to the present fields. This preserves v1 behavior when
**all** new fields are absent (distress = 0).

If `distress ≥ 0.75` → `overloaded`.
If `distress ≥ 0.40` AND Stage A said `active` → keep `active` but the
panel rendering layer adds a yellow dot. (No new enum value; this is
purely cosmetic and lives in the panel, not in the type.)

### Stage C — fallback

Whatever Stage A produced.

### Routing implication

The planner's candidate filter (see
[agent-card-schema.md §5](./agent-card-schema.md)) treats `overloaded`
as a hard skip. `stalled` is also a hard skip. `idle` is preferred over
`active` when load-balancing is otherwise tied. This is a routing change
only; no code is described here.

## 4. v1 ↔ v2 compatibility

| Writer \ Reader | v1 reader | v2 reader |
|---|---|---|
| **v1 writer** | works (current behavior) | works — all v2 fields are undefined; status inference reduces to Stage A; agent appears with v1 chips only |
| **v2 writer** | works — v1 reader ignores extra keys via TS structural typing; the agent shows up unchanged | works — full feature set |

Concretely: an agent on an old AutoClaw release that still emits the v1
shape will continue to appear in the panel with `active`/`idle`/`offline`/
`stalled`/`detected` exactly as today. The new `overloaded` state simply
never fires for them. This satisfies the constraint that "old agents
writing v1 heartbeats must still appear correctly in the panel."

The reverse — a v1 panel reading a v2 heartbeat — also works. v1's reader
parses the JSON, ignores the extra fields, and produces v1 status
inference. The user sees the v1 view and the v2 view side-by-side without
contradiction.

## 5. Local-first guarantees

Heartbeats are written to one well-known location:

```
.autoclaw/orchestrator/comms/heartbeats/<agent>.json
```

Phase 1 introduces no new network egress. The bridge's existing
`/heartbeat` endpoint (already opt-in via `autoclaw.bridge.enabled`)
accepts v2 fields transparently because it currently passes the JSON
through to disk.

The `last_error.message` field is the only field that could plausibly
contain user-typed content (e.g. a path with a username). The Phase 1
implementation must:

1. Truncate `message` to 500 characters.
2. Strip ANSI escape sequences and control characters.
3. Replace any path containing the user's home directory with `$HOME`.
4. Never include API keys, tokens, or full URLs from headers.

A small redaction helper is in scope for Phase 1; the spec mandates the
behavior, not the implementation.

## 6. Field-by-field provenance and update cadence

| Field | Source | Updated when |
|---|---|---|
| `token_budget_remaining` | adapter — reads model API usage counters | every heartbeat tick (30 s today) |
| `queue_depth` | local count of `inbox/<agent>/*.json` | every heartbeat tick |
| `current_llm` | adapter — current session model | every heartbeat tick or on model switch |
| `last_error` | adapter — most recent failure within 5 min, redacted | on any new error |
| `network_latency_ms` | EWMA over last 10 bridge calls | every heartbeat tick |
| `error_rate_1m` | sliding-window count over last 60 s | every heartbeat tick |
| `session_id` | adapter — IDE session identifier | on session start |

No field requires polling an external service; every value is computed
from local state the agent already has.

---
*See also: [agent-card-schema.md](./agent-card-schema.md),
[registered-agent-v2.md](./registered-agent-v2.md),
[DISTRIBUTED_AGENT_FABRIC.md](../DISTRIBUTED_AGENT_FABRIC.md).*
