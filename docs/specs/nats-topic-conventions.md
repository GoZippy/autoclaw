# AutoClaw NATS Topic Conventions (Phase 2)

> Status: **Proposal**, 2026-05-09. Phase 2 of the
> [Distributed Agent Fabric](../DISTRIBUTED_AGENT_FABRIC.md) roadmap.
> Companion specs: [agent-card-schema.md](./agent-card-schema.md),
> [biscuit-token-attenuation.md](./biscuit-token-attenuation.md),
> [program-plane-registry.md](./program-plane-registry.md),
> [coordination-improvements-mapping.md](./coordination-improvements-mapping.md).
>
> **Spec verification status (2026-05-10):** §2 (subject grammar) and §6
> (JetStream replicas) have been verified against the canonical NATS
> documentation in
> [nats-io/nats.docs/nats-concepts/subjects.md](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/subjects.md)
> and
> [nats-io/nats.docs/nats-concepts/jetstream/streams.md](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/jetstream/streams.md).
> The "≤ 32 chars per token" rule has been **corrected**: the canonical
> NATS docs do not specify a per-token character limit; only a
> recommended overall ceiling of "max 16 tokens, < 256 characters total".
> §5 NATS account permission `{{user}}` substitution claim remains a
> best-effort assertion — it requires either NATS 2.x JWT-based auth
> callout or per-agent user records.
> See [§ Sources](#sources) at end of file.

## 1. Why a topic convention matters

Phase 2 introduces NATS JetStream as the optional fast-path bus
([DISTRIBUTED_AGENT_FABRIC.md §3 / Phase 2](../DISTRIBUTED_AGENT_FABRIC.md)).
The filesystem mailbox stays as the canonical durable record. Topic naming
must be:

- **Hierarchical** — wildcards (`*`, `>`) let an observer subscribe broadly
  without 30 explicit subscriptions.
- **Stable** — sprint and task IDs are part of the subject, not the payload,
  so a JetStream consumer can replay by subject filter.
- **Predictable for ACLs** — agent vs orchestrator vs observer roles get
  one-line allow rules.

All AutoClaw subjects live under the `ac.` prefix to avoid collision with
NATS micro and other tenants on a shared cluster.

## 2. Subject hierarchy

`ac.<plane>.<verb>[.<scope>][.<id>]`

| Subject pattern | Direction | Payload | Retain | Replicas | Consumer pattern |
|---|---|---|---|---|---|
| `ac.fleet.announce` | agent → all | A2A Agent Card (anonymous) | JetStream stream `AC_FLEET`, 7d | 1 (laptop) / 3 (LAN) | broadcast (each subscriber gets all) |
| `ac.fleet.heartbeat.<agent>` | agent → all | heartbeat-v2 record | in-memory (no JetStream) | n/a | broadcast |
| `ac.fleet.capabilities.query` | orchestrator → fleet | `{request_id, requirements}` | in-memory | n/a | broadcast |
| `ac.fleet.capabilities.offer.<request_id>` | agent → orchestrator | `{agent_id, score, eta}` | in-memory | n/a | queue group `cap-aggregator` |
| `ac.task.assign.<sprint>` | orchestrator → assigned agents | task envelope (incl. resolved agent_id) | JetStream `AC_TASKS`, 30d | 1 / 3 | queue group per sprint (one delivery) |
| `ac.task.complete.<task>` | agent → all | completion summary + diff URI | JetStream `AC_TASKS`, 30d | 1 / 3 | broadcast |
| `ac.review.request.<agent>` | agent → reviewer | review_request body | JetStream `AC_REVIEW`, 14d | 1 / 3 | queue group `<agent>-review` |
| `ac.review.vote.<task>` | reviewer → orchestrator | consensus_vote body | JetStream `AC_REVIEW`, 14d | 1 / 3 | queue group `consensus-tally` |
| `ac.thought.record` | any agent → KG daemon | Thought (KG schema) | JetStream `AC_THOUGHT`, 90d | 1 / 3 | queue group `kg-writer` |
| `ac.subcontract.<request_id>` | parent → child + acks back | subcontract_request / accept / deliver / ack | JetStream `AC_SUBCONTRACT`, 30d | 1 / 3 | queue group per request_id |
| `ac.system.escalation` | any agent → orchestrator + humans | escalation envelope | JetStream `AC_SYS`, ∞ (compact) | 1 / 3 | broadcast |
| `ac.security.revocations` | orchestrator → all | revoked Biscuit IDs | JetStream `AC_SEC`, 24h | 1 / 3 | broadcast (every node syncs) |

> **JetStream replica defaults [verified 2026-05-10 against
> [nats-concepts/jetstream/streams.md](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/jetstream/streams.md)]:**
> the canonical Stream `Replicas` field accepts **1–5** with the docs
> noting *"How many replicas to keep for each message in a clustered
> JetStream, maximum 5."* The **default** when unspecified is **1** (no
> replication; effective on a single-node embedded server). AutoClaw's
> "1 (laptop) / 3 (LAN)" column reflects an AutoClaw policy: laptop-mode
> embedded `nats-server` runs single-replica, LAN-mode bumps to 3 when ≥
> 3 peers are reachable. Default storage type is `File` (per docs §
> StorageType), default retention is `LimitsPolicy`, default discard is
> `DiscardOld`. AutoClaw streams use defaults except where the table
> above declares a `MaxAge` (the `7d` / `30d` / `14d` / `90d` / `24h`
> values are configured `MaxAge` settings).

