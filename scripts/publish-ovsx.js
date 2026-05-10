#!/usr/bin/env node
/**
 * Cross-platform Open VSX publisher.
 *
 * Reads OVSX_TOKEN from .env (falls back to process.env), then runs
 * `ovsx publish autoclaw-<version>.vsix --pat <token>`.
 *
 * Behavioral hardening (v2.3.1):
 *   - Logs the resolved token source ("from .env", "from environment", or
 *     "MISSING") and bails clearly when no token is found.
 *   - Always emits a single-line "[publish-ovsx] ..." status before AND
 *     after the spawn, so even a buffered-stdio harness sees something.
 *   - Honours `--dry-run`: prints the planned command line (token redacted)
 *     and exits 0 without invoking ovsx.
 *   - Forwards `result.error` if spawnSync failed to launch the binary, and
 *     exits with `result.status` (or 1 if undefined).
 *
 * Works on bash, PowerShell, and cmd.exe.
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

let token = '';
let tokenSource = 'MISSING';
if (process.env.OVSX_TOKEN) {
  token = process.env.OVSX_TOKEN;
  tokenSource = 'from environment';
} else if (dotenv.OVSX_TOKEN) {
  token = dotenv.OVSX_TOKEN;
  tokenSource = 'from .env';
}

const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const vsixName = `autoclaw-${pkg.version}.vsix`;
const vsixPath = path.join(repo, vsixName);

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const ovsxArgs = ['ovsx', 'publish', vsixPath, '--pat', token];
const redacted = ['ovsx', 'publish', vsixPath, '--pat', '<redacted>'];

console.log(`[publish-ovsx] Version: ${pkg.version}`);
console.log(`[publish-ovsx] VSIX:    ${vsixName} ${fs.existsSync(vsixPath) ? '(present)' : '(MISSING)'}`);
console.log(`[publish-ovsx] Token:   ${tokenSource}`);
console.log(`[publish-ovsx] Command: ${npxCmd} ${redacted.join(' ')}`);

if (dryRun) {
  console.log('[publish-ovsx] --dry-run set; not invoking ovsx. Exit 0.');
  process.exit(0);
}

if (!fs.existsSync(vsixPath)) {
  console.error(`[publish-ovsx] ERROR: VSIX not found: ${vsixPath}`);
  console.error('[publish-ovsx] Run `npm run package` first.');
  process.exit(1);
}

if (!token) {
  console.error('[publish-ovsx] ERROR: OVSX_TOKEN is not set in .env or the environment.');
  console.error('[publish-ovsx] Get a token from https://open-vsx.org/user-settings/tokens and add it to .env.');
  process.exit(1);
}

const result = spawnSync(npxCmd, ovsxArgs, {
  cwd: repo,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`[publish-ovsx] ERROR launching ${npxCmd}: ${result.error.message}`);
  process.exit(1);
}

const status = result.status ?? 1;
if (status !== 0) {
  console.error(`[publish-ovsx] FAILED with exit ${status}. ` +
    `Verify OVSX_TOKEN scope and that the VSIX has not already been published.`);
} else {
  console.log('[publish-ovsx] OK.');
}
process.exit(status);
