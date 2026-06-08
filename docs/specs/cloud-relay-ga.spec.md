---
spec_id: cloud-relay-ga
title: Cloud relay GA — flip the inert preview relay to opt-in GA
status: verify  # draft | review | pilot | implement | verify | done
owner: claude-code
created: 2026-06-04
updated: 2026-06-05
supersedes: []
superseded_by: null
references:
  - ../V3_1_ROADMAP.md
  - ../../src/cloud/relay.ts
  - ../../src/cloud/auth.ts
  - ../../.autoclaw/orchestrator/manifests/integrate-automate-v3.2.yaml
acceptance:
  - given: a workspace with no relay-config.json (or endpoint empty / enabled false / no token)
    when: any relay send fires
    then: it is a no-op returning { ok: true, skipped: 'relay_disabled' } — nothing leaves the machine
  - given: every must-fix in reviews/cloud-relay-security-audit.md is resolved or accepted-risk-documented
    when: a user sets endpoint + enabled:true + stores a cloud token
    then: heartbeats/inbox forward to the relay under the documented GA schema, token only in the Authorization header
  - given: an unresolved unanimous-vote security finding in the audit
    when: the GA flip is attempted
    then: it does NOT merge — the security gate (ia-3 unanimous) blocks it
non_goals:
  - Building the relay server / web dashboard (ZippyTech-hosted; out of this repo)
  - Changing the cross-machine fleet VIEW (that is CF-1/CF-2, already merged-pending)
  - Multi-tenant auth or org-level RBAC (future; relay GA is single-installation opt-in)
---

# Cloud relay GA — flip the inert preview relay to opt-in GA

## Summary
The cloud relay forwards a subset of the local file bus (heartbeats + inbox
messages) to a hosted endpoint so a web dashboard can show a cross-machine
fleet. It shipped in v3.0 **inert** (Sprint-4 D-series, no endpoint wired).
v3.2 Lane D promotes it to **GA**: a documented config schema, explicit
opt-in, mandatory token, and a clear consent surface — **without weakening a
single one of the inert-by-default safety invariants.** This spec is prepped
ahead of the gate so the flip (CF-3) is fast and audit-driven once
`reviews/cloud-relay-security-audit.md` (kilocode PA-2) lands.

> **BLOCKED.** CF-3/CF-4 do not start until the PA-2 audit exists. This spec
> is `draft` and stays there until the audit's findings are folded into the
> "Audit gate checklist" below.

## Read first
- [src/cloud/relay.ts](../../src/cloud/relay.ts) — `RelayConfig`,
  `relayIsActive()`, `encryptPayload()`, the send paths, the offline queue.
- [src/cloud/auth.ts](../../src/cloud/auth.ts) — `getCloudToken()`,
  `SecretStore`, `redactToken()`.
- reviews/cloud-relay-security-audit.md — **does not exist yet**; the gate.

## Design

### Inputs
- `.autoclaw/cloud/relay-config.json` (the `RelayConfig` document).
- A cloud token in the OS secret store (via `SecretStore`).
- The local file bus (heartbeats, inbox) that the relay batches.

### Outputs
- GA-shaped `RelayConfig` (see contract) + a documented schema doc.
- An explicit, logged consent record the first time GA is enabled.
- Forwarded (encrypted) inbox + (batched) heartbeat payloads — only when active.

