#!/usr/bin/env node
/**
 * check-vsix-size.js — packaging guard CLI.
 *
 * Fails (exit 1) when the built `.vsix` is over the size cap or contains known
 * scratch/private/never-ship paths or sensitive content markers, so a bloat
 * regression (the 680 MB `research/` scare) or private-code leak can never ship
 * silently. Pure decision logic lives in
 * `src/packaging/vsixGuard.ts` (compiled to `out/packaging/vsixGuard.js`); this
 * wrapper supplies the real size and a cheap contamination scan.
 *
 * Usage:
 *   node scripts/check-vsix-size.js [path/to/file.vsix]
 *   VSIX_MAX_MB=10 node scripts/check-vsix-size.js   # tighten the cap
 *
 * With no path it picks the newest `*.vsix` in the current directory.
 * Requires a prior `npm run compile` (the `package` script and CI both do this).
 */
'use strict';

const fs = require('fs');
const path = require('path');

function fail(msg) {
  console.error(`\n✖ vsix guard: ${msg}\n`);
  process.exit(1);
}

// Load the compiled pure logic. If it's missing, the project wasn't compiled.
let guard;
try {
  guard = require(path.join(__dirname, '..', 'out', 'packaging', 'vsixGuard.js'));
} catch (e) {
  fail(`could not load out/packaging/vsixGuard.js (run "npm run compile" first): ${e.message}`);
}

// Resolve the target .vsix: explicit arg, else newest *.vsix in cwd.
function resolveVsix() {
  const arg = process.argv[2];
  if (arg) {
    if (!fs.existsSync(arg)) { fail(`no such file: ${arg}`); }
    return arg;
  }
  const candidates = fs.readdirSync(process.cwd())
    .filter(f => f.toLowerCase().endsWith('.vsix'))
    .map(f => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) {
    fail('no .vsix found in the current directory (run "npm run package" first, or pass a path)');
  }
  return candidates[0].f;
}

const vsixPath = resolveVsix();
const sizeBytes = fs.statSync(vsixPath).size;

// Cheap contamination scan: ZIP local file headers store entry names verbatim,
// so a packaged scratch file leaves its path as a plain substring in the buffer.
// We don't parse the central directory — substring presence is enough to flag.
const buf = fs.readFileSync(vsixPath);
const forbidden = guard.DEFAULT_FORBIDDEN_PREFIXES;
const detected = forbidden.filter(p => buf.includes(p));
const privateKeyMarker = kind => `-----BEGIN ${kind}PRIVATE KEY-----`;
const contentFindings = [
  privateKeyMarker(''),
  privateKeyMarker('RSA '),
  privateKeyMarker('EC '),
  privateKeyMarker('DSA '),
  privateKeyMarker('OPENSSH '),
].filter(marker => buf.includes(marker));

const maxBytes = process.env.VSIX_MAX_MB
  ? Math.round(parseFloat(process.env.VSIX_MAX_MB) * 1024 * 1024)
  : guard.DEFAULT_MAX_BYTES;

const result = guard.evaluateVsix({
  sizeBytes,
  entryNames: detected, // each detected prefix matches itself via startsWith
  maxBytes,
  contentFindings,
});

const sizeStr = guard.formatBytes(sizeBytes);
const capStr = guard.formatBytes(maxBytes);
console.log(`vsix guard: ${path.basename(vsixPath)} — ${sizeStr} (cap ${capStr})`);

if (!result.ok) {
  for (const r of result.reasons) { console.error(`  ✖ ${r}`); }
  process.exit(1);
}

console.log('  ✓ within size cap, no scratch/private/never-ship paths or sensitive markers detected');
