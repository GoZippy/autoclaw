# Building AutoClaw Editions

## TL;DR
The normal build is the **community/marketplace** build — exactly today's pipeline:

```bash
npm run compile          # tsc → out/
npm run package          # vsce package --no-dependencies → autoclaw-<version>.vsix
```

`src/edition.ts` reads `AUTOCLAW_EDITION` at module load and **defaults to
`community`** when unset, so the standard build needs no extra flags.

## Selecting an edition
`AUTOCLAW_EDITION` is read from the environment when the extension code loads. To
produce a non-default edition, set it before `compile`:

- **bash / Git Bash:** `AUTOCLAW_EDITION=enterprise npm run compile`
- **PowerShell:** `$env:AUTOCLAW_EDITION='enterprise'; npm run compile`
- **CI:** set it as a job env var.

> A `cross-env`-based `build:community` / `build:marketplace` / `build:enterprise`
> script set is intentionally **not** added yet (it would require a new dev
> dependency). Add `cross-env` and the scripts when an enterprise build pipeline
> actually exists; for now the env-prefix above is sufficient and the default
> (`community`) covers the published VSIX.

For a hermetic enterprise build that cannot rely on runtime env, generate
`src/generated/edition.ts` at build time and import from it instead.

## Premium engine: public stub vs licensed build (IMPLEMENTED)

The premium engines live in the **private** repo `GoZippy/autoclaw-premium`
(package `@autoclaw/premium`). The public repo contains only the `PremiumApi`
interface (`src/premium/premiumApi.ts`) + a free fallback
(`src/premium/unavailablePremium.ts`).

**The seam** (`src/premium/index.ts`) loads the private package **optionally** at
runtime via an indirect `require('@autoclaw/premium')` guarded by try/catch:
- **Public/community build** (package absent) → falls back to the free impl. The
  app builds + runs; nothing private is in this repo. `tsc` does not try to
  resolve the optional module (the require arg is a variable).
- **Licensed build** (package present) → the real engines run, gated at runtime
  by license/trial.

**Baking premium into the licensed `.vsix`** (maintainer build):
1. `npm install` the private package (from the private repo / private registry),
   or `npm install ../autoclaw-premium` for a local checkout.
2. Build it (`npm run build` in autoclaw-premium → `dist/`).
3. Vendor its **compiled** output into the extension's
   `out/node_modules/@autoclaw/premium/` — the same lean-packaging path used for
   `ws`/`chokidar` (extend `scripts/copy-runtime-deps.js` to copy it when present).
   It ships **compiled, not as source**.
4. `npm run package` → the `.vsix` now resolves `require('@autoclaw/premium')`.

The **public marketplace** build skips steps 1–3, so it ships the free fallback
only. Premium source never enters the public repo or the public `.vsix`.

> Honesty note: a `.vsix` is a zip — a determined user can read bundled JS. This
> protects the **source** (private repo) and gates **execution** (license/trial);
> per License Rule 5 these are UX/compliance gates, not perfect DRM. We do not
> ship invasive anti-tamper.

## What must NEVER be in the VSIX
- license **private** signing keys
- payment-processor / webhook secrets
- cloud service credentials, admin tokens, any private server secret

The VSIX may contain only the **public** verification key. `.vscodeignore`
already excludes `.env`, `src/**`, and the heavy native peers; verify any new
secret-bearing path is excluded before packaging.
