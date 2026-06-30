# AutoClaw Connector Protocol (acp/1): A Standardized Adapter + Agent-to-Agent Platform Standard

> AutoClaw design idea — generated 2026-06-15 via multi-agent workflow (3-lens judge panel + synthesis). Exploratory; not yet scheduled.

## Summary

A single unified standard, acp/1, that lets any external tool (Codex, CodeGPT, Copilot-chat, Hermes, OpenClaw, future CLIs) become a first-class AutoClaw citizen by implementing one versioned manifest + connector with up to three optional faces — runner (act), source (ingest sessions), and presence (be visible in the fleet) — all tied together by a single shared identity. It fuses three lenses: (1) the SDK/contract layer (@autoclaw/connector-sdk wrapping the existing Runner and SourceAdapter contracts plus a tiny new PresenceProvider, with out-of-tree discovery so no fork is needed); (2) the A2A coordination layer (presence = Beacon, capability = A2A v0.2.5 Agent Card, messages = the existing comms envelope, durable code-coordination = git/GitHub PRs/CI, over four transports — filesystem, MCP, HTTP bridge, relay — all already in-tree); and (3) governance (two-axis SemVer with ABI range negotiation, a signed connector.json manifest, a published conformance harness, tier-driven default-off consent, scope-jailed runners, signing/provenance, and a local-first marketplace). The work is almost entirely additive: the heavy contracts already exist and the nine built-in runners + ten source adapters already satisfy them. The net new code is small — two MCP presence tools, optional Beacon fields, a well-known path alias, a heartbeat-envelope unification, the connector manifest/loader, and the conformance package — plus adopting three orphaned Tier-3 source adapters (clineRoo, continue, kilocode) that exist on disk but are never registered.

## Key decisions
- One shared identity (manifest.id) ties a tool's runner, source, and presence faces into a single fleet row keyed on id — the central fix that makes the three extension points one standard.
- Protocol tagged acp/1 with two independent SemVer axes: a connector-ABI version (abi/<major>.<minor>) with declared abiRange negotiation, and the connector's own version. Host refuses to load outside the range rather than crashing on a missing method.
- Additive over existing contracts: runner=existing Runner (unchanged), source=existing SourceAdapter (unchanged), presence=one tiny NEW PresenceProvider face. The 9 built-in runners + 10 source adapters already satisfy acp/1.
- git + GitHub PRs + CI is the durable code-coordination plane; the filesystem create-exclusive claim is retired for code and survives only as the scope-lease soft mutex (src/program/leases.ts). task_complete/review_request carry payload.pr.
- Beacon is the single canonical heartbeat/presence wire shape (it is already the superset); comms/heartbeat.ts and relay/bridge bodies unify onto it — no second identity model.
- Four transports, one envelope: filesystem, MCP, HTTP bridge, relay — all already in-tree; MCP is the recommended lowest-friction plug for a brand-new external CLI (Codex/CodeGPT/Copilot).
- Tier-driven default-off consent preserved: Tier 1 native on, Tier 2/3 default-off (DEFAULT_SOURCE_ENABLED / resolveEnabledSources), opt-in per connector with first-run consent.
- Governance is host-enforced not honor-system: signed connector.json (fail-closed validation), conformance certification before first enable, worktree/branch-jailed runners (path scope PREVENTED not just audited), opt-in MCP/secret inheritance, provenance + signing + pin-on-first-use + revocation list.
- Highest-leverage net-new code is two MCP presence tools (presence.beacon / presence.fleet) wrapping writeBeacon/readAllBeacons — today MCP peers can message and claim but cannot check in.

## Phasing
1. Phase 0 (foundation, no behavior change): publish @autoclaw/connector-sdk re-exporting Runner + SourceAdapter + the new Connector/ConnectorManifest/PresenceProvider types; define connector.json schema + fail-closed validator.
2. Phase 1 (close the A2A presence gap): add presence.beacon + presence.fleet MCP tools (wrap writeBeacon/readAllBeacons); add optional Beacon.transports[] + card_url; serve /.well-known/agent.json alongside agent-card.json. This alone makes Codex-CLI/Copilot visible peers.
3. Phase 2 (unify + clean in-tree): unify heartbeat envelope onto Beacon (comms/heartbeat.ts + relay/bridge); replace hardcoded defaultRegistry.ts / createDefaultRegistry() with a declarative BUILTIN_CONNECTORS loop and ADOPT the orphaned Tier-3 source adapters clineRoo/continue/kilocode; add payload.pr to task_complete/review_request.
4. Phase 3 (out-of-tree connectors): connector loader (npm @autoclaw/connector-* scope + ~/.autoclaw/connectors/ discovery), ABI-range negotiation, RESOLVE→NEGOTIATE→DETECT→REGISTER lifecycle with per-connector isolation, tier-gated default-off registration, doctor + panel surfacing.
5. Phase 4 (governance hardening for runners): worktree/branch jail so external-runner path scope is PREVENTED not just audited (tighten runner-bridge RFC §9); opt-in MCP-server + secret/env inheritance; post-dispatch trust-preset verification → scope_violation + downgrade.
6. Phase 5 (trust infrastructure): @autoclaw/connector-conformance harness + golden-fixture replay; manifest signing + provenance/SBOM verification; pin-on-first-use keys + revocation list.
7. Phase 6 (marketplace): signed local-first index.json registry, conformance badges, reputation weighting in RunnerRegistry.getPreferred by errorClass/scope_violation history.
8. Phase 7 (docs + reference connectors): AGENT_SESSION_PROTOCOL.md §10 peer on-ramps (A/B/C); ship one reference out-of-tree connector (e.g. codex source+presence) as the worked example and conformance smoke target.

