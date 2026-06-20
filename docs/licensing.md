# AutoClaw Licensing & Trial

AutoClaw is **local-first and non-abusive**. Your code, your data, and the core
workflows stay usable; paid tiers add advanced/commercial capabilities and
graceful upgrades — never hostile DRM, never hidden telemetry, never a lockout of
your own data.

## Modes

### Free Community mode
Available for **personal, educational, open-source, and evaluation use**. Always
usable, no account, no key. Includes basic KDream memory, Doctor/health checks,
adapter install/generation, TODO/FIXME tracking, manual skill launch, limited
local run history, and basic markdown summaries. You can always **view and export
your own local data**, even after a trial ends.

### 7-day Pro trial
- Full Pro feature unlock for **7 days**.
- Starts on **first meaningful use** — not on install.
- **No account, no credit card.**
- Stored locally (`globalState`); it does **not** restart on reinstall.
- After it ends, you fall back to Free Community mode (your data stays).

Check it any time: **AutoClaw: Trial Status**. Start it manually: **AutoClaw:
Start Pro Trial**. The status bar shows `AutoClaw Trial Nd` while active.

### Paid tiers — Solo / Pro / Teams / Enterprise
Commercial use requires a paid license. Enter one with **AutoClaw: Enter License
Key** (the `AUTOCLAW-…` key from your purchase). Licenses verify **offline**
against an embedded public key — no license server, no phone-home.

- **One-time major-version licenses** (Solo/Pro): buy a major version once, use it
  forever; **12 months of updates** included. After the update window, you keep
  using the last eligible version — the license does not stop working.
- **Teams/Enterprise**: may be subscription or annual seat licenses; unlock team
  shared memory, policy engine, audit logs, cloud relay, private skill registry,
  and (later) SSO / self-hosted control plane.

## Hosted features & BYO key
A small set of features cost **us** money to run (hosted model oracle,
cross-machine routing, cloud sync). Those are gated by `requireHosted`, satisfied
two ways: **a paid license**, or **bring your own API key** (BYO — you pay your
provider directly). The trial does **not** unlock hosted features (so a free trial
never runs up our bill). Set a key with **AutoClaw: Set My Own API Key (BYO)**.

## What's gated vs. free
- **Free, always:** core KDream, Doctor, adapter install, launch skill, basic
  reports, limited history, basic intelligence, viewing/exporting your data.
- **Pro (or trial):** scheduled AutoBuild, advanced Orchestrate, MAteam, PR
  evidence reports, agent scorecards, full history, GitHub/Kiro import.
- **Teams/Enterprise:** shared memory, policy engine, audit logs, cloud relay,
  private skill registry; SSO / self-hosted control plane / air-gapped mode.

Gated local features **fall back gracefully** (e.g. PR Evidence → a basic free
summary) and show at most one polite upgrade prompt — never a startup nag.

## Privacy
- No source-code upload, no hidden telemetry.
- The VSIX contains only the **public** verification key — never any secret.
- Any local counters are stored locally and disclosed.

> "Source-available / free for personal, educational, and evaluation use" — see
> [LICENSE](../LICENSE) (authoritative) and [COMMERCIAL_TERMS.md](../COMMERCIAL_TERMS.md)
> (plain-language summary).
