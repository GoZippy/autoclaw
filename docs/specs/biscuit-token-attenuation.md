# AutoClaw Biscuit Capability Tokens (Phase 4)

> Status: **Proposal**, 2026-05-09. Phase 4 of the
> [Distributed Agent Fabric](../DISTRIBUTED_AGENT_FABRIC.md) roadmap.
> Companion specs: [agent-card-schema.md](./agent-card-schema.md),
> [nats-topic-conventions.md](./nats-topic-conventions.md),
> [program-plane-registry.md](./program-plane-registry.md),
> [coordination-improvements-mapping.md](./coordination-improvements-mapping.md).
>
> **Spec verification status (2026-05-10):** §2 (token shape), §3
> (attenuation invariants), §5 (revocation), and §9 (license) have been
> verified against the
> [Biscuit SPECIFICATIONS.md (eclipse-biscuit)](https://github.com/biscuit-auth/biscuit/blob/master/SPECIFICATIONS.md)
> and the
> [biscuit-auth LICENSE](https://github.com/biscuit-auth/biscuit/blob/master/LICENSE)
> (Apache-2.0 confirmed). §6 (JWT-SVID claim shape) has been verified
> against the SPIFFE JWT-SVID standard.
> The **AIP IBCT verification figures (0.049 ms / 0.189 ms) remain
> unverified** — the cited arXiv ID `2603.24775` could not be fetched
> (WebFetch denied to arxiv.org) and the ID format itself is suspect.
> See [§ Sources](#sources) at end of file.

## 1. Why Biscuit (not JWT, not Macaroons)

We compared three signed-token formats for AutoClaw subagent dispatch:

| Property | JWT (current bearer) | Macaroons | **Biscuit** |
|---|---|---|---|
| Attenuation by holder | ✗ | ✓ (caveats) | **✓ (Datalog blocks)** |
| Offline verification | ✓ | ✓ | **✓** |
| Revocation list | needs server | needs server | **revocation IDs in token** |
| Verification cost | ms-class | ms-class | **0.049 ms (Rust) / 0.189 ms (Python)** [**still needs verification** — AIP arXiv ID `2603.24775` unfetchable from sandbox; the canonical [Biscuit SPECIFICATIONS.md](https://github.com/biscuit-auth/biscuit/blob/master/SPECIFICATIONS.md) does not publish performance benchmarks. Treat these numbers as advisory until a maintainer confirms against the AIP paper or runs a local benchmark.] |
| Public-key alg | RS256 / ES256 | varies | **Ed25519** [verified 2026-05-10 against [Biscuit SPECIFICATIONS.md](https://github.com/biscuit-auth/biscuit/blob/master/SPECIFICATIONS.md) — root keys defined as `(pk_0, sk_0)` Ed25519 key pair] |
| Multi-hop delegation | manual chain | caveat-chain | **first-class**, with completion blocks |
| Datalog policy expressivity | none | string equality | **rules + facts + checks** |

JWT cannot be attenuated by the holder — once minted, scope is fixed. A
parent agent that subcontracts to a child has to ask the orchestrator to
mint a fresh JWT, defeating offline operation. Macaroons attenuate but
revocation requires a server round-trip, which kills the local-first
promise. **Biscuit** keeps the audit chain inside the token (every block is
signed by the attenuator), supports Datalog-style facts and rules, and
embeds revocation IDs that any verifier can match against a synced list.

References: [biscuitsec.org](https://www.biscuitsec.org/),
[AIP arXiv 2603.24775](https://arxiv.org/html/2603.24775),
[research/distributed-orchestration-prior-art.md §5.2](../research/distributed-orchestration-prior-art.md).

## 2. Token shape

A Biscuit is a sequence of cryptographically chained **blocks**. Each block
holds **facts**, **rules**, **checks**. AutoClaw uses three layers of facts.

### 2.1 Authority block (root, signed by the orchestrator)

Facts:

```
agent("claude-code-laptop1-window3")
project("autoclaw")
sprint("sprint-3")
task_id("task-42")
scope("src/comms.ts")
scope("tests/comms.test.ts")
expires_at(2026-05-09T19:00:00Z)
trust_level("high")
revocation_id("rev-3a9f12c0")
```

Checks:

```
check if time($t), $t < 2026-05-09T19:00:00Z;
check if operation($op), allowed_op($op);
allowed_op("read"). allowed_op("write"). allowed_op("test").
```

### 2.2 Subcontract block (added by parent agent on dispatch)

Facts:

```
subcontracted_from("claude-code-laptop1-window3")
subcontracted_to("kilocode-laptop1-window2")
sub_request_id("subreq-7c44")
```

Checks (attenuation):

```
check if scope($s), $s.starts_with("src/comms.ts");
check if expires_at($t), $t < 2026-05-09T18:30:00Z;
```

The **child cannot remove** the parent's checks — the chain forces the
intersection. The child **can add more**, narrowing scope further.

### 2.3 Revocation list (synced via NATS)

Subject `ac.security.revocations`
([nats-topic-conventions.md §2](./nats-topic-conventions.md)) carries:

```json
{ "revoked": ["rev-3a9f12c0", "rev-1bb78d44"], "ts": "2026-05-09T18:00:00Z" }
```

Verifiers refuse any token whose authority block contains a revoked
`revocation_id`. The list is small (UUID-ish IDs), syncs in milliseconds,
and survives restarts via local cache.

> **[verified 2026-05-10]** Biscuit's canonical revocation mechanism:
> per [Biscuit SPECIFICATIONS.md](https://github.com/biscuit-auth/biscuit/blob/master/SPECIFICATIONS.md),
> *"The revocation identifier for a block is its signature serialized to
> a byte array. For each of these, a fact `revocation_id(<index>, <byte
> array>)` will be generated."* AutoClaw's friendly `rev-3a9f12c0` IDs in
> the example above are an application-level alias on top of the canonical
> per-block signature-bytes identifier; AutoClaw verifiers must check the
> token's revocation list against the **canonical** signature-derived
> revocation IDs, not just the friendly aliases.

## 3. Attenuation rules

A parent agent issuing a subcontract MUST satisfy the following invariants
when adding its block. Pseudocode for the parent-side helper:

```ts
function attenuateForSubcontract(parent: Biscuit, sub: SubcontractRequest) {
  const block = parent.createBlock();

  // (a) Scope: child scope MUST be a subset of parent scope.
  for (const glob of sub.scopeGlobs) {
    assertSubsetOfParentScope(parent, glob);
    block.addCheck(`check if scope($s), $s == "${glob}"`);
  }

  // (b) Time: child expiry MUST be earlier than parent expiry.
  const childExpiry = min(sub.deadline, parent.expiresAt - 60_000);
  block.addCheck(`check if expires_at($t), $t < ${iso(childExpiry)}`);

  // (c) Task identity: MAY be narrowed (one specific task only).
  if (sub.taskId) {
    block.addCheck(`check if task_id($id), $id == "${sub.taskId}"`);
  }

  // (d) Trust level: CANNOT be widened — Biscuit forbids removing facts,
  //     so this is structural; we only assert the parent's level.
  // (e) Operations: child MAY drop ops (e.g. write -> read-only) but
  //     cannot add new ones beyond the orchestrator's `allowed_op` set.

  block.addFact(`subcontracted_from("${parent.agentId}")`);
  block.addFact(`subcontracted_to("${sub.childAgentId}")`);
  block.addFact(`sub_request_id("${sub.requestId}")`);

  return parent.append(block); // signed with parent's key
}
```

Invariants:

- Parent CANNOT widen anything. Block-append cannot remove facts or checks
  from earlier blocks; only add new checks. This is structural, not
  enforced by AutoClaw. [verified 2026-05-10 against
  [Biscuit SPECIFICATIONS.md](https://github.com/biscuit-auth/biscuit/blob/master/SPECIFICATIONS.md):
  *"The holder of a biscuit token can at any time create a new token by
  adding a block with more checks, thus restricting the rights of the new
  token, but they cannot remove existing blocks without invalidating the
  signature."*]
- Parent MUST attenuate scope when issuing a subcontract.
- Parent MAY attenuate `task_id` to a single ID (e.g. parent has scope on
  3 tasks; child gets only 1).
- Child's expiry MUST end before parent's expiry minus a 60 s skew margin.

## 4. Verification path

When the bridge receives any authenticated request (HTTP, WS, or NATS via
account auth), the verification routine is:

```
1. Extract Biscuit from `Authorization: Biscuit <base64>`.
2. Reject if revocation_id is in the synced revocation set.
3. Build verifier:
     - Add fact `time(NOW)`.
     - Add fact `operation("<requested_op>")` (e.g. "write").
     - Add fact `target("<requested_path>")` (e.g. "src/comms.ts").
     - Add policy:
         allow if scope($s), target($p), $p.starts_with($s);
         deny if true;
4. Call verifier.authorize(token). On success, the verifier returns the
   final fact set; AutoClaw extracts agent_id, project, sprint, task_id.
5. The handler enforces those extracted facts against the request body
   (e.g. the message envelope's `task_id` MUST equal the token's task_id).
```

Per AIP IBCT figures (cited in
[research/distributed-orchestration-prior-art.md §5.2](../research/distributed-orchestration-prior-art.md)),
verification is **0.049 ms in Rust, 0.189 ms in Python** — fast enough to
run on every bridge call without batching.

> **Discrepancy / open follow-up (2026-05-10):** These figures **remain
> unverified**. The cited arXiv URL `https://arxiv.org/html/2603.24775`
> could not be fetched (WebFetch denied to arxiv.org from the sandbox),
> and the arXiv identifier format `2603.24775` is suspect (arXiv IDs are
> `YYMM.NNNNN` and `2603` would be Mar 2026, plausible, but the 5-digit
> NNNNN is typical only for very-high-volume months). The canonical
> [Biscuit SPECIFICATIONS.md](https://github.com/biscuit-auth/biscuit/blob/master/SPECIFICATIONS.md)
> publishes **no** performance benchmarks. Action: a maintainer should
> either (a) confirm the arXiv reference and quote a real ID, (b) run a
> local `biscuit-auth` verification benchmark and replace these numbers
> with measured ones, or (c) drop the specific timings and replace with
> "sub-millisecond verification, fast enough for per-call use". Until
> resolved, treat these numbers as advisory.

Concrete enforcement examples for AutoClaw operations:

| Operation | Required facts | Reject when |
|---|---|---|
| `POST /messages` (send) | `agent` matches `from`, `task_id` matches body | mismatch, expired, revoked |
| Edit file `src/auth/login.ts` | `scope` glob covers the file path | scope outside file glob |
| `POST /consensus/vote` | `agent` matches voter, `task_id` matches | scope check + task match |
| Subcontract dispatch | parent token + new subcontract block; child sees attenuated set | child token widens scope |

## 5. Revocation

Three triggers fire a revocation:

1. **Time-based** (default): tokens TTL = 5 min. After expiry the
   `time($t) < expires_at` check fails; no list lookup needed.
   [verified 2026-05-10: the
   [Biscuit specification](https://github.com/biscuit-auth/biscuit/blob/master/SPECIFICATIONS.md)
   does **not** prescribe a default TTL — TTL is application-policy. The
   5-min default in AutoClaw is borrowed from SPIFFE SVID rotation
   guidance (see §6) and the AIP IBCT pattern, not from Biscuit itself.]
2. **Explicit** (operator): orchestrator publishes the `revocation_id` on
   `ac.security.revocations`; every verifier rejects within one bus round
   trip (< 100 ms on LAN).
3. **Cascading** (parent revoked): if the orchestrator revokes the parent
   token's `revocation_id`, every child Biscuit derived from it is rejected
   because verification re-evaluates the authority block first.

Default TTL of 5 min was chosen from
[research §5.1 SPIFFE rotation](../research/distributed-orchestration-prior-art.md);
it bounds the worst-case window between revocation publish and effective
denial regardless of bus health.

Local cache schema: `~/.autoclaw/revocations.json`:

```json
{
  "synced_at": "2026-05-09T18:00:00Z",
  "revoked": ["rev-3a9f12c0", "rev-1bb78d44"]
}
```

The file is rewritten atomically on every NATS update.

## 6. SPIFFE/SPIRE alongside Biscuit

The two are orthogonal and complementary:

| Concern | Mechanism |
|---|---|
| "Who is this process?" (workload identity) | **SPIFFE SVID** — `spiffe://autoclaw.local/agent/<id>`, signed by SPIRE |
| "What may they do here?" (capability) | **Biscuit** — facts + checks |

Token issuance flow:

```
Agent process starts ──▶ SPIRE agent attests (process selectors, host UUID)
                          │
                          ▼
                    SPIRE issues SVID (X.509 or JWT, 5-min TTL)
                          │
                          ▼
        Agent presents SVID to AutoClaw bridge `/auth/exchange`
                          │
                          ▼
   AutoClaw verifies SVID, looks up agent in registry, mints
       Biscuit scoped to project + sprint + task + file globs
                          │
                          ▼
           Agent uses Biscuit on every subsequent API call
```

The SVID stays inside the agent's TLS layer (mTLS). The Biscuit travels in
`Authorization` headers / NATS message metadata. Compromise of one does not
automatically compromise the other:

- Stolen Biscuit but no SVID → cannot open mTLS to the bridge → useless.
- Stolen SVID but no Biscuit → can connect, but every endpoint requires a
  capability check → useless.

JWT-SVID shape (informational; verified 2026-05-10 against
[SPIFFE JWT-SVID standard (spiffe/spiffe repo)](https://github.com/spiffe/spiffe/blob/main/standards/JWT-SVID.md)):

```json
{
  "iss": "spiffe://autoclaw.local",
  "sub": "spiffe://autoclaw.local/agent/claude-code-laptop1-window3",
  "aud": ["spiffe://autoclaw.local/orchestrator"],
  "exp": 1746820800,
  "iat": 1746820500
}
```

> **Annotation (2026-05-10) per JWT-SVID standard:** the standard
> mandates only `sub` (set to the SPIFFE ID of the workload), `aud`
> (one or more values; validators reject if their identifier isn't in
> `aud`), and `exp` (validators MUST reject tokens without `exp`). `iss`
> and `iat` are NOT mandated by the JWT-SVID standard, though both are
> permitted and AutoClaw will populate them. The SPIFFE ID URI format
> is `spiffe://<trust-domain>/<workload-path>`; AutoClaw's example uses
> `spiffe://autoclaw.local/agent/<machine_id>-window<N>` which is
> conformant.

## 7. Compatibility with the current bearer-token bridge

AutoClaw v2.1 ships with static bearer tokens (`acl_<hex>`) per agent.
Phase 4 keeps both paths during cutover:

| Phase | Bearer accepted | Biscuit accepted | Default to mint |
|---|---|---|---|
| 2.1.x (today) | ✓ | ✗ | bearer |
| 2.4 (Phase 3) | ✓ | ✓ (opt-in) | bearer |
| 3.0 (Phase 4 GA) | ✓ (deprecation banner) | ✓ (default) | Biscuit |
| 3.1 | ✗ removed | ✓ | Biscuit |

Trust semantics during overlap:

- **Bearer = full-trust within the workspace.** Today's behaviour. Used
  only when SPIRE is not running or the user opts out of identity.
- **Biscuit = scoped.** Even an "admin" agent must present a Biscuit whose
  scope facts match the requested operation.

The bridge picks the format from the `Authorization:` scheme:
`Bearer <hex>` vs `Biscuit <base64>`. Both code paths share the same
audit-log writer; the auth method is recorded as a field on every entry
so a Phase 4 forensic review can spot residual bearer use.

## 8. Worked example — claude-code subcontracts to kilocode

Authority (orchestrator → claude-code) and the appended block
(claude-code → kilocode):

```
authority {
  agent("claude-code-laptop1-window3");
  project("autoclaw"); sprint("sprint-3"); task_id("task-42");
  scope("src/auth/**"); scope("tests/auth/**");
  expires_at(2026-05-09T19:00:00Z); revocation_id("rev-3a9f12c0");
  check if time($t), $t < 2026-05-09T19:00:00Z;
  check if operation($op), allowed_op($op);
  allowed_op("read"). allowed_op("write"). allowed_op("test").
}
block 1 {
  subcontracted_from("claude-code-laptop1-window3");
  subcontracted_to("kilocode-laptop1-window2");
  sub_request_id("subreq-7c44");
  check if scope($s), $s == "src/auth/login.ts";
  check if expires_at($t), $t < 2026-05-09T18:30:00Z;
  check if operation($op), $op == "write" || $op == "read";  // dropped "test"
}
```

Outcomes when kilocode acts:

- write `src/auth/login.ts` @ 18:25Z → all checks pass.
- write `src/billing/pay.ts` → child scope check fails, rejected.
- write `src/auth/login.ts` @ 18:35Z → child time check fails, rejected.
- run a test (`operation("test")`) → child dropped that op, rejected.

## 9. License & dependencies

`biscuit-auth` is **Apache-2.0** (per repo). All examples in this spec are
hand-written and MIT/Apache-compatible. No GPL dependencies are introduced.
SPIFFE/SPIRE is **Apache-2.0**.

## 10. Cross-references

- Master synthesis: [../DISTRIBUTED_AGENT_FABRIC.md §3 / Phase 4](../DISTRIBUTED_AGENT_FABRIC.md).
- Bus subject for revocation list:
  [nats-topic-conventions.md §2](./nats-topic-conventions.md).
- Where token's `agent_id` comes from:
  [agent-card-schema.md §2](./agent-card-schema.md).
- Multi-repo identity scope:
  [program-plane-registry.md §6](./program-plane-registry.md).
- Maps to COORDINATION items §2.10 and §2.5:
  [coordination-improvements-mapping.md](./coordination-improvements-mapping.md).
- Research basis:
  [../research/distributed-orchestration-prior-art.md §5](../research/distributed-orchestration-prior-art.md).

## Sources

Verified 2026-05-10 against the following canonical sources:

- [Biscuit SPECIFICATIONS.md (eclipse-biscuit/biscuit)](https://github.com/biscuit-auth/biscuit/blob/master/SPECIFICATIONS.md)
  — block grammar (facts/rules/checks), attenuation rules, revocation IDs,
  Ed25519 signing.
- [biscuit-auth LICENSE](https://github.com/biscuit-auth/biscuit/blob/master/LICENSE)
  — Apache-2.0 (verified by direct fetch).
- [SPIFFE JWT-SVID standard](https://github.com/spiffe/spiffe/blob/main/standards/JWT-SVID.md)
  — required claims (`sub`, `aud`, `exp`), SPIFFE ID URI format.
- arXiv `2603.24775` (Agent Identity Protocol / IBCT) — **NOT verified**;
  WebFetch denied to arxiv.org from sandbox. Performance figures (0.049 ms
  Rust / 0.189 ms Python) carry a discrepancy block; see §4.
