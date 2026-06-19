#!/usr/bin/env node
/**
 * smoke-vector-install.js — END-TO-END smoke test for the Intelligence vector
 * backend installer, decoupled from VS Code.
 *
 * Runs the REAL `installVectorBackend()` (the same code the
 * `autoclaw.intelligence.installBackend` command calls) against a throwaway temp
 * directory, with the same npm your editor would use. This is the fastest way to
 * answer "does the installer itself work on this machine?" without fighting the
 * extension-reload / multi-window caching that can mask a fix.
 *
 * Usage:
 *   node scripts/smoke-vector-install.js            # uses the pinned version
 *   node scripts/smoke-vector-install.js 0.1.6      # force a version
 *   AC_KEEP=1 node scripts/smoke-vector-install.js  # keep the temp dir
 *
 * Exit code 0 = backend installed + loadable resolved; non-zero = failure.
 * Requires `npm run compile` first (reads from ./out).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function pinnedVersion() {
  try {
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    const v = (pkg.optionalDependencies || {})['sqlite-vec'];
    return typeof v === 'string' ? v : 'latest';
  } catch {
    return 'latest';
  }
}

function main() {
  let installVectorBackend;
  try {
    ({ installVectorBackend } = require(path.join(__dirname, '..', 'out', 'intelligence', 'installBackend.js')));
  } catch (err) {
    console.error('✖ Could not load out/intelligence/installBackend.js — run `npm run compile` first.');
    console.error(`  (${err.message})`);
    process.exit(2);
  }

  const version = process.argv[2] || pinnedVersion();
  // Deliberately nest under .autoclaw/native like the real project-local default,
  // and seed it under a fresh temp root so we never touch a real workspace.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-smoke-'));
  const target = path.join(root, '.autoclaw', 'native');

  console.log('AutoClaw — vector backend install smoke test');
  console.log('────────────────────────────────────────────');
  console.log(`  node       : ${process.versions.node}`);
  console.log(`  cwd        : ${process.cwd()}`);
  console.log(`  version    : sqlite-vec@${version}`);
  console.log(`  target     : ${target}`);
  console.log('────────────────────────────────────────────');

  const started = Date.now();
  const result = installVectorBackend({
    targetDir: target,
    version,
    log: (m) => console.log(`  [installer] ${m}`),
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log('────────────────────────────────────────────');
  const seeded = fs.existsSync(path.join(target, 'package.json'));
  console.log(`  seeded package.json : ${seeded}`);
  console.log(`  ok                  : ${result.ok}`);
  console.log(`  loadablePath        : ${result.loadablePath || '(none)'}`);
  if (result.error) {
    console.log(`  error               : ${result.error}`);
  }
  console.log(`  elapsed             : ${secs}s`);

  if (process.env.AC_KEEP) {
    console.log(`  (kept temp dir: ${root})`);
  } else {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  console.log('────────────────────────────────────────────');
  if (result.ok) {
    console.log('✔ PASS — installer works on this machine.');
    process.exit(0);
  } else {
    console.log('✖ FAIL — see error above (npm on PATH? network? Node version?).');
    process.exit(1);
  }
}

main();
