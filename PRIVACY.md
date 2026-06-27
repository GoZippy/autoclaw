# AutoClaw Privacy Policy

**Effective date:** June 27, 2026
**Publisher / data controller:** Zippy Technologies LLC, 1515 E Lewis, Wichita,
Kansas 67211, United States — Support@GoZippy.com

AutoClaw is a **local-first** VS Code extension. This policy explains what it
processes, what stays on your machine, and the few features that are networked
(all opt-in). Plain language; if anything conflicts with the
[LICENSE](LICENSE), the LICENSE governs licensing terms and this policy governs
data handling.

## The short version

- AutoClaw runs on **your machine** and stores its data **locally** (in your
  workspace under `.autoclaw/` and in VS Code storage).
- It has **no analytics, no telemetry, and no usage tracking** sent to Zippy
  Technologies LLC by default.
- The only times data leaves your machine are features **you turn on** (a cloud
  relay you configure) or **you invoke** (an external LLM provider you choose, or
  clicking a Buy/Support link that opens a payment page).

## What AutoClaw processes locally

To do its job, AutoClaw reads and indexes content **on your machine**:
- Your workspace **source code** (for code search / RAG indexing).
- **Local AI coding-session files** from supported tools, when you enable
  cross-tool ingestion (used to learn patterns and build context).
- Orchestration / coordination state, task ledgers, and review evidence your
  agents produce.

This processing happens **locally**. Indexes, embeddings, learned patterns, and
memory are written to your workspace (`.autoclaw/`) and/or VS Code's local
storage. **Secrets and personal data are redacted before content is indexed or
stored** (see `src/intelligence/redact.ts`).

## Features that use the network — all opt-in

1. **Your chosen LLM providers.** When you run a workflow, AutoClaw sends prompts
   to the model provider **you configure** — a local one (Ollama, LM Studio) that
   stays on your machine/LAN, or a remote API you set up. Your prompts and code
   go to that provider under **their** privacy terms. AutoClaw does not add a
   middleman.
2. **Cloud relay (off by default).** A coordination relay that forwards a subset
   of fleet state (heartbeats; encrypted inbox messages, AES-256-GCM) to an
   endpoint **you configure**. It is **inert unless you enable it and acknowledge
   consent**. No relay endpoint is set by default.
3. **LAN discovery / gossip (off by default).** Peer discovery on your local
   network. **No socket is opened** unless you enable the flag and grant one-time
   consent; discovered peers are untrusted by default.
4. **Purchases & support links.** Clicking "Buy AutoClaw Pro" or a support link
   opens an external page (e.g., **Square** checkout). Payment is processed by
   **Square, Inc.** under Square's privacy policy; Zippy Technologies LLC receives
   order and license-fulfilment details (your email, order id, tier) to issue and
   support your license. We do **not** receive or store your card details.
5. **License keys.** AutoClaw verifies your license key **offline** on your
   machine (Ed25519 signature check). Entering or using a key does **not** phone
   home.

## Third parties that may process data

- **Square, Inc.** — payment processing and order fulfilment for paid licenses.
- **Your configured model provider(s)** — whatever local or remote LLM you select.
- **A relay endpoint you configure** — only if you enable the cloud relay.

We do not sell your data, and we do not share it except as needed to deliver a
feature you invoked (above) or as required by law.

## Retention

Local data stays until you delete it (remove `.autoclaw/` or uninstall). License
and order records needed to support your purchase are retained per our business
and tax obligations. Relay messages, if you enable relay, are transient and
queued only until delivered.

## Your rights

Depending on where you live (e.g., GDPR/EEA, UK, CCPA/California), you may have
rights to access, correct, delete, or port the limited personal data we hold for
your purchase (your email and order/license records). Email **Support@GoZippy.com**
and we will respond within a reasonable period. Most AutoClaw data never reaches
us because it stays on your machine — you control it directly.

## Children

AutoClaw is a developer tool not directed to children under 16, and we do not
knowingly collect data from them.

## Changes

We may update this policy; material changes will be noted in the CHANGELOG and
the effective date above. Continued use after an update means you accept the
revised policy.

## Contact

Zippy Technologies LLC — Support@GoZippy.com — 1515 E Lewis, Wichita, Kansas
67211, United States.
