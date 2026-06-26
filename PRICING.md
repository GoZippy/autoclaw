# AutoClaw Pricing

AutoClaw is **source-available** under the
[Zippy Technologies Source-Available Commercial License](LICENSE).

## Free — Personal & Educational use

Use the entire Product **for free** for personal, hobbyist, evaluation, and
educational purposes (License §4). No feature gating, no trial clock. Everything
that runs locally on your machine stays free.

## Paid — Commercial use

Any use that isn't personal or educational (use at a company, by a contractor
for a paying client, in production, or as part of a billable workflow) requires a
paid commercial license (License §5). Tiers (Schedule A):

| Tier | Seats | Price | Model |
|------|-------|-------|-------|
| **Pro** | 1 seat | **$99 one-time** *(early-bird $79)* | **Buy once, own it.** Perpetual license for this major version + **12 months of updates**. Keep using it forever. |
| **Teams** | per seat (min 3) | **$20 / seat / month** or **$200 / seat / year** | Annual subscription. Everything in Pro **plus hosted team coordination** (cloud relay, shared memory, policy + audit). |
| **Enterprise** | unlimited | **Custom — contact us** | SSO, self-hosted control plane, air-gapped mode, audit logs, priority support. |

A *seat* is one developer using AutoClaw for commercial work. Solo evaluation to
decide whether to buy is not a seat.

**No subscription for Pro — on purpose.** You buy the current major version once
and use it forever; the purchase includes a year of updates. When a new major
version ships, you can upgrade at a reduced price — but you're never forced to.
Hosted services (the features that run on *our* servers) are available to Pro via
your own (BYO) API key, or bundled into the Teams subscription.

### How to buy

> **TODO (maintainer):** paste your Square **one-time** checkout link here and in
> [`src/support/supportConfig.ts`](src/support/supportConfig.ts) (`proUrl`).

- **Pro (one-time):** `https://square.link/u/REPLACE_ME`  ← TODO
- **Teams / Enterprise:** email **Support@GoZippy.com**

### Why pay for something that's free locally?

The paid tiers fund development. The local individual experience is **always
free** — we charge only for *commercial use* and for the **hosted services that
*we* pay to run** (model oracle, cross-machine routing, fleet sync). Pro is a
one-time purchase because your local tooling shouldn't be a subscription; the
recurring cost lives where the recurring value (and our server bill) is — Teams.

Self-reporting commercial use is honored at the standard rate (License §5.5).
Contact **Support@GoZippy.com** for anything.