## Open questions
- Signing trust root: who holds the publisher key registry and revocation list — a Tomorrow-Inc-operated registry, a self-hostable one, or both? Local-first cache implies offline verification, which needs a pinned root key shipped with the host.
- Worktree/branch jail enforcement mechanism on Windows vs POSIX: git worktree isolation is the proposed jail, but per-process filesystem sandboxing for path-scope PREVENTION (not audit) is OS-dependent and may need a lighter enforcement tier where true sandboxing is unavailable.
- ABI baseline version: do we cut the current Runner/SourceAdapter contracts as abi/2.0 (implying a prior 1.x) or abi/1.0? The lens write-ups used >=2.0 illustratively; the real starting major needs to be fixed before any abiRange is published.
- Marketplace conformance authority: is the conformance badge self-asserted by the author's CI (re-verified by the host before enable, as proposed) or must it be re-run by a central CI before listing? Affects how much trust a badge carries pre-install.
- Codex/CodeGPT/Copilot source ingestion: these have no parseable local session store today, so they onboard as runner+presence only. Is a session-store adapter for any of them in scope, or do they remain ingestion-blind until the vendor exposes a store?
- Scope-lease vs PR mutex interaction across repos: when a lane spans multiple repos, the scope-lease (program/leases.ts) is the cross-repo mutex but each repo's PR is the per-repo mutex — need to confirm the orchestrator reconciles a stale lease steal with already-open PRs.
- Heartbeat-envelope unification compatibility: does any existing reader depend on the narrower comms/heartbeat.ts shape such that widening to the Beacon superset breaks it, or is it strictly additive as claimed?

## Risks
- External runner connectors are arbitrary code that spawns processes and edits the repo — the dominant attack surface. Mitigated by signing + SBOM + pinned commit + mandatory conformance + worktree jail + CI-as-merge-authority, but a defect anywhere in that chain is high-impact.
- Trust-preset spoofing: an external runner claiming 'auto' but running 'turbo'. Requires the host (not the connector) to enforce the deny list and verify post-dispatch; if post-dispatch verification is incomplete, silent escalation is possible.
- Prompt injection via ingested transcripts: a malicious source connector can plant content that later steers a native agent during RAG retrieval. Tier-weighting + quarantine of unverified-source signals mitigates but does not eliminate.
- Credential/secret leakage: external runners inheriting API keys, MCP servers, or env by default would be catastrophic. The standard makes inheritance opt-in and env allow-listed, but this depends on every transport path honoring the restriction.
- Path-scope enforcement gap: RFC §9 currently audits path scope post-dispatch only. Until Phase 4 ships true worktree/branch jailing, external runners can write out-of-scope and only be caught after the fact.
- Discrepancy found vs the SDK lens write-up: it claimed the orphaned Tier-3 adapters were missing from createDefaultRegistry — verified true (clineRoo/continue/kilocode exist on disk, are not registered) — but registering them flips ingestion paths for those tools; they must stay Tier-3 default-off to avoid silently ingesting without consent.
- Heartbeat-envelope unification touches relay/bridge/comms wire shapes; a regression here degrades fleet visibility across all transports at once. Needs the compatibility question resolved and golden-shape tests before merge.
- Marketplace centralization risk: a host-operated registry + revocation list becomes a single point of trust and availability. A revoked or unreachable registry must fail safe (disable third-party connectors) without bricking the host or its built-ins.
- Versioning drift: two SemVer axes (ABI + connector) plus the acp protocol tag is three version dimensions a third party must reason about — onboarding friction and a source of subtle load failures if abiRange is mis-declared.

---

# AutoClaw Connector Protocol (`acp/1`)

> A standardized adapter/connector + agent-to-agent platform standard. One manifest, one identity, one registration, three optional capability faces — versioned, signed, consent-gated, and reachable over four transports that already exist in-tree.

## 0. Why this exists

Today a tool owner who wants their product to interoperate with AutoClaw must discover and implement **three unrelated interfaces, in three directories, with three registration paths**, and two of them are not even fully wired:

