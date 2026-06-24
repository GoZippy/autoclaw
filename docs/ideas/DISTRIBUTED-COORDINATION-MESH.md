# Distributed Coordination Mesh — Goal Charter

**Status:** scoping → phased build
**Owner initiative:** make AutoClaw coordinate multi-agent / multi-IDE / multi-LLM /
multi-machine work for real — "fire the orchestration no matter where it starts,"
elect one active orchestrator with hot standbys, and let multiple computers join one
secure fleet that shares messages **and files**, not just isolated worktrees.

This charter consolidates four grounded architecture passes (election/quorum,
secure LAN transport, replicated work-state, reuse audit). It supersedes nothing —
it **completes** the prior [DISTRIBUTED_AGENT_FABRIC](../DISTRIBUTED_AGENT_FABRIC.md)
+ [FLEET_ARCHITECTURE](../FLEET_ARCHITECTURE.md) +
[FLEET-FEDERATION-SELF-HEALING](FLEET-FEDERATION-SELF-HEALING.md) vision by adding the
coordination, election and replication layer those docs left as "P3/P4 / TODO."

---

## 1. The Ceph mapping (the user's mental model, made concrete)

| Ceph daemon | Responsibility | AutoClaw role | Backed by (today) |
|---|---|---|---|
| **MON** (monitor) | Paxos quorum holding the authoritative *cluster map* | **Monitor** — every session running the *start loop*; votes on the map | `supervisorLease.ts` + `lmd/gossip.ts` (extend) |
| **MGR** (manager) | Exactly one **active** + ranked **standbys**; runs the work | **Manager** — the one session that dispatches/heals/tallies | `supervisorLease.ts` (today gates only HEAL) |
| **MDS** (metadata) | Owns the metadata namespace | **Metadata** — sole writer of `board.json`, claims, consensus | `boardWriter.ts`, `consensusTally.ts` |
| **OSD** (data) | Stores the data | **Worker** — the coding agents (claude-code, kilo, kiro, …) | heartbeats / beacons |

We **simplify** Ceph deliberately (per the transport + audit passes): a single elected
manager (no full Paxos), **TLS 1.3 instead of a bespoke msgr2 frame**, and a
**lease+fence instead of a quorum** for the common case — adopting cephx's
*issued-ticket + scoped-capability + rotating-key* model via the SVID/biscuit
primitives we already have.

---

## 2. Design principles (the guardrails — non-negotiable)

The reuse audit was blunt: most of this exists, and the failure mode is re-inventing it.

1. **Extend, don't reinvent.** NATS is specified in 3 places and built in 0 — there is
   ONE transport seam (`lmd/natsGossip.ts` `GossipTransport`); implement it once,
   share it with `program-plane.bus_driver` and the gossip ring. Do **not** add a 4th
   transport, a 4th lock format, or a 3rd presence system.
2. **The filesystem mailbox stays canonical.** Network transports are the *fast path*;
   `.autoclaw/orchestrator/comms` remains the durable source of truth and the offline
   fallback. Never replace it.
3. **Off by default, explicit consent.** Relay, bridge, self-healing, NATS are all
   inert until enabled — that is the local-first / no-phone-home promise. Every new
   network or replication capability ships **inert** and opt-in, mirroring
   `relayIsActive` / the GA-consent gate.
4. **One lease, extended.** Don't invent a leader election next to `supervisorLease.ts`,
   `scopeLease.ts`, `program/leases.ts`, and claim files. Add an **epoch + fencing
   token** to the supervisor lease and promote it from "HEAL gate" to "active-manager
   election."
5. **Name leader-election distinctly from role-election.** `fleet/roleElection.ts` picks
   a *job role*; the new thing picks a *leader*. Keep them separate in code and docs.
6. **Beacons = membership roster; gossip = liveness/health.** Don't add a third
   membership file.
7. **Mock crypto is not a multi-host trust root.** SVID/biscuit run as HMAC mocks unless
   SPIRE / biscuit-wasm is present — which collapses cross-host trust to a shared env
   secret. Real multi-host authz must use a real key-distribution step (invite-bootstrapped
   fleet CA) or SPIRE; never ship the shared-secret mock as "secure."

---

## 3. Unified architecture

### 3.1 Cluster map (the versioned source of truth)
`.autoclaw/orchestrator/comms/cluster-map.json` (mirrored to the program plane for
cross-machine). A **superset of today's `SupervisorLease`** — the lease becomes the
`active_manager` sub-object, so migration is a rename+nest, not a rewrite. Carries:
`epoch` (bumped on any membership change), `term` (bumped only on a new active),
`active_manager` (= lease holder + expiry), ranked `standbys[]`, `monitors[]`,
`quorum_size`, and `fenced[]`. **Ordering uses integer (epoch, term)** — never
timestamps — so clock skew can't reorder it. Merge rule = the freshest-wins merge
already implemented in `RemoteHealthTracker.merge`, generalized.

