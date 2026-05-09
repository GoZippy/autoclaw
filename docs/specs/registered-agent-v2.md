# `RegisteredAgent` v2 — Backwards-Compatible Schema Evolution

> Status: **Proposal**, 2026-05-09. Phase 1 of the
> [Distributed Agent Fabric](../DISTRIBUTED_AGENT_FABRIC.md) roadmap.
> Companion specs: [agent-card-schema.md](./agent-card-schema.md),
> [heartbeat-v2.md](./heartbeat-v2.md).
>
> **Goal:** Extend `RegisteredAgent` in `src/comms.ts` so the registry can
> express capabilities, trust, cost, and machine identity *without* breaking
> any existing v1 reader or registry file on disk.

## 1. Current shape (v1)

Verbatim from `src/comms.ts:42-61` (today's `master`):

```ts
export interface Heartbeat {
  agent_id: string;
  timestamp: string;
  status: 'active' | 'idle';
  current_task: string | null;
  sprint: number | null;
}

export type AgentStatus = 'active' | 'idle' | 'offline' | 'detected' | 'stalled';

export interface RegisteredAgent {
  id: string;
  name: string;
  extension_id: string | null;
  detected: boolean;
  inbox_path: string;
  hooks_supported: boolean;
  last_heartbeat: string | null;
  status: AgentStatus;
}
```

Today's `.autoclaw/orchestrator/comms/registry.json` also contains a
`rules_path` field on each agent that is **not present in the type**.
The Phase 1 type declares it explicitly so TypeScript callers don't have
to cast through `any`.

## 2. Proposed v2 shape

```ts
/** v2 sub-types — all new. */

export type CapabilityTag = string;          // e.g. "typescript", "react", "go"
export type ToolTag = string;                // e.g. "bash", "edit", "mcp:autoclaw-knowledge"
export type TrustLevel = 'low' | 'medium' | 'high';

export interface CostBudget {
  daily_usd?: number;     // optional soft cap, evaluated per local clock day
  hourly_usd?: number;    // optional soft cap, sliding 60-min window
  per_task_usd?: number;  // optional ceiling for a single task assignment
}

export interface RegisteredAgent {
  // --- v1 fields (unchanged) ---
  id: string;
  name: string;
  extension_id: string | null;
  detected: boolean;
  inbox_path: string;
  hooks_supported: boolean;
  last_heartbeat: string | null;
  status: AgentStatus;

  // --- v1 fields previously implicit, now declared (optional) ---
  /** Path to this agent's cross-agent-protocol rules file relative to
   *  workspace root. Already written by provisioning today; promoting from
   *  implicit to explicit. */
  rules_path?: string;                                          // optional, default: undefined

  // --- v2 additions (every field optional, every field has a safe default) ---

  /** Stable opaque machine identifier (sha256(hostname+user+install)/12 hex).
   *  default: undefined → router treats agent as on the local machine. */
  machine_id?: string;

  /** Coarse capability tags drawn from the Agent Card.
   *  default: [] → router skips capability filtering for this agent. */
  capabilities?: CapabilityTag[];

  /** Models the agent can invoke.
   *  default: [] → planner cannot use llm-aware routing for this agent. */
  llms_available?: string[];

  /** Maximum context window in tokens for the agent's primary LLM.
   *  default: undefined → planner uses conservative 200_000 fallback. */
  context_window?: number;

  /** Coarse tool taxonomy (see agent-card-schema.md §2).
   *  default: [] → planner assumes only basic edit/read are available. */
  tools_supported?: ToolTag[];

  /** Trust tier; gates auto-merge and consensus rules.
   *  default: 'medium'. */
  trust_level?: TrustLevel;

  /** Soft budget caps. Local-only; never reported off-machine.
   *  default: undefined → unlimited (subject to upstream model limits). */
  cost_budget?: CostBudget;

  /** Concurrency ceiling.
   *  default: 1. */
  max_parallel_tasks?: number;

  /** AutoClaw skill IDs available (kdream, autobuild, mateam, orchestrate, ...).
   *  default: []. */
  skills_loaded?: string[];

  /** When true, the agent will not auto-execute tool calls.
   *  default: false. */
  human_in_loop_required?: boolean;

  /** Pointer to the canonical Agent Card on disk for this agent
   *  (see agent-card-schema.md §3).
   *  default: undefined. */
  agent_card_path?: string;

  /** SPIFFE ID, populated only when SPIRE is configured (Phase 4).
   *  default: undefined. */
  spiffe_id?: string;

  /** ISO timestamp the registry entry was last refreshed by detection.
   *  default: undefined → use provisioned_at from registry root. */
  last_detected_at?: string;
}
```

The companion `AgentRegistry` interface adds an optional `schema_version`:

```ts
export interface AgentRegistry {
  agents: RegisteredAgent[];
  ide: string;
  provisioned_at: string;
  schema_version?: '1' | '2';   // optional; absence implies '1'
}
```

## 3. Migration plan

The contract is: **a v1 registry on disk must read cleanly through a v2
`readRegistry()` and survive a v2 `writeRegistry()` round-trip without
losing or fabricating fields.**

Concrete rules for `readRegistry()` (no code in this spec — described
algorithmically):

1. Read and `JSON.parse` the file as today (BOM-stripping is already in
   place per commit `a8ac62c`).
2. Coerce `schema_version` to `'2'` only when explicitly present;
   otherwise leave undefined and treat the file as v1.
3. For each agent:
   - Every v1 field is read as-is.
   - Every v2 field is read if present, left `undefined` if absent.
   - Never throw on unknown fields — preserve them on a hidden
     `__extra__` map so a future v3 reader can recover them. This
     covers forward-compat for fields we haven't designed yet.
4. `writeRegistry()` writes `schema_version: '2'` going forward, but
   **only emits v2 fields that are defined**. Undefined fields are
   omitted (not written as `null`) so a v1 consumer's JSON-schema check,
   if any, doesn't trip on type mismatches.
5. The orchestrator panel falls back to a "v1-rendering" path when it sees
   no `schema_version` or no v2 fields populated — chips for capabilities,
   trust, etc. simply don't render. No empty placeholders.

Failure modes that must remain non-fatal:

- Missing file → return `null` (already today's behavior).
- Truncated JSON → return `null` and log a warning.
- A field present with the wrong type (e.g. `trust_level: "ultra"`) →
  drop the offending field for that agent only; keep the rest.

## 4. Defaulting helper (described, not coded)

A v2 helper `withDefaults(agent: RegisteredAgent): Required<RegisteredAgent>`
fills in:

| Field | Default |
|---|---|
| `rules_path` | inferred from `extension_id`/`id` if known, else undefined |
| `capabilities` | `[]` |
| `llms_available` | `[]` |
| `tools_supported` | `[]` |
| `trust_level` | `'medium'` |
| `max_parallel_tasks` | `1` |
| `skills_loaded` | `[]` |
| `human_in_loop_required` | `false` |
| `cost_budget` | undefined → caller treats as "no cap" |
| `context_window` | undefined → caller treats as 200 000 |
| `machine_id` | undefined → caller treats as local |

The helper is the **only** place defaults live. Call sites in `orchestrate.ts`
that previously hard-coded fallbacks must be updated to call
`withDefaults()` first; this is in scope for Phase 1 implementation but
out of scope for this spec.

## 5. Compatibility matrix

| Reader \ Registry on disk | v1 file | v2 file |
|---|---|---|
| **v1 reader** (pre-Phase-1) | works | works (ignores extra fields, since the field set is open under TS structural typing) |
| **v2 reader** (Phase 1+) | works (new fields = undefined; defaults applied lazily) | works |

The audit-trail invariant in
[`DISTRIBUTED_AGENT_FABRIC.md` §5](../DISTRIBUTED_AGENT_FABRIC.md) holds:
the filesystem registry remains the canonical source of record at every
phase. Phase 4's program plane (cross-repo) extends — never replaces —
the v2 registry.

## 6. Field-by-field provenance

| v2 field | Sourced from | When written |
|---|---|---|
| `machine_id` | `~/.autoclaw/machine-id` (cached on first run) | provisioning |
| `capabilities` | Agent Card `x-autoclaw.capabilities` (currently A2A `skills[].tags` rolled up) | provisioning + on card refresh |
| `llms_available` | Agent Card `x-autoclaw.llms_available` | provisioning |
| `context_window` | Agent Card `x-autoclaw.context_window` | provisioning |
| `tools_supported` | Agent Card `x-autoclaw.tools_supported` | provisioning |
| `trust_level` | user policy file `~/.autoclaw/trust.json` (default `medium`) | provisioning, hot-reload on file change |
| `cost_budget` | `~/.autoclaw/budgets.json` per-agent | provisioning |
| `max_parallel_tasks` | Agent Card | provisioning |
| `skills_loaded` | local skill scan | provisioning + when a skill is installed |
| `human_in_loop_required` | Agent Card | provisioning |
| `agent_card_path` | adapter bootstrap | provisioning |
| `spiffe_id` | SPIRE agent (Phase 4) | on SVID issuance |
| `last_detected_at` | provisioning step | every detection run |

No field requires a network call to populate.

---
*See also: [agent-card-schema.md](./agent-card-schema.md),
[heartbeat-v2.md](./heartbeat-v2.md),
[DISTRIBUTED_AGENT_FABRIC.md](../DISTRIBUTED_AGENT_FABRIC.md).*