| Capability | Contract today | Registration today | Gap |
|---|---|---|---|
| Act as a runner | `Runner` (`src/runners/types.ts`) | `createDefaultRunnerRegistry()` — hardcoded `reg.register(new XRunner())` list in `src/runners/defaultRegistry.ts` | No external registration; you must edit AutoClaw source |
| Ingest sessions | `SourceAdapter` (`src/intelligence/types.ts`) | `SourceRegistry.registerAdapter()`; `createDefaultRegistry()` hardcoded in `src/intelligence/sources/registry.ts` | Tier-3 adapters `clineRoo`, `continue`, `kilocode` exist on disk but are **never registered**; no external registration |
| Be visible in the fleet | `Beacon` (`src/fleet/beacons.ts`) | Hand-write a JSON file to `~/.autoclaw/beacons` | Decoupled from the other two; no link between a beacon `host` and its runner/source `id` |

There is **no shared identity** (`codex`-the-runner, `codex`-the-source, and `codex`-the-beacon-`host` are three unrelated strings), **no version negotiation** (the `Runner` interface carries no version field), and **no single manifest**. A third party cannot ship a connector out-of-tree.

`acp/1` fixes this with **one manifest, one identity, one registration call, three optional faces**, plus a transport-agnostic agent-to-agent layer on top — all additive over contracts that already ship.

---

## 1. The unified connector contract

A connector is a package (npm module or discovered plugin dir) that **default-exports a factory** returning one `Connector`. It declares which faces it provides and implements only those. Published as a new package, `@autoclaw/connector-sdk`.

```ts
export const ACP_VERSION = 'acp/1' as const;

export interface Connector {
  manifest: ConnectorManifest;
  /** Present iff provides includes 'runner'  → the EXISTING Runner contract. */
  runner?: Runner;       // src/runners/types.ts, unchanged
  /** Present iff provides includes 'source'  → the EXISTING SourceAdapter.   */
  source?: SourceAdapter; // src/intelligence/types.ts, unchanged
  /** Present iff provides includes 'presence' → the only NEW face (tiny).    */
  presence?: PresenceProvider;
}

export type ConnectorFactory =
  (ctx: ConnectorContext) => Connector | Promise<Connector>;
```

The two heavy faces are **the existing contracts, unchanged** — so the nine built-in runners and the ten built-in source adapters already satisfy `acp/1`:

- **`runner: Runner`** — full `src/runners/types.ts`: `id`, `capabilities`, `detect()`, `dispatch()`, `resume()`, `listSessions()`, `health()`, `cancel()`. Trust presets (`off`/`auto`/`turbo`) translate to host flags exactly as today.
- **`source: SourceAdapter`** — full `src/intelligence/types.ts`: `id`, `displayName`, `tier`, `capabilities`, `discover(env)`, `extract(opts)` yielding `UnifiedSession`. This is the slot Codex/CodeGPT/Copilot are missing today; implement it and `/learn` ingests them.
- **`presence: PresenceProvider`** — the **only new face**, and it is tiny. It standardizes the beacon write so a connector lights up the fleet panel without hand-rolling JSON.

```ts
export interface PresenceProvider {
  /** Build the beacon body; host stamps host=manifest.id, fills origin/workspace,
   *  and persists via writeBeacon() on the connector's behalf. */
  beacon(ctx: PresenceContext): Beacon | Promise<Beacon>;
  /** Host refresh cadence (ms). Default = BEACON_TTL_MS / 2 = 150s. */
  heartbeatIntervalMs?: number;
  /** Optional HTTP endpoint for runner-style remote agents → Beacon.endpoint. */
  endpoint?: string;
}
```

Because `manifest.id` is shared across all three faces, the panel can finally **fuse one tool's runner health, its ingested sessions, and its live beacon into a single fleet row keyed on `id`** — the thing that is impossible today.

### 1.1 The manifest (`connector.json`)

Every connector ships a signed `connector.json`, validated **fail-closed** with the same deny-by-default posture as the existing `validateScopeFile`:

```json
{
  "acp": "acp/1",
  "id": "acme-foo",
  "kind": "source",
  "displayName": "Acme Foo",
  "vendor": "acme",
  "version": "1.4.2",
  "tier": 3,
  "abiRange": ">=2.0 <3.0",
  "provides": ["source", "presence"],
  "homepage": "https://acme.dev/autoclaw",
  "permissions": {
    "reads": ["~/.acme/sessions/**"],
    "network": "none",
    "writesWorkspace": false,
    "spawnsProcess": false
  },
  "provenance": { "repo": "github.com/acme/foo", "commit": "<sha>", "sbom": "sbom.spdx.json" },
  "signature": "<detached sig over canonicalized manifest + bundle hash>"
}
```

Rules:
- **`acp`** is the protocol tag the connector targets. The host speaks `acp/1`; a connector declaring `acp/2` is **shelved with a doctor hint, never crashed**.
- **`id`** is THE shared identity — same string for the runner, source, and presence faces.
- **`tier`** governs default-on/off and gating (`1` native · `2` first-party · `3` third-party). Defaults to `3` (most-restricted) when omitted; any connector that provides a `runner` is forced to `tier ≥ 2`.
- **`provides`** drives registration and the fleet badge.
- **`permissions`** is capability-bounded by the manifest **and** runtime-enforced (§4).
- An absent/malformed manifest, an unparseable `permissions` block, or an unrecognized tier loads the connector **disabled with a surfaced hint** — never as a wildcard.