Wildcards a typical agent subscribes to:

```
ac.fleet.announce               # discover peers
ac.fleet.heartbeat.>            # observe liveness
ac.task.assign.<my-sprint>      # only my sprint's assignments
ac.review.request.<my-agent-id> # only my reviews
ac.subcontract.>                # all subcontract envelopes (filter by request_id)
ac.security.revocations         # always
```

Subject token grammar follows
[NATS subject rules][nats-subj]; periods are reserved as separators.
[verified 2026-05-10 against
[nats-concepts/subjects.md](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/subjects.md)]:
the canonical rule is *"Allowed characters: any Unicode character except
`null`, space, `.`, `*` and `>`"* with **recommended** characters
`[a-zA-Z0-9_-]` (case-sensitive). The wildcards `*` (single token) and
`>` (terminal multi-token) are reserved.

> **Discrepancy fix (2026-05-10):** Earlier drafts said "we use ≤ 32 chars
> per token defensively" with a `[needs verification]` flag. The canonical
> NATS docs **do not specify any per-token character limit**; the
> documented recommendation is *"a maximum of 16 tokens in your subjects
> and the subject length to less than 256 characters"* (overall, not
> per-token). AutoClaw's defensive 32-char-per-token cap is therefore an
> **internal best-effort policy**, not a NATS constraint. Phase 2
> implementations MAY choose to enforce a per-token limit (e.g. 32 or
> 64 chars) for ACL pattern simplicity, but MUST NOT advertise it as a
> NATS-level requirement. The hard ceiling AutoClaw must respect is the
> documented overall recommendation: ≤ 16 tokens, ≤ 256 chars total.

[nats-subj]: https://github.com/nats-io/nats.docs/blob/master/nats-concepts/subjects.md

## 3. Payload shape examples

### 3.1 `ac.fleet.heartbeat.<agent>` (in-memory, ephemeral)

```json
{
  "agent_id": "claude-code-laptop1-window3",
  "ts": "2026-05-09T18:00:00Z",
  "session_id": "sess_2026-05-09T18:00:00",
  "queue_depth": 1,
  "tokens_remaining": 720000,
  "current_llm": "claude-opus-4-7",
  "last_error": null
}
```

### 3.2 `ac.task.assign.<sprint>` (durable)

```json
{
  "msg_id": "msg_2026-05-09T18:00:00.123Z_ab12",
  "sprint": "sprint-3",
  "task_id": "task-42",
  "assigned_to": "claude-code-laptop1-window3",
  "scope_globs": ["src/comms.ts", "tests/comms.test.ts"],
  "biscuit_token": "<base64>",
  "fs_mailbox_path": ".autoclaw/orchestrator/comms/inboxes/<agent>/msg_..."
}
```

