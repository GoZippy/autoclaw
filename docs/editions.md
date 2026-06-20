# AutoClaw Editions

AutoClaw builds from one codebase. The **edition** marker (`src/edition.ts`,
`AUTOCLAW_EDITION`) lets a build flip behavior without forking the public core.

| Edition | What it is |
|---|---|
| **community** | The public, source-available core. Free + 7-day trial + paid-unlock all work. This is the default when `AUTOCLAW_EDITION` is unset. |
| **marketplace** | The published `ZippyTechnologiesLLC.autoclaw` VSIX. Functionally identical to community (one install → free / trial / paid unlock). |
| **enterprise** | A private/customer-specific build that may swap in private premium modules (`@autoclaw/premium`) and enable enterprise features. |

Key points:
- **One install feels like one product.** Users never uninstall/reinstall to
  unlock Pro — they enter a license key in place.
- The **community** and **marketplace** editions ship the same free fallback
  premium implementation (`src/premium/unavailablePremium.ts`), so the public
  build compiles and runs with **no private package**.
- Only an **enterprise** build replaces the premium factory with a real
  implementation behind the same `PremiumApi` interface (`src/premium/premiumApi.ts`).

See [build-editions.md](build-editions.md) for how to build each, and
[licensing.md](licensing.md) for the trial/paid model.