### 1.2 Lifecycle (versioned, host-driven)

```
RESOLVE → NEGOTIATE → DETECT → REGISTER → (ingest | dispatch | beacon) → DISPOSE
```

1. **RESOLVE** — host loads the factory and calls it with `ConnectorContext` (logger, `AdapterEnv`, comms/beacon dirs, host version). **No I/O at module load** (the rule source adapters already follow).
2. **NEGOTIATE** — host reads `manifest.acp` + `manifest.abiRange`. Minor/patch within a major are forward-compatible (unknown fields ignored & **preserved on round-trip**); a major it does not speak is shelved, not crashed.
3. **DETECT** — host runs `runner.detect()` and/or `source.discover(env)` with **per-connector isolation** via `Promise.allSettled` (a throw becomes `not_installed` / `unavailable` + hint, never an abort — both registries already do this).
4. **REGISTER** — host registers each present face into its existing registry (`RunnerRegistry.register`, `SourceRegistry.registerAdapter`) under the shared `id`.
5. **Steady state** — `extract()` streams on `/learn`; `dispatch()`/`resume()` run work; the host calls `presence.beacon()` on the heartbeat interval and persists with `writeBeacon()`.
6. **DISPOSE** — host stops the heartbeat and may remove the connector's beacon.

**Enablement defaults are tier-driven and unchanged.** Tier 1 native is on; **Tier 2/3 default-off**, opt-in via `config.sources[id].enabled` / `autoclaw.runner.*` (the existing `resolveEnabledSources` / `DEFAULT_SOURCE_ENABLED`). A third-party connector ships **off** until the user trusts it — preserving the local-first, consent-gated posture.

### 1.3 Registration channels (no fork required)

