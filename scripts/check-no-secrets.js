#!/usr/bin/env node
/**
 * check-no-secrets.js — the PUBLIC-repo guard.
 *
 * AutoClaw's repo (GoZippy/autoclaw) is PUBLIC + source-available. The only real
 * protection for paid/secret material is to keep it OUT of public history in the
 * first place (a history rewrite after the fact does NOT recall already-published
 * content — forks, clones, caches, and archives retain it). This guard is that
 * prevention: it blocks
 *   1. secret FILES (.env, *.pem/*.key/*.p12/*.pfx, id_rsa/id_ed25519),
 *   2. private-key CONTENT under any filename (PEM markers),
 *   3. private/paid CODE paths that must live in the private repo, not here.
 *
 * Modes:
 *   --staged  pre-commit: only staged (added/copied/modified) files.
 *   (default) CI: every tracked file.
 *
 * Exit 1 with a clear report on any violation; exit 0 otherwise. Node-only,
 * cross-platform (bash / PowerShell / cmd).
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');

// 1. Secret file names (basename or path patterns).
const FORBIDDEN_NAME = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)[^/]*$/, // .env.local etc., but ALLOW .env.example
  /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i,
  /(^|\/)id_rsa/i, /(^|\/)id_ed25519/i,
];

// 2. Private/paid code that belongs in the PRIVATE repo, never the public one.
const FORBIDDEN_PATH = [
  /(^|\/)premium-impl(\/|$)/,
  /(^|\/)src\/premium-private(\/|$)/,
  /(^|\/)packages\/premium(\/|$)/,
  /(^|\/)packages\/autoclaw-premium(\/|$)/,
];

// 3. Private-key content markers (any filename).
const CONTENT_MARKERS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  /C:\\Users\\gotad/i,
  /[A-Z]:[\\/](?:Projects|tmp)[\\/]/i,
];

// Files allowed to legitimately contain key-looking content: redaction test
// fixtures (they feed FAKE keys to prove the scrubber works) and the example env.
const CONTENT_ALLOWLIST = [
  /(^|\/)src\/test\//,
  /(^|\/)\.env\.example$/,
  // This guard itself describes the markers it looks for.
  /(^|\/)scripts\/check-no-secrets\.js$/,
];

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

const staged = process.argv.includes('--staged');
let files;
try {
  files = staged
    ? sh('git diff --cached --name-only --diff-filter=ACM')
    : sh('git ls-files');
} catch (e) {
  console.error('[check-no-secrets] could not list files:', e.message);
  process.exit(1);
}

const violations = [];
for (const f of files) {
  if (FORBIDDEN_NAME.some(re => re.test(f))) { violations.push(`secret file (use .env, gitignored): ${f}`); continue; }
  if (FORBIDDEN_PATH.some(re => re.test(f))) { violations.push(`private/paid code in PUBLIC repo (move to the private repo): ${f}`); continue; }
  if (CONTENT_ALLOWLIST.some(re => re.test(f))) { continue; }
  let content;
  try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (content.length > 2_000_000) { continue; }
  if (CONTENT_MARKERS.some(re => re.test(content))) {
    violations.push(`embedded PRIVATE KEY content: ${f}`);
  }
}

if (violations.length > 0) {
  console.error(`[check-no-secrets] BLOCKED — ${violations.length} item(s) must NOT enter the public repo:`);
  for (const v of violations) { console.error('  ✗ ' + v); }
  console.error('Secrets → .env (gitignored). Paid/private code → the private repo (@autoclaw/premium).');
  console.error('If a match is a legitimate test fixture, add it to CONTENT_ALLOWLIST in scripts/check-no-secrets.js.');
  process.exit(1);
}
console.log(`[check-no-secrets] OK — scanned ${files.length} ${staged ? 'staged' : 'tracked'} file(s); no secrets or private code.`);
