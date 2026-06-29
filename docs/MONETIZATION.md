# AutoClaw — Monetization Strategy

**Status:** draft for decision · **Owner:** the user (eric@gozippy) · **Date:** 2026-06-09

> **Superseded on pricing (2026-06-26):** the consumer *subscription* proposed
> below was reversed — **Pro is now a one-time perpetual-major license** (buy once,
> 12 months of updates, keep forever); recurring billing lives only in
> Teams/Enterprise. See [PRICING.md](../PRICING.md) + [COMMERCIAL_TERMS.md](../COMMERCIAL_TERMS.md).
> The open-core thesis (paywall the *hosted coordination*) still stands; the
> price/model specifics in this doc are historical.

This is a planning doc, kept local (not a public roadmap). It proposes how
AutoClaw funds its own long-term development + hosting without poisoning the
free, open, local-first experience that drives adoption.

---

## 1. The core decision: open-core, paywall the *hosted coordination*

AutoClaw's cloud relay is, structurally, a **coordination server** — the same
shape as Tailscale's control plane. That gives a clean, honest monetization
line:

> **The open-source client stays free and fully local. We charge for the
> hosted service that costs *us* money to run — the cross-machine relay — and
> for the team/enterprise features that only organizations need.**

Why this line and not another:
- It aligns price with **our actual cost** (hosting the relay, retention,
  bandwidth). Users understand paying for a service we run for them.
- It **protects the viral free tier**. Single-machine orchestration, local
  models, personas, AutoBuild, MCP — the things a solo dev falls in love with —
  stay free. Never paywall the thing people tell their friends about.
- It's **enforceable without crippling the client**. Entitlement is checked
  server-side at the relay (per token / `installation_id`), so the OSS client
  needs no license nag and can't be "cracked" — self-hosters just point at
  their own relay. See [docs/specs/relay-entitlement.spec.md](specs/relay-entitlement.spec.md).

**Precedent:** Tailscale (open client, paid coordination + scale), Continue.dev
(open extension, paid hosted Hub/teams), GitLab (open-core + enterprise).

---

## 2. Tiers

| | **Free / OSS** | **Pro** (~$8–15/mo) | **Team / Enterprise** (per-seat) |
|---|---|---|---|
| Multi-agent orchestration (1 machine) | ✅ | ✅ | ✅ |
| Local-first LLM routing (BYO keys, Ollama/LM Studio) | ✅ | ✅ | ✅ |
| Personas, AutoBuild, MCP tools | ✅ | ✅ | ✅ |
| **Self-hosted** relay | ✅ | ✅ | ✅ |
| **Hosted** relay (we run it) | — | ✅ | ✅ |
| Cross-machine fleet view | — | ✅ (up to N machines) | ✅ (unlimited) |
| Message history / retention | local only | extended | configurable |
| Persona-memory sync across machines | — | ✅ | ✅ |
| SSO / SAML, RBAC, audit logs | — | — | ✅ |
| On-prem / self-host **license** + governance | — | — | ✅ |
| SLA, priority support, onboarding | — | — | ✅ |

**The rule of thumb:** paywall things that (a) cost us to run, or (b) only
matter to teams. Never paywall what makes a solo dev productive on one machine.

---

## 3. Other revenue lines to consider (ranked)

1. **Hosted relay subscription (Pro)** — the anchor. Recurring, aligned to cost.
2. **Enterprise license** — SSO/RBAC/audit/on-prem + support. Where margin lives.
3. **Managed ZippyMesh** (optional hosted LLM routing) — a paid *convenience*;
   keep BYO/local free so the local-first ethos is intact.
4. **Persona / workflow marketplace** — community-contributed personas +
   AutoBuild templates; later a rev-share line and a content flywheel.
5. **Support / onboarding contracts** for teams adopting it at scale.

Avoid early: per-token LLM markup (breaks the BYO/local promise), and gating
core orchestration (kills virality).

---

## 4. Sequencing (don't build the meter before the engine)

The relay is currently **built but dormant** — nothing invokes it. So:

1. **Wire the relay live** (heartbeat/inbox forwarding + flush + consent UX) so
   cross-machine actually works, still free + opt-in. *(In progress — RELAY-WIRE.)*
2. **Validate demand** — do people enable it across machines? Instrument opt-in
   counts (locally/aggregate, privacy-respecting).
3. **Stand up the hosted relay** as a service with server-side entitlement.
4. **Introduce Pro** (billing + machine-count metering) once there's pull.
5. **Enterprise** after the first teams ask for SSO/audit.

Monetize the relay only after it's proven useful — a paywall on a feature no
one uses yet earns nothing and signals the wrong thing.

---

## 5. Risks / honest cautions

- **OSS goodwill:** the moment people feel the *free* thing got worse to sell
  the paid thing, growth stalls. Keep the free tier genuinely excellent and
  never regress it to upsell.
- **A big player ships multi-agent orchestration.** Defend with: editor-agnostic
  + local-first + "works with the agents you already have" (low switching cost),
  and being open.
- **Self-host cannibalization.** Fine — self-hosters were never going to pay for
  hosting; they become contributors and word-of-mouth. Charge teams for the
  parts they actually need (governance/support), not for running a binary.
- **Hosting cost outrunning Pro revenue early.** Keep the hosted relay cheap to
  run (it forwards small encrypted messages, not compute) and cap free hosted
  usage tightly.

---

## 6. Recommendation

Adopt **open-core + hosted-relay subscription + enterprise**, sequenced behind
making the relay actually work first. It funds hosting honestly, protects the
viral free tier, and the existing token/`tier` design means the lift is mostly
*server-side entitlement + billing*, not a client rewrite.

See also: [docs/COMPETITIVE_BRIEF.md](COMPETITIVE_BRIEF.md) (positioning vs other
tools) and [docs/specs/relay-entitlement.spec.md](specs/relay-entitlement.spec.md)
(how the paywall is enforced).