**A. In-tree (built-ins, today's path, kept and cleaned up).** Replace the hardcoded `new XRunner()` wall in `defaultRegistry.ts` and the hardcoded list in `createDefaultRegistry()` with a loop over a single declarative `BUILTIN_CONNECTORS: ConnectorFactory[]` array; the registries route by `manifest.provides`. **This also adopts the three orphaned Tier-3 source adapters** — `clineRoo`, `continue`, `kilocode` — that exist on disk but are absent from `createDefaultRegistry()` today.

**B. Out-of-tree (the new capability).** A discovery pass scans, in precedence order:
- npm packages named `autoclaw-connector-*` or under the `@autoclaw/connector-*` scope, resolvable from the workspace;
- a user plugin dir `~/.autoclaw/connectors/<id>/` (or in-workspace `.autoclaw/connectors/`), each with a `connector.json` + entry module.

Each discovered package runs the same RESOLVE→…→REGISTER lifecycle, isolated, tier-gated to default-off, and surfaced in `autoclaw doctor` + the fleet panel. A connector with no installed CLI and no local store simply reports `found:false` / `available:false` with a remediation hint — exactly how Codex/CodeGPT/Copilot-chat appear before a connector exists.

---

## 2. The agent-to-agent (A2A) coordination layer

The coordination premise has shifted: **git + GitHub PRs + CI is the durable code-coordination plane** (who-owns-what merges, review gates). The filesystem create-exclusive *claim mailbox* is retired for code. But **live A2A messaging + presence still matters** for what a PR cannot carry: "who is alive right now," "who can do X," "I'm taking this lane," "answer my question before I push." `acp/1` specifies that residual layer as a small, transport-agnostic envelope — and almost all of the substrate already ships.

### 2.1 What already exists (build on it; do not reinvent)

| Concern | Existing asset | State |
|---|---|---|
| Capability advertisement | `src/agent-card.ts` + `src/fabric/agentCardPublisher.ts` — A2A v0.2.5 Agent Card with `x-autoclaw` block | shipped |
| Presence / heartbeat | `src/fleet/beacons.ts` (`writeBeacon`/`readAllBeacons`, `BEACON_TTL_MS=5min`, staleness, origin tags) | shipped |
| Pub/sub fanout | `src/fabric/bus.ts` — `fs`/`ws`/`nats` drivers, durable-write-first | shipped |
| Cross-machine transport | `src/relay-server/*` + `src/cloud/relay.ts` | shipped, inert by default |
| HTTP-runner transport | `src/bridge.ts` — `POST /api/v1/heartbeat`, `/messages`, SSE `/messages/stream` | shipped |
| MCP transport | `src/mcp/writeTools.ts` (`inbox.send`, `claim.task`, `consensus.vote`), `src/mcp/tools.ts` (`fleet.status`, `inbox.read`) | shipped |
| Message taxonomy + idempotency | `src/comms/types.ts` `MessageType`; `src/comms/inboxState.ts` | shipped |
| Scope lease (the surviving soft claim) | `src/program/leases.ts` | shipped |

**Three divergences this standard closes:**
1. **Two+ heartbeat shapes** — `Beacon` (`fleet/beacons.ts`) vs `Heartbeat` (`comms/heartbeat.ts`) vs the relay/bridge body. Pick **`Beacon` as the one canonical wire form** (it is already the superset); a heartbeat is a `Beacon` with `endpoint` omitted.
2. **Well-known path drift** — A2A canonical is `/.well-known/agent.json`, but `agentCardPublisher.ts` writes `/.well-known/agent-card.json`. Serve **both** (canonical + alias) so strict-A2A peers resolve.
3. **Live vs ingested identity** — `Beacon{agent_id, session_id, host, workspace}` must stay a **superset of** intel's `UnifiedSession{id, source, workspace}` so a live peer correlates to its later-ingested transcript. Enforce in review; do not fork a second identity model.

### 2.2 Two lanes, one identity

- **Presence lane** (broadcast, lossy, TTL'd): the `Beacon`. "I exist, here's what I am, here's how to reach me."
- **Message lane** (addressed, durable, idempotent): the comms message envelope. "Review this. Answer that. I'm taking lane X."

**Presence — the Beacon** gains two optional, ignorable-by-existing-readers fields:

```jsonc
{
  "agent_id": "hermes", "session_id": "9f2c…",
  "timestamp": "2026-06-15T19:30:00Z", "status": "active",
  "current_task": "PR #12 review", "current_llm": "claude-opus-4-8",
  "role": "ops", "agent_type": "assistant",
  "host": "hermes", "machine_id": "win-gotad-01",
  "workspace": "<local-projects>/autoclaw", "workspace_id": "autoclaw",
  "origin": "beacon", "endpoint": "http://localhost:42777",
  "transports": ["fs", "mcp", "http"],                          // NEW: which lanes I speak
  "card_url": "http://localhost:42777/.well-known/agent.json"   // NEW: capability pointer
}
```

`transports[]` + `card_url` let the orchestrator pick **how** to message a peer without probing. Both optional; both ignored by existing readers.

**Message — the existing envelope, transport-neutral.** The `src/comms/types.ts` vocabulary is unchanged: `task_assign`, `task_claim`, `task_complete`, `review_request`, `review_response`, `consensus_vote`, `finding_report`, `question`/`answer`, `capability_query`/`capability_offer`, `subcontract_*`, `scope_violation`. One **deprecation** for the new plane: in PR-coordinated mode, `task_complete`/`review_request` SHOULD carry `payload.pr` (number/URL) instead of `payload.branch` — the durable review record is the PR; the A2A message is just the **doorbell** that one is ready.

**Capability — the Agent Card, two depths (both already exist):**
- *Cheap/live:* the `Beacon` (role, llms, status) — good enough for "is there a coder free right now."
- *Rich/authoritative:* fetch `card_url` → full A2A v0.2.5 card (`tools_supported`, `context_window`, `trust_level`, `cost_budget`, `skills[]`). The `skills[]` array maps 1:1 to the message taxonomy (a peer listing `skills:[{id:"review_request"}]` advertises it accepts reviews), and drives capability-scored routing.

### 2.3 Claim / role under the PR plane

- **Claim a PR/branch, not a file.** Announce intent with a `task_claim` carrying `payload.lane` + `payload.intended_branch`; the durable mutex is the open PR, and overlapping diffs surface as merge conflicts/CI, not claim-file races.
- **Scope lease** (`src/program/leases.ts`) is the surviving soft mutex — "this lane is mine" across repos/peers — with TTL + owner-heartbeat liveness (a stale lease may be stolen, same rule as the old claim file). The create-exclusive write rule survives **for the lease**, not for code files.
- **Role is user-authoritative** via `fleet.json` (`role` setting → beacon self-declared `role` → activity inference). A peer's beacon `role` is a hint; the user's manifest wins.

### 2.4 Four transports, one envelope (ranked by reach)

A peer declares what it speaks in `Beacon.transports[]`; the orchestrator delivers over the highest-reach shared lane. **All four already exist in-tree.**

| Transport | Code | Reach | Use when |
|---|---|---|---|
| **filesystem** | `comms/` tree + `fleet/beacons.ts` | same machine + workspace | default; anything that can write a file participates |
| **MCP** | `mcp/writeTools.ts` + `mcp/tools.ts` | any MCP-speaking agent | **lowest-friction plug for a brand-new external CLI** — no file paths, no HTTP server, just tool calls |
| **HTTP bridge** | `bridge.ts` (`/api/v1/heartbeat`, `/messages`, SSE) | localhost runners | headless runners that want push (Hermes, AutoGPT) |
| **relay** | `relay-server/*` + `cloud/relay.ts` | cross-machine | multi-box fleets; forwards encrypted inbox + heartbeats with `host`/`workspace`/`origin` |
| *fanout (accel)* | `fabric/bus.ts` (`ws`/`nats`) | optional | ephemeral event fanout **on top of** a durable lane — never the system of record |

**Invariant (already enforced in `fabric/bus.ts`): durable-write-first.** A peer writes the message to its canonical lane (FS/MCP/HTTP/relay) **then** may publish a bus notification. The bus is a doorbell, not the mailbox — a missed WebSocket never loses a `review_request`.

---

## 3. Governance: versioning, conformance, trust, provenance, marketplace

A connector is one of **two kinds**, and the security posture differs sharply:
- **Source connector** (read-only ingestion) — risk surface = **read** (privacy/exfiltration). Consent-gated, redacted, default-off.
- **Runner connector** (lets an external agent *act*) — risk surface = **write/execute** (code injection, supply chain, autonomy). This is the dangerous one and is gated hardest.

### 3.1 Versioning (two independent SemVer axes)

- **(a) Connector ABI** — the `SourceAdapter`/`Runner` TS contract, versioned `abi/<major>.<minor>`; **(b) the connector's own version**. A connector declares `abiRange` (e.g. `">=2.0 <3.0"`); the host **refuses to load outside the range** rather than crashing on a missing method — the same defensive posture `translateTrust` already takes for unknown runners (fall back to strictest).
- **ABI major = breaking** (method removed / signature changed); **minor = additive** (new optional capability flag, new `errorClass`). Capabilities are **negotiated, not assumed**: a host on `abi 2.1` calling a `2.0` connector sees the new capability reported `false` — mirroring how `AdapterCapabilities`/`Capabilities` already gate behavior (`incremental`, `toolTrustGranularity`).
- **Deprecation window:** a removed ABI method survives as a shimmed no-op for **one minor cycle** with a host-surfaced warning before a major drop. **Unknown future fields are preserved on round-trip** (as `recordConsent`/`readBeacons` already do).
- **No silent capability inflation.** A connector may never report a capability it cannot honor; conformance verifies the claim — closing the gap the runner contract already worries about (claim `turbo`, lack granular flags → must `downgrade` and report it, never quietly run unrestricted).

### 3.2 Conformance / certification harness

A published `@autoclaw/connector-conformance` package — run by the author in their CI and re-run by the host **before first enable** — asserting the contracts already encoded in the registries are met, producing a green/red **certification** signal:

- **Source connectors:** `discover()` never throws (returns `{available:false, hint}` on a missing store — the `Promise.allSettled` isolation contract); `extract()` honors `sinceTs`/`limit` and yields well-formed `UnifiedSession` with correct `provenance.adapterId`; redaction runs at message-build time; **declared capabilities match observed output** (claim `incremental:true` ⇒ a `sinceTs` run actually filters).
- **Runner connectors:** preset translation is **exhaustive + monotonic** (no preset maps looser than requested); an unsupported preset **downgrades to stricter** and sets `downgradedFrom` (never silently runs `turbo`); `errorClass` is emitted for each failure mode; `cancel()` actually terminates; path/branch scope violations are detectable post-dispatch.
- **Golden-fixture replay:** ship a recorded session/dispatch fixture; the connector must produce a **byte-stable normalized record**. A connector that fails conformance is marketable only as `tier 3, unverified`.

### 3.3 Trust & permission scoping (capability-bounded + host-enforced)

- **Source connectors** are confined to their declared `permissions.reads` globs and `network:"none"` by default. The host **sandboxes file access to the declared glob** (a connector declaring `~/.acme/**` cannot read `~/.ssh`) and **strips/redacts before the transcript reaches the vector store or `/learn`**. Ingestion stays **default-off for all Tier-3** and requires the existing `consent.ts` first-run opt-in per source; a new id with no recorded decision is `toPrompt`, never auto-run.
- **Runner connectors** inherit the **full `ScopeDeclaration`**: `trust` preset, allow/deny tool lists (deny always wins), `pathScope`, `branchScope`, `maxTokensPerDispatch`, `maxWallClockMs`, `browserAllowed`. The standard tightens two existing weak points:
  1. **Path/branch scope is host-enforced, not just audited.** RFC §9 currently lists path scope as "post-dispatch audit only" — insufficient for *external* runners. The host must constrain the working tree (**worktree/branch jail**) so an out-of-scope write is **prevented**, then audited, then reported as `scope_violation`.
  2. **MCP server inheritance is opt-in.** An external runner does **not** silently inherit the workspace's `.claude/settings.json`/`mcp.json` servers (which may hold credentials + write tools). MCP exposure to a third-party runner is its **own consent line** on the per-connector toggle.
- **Network egress** declared in the manifest is enforced (default `none`); a Tier-3 connector phoning home is a conformance failure + trust downgrade.

### 3.4 Signing & provenance

- **Detached signature over the canonicalized manifest + a content hash of the bundle**, verified against the publisher's registered key **before** the connector may `extract`/`dispatch`. Unsigned ⇒ loadable only as `tier 3, unverified` with an explicit per-connector override.
- **Provenance is recorded, not just trusted:** `repo`/`commit`/`sbom` are stamped into the connector's audit row, and every `UnifiedSession` already carries `provenance.adapterId` + `extractedAt` so ingested data is traceable to a *signed, versioned* connector.
- **Key rotation / revocation:** the marketplace publishes a revocation list; a revoked key disables its connectors on next host check-in. **Pin-on-first-use** for keys so a swapped signature on an installed connector trips an alarm rather than silently updating.

### 3.5 Marketplace / discovery

- A **signed `index.json` registry** (local-first cache) where owners publish `id`, `kind`, `tier`, `abiRange`, publisher key fingerprint, conformance badge, signature. Install pulls the bundle, verifies signature + provenance, runs conformance, and **lands disabled** pending the user's consent/scope decision.
- **Reputation routing reuse:** the existing reputation/cost-ledger routing weights connectors by conformance status + observed `errorClass` rates + `scope_violation` history — a connector that repeatedly trips scope or downgrades drops in the preference order (extending `RunnerRegistry.getPreferred`).
- **Cross-tool presence:** an installed external runner announces via the existing beacon, so the fleet panel shows third-party agents alongside native ones **with their tier/trust badge** — visibility is part of governance.

### 3.6 Security call-outs for external runners (highest-risk surface)

1. **Arbitrary code execution / supply chain** — a runner *is* code that spawns processes and edits the repo. Mitigations: signing + SBOM + pinned commit, mandatory conformance, `spawnsProcess`/`writesWorkspace` declared-and-enforced, **worktree isolation** so a runner cannot touch other projects' scope (ties to the MP-2/3 scope-lease work).
2. **Trust-preset spoofing / silent escalation** — an external runner could claim `auto` then run `turbo`. The **host** applies the deny list and verifies post-dispatch that only auto-approved categories fired; a mismatch is a `scope_violation` + immediate trust downgrade, not a warning.
3. **Credential & secret theft** — external runners do **not** inherit API keys, MCP servers, or env by default; `DispatchOptions.env` is allow-listed per connector, secrets injected only on explicit consent. Source connectors must never ingest secrets — redaction is mandatory + conformance-tested.
4. **Prompt injection through ingested transcripts** — a malicious connector can inject content that later steers a native agent during RAG retrieval. Provenance tagging + tier-weighting means **Tier-3 ingested memory is lower-trust in retrieval**, and unverified-connector `/learn` signals are quarantined until corroborated (the existing noisy-OR only raises confidence on independent agreement — a single unverified source must not dominate).
5. **Coordination-plane abuse** — with coordination on git/PRs/CI, an external runner that can push is an actor in the merge gate. It operates under a **scoped bot identity on a `branchScope`-jailed branch**, with **CI (not the runner) as the authority that promotes** — never direct-to-`master`. Signed commits/PRs let the gate attribute and revoke.
6. **Denial / resource exhaustion** — `maxTokensPerDispatch`/`maxWallClockMs` are hard-enforced (host hard-kills at 2× per the runner contract); a misbehaving connector is circuit-broken out of the preference order via its violation history.

**Net governance stance:** source connectors are *read-scoped + consent-gated + redacted*; runner connectors are *signed + conformance-certified + scope-jailed + post-dispatch-audited* — with the host (not the connector) holding final enforcement, and CI holding merge authority. Every mechanism extends a primitive already in `src/intelligence/sources/` and `src/runners/`, not a new subsystem.

---

## 4. How specific tools onboard

The contract is deliberately **"anything that can speak one of four transports is a peer."** A tool implements as many of the three faces as it can; the shared `id` ties them together.

| Tool | Faces it can fill today | Recommended on-ramp |
|---|---|---|
| **Codex / Codex-CLI** | `runner` (+ `presence`); no local session store ⇒ no `source` yet | **MCP lane** — mount AutoClaw's MCP server, no file/HTTP plumbing |
| **CodeGPT** | `runner` (+ `presence`); `source` once a session-store adapter is written | MCP lane; add a `SourceAdapter` later for ingestion |
| **Copilot-chat** | `presence` now; `source` when its chat store is parseable | MCP `presence.beacon`; visible without ingestion |
| **Hermes** | `runner` + `presence` (REST agent) | **HTTP bridge lane** — `POST /api/v1/heartbeat`, SSE stream |
| **OpenClaw** | all three (headless host) | **filesystem lane** (lowest common denominator) or HTTP bridge |
| **AutoGPT** | `runner` + `presence` (REST) | HTTP bridge lane (existing `runners/autogpt.ts` shape) |

**Three on-ramps by tool shape:**

**A. MCP-capable CLI (Codex/CodeGPT/Copilot) → MCP lane (zero file/HTTP plumbing).** These tools have no local session store today, so they are invisible to ingestion — but live A2A does not require ingestion. The peer mounts AutoClaw's MCP server and:
1. On start: call the **new** `presence.beacon` MCP tool → it's now a fleet row.
2. Advertise capability: serve/point a `card_url`, or pass `tools_supported`/`llms_available` inline in the beacon.
3. Coordinate: `inbox.send`, `inbox.read`, `claim.task`, `consensus.vote` (already implemented).
   *This is the recommended path precisely because it needs no filesystem convention.* **The one real gap:** today MCP can message + claim but cannot **check in** — `mcp/writeTools.ts`/`tools.ts` have `inbox.send`/`claim.task`/`fleet.status` but no `presence.beacon`. Adding it (a one-line wrapper over `writeBeacon`) is the single highest-leverage change.

**B. REST runner (Hermes/AutoGPT) → HTTP bridge lane.** The peer `POST`s `/api/v1/heartbeat` each cycle (or drops a machine beacon — both land in the same view), subscribes to the SSE `…/messages/stream` for push (or polls), and serves its Agent Card at its own `endpoint` + `/.well-known/agent.json` so the router fetches it for capability scoring. The orchestrator wakes these runner hosts by flipping `ready`; they re-read state each dispatch (no in-memory continuity assumed).

**C. Shell / file-only tool (OpenClaw, any one-liner) → filesystem lane.** `writeBeacon` (or the documented `node -e` one-liner) → `~/.autoclaw/beacons/<id>.json`; write message files to `comms/inboxes/<to>/` with the filename convention, honoring idempotency (`inboxState.ts`: read once → `_state/<id>.json` → move to `processed/`); cross-machine via `cloud/relay.ts` pointed at a self-hosted `relay-server`.

**Uniform onboarding handshake (across A/B/C):**
```
1. REGISTER  → write a Beacon (transports[], card_url, role hint)
2. ADVERTISE → serve/point an Agent Card (skills[] = accepted message types)
3. (user)    → fleet.json assigns authoritative role/type/orchestrator
4. LOOP      → heartbeat(beacon) each cycle; SYNC inbox (any lane); claim a LANE
               (scope-lease) not a file; do work; open/annotate a PR;
               send task_complete{payload.pr} + review_request; back off when idle
```
This is the existing six-phase session loop with two substitutions for the new plane: **heartbeat→beacon** (so non-VS-Code tools check in) and **claim-file→PR + scope-lease** (so the durable mutex is the PR).

---

## 5. Concrete deltas to ship (small, mostly additive)

1. **`@autoclaw/connector-sdk`** — publish the `Connector`/`ConnectorManifest`/`PresenceProvider`/`ConnectorFactory` surface re-exporting the existing `Runner` + `SourceAdapter` types. *(new package)*
2. **`presence.beacon` + `presence.fleet` MCP tools** (`src/mcp/writeTools.ts` / `tools.ts`) — thin wrappers over `writeBeacon`/`readAllBeacons`. **The single highest-leverage change**: makes Codex-CLI and any MCP CLI a visible peer with no new convention. *(closes the one real A2A gap)*
3. **`Beacon.transports[]` + `card_url`** (`src/fleet/beacons.ts`) — optional fields letting the router pick a lane without probing.
4. **Serve `/.well-known/agent.json`** alongside the existing `agent-card.json` (bridge + `agentCardPublisher.ts`) — A2A-canonical path so strict peers resolve.
5. **Unify the heartbeat envelope on `Beacon`** — make `comms/heartbeat.ts` and the relay/bridge bodies accept/emit the `Beacon` superset; one wire shape, no second identity model.
6. **PR-aware message payloads** — `task_complete`/`review_request` carry `payload.pr`.
7. **Declarative `BUILTIN_CONNECTORS` loop** replacing the hardcoded `defaultRegistry.ts` / `createDefaultRegistry()` walls — **and adopt the three orphaned Tier-3 source adapters** (`clineRoo`, `continue`, `kilocode`).
8. **Out-of-tree connector loader** — npm-scope + `~/.autoclaw/connectors/` discovery, manifest validation (fail-closed), ABI-range negotiation, signature verification, tier-gated default-off registration.
9. **`@autoclaw/connector-conformance`** harness + golden-fixture replay. *(new package)*
10. **Marketplace `index.json`** (signed, local-first cache) + revocation list + reputation weighting via `RunnerRegistry.getPreferred`.
11. **Docs:** add `AGENT_SESSION_PROTOCOL.md §10 "Peers without a native bridge (Hermes/OpenClaw/Codex-CLI)"` with the A/B/C on-ramps, and reconcile §4 (claim-file) to "PR + scope-lease" for the code plane while keeping create-exclusive for the *lease*. Bump the runner-bridge RFC to make external path-scope **host-enforced, not audit-only**.

---

## 6. One-line summary

*A connector is one signed manifest + one shared id with up to three faces — **runner** (act), **source** (ingest), **presence** (be visible). Presence is a `Beacon`, capability is an A2A Agent Card, messages are the existing comms envelope, the durable code-coordination record is a PR, and a peer is anything that speaks one of four transports already in-tree (filesystem / MCP / HTTP bridge / relay). The host — never the connector — holds trust enforcement, and CI holds merge authority. The heavy contracts already exist; the work is unifying the heartbeat shape, adding two MCP presence tools + a few optional fields, wiring out-of-tree discovery, and publishing the SDK + conformance + marketplace.*
