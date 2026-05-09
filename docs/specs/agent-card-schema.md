# AutoClaw Agent Card Schema (Phase 1)

> Status: **Proposal**, 2026-05-09. Phase 1 of the
> [Distributed Agent Fabric](../DISTRIBUTED_AGENT_FABRIC.md) roadmap.
> Companion specs: [registered-agent-v2.md](./registered-agent-v2.md),
> [heartbeat-v2.md](./heartbeat-v2.md).
>
> **Spec verification flag:** WebFetch to `a2a-protocol.org` was unavailable
> at authoring time. The A2A v0.2.5 field set in §1 is reproduced from our
> internal synthesis in
> [`docs/research/distributed-orchestration-prior-art.md` §1.1](../research/distributed-orchestration-prior-art.md)
> and [`DISTRIBUTED_AGENT_FABRIC.md` §2.1](../DISTRIBUTED_AGENT_FABRIC.md).
> Before merging, a maintainer must diff this section against the live spec
> at <https://a2a-protocol.org/latest/specification/> and the
> Linux Foundation A2A repo on GitHub.

## 1. A2A v0.2.5 fields adopted verbatim

AutoClaw publishes one Agent Card per registered agent at
`/.well-known/agent-card.json` on the bridge host (per A2A discovery
convention). The following fields are taken directly from the A2A
specification — names, types, and semantics are **not modified**.

| Field | Type | Required | Notes |
|---|---|---|---|
| `protocolVersion` (a.k.a. `schema_version`) | string | yes | Pinned to `"0.2.5"` for Phase 1. Track the spec; bump as A2A progresses. |
| `name` | string | yes | Human-readable agent name. |
| `description` | string | yes | One-paragraph capability summary. |
| `url` | string (URI) | yes | Base endpoint for A2A JSON-RPC requests. For AutoClaw: bridge URL + `/a2a`. |
| `version` | string (semver) | yes | Agent (not protocol) version. AutoClaw uses the IDE adapter version. |
| `capabilities` | object | yes | A2A capability flags: `streaming`, `pushNotifications`, `stateTransitionHistory`. |
| `defaultInputModes` | string[] | yes | MIME types the agent accepts. Default: `["text/plain", "application/json"]`. |
| `defaultOutputModes` | string[] | yes | MIME types the agent emits. |
| `skills` | object[] | yes | A2A skill descriptors (id, name, description, tags, examples, inputModes, outputModes). |
| `securitySchemes` | object | optional | A2A auth schemes (bearer, mTLS, etc.). |
| `security` | object[] | optional | Required scheme(s) for this card. |
| `provider` | object | optional | `{organization, url}`. AutoClaw fills with the IDE vendor. |
| `documentationUrl` | string (URI) | optional | Link to docs. |
| `supportsAuthenticatedExtendedCard` | boolean | optional | When true, an authenticated `GET /agent/authenticatedExtendedCard` returns a richer card. AutoClaw uses this to gate `x-autoclaw.machine_ip` (see §2). |

