# AutoClaw 3.6.5 Release Checklist

Target: publish `ZippyTechnologiesLLC.autoclaw` version `3.6.5` to the VS Code Marketplace and Open VSX.

Status on 2026-06-26:

- `package.json` is already `3.6.5`.
- `CHANGELOG.md` already has a `3.6.5` entry.
- VS Code Marketplace and Open VSX are still serving `3.6.4`.
- Release is manual. Do not rely on tag CI to publish unless `CI_PUBLISH=true` is intentionally set.

Validation snapshot from 2026-06-26 release prep:

- `npm run secrets:check` passed.
- `npm run compile` passed.
- `npm run adapters:check` passed.
- `npm run sample:doctor` passed with expected local warnings only.
- `npm run test:unit` passed: 2513 passing, 2 pending.
- VS Code extension-host integration passed via an isolated VS Code 1.118.1 cache: 2688 passing, 3 pending.
- `npm run package` produced `autoclaw-3.6.5.vsix` at 1.6 MB.
- Targeted VSIX scan found no local steering, private assessment, private package source, or token markers.
- `node scripts/publish-vsce.js --dry-run` resolved `autoclaw-3.6.5.vsix` and found `VSCE_PAT`.
- `node scripts/publish-ovsx.js --dry-run` resolved `autoclaw-3.6.5.vsix` and found `OVSX_TOKEN`.

Remaining before irreversible publish:

- Publish to both registries.
- Verify both registries show `3.6.5`.
- Tag the selected release commit as `v3.6.5`.
- Smoke test install/upgrade from both registries.

## Release Goals

- Ship the 3.6.5 coordination and fleet command-center work.
- Keep the community/marketplace build fully usable without private packages.
- Keep private steering, local agent state, strategy notes, and scratch research out of the VSIX.
- Publish the exact package that was inspected locally.

## Must Be Clean Before Publishing

- No tracked private steering files.
- No `autoclaw-ecosystem-steering.md` under `docs/`, `src/`, `skills/`, or `adapters/`.
- No private package source or private signing/payment/provider secrets.
- No stale package artifact selected by mistake. Publish scripts should use `autoclaw-3.6.5.vsix`.
- No unreviewed public docs that describe internal monetization or proprietary strategy beyond the already-approved public edition docs.

## Preflight

Run from repo root:

```powershell
git status --short --untracked-files=all
npm run secrets:check
npm run compile
npm run test:unit
node .autoclaw\release\run-vscode-integration.mjs
npm run adapters:check
npm run sample:doctor
```

Note: the default `npm test` cache on this workstation may fail before tests
with a Windows `EBUSY` lock on `.vscode-test/.../node_modules.asar`. The
local-only runner above uses the same compiled tests through an isolated
VS Code cache under `.autoclaw/release/`.

If a generated or runtime path appears in `git status`, either remove it from the release worktree or add the correct ignore rule before packaging.

## Package And Inspect

```powershell
Remove-Item .\autoclaw-3.6.5.vsix -ErrorAction SilentlyContinue
npm run package
node scripts/publish-vsce.js --dry-run
node scripts/publish-ovsx.js --dry-run
```

Inspect the VSIX before publishing:

```powershell
$tmp = Join-Path $env:TEMP 'autoclaw-vsix-3.6.5'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive .\autoclaw-3.6.5.vsix -DestinationPath $tmp
Get-ChildItem $tmp -Recurse | Select-String -Pattern 'autoclaw-ecosystem-steering|premium-impl|autoclaw-premium|PRIVATE KEY|VSCE_PAT|OVSX_TOKEN'
```

Expected result: no matches except harmless public docs that intentionally mention `@autoclaw/premium` as an optional private package seam.

## Publish

After the package is inspected and both dry-runs look correct:

```powershell
$env:NODE_OPTIONS='--use-system-ca'
npm run publish:vscode
npm run publish:ovsx
```

Then verify both registries show `3.6.5`.

## Git Release

Once the release commit is on `master` and the published package is verified:

```powershell
git tag v3.6.5
git push origin v3.6.5
```

If the tag already exists from the selected release commit, do not retag. Verify the tag commit matches the published package source.

## Post-Publish

- Add a done-log entry in `docs/BACKLOG.md`.
- Confirm marketplace install/upgrade from both registries.
- Smoke test activation, `AutoClaw: Doctor`, fleet panel, join prompt, and `fleet.brief`.
- Keep `autoclaw.licensing.enforceGates` off unless a real purchase path is live.