### 3.2 Election (lease + fence, not Paxos)
Every session runs a **START LOOP** before the work loop: DISCOVER (read map + beacons
+ gossip) → JOIN the monitor set → ELECT/RENEW the manager → only the active manager
runs dispatch. The claim is fenced by a create-exclusive `wx` lock
(`claim.ts:91` primitive) so concurrent windows serialize to one winner; a deposed
active is appended to `fenced[]` and stops on its next read. A **lone agent bootstraps a
quorum-of-one** and keeps full authority as peers arrive as standbys. Standby promotion
is a sorted-array lookup (rank by `roleElection.scoreNeed` × freshness, tie-break by
instance id) — no re-election round.

### 3.3 Secure multi-host transport
Topology = **one elected LAN hub** (the active manager's machine running the existing
self-hostable relay server) + relay clients on every other host — *not* an N×N mesh.
This reuses the relay's store-and-forward replication verbatim; only the endpoint
changes from cloud to `https://<hub>:port`.
- **Discovery:** mDNS (`_autoclaw-fleet._tcp`) + UDP broadcast + a hand-editable
  seed-list, all on Node's built-in `dgram` (no new hard dep). Discovered peers become
  `Beacon` rows → the panel shows them with zero panel changes.
- **Secure channel:** **mTLS** (Node `tls`, TLS 1.3 AEAD) where each host's leaf cert's
  SAN-URI **is its SVID**, chaining to a **per-fleet CA** bootstrapped from one join
  code. Then the existing `bridge.validateRawToken` fusion (bearer → SVID → biscuit)
  runs **unchanged** behind the TLS gate. Three layers: TLS = machine auth, SVID =
  which agent, biscuit = what it may do.
- **Authz:** an `agent_type → wire-op` capability matrix driven by
  `fabric/agentTypes.ts` trust tiers; biscuit attenuation delegates scoped caps without
  re-minting. Keys provisioned by the invite (one code), stored in the keychain-backed
  `SecretStore`; SVID auto-rotates (4 min), fleet CA rotates by bumping a `fleet_epoch`.

### 3.4 Replicated work-state
- **Single elected MDS writer:** gate `writeBoard` + ingestion + consensus tally behind
  the manager lease (today every host writes the board every tick → a race). Atomic
  publish via temp+rename so a reader never sees a half-written board.
- **Replicas:** non-managers consume the board; cross-host they pull a **non-draining
  `GET /v1/state`** state-pool from the relay and write a local mirror, so every machine
  renders an identical board (with a `generated_at` staleness stamp).