Citations:
[A2A spec](https://a2a-protocol.org/latest/specification/),
[A2A streaming docs](https://a2a-protocol.org/latest/topics/streaming-and-async/),
[IBM A2A explainer](https://www.ibm.com/think/topics/agent2agent-protocol).

The A2A `skills[]` array is the integration seam for AutoClaw's existing
message-type taxonomy. We map current message types
(`review_request`, `task_claim`, `consensus_vote`, `finding_report`, etc.)
1:1 to skills with stable IDs — see §3.

## 2. AutoClaw extensions (`x-autoclaw` namespace)

A2A explicitly permits extension fields. We scope all AutoClaw additions
under a single top-level object key, `x-autoclaw`, so we never collide with
future A2A core fields and so a strict-A2A consumer can ignore us cleanly.

All extension fields are **optional from the A2A consumer's perspective**.
AutoClaw's own router (the orchestrator) treats `x-autoclaw.machine_id` as
required for fleet routing; the rest are advisory.

| Field | Type | Required (by AutoClaw) | Default | Motivation |
|---|---|---|---|---|
| `x-autoclaw.machine_id` | string | **yes** | `os.hostname()` hash | Distinguishes "Eric's laptop window 2" from "Eric's laptop window 3" without leaking PII. Fleet routing keys off this. |
| `x-autoclaw.machine_ip` | string | no — **GDPR / PII risk, see §2.1** | unset | Only used when the user explicitly opts into LAN fabric. Never written to disk in the canonical card; only returned via the *authenticated extended card* endpoint. |
| `x-autoclaw.llms_available` | string[] | no | `[]` | Models the agent can invoke (`claude-opus-4-7`, `claude-sonnet-4-6`, `gpt-5`, etc.). Drives capability-aware routing. |
| `x-autoclaw.context_window` | integer | no | unset | Maximum context window in tokens for the agent's primary LLM. Used to filter out agents too small for a given task. |
| `x-autoclaw.tools_supported` | string[] | no | `[]` | Coarse tool taxonomy (`bash`, `edit`, `grep`, `glob`, `webfetch`, `mcp:<server>`). Lets the planner avoid assigning a `webfetch`-required task to an agent that lacks it. |
| `x-autoclaw.trust_level` | `"low" \| "medium" \| "high"` | no | `"medium"` | Hand-set per agent. Gates whether an agent may auto-merge, requires review, or requires unanimous consensus. See [registered-agent-v2.md §2](./registered-agent-v2.md). |
| `x-autoclaw.cost_budget` | `{daily_usd?: number, hourly_usd?: number, per_task_usd?: number}` | no | unset | Soft cap; the planner skips an agent whose remaining budget is < estimated task cost. Local-first: no telemetry, just a hint to the local planner. |
| `x-autoclaw.max_parallel_tasks` | integer | no | `1` | Concurrency ceiling. Most IDE agents are 1 today; Claude Code can sustain 2-3 worktrees. |
| `x-autoclaw.skills_loaded` | string[] | no | `[]` | AutoClaw skill IDs available to this agent (`kdream`, `autobuild`, `mateam`, `orchestrate`, plus user-installed). |
| `x-autoclaw.human_in_loop_required` | boolean | no | `false` | When `true`, the agent will not auto-execute tool calls; the planner factors this into routing (e.g. avoids assigning unattended Phase-2 work). |

### 2.1 GDPR / PII flag

`x-autoclaw.machine_ip` is the only field that touches PII. Three rules:

1. The **canonical, anonymous card** at `/.well-known/agent-card.json`
   **must omit** `machine_ip`.
2. The **authenticated extended card** (A2A's
   `supportsAuthenticatedExtendedCard` mechanism) **may include it** when
   the requester presents a valid bearer / SVID for the same trust domain.
3. `machine_id` is a **stable opaque identifier** — recommended derivation
   is `sha256(hostname + os.userInfo().username + install_uuid)` truncated
   to 12 hex chars. It is *required* in the canonical card so we can route
   without leaking the underlying hostname.

Local-first promise: cards are written to disk under the workspace's
`.autoclaw/` tree. Nothing is sent off-machine unless the user opts into
the bridge AND another agent is reachable on the network.

## 3. How each adapter populates the card

The adapter contract lives in `adapters/<id>/`. On first run, each adapter
runs an `agent-card.bootstrap.ts` step (Phase 1 deliverable, not part of
this spec). The bootstrap reads three sources in order; later sources
override earlier ones:

1. **Adapter defaults** (committed in the adapter package).
2. **Workspace overrides** at `.autoclaw/agents/<id>.card.json`.
3. **User overrides** at `~/.autoclaw/agent-card.json` (per-machine).

Per-adapter defaults for Phase 1:

| Adapter | `name` | `version` source | `llms_available` defaults | `tools_supported` | `human_in_loop_required` |
|---|---|---|---|---|---|
| `claude-code` | "Claude Code" | `package.json` of the adapter | `["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]` | `["bash","edit","grep","glob","read","write","webfetch","agent","mcp:*"]` | `false` |
| `kiro` | "Kiro" | adapter `package.json` | `["claude-sonnet-4-5"]` (Kiro defaults) | `["edit","read","grep","bash"]` | `false` |
| `kilocode` | "Kilo Code" | extension manifest | unset (Kilo lets user pick at runtime) | `["edit","read","bash","mcp:*"]` | `false` |
| `cline` | "Cline" | extension manifest | unset | `["edit","read","bash","mcp:*"]` | `false` |
| `cursor` | "Cursor" | extension manifest | `["claude-sonnet-4-6","gpt-5"]` | `["edit","read","grep","bash"]` | `false` |
| `antigravity` | "Antigravity AI" | manifest | `["claude-opus-4-7"]` | `["edit","read","bash"]` | `false` |
| `windsurf` | "Windsurf" | manifest | `["claude-sonnet-4-6"]` | `["edit","read","bash"]` | `false` |
| `continue` | "Continue" | manifest | unset | `["edit","read","bash","mcp:*"]` | `true` (Continue defaults to manual approval) |
| (future) generic worker | from manifest | manifest | manifest | manifest | manifest |

`machine_id` is computed once and cached at
`~/.autoclaw/machine-id` on first run. `context_window` is sourced from
the adapter's known model table; if the user picks a custom model, the
adapter writes `context_window: null` and the planner falls back to a
conservative 200 000-token default.

## 4. Example card (canonical, anonymous form)

```json
{
  "protocolVersion": "0.2.5",
  "name": "Claude Code",
  "description": "Anthropic's official CLI in VS Code. TypeScript expert.",
  "url": "http://127.0.0.1:31415/a2a",
  "version": "2.1.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": true
  },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    {
      "id": "review_request",
      "name": "Code review",
      "description": "Review another agent's diff against scope and quality bar.",
      "tags": ["review", "consensus"],
      "examples": ["Review PR #42 for security regressions"]
    },
    {
      "id": "task_claim",
      "name": "Claim a planned task",
      "description": "Claim and execute a task from the orchestrator's sprint plan.",
      "tags": ["execution"]
    }
  ],
  "supportsAuthenticatedExtendedCard": true,
  "x-autoclaw": {
    "machine_id": "a3f9c1b87d24",
    "llms_available": ["claude-opus-4-7", "claude-sonnet-4-6"],
    "context_window": 1000000,
    "tools_supported": ["bash", "edit", "grep", "glob", "agent", "webfetch"],
    "trust_level": "high",
    "cost_budget": { "daily_usd": 100, "hourly_usd": 10 },
    "max_parallel_tasks": 3,
    "skills_loaded": ["kdream", "autobuild", "mateam", "orchestrate"],
    "human_in_loop_required": false
  }
}
```

The authenticated extended card adds `x-autoclaw.machine_ip` and may add a
richer `securitySchemes`/`security` block with the bearer or SPIFFE SVID
required to address this agent over the LAN.

## 5. `resolveAgentId` v2 — capability-aware

The orchestrator currently resolves `WA-1..WA-N` slots positionally
(audit Tier-1 #2 in
[DISTRIBUTED_AGENT_FABRIC.md §0](../DISTRIBUTED_AGENT_FABRIC.md)). Phase 1
upgrades `resolveAgentId(slot, task)` to consult the Agent Card store:

1. Load all cards from `.autoclaw/agents/*.card.json` plus any cards
   discovered via the bridge's `/a2a/agents` endpoint.
2. Build a candidate list. A card is a candidate iff:
   - `x-autoclaw.tools_supported` ⊇ `task.tools_required` (set inclusion),
   - `x-autoclaw.context_window ≥ task.estimated_tokens` (or unset, in
     which case treat as 200 000),
   - `x-autoclaw.human_in_loop_required` matches `task.allows_unattended`,
   - `x-autoclaw.trust_level` ≥ `task.min_trust` (`high>medium>low`),
   - the agent's last heartbeat is fresh per
     [heartbeat-v2.md §3](./heartbeat-v2.md).
3. Score each candidate:
   `score = capability_overlap × trust_weight × idle_factor / cost_estimate`.
4. Return the highest-scoring agent. If none qualifies, fall back to the
   legacy positional `WA-N → registry.agents[N]` mapping so v1 manifests
   continue to work (backwards-compat — see
   [registered-agent-v2.md §3](./registered-agent-v2.md)).
5. The resolved agent ID is persisted alongside the slot in the sprint
   YAML, so a re-plan on a different fleet shape doesn't silently swap
   workers under a running sprint.

This is a routing change only; no card field is read more than once per
planning pass, and no telemetry is emitted.

---
*See also: [registered-agent-v2.md](./registered-agent-v2.md),
[heartbeat-v2.md](./heartbeat-v2.md),
[DISTRIBUTED_AGENT_FABRIC.md](../DISTRIBUTED_AGENT_FABRIC.md),
[research/distributed-orchestration-prior-art.md](../research/distributed-orchestration-prior-art.md).*
