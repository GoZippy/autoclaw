#!/usr/bin/env node
/**
 * Cross-platform Open VSX publisher.
 * Reads OVSX_TOKEN from .env (falls back to process.env), then runs
 * `ovsx publish autoclaw-<version>.vsix --pat <token>`.
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
const env = { ...loadDotenv(path.join(repo, '.env')), ...process.env };
const token = env.OVSX_TOKEN;
if (!token) {
  console.error('Missing OVSX_TOKEN. Set it in .env (see .env.example) or in the environment.');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const vsix = path.join(repo, `autoclaw-${pkg.version}.vsix`);
if (!fs.existsSync(vsix)) {
  console.error(`VSIX not found: ${vsix}\nRun \`npm run package\` first.`);
  process.exit(1);
}

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npxCmd, ['ovsx', 'publish', vsix, '--pat', token], {
  cwd: repo,
  stdio: 'inherit'
});
process.exit(result.status ?? 1);