### Algorithm / contract
The inert posture is governed today by `relayIsActive()`:
```ts
export function relayIsActive(cfg: RelayConfig): boolean {
  return cfg.enabled === true
    && typeof cfg.endpoint === 'string'
    && cfg.endpoint.trim().length > 0;
}
```
GA keeps this exact gate and **adds** a token precondition at every send site
(no token ⇒ inert) and a one-time consent acknowledgement. Proposed schema
delta (additive, back-compatible — every new field defaults to the safe value):
```ts
export interface RelayConfig {
  endpoint: string;            // unchanged — '' ⇒ off
  enabled: boolean;            // unchanged — false ⇒ off
  heartbeatIntervalMs: number; // unchanged (default 60s)
  requestTimeoutMs: number;    // unchanged (default 15s)
  // ── GA additions (all default to the inert/safe value) ──
  tier?: 'preview' | 'ga';     // default 'preview'; 'ga' is a label only, NOT a gate relaxation
  consentAckAt?: string | null;// ISO ts of explicit user opt-in; null ⇒ never consented ⇒ inert
  forward?: { heartbeats: boolean; inbox: boolean }; // default both false ⇒ nothing forwarded
}
```
Invariants that MUST hold post-GA (carried verbatim from relay.ts header):
1. No endpoint ⇒ every send is a no-op `{ ok: true, skipped: 'relay_disabled' }`.
2. `enabled:false` ⇒ inert even with an endpoint set.
3. No stored token ⇒ inert.
4. **No `consentAckAt` ⇒ inert** (new — explicit opt-in required for GA).
5. Token rides ONLY in the `Authorization` header — never in the offline
   queue, a log line, or a request body. (`redactToken()` everywhere it's shown.)
6. `POST /v1/inbox` payloads are AES-256-GCM encrypted before the network call.
7. Heartbeat batches are gzip-compressed; cadence 60s.
8. Failed sends append to a **bounded** on-disk queue and retry on next flush.

## Acceptance criteria
See frontmatter `acceptance:`. Expanded:
- **Inert-by-default regression**: a fresh workspace, or any of {endpoint empty,
  enabled false, no token, no consent}, forwards nothing. This is the single
  most important test and must be exhaustive over the 4 gates.
- **Token hygiene**: grep the offline queue files + all log output after a
  forced-failure send — the token string must never appear.
- **Audit gate**: CF-4 walks every finding in the audit; each is fixed or has a
  documented accepted-risk line. An unresolved unanimous-vote finding blocks merge.

## Sequencing
| Step | Deliverable | Owner | Exit gate |
|---|---|---|---|
| PA-2 | reviews/cloud-relay-security-audit.md | kilocode | audit exists, findings enumerated |
| CF-3 | RelayConfig GA schema + consent + token-precondition send gate | claude-code | invariants 1-8 hold; audit must-fixes addressed |
| CF-4 | Walk + resolve every audit finding | claude-code | no open unanimous-vote finding |
| CF-5 | Relay-posture + cross-machine tests | claude-code | inert-by-default exhaustive; token never leaks; suite green |
| ia-3 gate | Unanimous security sign-off | claude-code + kilocode | both approve |

## Non-goals
See frontmatter. The relay server + dashboard live in ZippyTech infra, not here.

## Open questions
1. Consent surface: a VS Code modal on first enable, or config-file-only? Recommend
   a modal that writes `consentAckAt` so opt-in is a deliberate, auditable action.
2. Does GA need a "forward heartbeats only, not inbox" minimal mode for the
   privacy-cautious? The `forward` sub-object above allows it; confirm default.
3. Key management for the AES-256-GCM payload key — where does it come from at
   GA (per-installation vs per-user)? Defer to the audit's recommendation.

## Don't-do
- Do NOT relax `relayIsActive()` or treat `tier: 'ga'` as permission to forward —
  it's a display label only; the gates are endpoint+enabled+token+consent.
- Do NOT log, queue, or body-embed the token, ever (the #1 relay anti-pattern).
- Do NOT forward anything before the PA-2 audit clears — premature GA is the
  exact risk the ia-3 unanimous gate exists to prevent.

---

> **Lifecycle.** `draft` until the PA-2 audit lands and its findings are folded
> into the Audit gate checklist; then `review` (architect/security-auditor sign
> off), `pilot` (one forced-failure send proves token hygiene), `implement`
> (CF-3 schema + gate), `verify` (CF-5 tests), `done` (ia-3 unanimous sign-off).
