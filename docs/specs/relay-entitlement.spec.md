---
status: draft  # draft | review | pilot | implement | verify | done
owner: claude-code
created: 2026-06-09
updated: 2026-06-09
---

# Relay Entitlement — server-side paywall for the hosted relay

**Read first:** [docs/MONETIZATION.md](../MONETIZATION.md) (the business model),
[reviews/cloud-relay-security-audit.md](../../reviews/cloud-relay-security-audit.md)
(the relay's security posture), and `src/cloud/relay.ts` / `src/cloud/auth.ts`
(the existing client).

## Goal
Let the **hosted** relay be a paid feature **without paywalling the
open-source client**. Entitlement is enforced **server-side**, at the relay, on
every request — keyed by the bearer token and `installation_id` the client
already sends. A self-hoster who points at their own relay is unaffected and
unmetered.

## Non-goals
- No client-side license check, no nag, no "phone-home" in the OSS client.
- No change to the inert-by-default or token-hygiene guarantees (the audit's
  invariants hold unchanged).
- Not billing itself — this spec is the *entitlement gate*; billing (Stripe et al.)
  is a separate integration that writes the subscription record this gate reads.

## Where the gate lives
The client → relay contract is unchanged: `Authorization: Bearer <token>` +
`installation_id` in the body. The **relay server** gains an entitlement check
*before* it accepts a heartbeat/inbox/flush request.

```
client (open, unchanged) ──POST /v1/{heartbeat,inbox}──▶ hosted relay
                                                          │
                                                   1. authenticate token
                                                   2. resolve subscription
                                                   3. enforce tier + limits   ◀── this spec
                                                   4. accept / 402 / 429
```

## Tier model (server-side)
A subscription record, keyed by the account that owns the token:

```
{ account_id, tier: 'free' | 'pro' | 'enterprise',
  max_machines: number,            // distinct installation_ids allowed
  retention_days: number,
  status: 'active' | 'past_due' | 'canceled',
  valid_until: ISO }
```

- `free` — hosted relay allowed for a tight cap (e.g. 1 machine, short
  retention) so people can *try* cross-machine, or 0 machines (hosted is
  Pro-only) — a pricing decision, not a technical one.
- `pro` — `max_machines` = N, extended retention.
- `enterprise` — high/unlimited caps; may run a self-hosted relay under license.

## Enforcement rules (Given/When/Then)
1. **Given** a request with a valid token whose subscription is `active` and
   within `max_machines`, **when** it arrives, **then** the relay accepts it.
2. **Given** a token with no/canceled subscription (or `status: past_due` past a
   grace window), **when** a request arrives, **then** the relay responds
   `402 Payment Required` with a machine-readable `{ reason: 'no_subscription' }`.
3. **Given** a subscription at its `max_machines` and a request from a *new*
   `installation_id`, **when** it arrives, **then** the relay responds `402`
   with `{ reason: 'machine_limit', max_machines }` (existing machines keep working).
4. **Given** any over-limit rate/volume, **when** exceeded, **then** `429` with
   `Retry-After` (already the client's queue-and-retry path — no client change).
5. **Given** a `402`/`429`, **when** the client receives it, **then** it treats
   the channel as **inert** (queues, surfaces a non-blocking notice) — it never
   crashes or blocks the editor.

## Client touchpoints (small, additive)
The OSS client needs only graceful handling of the new statuses — no license logic:
- `RelaySendResult` gains `skipped: 'not_entitled'` (mapped from `402`) and the
  existing queue path handles `429`.
- A non-blocking notice: "Cross-machine relay needs an active plan — [Manage]"
  with a link to the account page. Shown at most once per session.
- `relayIsActive` is unchanged; entitlement is **not** a client gate (a self-host
  relay returns 200 and everything works).

## Account ↔ machine binding
- `installation_id` is the unit of "machine" (already minted per install).
- The relay records the set of `installation_id`s seen per account; the
  (N+1)th new one is refused with `machine_limit` until the user removes one or
  upgrades. A management UI (web) lists + revokes machines.

## Security notes (carry the audit forward)
- Entitlement is **server-side only** — the client cannot grant itself access,
  and reading the OSS source reveals no secret (the gate isn't in it).
- HTTPS enforcement (F1) and expired-token rejection (F2) remain preconditions:
  the entitlement check runs *after* auth, *after* TLS.
- The `402`/`429` responses carry **no** payload data back — just the reason.

## Acceptance criteria
- [ ] Relay rejects unentitled tokens with `402` + reason; entitled tokens pass.
- [ ] Machine-count enforced per account; existing machines unaffected when a new
      one is refused.
- [ ] OSS client handles `402`/`429` gracefully (inert + one notice), with no
      license logic added to the client.
- [ ] Self-hosted relay (no entitlement service) accepts everything — unmetered.
- [ ] No regression to inert-by-default, HTTPS-enforce, or expired-token rejection.

## Sequencing
This spec is **blocked on RELAY-WIRE** — wire the relay into the live loops and
prove cross-machine demand first; stand up entitlement + billing only once the
hosted relay is real and used. (See [docs/MONETIZATION.md](../MONETIZATION.md) §4.)
