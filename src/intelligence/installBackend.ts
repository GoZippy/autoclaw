/**
 * installBackend.ts — one-command install of the Intelligence vector backend's
 * native peer (`sqlite-vec`).
 *
 * Why this exists: the vector/embedding native peers (`sqlite-vec`,
 * `better-sqlite3`, …) are declared as `optionalDependencies` but EXCLUDED from
 * the packaged `.vsix` (see `.vscodeignore`) to keep the extension lean. The
 * SQLite *engine* now comes from Node-core `node:sqlite` (ABI-proof, no install),
 * but the `sqlite-vec` `vec0` loadable extension is a separate package that still
 * has to be present locally. Without it `require('sqlite-vec')` throws and the
 * layer degrades to no-RAG ("vector backend unavailable").
 *
 * This module installs `sqlite-vec` (the exact pinned version) into a PERSISTENT
 * per-user directory that survives extension updates, and exposes a resolver the
 * loader uses as a fallback. Host-free: no `vscode` import; the caller passes the
 * target dir (e.g. the extension's `globalStorage`).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { LogFn } from './config';

/** Env var the host-free vector loader reads to find a user-installed sqlite-vec. */
export const VEC_DIR_ENV = 'AUTOCLAW_SQLITE_VEC_DIR';

export interface InstallBackendOptions {
  /** Persistent dir; `sqlite-vec` lands at `<targetDir>/node_modules/sqlite-vec`. */
  targetDir: string;
  /** Exact pinned version to install (from the extension's optionalDependencies). */
  version: string;
  /** npm executable (default `npm`). Injected for tests. */
  npmPath?: string;
  /** Spawn override (tests). Defaults to a real `spawnSync`. */
  spawn?: typeof spawnSync;
  log?: LogFn;
}

export interface InstallBackendResult {
  ok: boolean;
  /** Resolved `vec0` loadable path when the install succeeded. */
  loadablePath?: string;
  /** The dir to point {@link VEC_DIR_ENV} at on success. */
  installedDir?: string;
  error?: string;
}

/**
 * Resolve the `sqlite-vec` loadable from a persistent install dir, returning the
 * `vec0` loadable path only when both the wrapper resolves AND the binary exists.
 * Never throws.
 */
export function resolveInstalledLoadable(targetDir: string): string | undefined {
  try {
    const pkgDir = path.join(targetDir, 'node_modules', 'sqlite-vec');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqliteVec = require(pkgDir);
    const loadable: string = sqliteVec.getLoadablePath();
    return loadable && fs.existsSync(loadable) ? loadable : undefined;
  } catch {
    return undefined;
  }
}

/** True when a usable sqlite-vec is already installed under `targetDir`. */
export function isBackendInstalled(targetDir: string): boolean {
  return resolveInstalledLoadable(targetDir) !== undefined;
}

/**
 * The npm argv used to install sqlite-vec. Split out so a test can assert the
 * exact, side-effect-free command without spawning npm.
 */
export function buildInstallArgs(targetDir: string, version: string): string[] {
  return [
    'install',
    `sqlite-vec@${version}`,
    '--prefix',
    targetDir,
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ];
}

/**
 * Install `sqlite-vec@version` into `targetDir`. Returns `ok:false` with a
 * trimmed error rather than throwing, so the command can surface remediation.
 * Idempotent: if a usable sqlite-vec is already present, returns success without
 * re-running npm.
 */
export function installVectorBackend(opts: InstallBackendOptions): InstallBackendResult {
  const { version, npmPath = 'npm', spawn = spawnSync, log } = opts;

  // Always resolve to an ABSOLUTE path. A relative target (or one coming from a
  // mis-set `backendDir` setting) would otherwise be resolved by npm against its
  // own cwd — the VS Code install dir — yielding a bogus path like
  // "<vscode>/Claims/.autoclaw/native" and an ENOENT on package.json.
  const targetDir = path.resolve(opts.targetDir);

  const existing = resolveInstalledLoadable(targetDir);
  if (existing) {
    log?.(`vector backend already installed at ${targetDir}`);
    return { ok: true, loadablePath: existing, installedDir: targetDir };
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `cannot create ${targetDir}: ${(err as Error).message}` };
  }

  // npm 7+ requires package.json to exist at --prefix before it will run
  // install; seed a minimal one so the directory looks like a package root.
  const pkgJsonPath = path.join(targetDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    try {
      fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: 'autoclaw-native', version: '1.0.0', private: true }));
    } catch (err) {
      return { ok: false, error: `cannot seed package.json: ${(err as Error).message}` };
    }
  }

  const args = buildInstallArgs(targetDir, version);
  log?.(`installing sqlite-vec@${version} into ${targetDir} (npm ${args.join(' ')})`);
  const res = spawn(npmPath, args, {
    encoding: 'utf8',
    // Run npm FROM the target dir so its cwd, --prefix, and the seeded
    // package.json all agree on one absolute location.
    cwd: targetDir,
    // npm is a .cmd shim on Windows — run through the shell so it resolves.
    shell: process.platform === 'win32',
  });

  if (res.error) {
    return { ok: false, error: `npm not runnable: ${res.error.message}` };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || res.stdout || '').toString().trim();
    return { ok: false, error: `npm exited ${res.status}: ${stderr.slice(0, 400)}` };
  }

  const loadablePath = resolveInstalledLoadable(targetDir);
  if (!loadablePath) {
    return {
      ok: false,
      error: 'sqlite-vec installed but its vec0 loadable could not be resolved for this platform',
    };
  }
  log?.(`vector backend ready: ${loadablePath}`);
  return { ok: true, loadablePath, installedDir: targetDir };
}
