#!/usr/bin/env node
/**
 * Cross-platform VS Code Marketplace publisher.
 *
 * Reads VSCE_PAT from .env, falls back to process.env.VSCE_PAT, and finally
 * to `vsce`'s own credential store (created via `vsce login <publisher>`).
 *
 * Behavioral hardening (v2.3.1):
 *   - Always discovers `autoclaw-<version>.vsix` from package.json and passes
 *     it to `vsce publish --packagePath`, so the script does not depend on
 *     vsce deciding to package again itself.
 *   - Logs the resolved PAT source ("from .env", "from environment",
 *     "vsce stored credentials", "NONE — no PAT and no stored credentials")
 *     so silent-stop failures (the v2.3.0 release symptom) become visible.
 *   - Always emits a single-line "[publish-vsce] ..." status before AND after
 *     the spawn, so even a buffered-stdio harness sees something.
 *   - Honours `--dry-run`: prints the planned command line (PAT redacted)
 *     and exits 0 without invoking vsce.
 *   - Forwards `result.error` if spawnSync failed to launch the binary, and
 *     exits with `result.status` (or 1 if undefined).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function loadDotenv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const repo = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const dotenv = loadDotenv(path.join(repo, '.env'));
const env = { ...process.env };

let patSource = 'NONE — vsce will fall back to its stored credentials (run `vsce login <publisher>` if none)';
if (dotenv.VSCE_PAT) {
  env.VSCE_PAT = dotenv.VSCE_PAT;
  patSource = 'from .env';
} else if (process.env.VSCE_PAT) {
  patSource = 'from environment';
}

const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const vsixName = `autoclaw-${pkg.version}.vsix`;
const vsixPath = path.join(repo, vsixName);

const vsceArgs = ['vsce', 'publish', '--packagePath', vsixPath];
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const printable = `${npxCmd} ${vsceArgs.join(' ')}  (VSCE_PAT: ${patSource})`;

console.log(`[publish-vsce] Publisher: ${pkg.publisher ?? '(unset)'}`);
console.log(`[publish-vsce] Version:   ${pkg.version}`);
console.log(`[publish-vsce] VSIX:      ${vsixName} ${fs.existsSync(vsixPath) ? '(present)' : '(MISSING)'}`);
console.log(`[publish-vsce] PAT:       ${patSource}`);
console.log(`[publish-vsce] Command:   ${printable}`);

if (dryRun) {
  console.log('[publish-vsce] --dry-run set; not invoking vsce. Exit 0.');
  process.exit(0);
}

if (!fs.existsSync(vsixPath)) {
  console.error(`[publish-vsce] ERROR: VSIX not found: ${vsixPath}`);
  console.error('[publish-vsce] Run `npm run package` first.');
  process.exit(1);
}

if (patSource.startsWith('NONE')) {
  console.warn('[publish-vsce] WARNING: no VSCE_PAT in .env or environment.');
  console.warn('[publish-vsce] vsce will use its stored credential, if any.');
  console.warn('[publish-vsce] If this fails non-interactively, run: npx vsce login ' + (pkg.publisher ?? '<publisher>'));
}

const result = spawnSync(npxCmd, vsceArgs, {
  cwd: repo,
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`[publish-vsce] ERROR launching ${npxCmd}: ${result.error.message}`);
  process.exit(1);
}

const status = result.status ?? 1;
if (status !== 0) {
  console.error(`[publish-vsce] FAILED with exit ${status}. ` +
    `If output was empty, check that VSCE_PAT is set or that ` +
    `\`npx vsce login ${pkg.publisher ?? '<publisher>'}\` has been run.`);
} else {
  console.log('[publish-vsce] OK.');
}
process.exit(status);