### 3.3 `ac.thought.record` (durable, KG-bound)

```json
{
  "thought_id": "th_2026-05-09T18:00:00_kc",
  "agent_id": "claude-code-laptop1-window3",
  "project": "autoclaw",
  "sprint": "sprint-3",
  "kind": "finding",
  "text": "...",
  "embedding_ref": null
}
```

## 4. FS mailbox vs NATS — the single rule

> **FS is the durable record; NATS is the fast path.**
>
> Both writes happen for **durable** message types (task_assign,
> task_complete, review_request, review_vote, subcontract_*, escalation,
> thought_record). The FS write is performed **first**, then the NATS
> publish; if NATS is down the message still lands in the inbox.
>
> NATS-only (no FS write) for **ephemeral** types: heartbeat,
> capability_query, capability_offer.

Implementation contract for `sendMessage()`:

```ts
async function sendMessage(env: MessageEnvelope) {
  if (DURABLE_TYPES.has(env.type)) {
    await fsMailbox.write(env);  // canonical
  }
  if (busDriver === "nats" && nats?.connected) {
    await nats.publish(subjectFor(env), encode(env));
  }
}
```

This guarantees the audit log is identical regardless of which transport
delivers first. The subscriber dedupes by `msg_id` to absorb the inevitable
double-delivery.

## 5. Account / permission ACLs

NATS account model: one `AC_FABRIC` account per workspace, three users.

```yaml
# nats-server.conf (excerpt — MIT-compatible example, hand-written)
accounts:
  AC_FABRIC:
    users:
      - user: orchestrator
        password: $ORCH_NKEY
        permissions:
          publish:   { allow: ["ac.>"] }
          subscribe: { allow: ["ac.>"] }
      - user: agent
        password: $AGENT_NKEY
        permissions:
          publish:
            allow:
              - "ac.fleet.announce"
              - "ac.fleet.heartbeat.{{user}}"
              - "ac.fleet.capabilities.offer.>"
              - "ac.task.complete.>"
              - "ac.review.request.>"
              - "ac.review.vote.>"
              - "ac.thought.record"
              - "ac.subcontract.>"
              - "ac.system.escalation"
          subscribe:
            allow:
              - "ac.fleet.>"
              - "ac.task.assign.>"
              - "ac.review.request.{{user}}"
              - "ac.subcontract.>"
              - "ac.security.revocations"
      - user: observer
        password: $OBS_NKEY
        permissions:
          publish:   { deny: [">"] }
          subscribe: { allow: ["ac.>"] }
```

Notes:

- The `{{user}}` substitution above is a notation convenience for this
  spec — it is **NOT** a literal NATS server-config feature. **[still
  needs verification with implementation prototype]**: NATS supports
  per-user dynamic permissions only via (a) account templates with
  decentralized JWT-based auth (`nsc`/`nats-jwt` flow) or (b)
  `auth_callout` (NATS 2.10+) which delegates auth to an external
  service. The static `nats-server.conf` user list above does **not**
  expand `{{user}}`. The Phase 2 implementation must either generate one
  user record per registered agent at registration (preferred for
  zero-config) or adopt JWT-based auth. Action: prototype both during
  Phase 2 and pick the lower-friction path.
- The `observer` role powers the AutoClaw panel: it watches everything,
  publishes nothing.
- `agent` cannot publish task assignments or revocations (orchestrator-only
  privileges). This is the bus-level enforcement of the trust model defined
  in [biscuit-token-attenuation.md §5](./biscuit-token-attenuation.md).

## 6. Bus-driver migration plan

`autoclaw.fabric.busDriver` setting transitions:

```
"fs"  →  "ws"  →  "nats"
```

### 6.1 `fs` → `ws`

1. Bridge already runs (Phase 0). Enable `/api/v1/messages/stream` SSE +
   WS endpoints.
2. For each agent, the adapter detects WS support; if present, it opens a
   socket and tags `transport=["ws","fs"]` on its Agent Card. If absent it
   stays `["fs"]`.
