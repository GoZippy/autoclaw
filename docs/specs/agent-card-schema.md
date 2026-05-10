# AutoClaw Agent Card Schema (Phase 1)

> Status: **Proposal**, 2026-05-09. Phase 1 of the
> [Distributed Agent Fabric](../DISTRIBUTED_AGENT_FABRIC.md) roadmap.
> Companion specs: [registered-agent-v2.md](./registered-agent-v2.md),
> [heartbeat-v2.md](./heartbeat-v2.md).
>
> **Spec verification status (2026-05-10):** §1 has been diff'd against the
> canonical A2A v0.2.5 schema and specification document at the
> [a2aproject/A2A v0.2.5 tag](https://github.com/a2aproject/A2A/tree/v0.2.5)
> (`specification/json/a2a.json` and `docs/specification.md`). The field set
> is **correct against v0.2.5**, with two corrections noted below
> (well-known path; `schema_version` alias is non-canonical). A2A has since
> evolved (v0.3.0, v1.0.0) and the canonical proto in `main` has restructured
> several fields (e.g. `supported_interfaces[]` instead of `url`,
> `extended_agent_card` capability flag instead of
> `supportsAuthenticatedExtendedCard`). This doc remains pinned to v0.2.5;
> a future bump must re-verify against the target tag.
> See [§ Sources](#sources) at end of file.

## 1. A2A v0.2.5 fields adopted verbatim

AutoClaw publishes one Agent Card per registered agent at
`/.well-known/agent.json` on the bridge host
([verified 2026-05-10 against A2A v0.2.5 specification §5.3](https://github.com/a2aproject/A2A/blob/v0.2.5/docs/specification.md#53-recommended-location)).
A2A v0.2.5 explicitly recommends `https://{server_domain}/.well-known/agent.json`
per RFC 8615 well-known URI convention.

> **Discrepancy fix (2026-05-10):** Earlier drafts used
> `/.well-known/agent-card.json`. The canonical v0.2.5 path is
> `/.well-known/agent.json`. AutoClaw bridge implementations MUST serve at
> `/.well-known/agent.json`; legacy `/.well-known/agent-card.json` MAY be
> kept as a redirect during cutover.

The following fields are taken directly from the A2A
specification — names, types, and semantics are **not modified**.

| Field | Type | Required | Notes |
|---|---|---|---|
| `protocolVersion` | string | yes | Pinned to `"0.2.5"` for Phase 1. Track the spec; bump as A2A progresses. **`schema_version` is NOT a canonical A2A field name** — earlier drafts called this out as an alias; the alias has been removed. [verified 2026-05-10 against [a2a.json v0.2.5](https://github.com/a2aproject/A2A/blob/v0.2.5/specification/json/a2a.json)]. |
| `name` | string | yes | Human-readable agent name. |
| `description` | string | yes | One-paragraph capability summary. CommonMark MAY be used per v0.2.5 §5.5. |
| `url` | string (URI) | yes | Base URL for the agent's A2A service. Must be absolute; HTTPS for production. AutoClaw uses bridge URL + `/a2a`. |
| `version` | string | yes | Agent (or A2A implementation) version string — format up to provider. AutoClaw uses the IDE adapter version. |
| `capabilities` | object | yes | A2A capability flags: `streaming`, `pushNotifications`, `stateTransitionHistory`, `extensions[]`. All four are optional with default `false` / `[]`. [verified 2026-05-10 against [v0.2.5 spec §5.5.2](https://github.com/a2aproject/A2A/blob/v0.2.5/docs/specification.md#552-agentcapabilities-object)]. Note: `stateTransitionHistory` is a v0.2.5 placeholder field and was removed in later A2A versions; do not rely on it for routing. |
| `defaultInputModes` | string[] | yes | MIME types the agent accepts. Default in AutoClaw bootstrap: `["text/plain", "application/json"]`. |
| `defaultOutputModes` | string[] | yes | MIME types the agent emits. |
| `skills` | object[] | yes | A2A `AgentSkill` descriptors (`id`, `name`, `description`, `tags`, `examples`, `inputModes`, `outputModes`). At least one skill required if the agent performs actions. [verified 2026-05-10 against [v0.2.5 §5.5.4](https://github.com/a2aproject/A2A/blob/v0.2.5/docs/specification.md#554-agentskill-object)]. |
| `securitySchemes` | object | optional | Map of name → `SecurityScheme`. A2A auth schemes (bearer, mTLS, OAuth2, OpenID Connect, API key). |
| `security` | object[] | optional | Required scheme(s) for this card. |
| `provider` | object | optional | `{organization, url}` — both required when `provider` present. AutoClaw fills with the IDE vendor. |
| `documentationUrl` | string (URI) | optional | Link to human-readable docs. |
| `iconUrl` | string (URI) | optional | URL to an icon for the agent. **Was missing from earlier drafts; added 2026-05-10** [verified against [v0.2.5 §5.5](https://github.com/a2aproject/A2A/blob/v0.2.5/docs/specification.md#55-agentcard-object)]. |
| `supportsAuthenticatedExtendedCard` | boolean | optional | When true, an authenticated `GET {url}/../agent/authenticatedExtendedCard` returns a richer card (per [v0.2.5 §7.10](https://github.com/a2aproject/A2A/blob/v0.2.5/docs/specification.md#710-agentauthenticatedextendedcard)). AutoClaw uses this to gate `x-autoclaw.machine_ip` (see §2). |

[verified 2026-05-10] All required-field designations above match
[a2a.json v0.2.5 line 238-248](https://github.com/a2aproject/A2A/blob/v0.2.5/specification/json/a2a.json):
required = `[capabilities, defaultInputModes, defaultOutputModes,
description, name, protocolVersion, skills, url, version]`.

Citations:
[A2A v0.2.5 specification.md](https://github.com/a2aproject/A2A/blob/v0.2.5/docs/specification.md),
[A2A v0.2.5 JSON schema](https://github.com/a2aproject/A2A/blob/v0.2.5/specification/json/a2a.json),
[IBM A2A explainer](https://www.ibm.com/think/topics/agent2agent-protocol).

The A2A `skills[]` array is the integration seam for AutoClaw's existing
message-type taxonomy. We map current message types
(`review_request`, `task_claim`, `consensus_vote`, `finding_report`, etc.)
1:1 to skills with stable IDs — see §3.

## 2. AutoClaw extensions (`x-autoclaw` namespace)

A2A v0.2.5 defines a first-class extension mechanism via
`AgentCapabilities.extensions[]` (each entry an `AgentExtension { uri,
required, description, params }`)
[verified 2026-05-10 against [v0.2.5 §5.5.2.1](https://github.com/a2aproject/A2A/blob/v0.2.5/docs/specification.md#5521-agentextension-object)].
The v0.2.5 JSON schema does **not** declare
`additionalProperties: false` on `AgentCard`, so by JSON Schema draft-07
default semantics extra top-level keys are tolerated by the schema, but
they are **not** the canonical extension surface.

> **Discrepancy / forward-compat note:** Earlier drafts implied that A2A
> "explicitly permits extension fields" via top-level `x-…` keys. The
> canonical extension surface is `capabilities.extensions[]` keyed by URI,
> not arbitrary `x-` prefixes. Phase 1 of AutoClaw will publish the
> `x-autoclaw` block at the top level for backward compatibility AND mirror
> the same data into a single
> `capabilities.extensions[{ uri: "https://autoclaw.dev/extensions/v1",
> required: false, params: { ...x-autoclaw fields... } }]` entry so strict
> A2A consumers see the canonical form. Phase 2 may drop the top-level
> `x-autoclaw` block once all known consumers read the canonical extension.

We scope all AutoClaw additions under a single top-level object key,
`x-autoclaw`, so we never collide with future A2A core fields and so a
strict-A2A consumer can ignore us cleanly.

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

## Sources

Verified 2026-05-10 against the following canonical sources (fetched via
`gh api` against `repos/a2aproject/A2A` at tag `v0.2.5`):

- [A2A v0.2.5 specification document](https://github.com/a2aproject/A2A/blob/v0.2.5/docs/specification.md)
  — section 5.3 (well-known location), 5.5 (AgentCard), 5.5.2 (capabilities),
  5.5.2.1 (extensions), 5.5.4 (skills), 7.10 (authenticated extended card).
- [A2A v0.2.5 JSON schema (`specification/json/a2a.json`)](https://github.com/a2aproject/A2A/blob/v0.2.5/specification/json/a2a.json)
  — `AgentCard` definition lines 130-249; required fields list lines 238-248.
- [A2A v0.2.5 README](https://github.com/a2aproject/A2A/blob/v0.2.5/README.md)
  — license (Apache-2.0), governance.
- [A2A repo tag listing](https://github.com/a2aproject/A2A/tags) — confirmed
  v0.2.5 exists; later tags v0.2.6, v0.3.0, v1.0.0 progressively restructure
  the AgentCard.

---
*See also: [registered-agent-v2.md](./registered-agent-v2.md),
[heartbeat-v2.md](./heartbeat-v2.md),
[DISTRIBUTED_AGENT_FABRIC.md](../DISTRIBUTED_AGENT_FABRIC.md),
[research/distributed-orchestration-prior-art.md](../research/distributed-orchestration-prior-art.md).*
