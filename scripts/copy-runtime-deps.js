/**
 * copy-runtime-deps.js — vendor the few PURE-JS production dependencies the
 * shipped `out/` actually `require()`s into `out/node_modules/`, so they resolve
 * at runtime even though the .vsix is packaged with `vsce package
 * --no-dependencies` (no top-level node_modules).
 *
 * Why: the extension ships no bundled node_modules. Node-built-ins and the
 * host-provided `vscode` resolve fine, and the HEAVY NATIVE peers
 * (@xenova/transformers, better-sqlite3, sqlite-vec, pg, onnxruntime-*, sharp)
 * are deliberately user-installed/optional with graceful degradation. But a few
 * SMALL pure-JS regular deps are required by shipped code and were silently
 * dropped by `--no-dependencies`:
 *   - `ws`       — the WebSocket bridge (out/bridge-ws.js, eager require) → was
 *                  throwing "Cannot find module 'ws'" when the bridge started.
 *   - `chokidar` — the daemon/voidspec file watchers (lazy require) → was falling
 *                  back to slow 30s polling instead of sub-second reactivity.
 *
 * This copies each root + its transitive `dependencies` FLAT into
 * `out/node_modules/<name>` (Node resolves them by walking up from out/*.js).
 * Native / optional-peer packages are NEVER vendored. `.vscodeignore` does not
 * exclude `out/node_modules/**`, so the vendored copies ship in the .vsix.
 */
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const NM = path.join(repo, 'node_modules');
const OUT_NM = path.join(repo, 'out', 'node_modules');

/** Pure-JS production deps the shipped out/ requires at runtime. */
const ROOTS = ['ws', 'chokidar'];

/** Never vendor these — native builds / heavy optional peers stay user-installed. */
const SKIP = new Set([
  'fsevents', // mac-only native optionalDependency of chokidar
  'better-sqlite3', 'sqlite-vec', '@xenova/transformers', 'pg',
  'onnxruntime-node', 'onnxruntime-web', 'onnxruntime-common', 'sharp', 'protobufjs',
]);

const done = new Set();

function pkgDir(name) {
  const dir = path.join(NM, name);
  return fs.existsSync(path.join(dir, 'package.json')) ? dir : null;
}

function vendor(name) {
  if (done.has(name) || SKIP.has(name)) {
    return;
  }
  done.add(name);
  const from = pkgDir(name);
  if (!from) {
    console.warn(`copy-runtime-deps: SKIP "${name}" — not found in node_modules (run npm install)`);
    return;
  }
  const to = path.join(OUT_NM, name);
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // dereference: follow the node_modules junction/symlinks to copy real files.
  fs.cpSync(from, to, { recursive: true, dereference: true });
  let deps = {};
  try {
    deps = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8')).dependencies || {};
  } catch {
    /* no deps */
  }
  for (const dep of Object.keys(deps)) {
    vendor(dep);
  }
}

/**
 * Vendor the PRIVATE @autoclaw/premium package (compiled dist ONLY) into the
 * licensed build — and ONLY then. Guarded by an explicit opt-in so a maintainer
 * who happens to have @autoclaw/premium installed locally can NEVER leak it into
 * the public marketplace .vsix: it ships only when AUTOCLAW_EDITION=enterprise or
 * AUTOCLAW_INCLUDE_PREMIUM is truthy. Source is never copied — compiled only.
 */
function vendorPremiumIfLicensed() {
  const inc = (process.env.AUTOCLAW_INCLUDE_PREMIUM || '').toLowerCase();
  const wantPremium =
    process.env.AUTOCLAW_EDITION === 'enterprise' ||
    (inc !== '' && inc !== '0' && inc !== 'false' && inc !== 'no');
  if (!wantPremium) {
    console.log(
      'copy-runtime-deps: @autoclaw/premium NOT vendored (public/community build). ' +
      'For a licensed build set AUTOCLAW_EDITION=enterprise or AUTOCLAW_INCLUDE_PREMIUM=1.',
    );
    return;
  }
  const from = path.join(NM, '@autoclaw', 'premium');
  if (!fs.existsSync(path.join(from, 'package.json'))) {
    console.warn(
      'copy-runtime-deps: licensed build requested but @autoclaw/premium is NOT installed — ' +
      'run `npm install @autoclaw/premium` (or the private checkout) first. ' +
      'Building with the FREE fallback for now.',
    );
    return;
  }
  const to = path.join(OUT_NM, '@autoclaw', 'premium');
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  // Ship the manifest + COMPILED dist only — never src.
  fs.copyFileSync(path.join(from, 'package.json'), path.join(to, 'package.json'));
  const distFrom = path.join(from, 'dist');
  if (fs.existsSync(distFrom)) {
    fs.cpSync(distFrom, path.join(to, 'dist'), { recursive: true, dereference: true });
  } else {
    console.warn('copy-runtime-deps: @autoclaw/premium has no dist/ — run its `npm run build` first.');
  }
  // Vendor any runtime deps premium declares (currently none).
  let deps = {};
  try { deps = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8')).dependencies || {}; } catch { /* none */ }
  for (const dep of Object.keys(deps)) { vendor(dep); }
  console.log('copy-runtime-deps: vendored @autoclaw/premium (LICENSED build) -> out/node_modules/@autoclaw/premium (compiled dist only).');
}

fs.rmSync(OUT_NM, { recursive: true, force: true });
for (const root of ROOTS) {
  vendor(root);
}
vendorPremiumIfLicensed();
console.log(
  `copy-runtime-deps: vendored ${done.size} pure-JS package(s) -> out/node_modules: ` +
    `${[...done].sort().join(', ')}`,
);