3. Senders dual-write (FS first, then WS broadcast). Receivers dedupe by
   `msg_id`. No in-flight message is lost because FS is still authoritative.
4. Settings flag flips after one full sprint with zero WS-only message loss.

### 6.2 `ws` → `nats`

1. Extension launches the embedded `nats-server` child process via Command
   Palette → `AutoClaw: Start LAN Fabric`. The bridge becomes a thin proxy
   between WS clients and NATS subjects (per
   [prior-art §3 recommendation](../research/distributed-orchestration-prior-art.md)).
2. Agents that support NATS directly switch to `transport=["nats","ws","fs"]`
   and publish/subscribe natively. WS-only agents keep working — the bridge
   bridges.
3. Cutover never breaks in-flight messages because:
   - The FS write happens before any bus publish.
   - The WS proxy keeps running until every agent's card declares `nats`.
   - JetStream replays missed messages on reconnect via `Last-Event-ID`-style
     consumer cursors.

### 6.3 Rollback

Setting flips back at any time; FS mailbox is canonical so no data is lost.
Heartbeats are ephemeral so a missed window only briefly marks an agent
`stalled`.

## 7. Failure-mode appendix — "NATS goes away mid-sprint"

Spec answer (one paragraph, normative):

> When the embedded `nats-server` child process exits or the LAN partitions
> mid-sprint, every agent's NATS client emits a `disconnect` event. The
> AutoClaw extension flips its internal status to **degraded** and the
> panel renders a banner: *"LAN fabric unavailable — falling back to
> filesystem polling. Latency increases to ~30 s."* Agents resume FS-poll
> at the previous interval. No message is lost: the dual-write rule (§4)
> guarantees every durable message was already on disk before the bus
> attempt. When NATS recovers, JetStream's per-consumer cursor replays
> any messages the subscriber hasn't acked, and the panel banner clears.
> The orchestrator does not pause or retry sprint assignment — assignments
> are durable on FS and idempotent on `msg_id`.

Concrete agent-side state machine:

```
healthy ──disconnect──▶ degraded ──reconnect──▶ catching-up ──cursor-drained──▶ healthy
```

The `degraded → catching-up` transition replays any JetStream messages
since the last acked sequence, not from FS — FS-poll already covered the
gap and dedup absorbs the doubles.

## 8. Cross-references

- Master synthesis: [../DISTRIBUTED_AGENT_FABRIC.md](../DISTRIBUTED_AGENT_FABRIC.md).
- Agent card fields used in `ac.fleet.announce`:
  [agent-card-schema.md](./agent-card-schema.md).
- Capability tokens published via `ac.security.revocations`:
  [biscuit-token-attenuation.md](./biscuit-token-attenuation.md).
- Cross-repo fan-in (subjects shared across linked workspaces):
  [program-plane-registry.md](./program-plane-registry.md).
- COORDINATION_IMPROVEMENTS items realized here:
  [coordination-improvements-mapping.md](./coordination-improvements-mapping.md).
- Research basis: [../research/distributed-orchestration-prior-art.md §2.1](../research/distributed-orchestration-prior-art.md).

## Sources

Verified 2026-05-10 against the following canonical sources (fetched via
`gh api` against `repos/nats-io/nats.docs`):

- [nats-concepts/subjects.md](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/subjects.md)
  — allowed characters, recommended characters, wildcard rules (`*`, `>`),
  reserved `$SYS`/`$JS`/`$KV` namespaces, "max 16 tokens / < 256 chars"
  guidance.
- [nats-concepts/jetstream/streams.md](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/jetstream/streams.md)
  — Stream configuration table (replicas max 5, `LimitsPolicy` default
  retention, `DiscardOld` default discard, `File` default storage,
  `MaxAge`/`MaxBytes`/`MaxMsgs` semantics).
- The exact "default replicas = 1" was inferred from the NATS docs
  describing replicas as opt-in for clustered mode; single-server JetStream
  is the implicit default. A maintainer should double-check against the
  Go server's stream-config defaults if a precise replicas-default value
  is load-bearing for testing.