- **Cross-host claims:** the local `wx`/rename mutex is correct on one machine and stays
  the fast path. Across machines (where `wx` is meaningless) the hub grants a
  **claim lease with a monotonic fencing token**; a zombie holder that lost the lease is
  rejected at the fence. No relay configured ⇒ local fast path only (today's behavior).

### 3.5 Secure file sharing (not just isolated worktrees)
Content-addressed artifacts (`sha256` id), AES-256-GCM encrypted with a fleet-derived
key so the hub holds ciphertext only, capability-gated by biscuit, integrity-checked on
fetch. Worktree/tarball sync lands in a **quarantined staging dir** and is applied only
via the human/orchestrator admit flow — never auto-applied. Divergent edits are retained
both-ways under `conflicts/` and raise the existing `scope_conflict` message.

### 3.6 The keystone local fix — task-catalog ingestion
**Root cause of "messages flow but nothing coordinates":** `OrchestratorState` has no
top-level `tasks[]` (`orchestrate.ts`), but the board reads exactly `state.tasks[]`
(`boardWriter.ts`). Tasks living in `specs/*/tasks.md` + sprint YAMLs are never
materialized into that array → `board.claimable` is always empty → agents idle and chat.
Fix = a new `taskCatalog` parser (manifest ⊕ sprint YAML ⊕ `tasks.md`, hand-rolled
YAML-subset, no new dep) that writes `state.tasks[]`, run on plan/assign, on a guarded
loop tick, and on file-watch. The board's bucketing logic needs **no change** once it's
fed.

---

## 4. Phased roadmap

Sequenced local-first (fixes the real bug, low risk) → election → multi-host
(security-sensitive, opt-in). Each phase is independently shippable + testable.

### Track L — Local-first coordination (shared FS, multi-IDE) — **start here**
- **L0 — Task-catalog ingestion.** `taskCatalog.ts` + `taskCatalogIngest.ts`; extend
  `OrchestratorState.tasks?`; call after plan/assign + guarded loop tick + file-watch.
  *Directly fixes the empty board.* New tests prove a `tasks.md`-only project yields a
  non-empty `claimable`.
- **L1 — Single-active board + atomic publish.** Gate `writeBoard`/ingest/tally behind
  `acquireSupervisorRole().isSupervisor`; temp+rename publish. Behind
  `autoclaw.cluster.singleActive` (default on, revertible). Fixes N-window double-dispatch.
- **L2 — Real-time propagation.** File-watch-driven board write + panel refresh; 30s/5s
  polls become backstops. Sub-second cross-IDE updates.
- **L3 — Wake idle peers.** Board-grounded `work_available` + `review_resolved` inbox
  nudges (reuse the `review_request` delivery path + recent-nudge dedup). Closes
  "idle when there is claimable work."
- **L4 — Supervisor visibility.** Panel chip "Orchestrator: <holder> (you / standby)" +
  takeover toast. Data already on disk; pure render wiring.

### Track E — Real election (epoch + fence + standby)
- **E1 — Cluster-map doc + lease projection** ((epoch, term) monotonic merge, fencing).
- **E2 — START LOOP + monitor quorum + standby ranking** (lone-agent bootstrap).
- **E3 — Activate `GossipRing` for map-beats** across windows/workspaces (same box).

### Track T — Secure multi-host (separate machines, LAN) — opt-in, gated
- **T0 — LAN discovery** (mDNS/UDP/seed-list → beacons).
- **T1 — LAN relay over the existing relay client/server** (trusted-LAN, plain) —
  retarget `CloudRelay` at a local hub.
- **T2 — mTLS + fleet CA + SVID-bound certs + biscuit authz matrix.**
- **T3 — Cross-host state-pool replica + cross-host claim arbiter (lease+fence).**
- **T4 — Secure content-addressed file/artifact sharing + worktree quarantine.**
- **T5 — Cross-machine quorum** (map over relay/NATS; partition → minority read-only).

### Track S — Identity/security hardening (cross-cutting, precedes T2+)
- Decide **mock-secret vs SPIRE** for the cross-host trust root; invite-bootstrapped key
  distribution; rotation + 3-layer revocation (biscuit revID, token revoke, CA epoch).

---

## 5. Reuse map (condensed) — what we build ON

| Need | Existing primitive | Maturity | Action |
|---|---|---|---|
| Single-active + standby | `supervisorLease.ts` | prod (lock, no epoch) | **extend** w/ epoch+fence |
| Best-fit selection | `roleElection.ts`, `fabric/router.ts` | tested/prod | reuse for standby rank + assign |
| Liveness/health replication | `lmd/gossip.ts` GossipRing | **tested but UNWIRED** | **activate**, add map-beats |
| LAN transport seam | `lmd/natsGossip.ts` GossipTransport | **stub** | implement once |
| Hub transport | `relay-server/*`, `cloud/relay.ts` | prod (opt-in) | reuse as LAN hub + state-pool + claim arbiter |
| Auth fusion | `bridge.validateRawToken` | prod (no TLS) | reuse behind mTLS |
| Identity / caps | `svid.ts`, `biscuit.ts` | mock unless SPIRE/wasm | bind to certs; real key dist |
| Secret storage | `cloud/auth.ts` SecretStore | prod | reuse for fleet keys |
| Membership / presence | `fleet/beacons.ts` | prod | the roster |
| Cross-repo state | `program-plane.ts` | prod (fs) | mirror cluster map |
| Task mutex | `claim.ts` | prod | local fast path (keep) |
| Board / consensus | `boardWriter.ts`, `consensusTally.ts` | prod | single-writer + atomic + events |

## 6. Open decisions / risks
- **Strategic fork:** how far to push multi-host — **(A)** local-first + elected single
  active (Tracks L+E: mostly hardening what exists, fixes the real bugs, low risk) vs
  **(B)** full active replicated multi-host + secure LAN mesh (Tracks T+S: the big
  vision, security-heavy, partly in tension with the prior "observe-and-dispatch"
  control-plane strategy). Recommendation: ship **L now**, then **E**, then **T/S behind
  explicit opt-in**, reusing fabric/relay/gossip seams (no new transport).
- **Security:** no LAN TLS today; mock-crypto trust root; lease has no fencing yet —
  all addressed in S/T2/E1 respectively and must land **before** any multi-host write path.
- **Backward-compat:** every primitive assumes a shared `.autoclaw/` FS; the networked
  path must keep the FS path working as the durable fallback. Activating GossipRing /
  watchers changes single-host runtime → opt-in.
