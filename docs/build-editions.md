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

## Future private premium module
The public build ships the free fallback (`src/premium/unavailablePremium.ts`). A
paid build implements the same `PremiumApi` (`src/premium/premiumApi.ts`) in a
private package and aliases it — e.g. a bundler/tsconfig path:

```jsonc
// tsconfig (enterprise build only)
{ "compilerOptions": { "paths": { "@autoclaw/premium": ["src/premium/unavailablePremium"] } } }
```

…overridden in the private build to point at the real `@autoclaw/premium`.

## What must NEVER be in the VSIX
- license **private** signing keys
- payment-processor / webhook secrets
- cloud service credentials, admin tokens, any private server secret

The VSIX may contain only the **public** verification key. `.vscodeignore`
already excludes `.env`, `src/**`, and the heavy native peers; verify any new
secret-bearing path is excluded before packaging.
