#!/usr/bin/env node
/*
 * rebuild-native.js — rebuild the optional native fallback module
 * (better-sqlite3) against the Electron ABI used by the VS Code extension host.
 *
 * Most users never need this: the intelligence vector backend prefers
 * `node:sqlite`, a Node CORE module that is ABI-stable and needs no rebuild.
 * `better-sqlite3` is only the FALLBACK for older hosts (Node < 22.5). On those
 * hosts the addon's binary must match the host Electron ABI
 * (NODE_MODULE_VERSION); `npm install` builds it for system Node, so it can be
 * wrong inside the Electron-based extension host. This script rebuilds it for the
 * Electron the local VS Code ships.
 *
 *   npm run rebuild:native
 *   ELECTRON_VERSION=42.2.0 npm run rebuild:native   # override detection
 *
 * NOTE: the result targets Electron, so it will NOT load under plain system Node
 * afterward. Run `npm rebuild better-sqlite3` (no flags) to restore a system-Node
 * binary if you need one. `sqlite-vec` is a SQLite loadable extension (not a Node
 * addon) and is never rebuilt.
 */
'use strict';

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Ask an Electron binary (run as Node) for its bundled Electron version. */
function probeElectron(exePath) {
  try {
    const out = execFileSync(exePath, ['-e', 'process.stdout.write(process.versions.electron || "")'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^\d+\.\d+\.\d+/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Resolve the VS Code Electron executable and return its Electron version. */
function detectElectronVersion() {
  if (process.env.ELECTRON_VERSION) {
    return process.env.ELECTRON_VERSION.trim();
  }

  const candidates = [];
  // Inside a VS Code integrated terminal these point straight at the Electron binary.
  for (const v of [process.env.VSCODE_GIT_ASKPASS_NODE, process.env.ELECTRON_EXEC_PATH]) {
    if (v) candidates.push(v);
  }

  // Resolve the `code` launcher on PATH back to its sibling Code executable.
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(which, ['code'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const launcher of found) {
      // .../Microsoft VS Code/bin/code(.cmd)  ->  .../Microsoft VS Code/Code.exe
      const root = path.dirname(path.dirname(launcher));
      if (process.platform === 'win32') {
        candidates.push(path.join(root, 'Code.exe'));
      } else if (process.platform === 'darwin') {
        candidates.push(path.join(root, 'MacOS', 'Electron'));
      } else {
        candidates.push(path.join(root, 'code'));
      }
    }
  } catch {
    // `code` not on PATH — fall through to whatever candidates we have.
  }

  for (const exe of candidates) {
    if (exe && fs.existsSync(exe)) {
      const v = probeElectron(exe);
      if (v) return v;
    }
  }
  return null;
}

function main() {
  const electronVersion = detectElectronVersion();
  if (!electronVersion) {
    console.error(
      '[rebuild-native] Could not detect the VS Code Electron version.\n' +
        '  Set it explicitly, e.g.:  ELECTRON_VERSION=42.2.0 npm run rebuild:native\n' +
        '  (Find it via Help > About in VS Code.)\n' +
        '  Tip: running this from the VS Code integrated terminal lets it auto-detect.',
    );
    process.exit(1);
  }

  console.log(`[rebuild-native] Rebuilding better-sqlite3 for Electron ${electronVersion} ...`);
  // Run through a shell: on Windows `npm` is `npm.cmd`, and Node >=20 refuses to
  // execFile a `.cmd` directly (EINVAL) without a shell.
  const cmd =
    `npm rebuild better-sqlite3 --runtime=electron ` +
    `--target=${electronVersion} --dist-url=https://electronjs.org/headers`;
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (err) {
    console.error(
      `[rebuild-native] Rebuild failed: ${err.message}\n` +
        '  If the compile failed on a missing prebuilt for a very new Electron, a prebuilt may not exist yet —\n' +
        '  the vector backend still works via node:sqlite on Node >= 22.5, so this fallback is optional.',
    );
    process.exit(1);
  }
  console.log(
    `[rebuild-native] Done. Reload the VS Code window (Developer: Reload Window) to pick up the new binary.`,
  );
}

main();
