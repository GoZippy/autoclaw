#!/usr/bin/env node
/**
 * Cross-platform VS Code Marketplace publisher.
 * Reads VSCE_PAT from .env (falls back to process.env or vsce's own credential
 * store), then runs `vsce publish`. If neither .env nor process.env set
 * VSCE_PAT, vsce will use its locally stored PAT for the publisher named in
 * package.json (created via `vsce login`).
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
const dotenv = loadDotenv(path.join(repo, '.env'));
const env = { ...process.env };
if (dotenv.VSCE_PAT) env.VSCE_PAT = dotenv.VSCE_PAT;

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npxCmd, ['vsce', 'publish'], {
  cwd: repo,
  stdio: 'inherit',
  env
});
process.exit(result.status ?? 1);
