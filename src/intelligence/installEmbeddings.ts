/**
 * installEmbeddings.ts — one-command install of the Intelligence embedding
 * provider's heavy peer (`@xenova/transformers`).
 *
 * Why this exists: this is the embeddings-side twin of `installBackend.ts`. The
 * default embedding provider is `transformers`, but `@xenova/transformers` is a
 * large `optionalDependency` (it pulls in `onnxruntime-node`, `sharp`,
 * `protobufjs` — ~135 MB) that is EXCLUDED from the packaged `.vsix` (see
 * `.vscodeignore`) to keep the extension lean. So in a packaged install the
 * runtime `import('@xenova/transformers')` always throws `Cannot find module`
 * and the layer silently degrades to the low-quality `none` provider — while
 * spamming one warning per indexed chunk.
 *
 * This module installs `@xenova/transformers` (the exact pinned version) into a
 * PERSISTENT directory that survives extension updates — the SAME project-local
 * `native` dir the sqlite-vec backend uses by default (`<workspace>/.autoclaw/
 * native`), never forced onto C:. It exposes a resolver the embeddings loader
 * uses to find the installed package, plus the env vars the loader reads.
 *
 * Host-free: no `vscode` import. The caller passes the target dir + cache dir.
 *
 * NOTE on loading: `@xenova/transformers@2.x` is a pure-ESM package with no
 * `exports` map (`main: ./src/transformers.js`, `type: module`). It cannot be
 * `require()`-d (that throws `ERR_REQUIRE_ESM`); the loader must dynamic-
 * `import()` the resolved entry via a `file://` URL. {@link resolveInstalledTransformersEntry}
 * returns exactly that entry path.
 */

import { spawn as cpSpawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { LogFn } from './config';

/**
 * Minimal async spawn contract this module needs — a child with optional
 * stdout/stderr streams that emits `error` and `close`. `child_process.spawn`
 * satisfies it; tests inject a lightweight fake. Kept loose (no Node typings
 * leak) so the host-free module stays simple to stub.
 */
export interface SpawnedChild {
  stdout?: { on(event: 'data', cb: (chunk: unknown) => void): void } | null;
  stderr?: { on(event: 'data', cb: (chunk: unknown) => void): void } | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null) => void): void;
}
export type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => SpawnedChild;

/** Env var the host-free embeddings loader reads to find a user-installed @xenova/transformers. */
export const TRANSFORMERS_DIR_ENV = 'AUTOCLAW_TRANSFORMERS_DIR';

/**
 * Env var the embeddings loader reads for the model cache dir (where the
 * feature-extraction model is downloaded on first use). Kept project-local by
 * default so multi-hundred-MB model weights never land silently on C:.
 */
export const TRANSFORMERS_CACHE_ENV = 'AUTOCLAW_TRANSFORMERS_CACHE';

export interface InstallEmbeddingsOptions {
  /** Persistent dir; the package lands at `<targetDir>/node_modules/@xenova/transformers`. */
  targetDir: string;
  /** Exact pinned version to install (from the extension's optionalDependencies). */
  version: string;
  /** npm executable (default `npm`). Injected for tests. */
  npmPath?: string;
  /** Spawn override (tests). Defaults to a real async `child_process.spawn`. */
  spawn?: SpawnFn;
  log?: LogFn;
}

export interface InstallEmbeddingsResult {
  ok: boolean;
  /** Absolute path to the ESM entry to dynamic-`import()` when install succeeded. */
  entryPath?: string;
  /** The dir to point {@link TRANSFORMERS_DIR_ENV} at on success. */
  installedDir?: string;
  error?: string;
}

/** The package the embeddings `transformers` provider needs. */
const PACKAGE_NAME = '@xenova/transformers';

/**
 * Resolve the importable ESM entry for an installed `@xenova/transformers`,
 * reading its `package.json` to honor `exports`/`module`/`main`. Returns the
 * absolute entry path only when both the manifest resolves AND the entry file
 * exists on disk. Never throws.
 */
export function resolveInstalledTransformersEntry(targetDir: string): string | undefined {
  try {
    const pkgDir = path.join(targetDir, 'node_modules', '@xenova', 'transformers');
    const manifestPath = path.join(pkgDir, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      main?: string;
      module?: string;
      exports?: unknown;
    };
    const rel = pickEntry(manifest);
    const entry = path.resolve(pkgDir, rel);
    return fs.existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pick the ESM entry path from a package manifest, preferring the conditional
 * `exports["."]` import condition, then `module`, then `main`, then `index.js`.
 * Defensive against the several shapes `exports` can take.
 */
function pickEntry(manifest: { main?: string; module?: string; exports?: unknown }): string {
  const dot = readDotExport(manifest.exports);
  return dot ?? manifest.module ?? manifest.main ?? 'index.js';
}

/** Extract the import/node/default target from an `exports["."]` of any common shape. */
function readDotExport(exportsField: unknown): string | undefined {
  if (typeof exportsField === 'string') {
    return exportsField; // `"exports": "./x.js"`
  }
  if (!exportsField || typeof exportsField !== 'object') {
    return undefined;
  }
  const map = exportsField as Record<string, unknown>;
  // `"exports": { ".": <cond> }` or a bare conditional object.
  const dot = '.' in map ? map['.'] : map;
  return readConditional(dot);
}

/** Resolve a conditional-exports value to a file string, walking import→node→default. */
function readConditional(cond: unknown): string | undefined {
  if (typeof cond === 'string') {
    return cond;
  }
  if (!cond || typeof cond !== 'object') {
    return undefined;
  }
  const c = cond as Record<string, unknown>;
  // Prefer ESM import conditions; recurse for nested ({ node: { import: ... } }).
  for (const key of ['import', 'node', 'default']) {
    if (key in c) {
      const resolved = readConditional(c[key]);
      if (resolved) {
        return resolved;
      }
    }
  }
  return undefined;
}

/** True when a usable `@xenova/transformers` is already installed under `targetDir`. */
export function isEmbeddingsInstalled(targetDir: string): boolean {
  return resolveInstalledTransformersEntry(targetDir) !== undefined;
}

/**
 * The npm argv used to install the package. Split out so a test can assert the
 * exact, side-effect-free command without spawning npm.
 *
 * Deliberately carries NO path argument. The install target is conveyed via the
 * spawn `cwd` instead of `--prefix`: under `shell:true` (needed on Windows to
 * resolve the `npm.cmd` shim) argv is concatenated and re-split on spaces, so a
 * `--prefix C:\…\Zippy Claims\…` would break at the space and npm would read a
 * bogus `<cwd>\Claims\…\package.json`. `cwd` is passed in the options object and
 * is immune to that splitting; none of these args contain spaces. (Same fix the
 * vector backend installer carries — see buildInstallArgs in installBackend.ts.)
 */
export function buildEmbeddingsInstallArgs(version: string): string[] {
  return [
    'install',
    `${PACKAGE_NAME}@${version}`,
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ];
}

/**
 * Install `@xenova/transformers@version` into `targetDir`. Resolves `ok:false`
 * with a trimmed error rather than throwing, so the command can surface
 * remediation. Idempotent: if a usable copy is already present, returns success
 * without re-running npm. ASYNC (non-blocking `spawn`, not `spawnSync`) because
 * this is a large install (~135 MB with native builds) that would otherwise
 * freeze the extension host for minutes.
 */
export async function installEmbeddingsProvider(
  opts: InstallEmbeddingsOptions,
): Promise<InstallEmbeddingsResult> {
  const { version, npmPath = 'npm', spawn = cpSpawn as unknown as SpawnFn, log } = opts;

  // Always resolve to an ABSOLUTE path. A relative target (or one from a mis-set
  // setting) would otherwise be resolved by npm against its own cwd — the VS Code
  // install dir — yielding a bogus path and an ENOENT on package.json.
  const targetDir = path.resolve(opts.targetDir);

  const existing = resolveInstalledTransformersEntry(targetDir);
  if (existing) {
    log?.(`embeddings provider already installed at ${targetDir}`);
    return { ok: true, entryPath: existing, installedDir: targetDir };
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `cannot create ${targetDir}: ${(err as Error).message}` };
  }

  // npm 7+ requires package.json to exist at the install root before it will run
  // install; seed a minimal one so the directory looks like a package root. This
  // is the same `<workspace>/.autoclaw/native` dir the vector backend uses, so a
  // seed it already wrote is reused (guarded by existsSync).
  const pkgJsonPath = path.join(targetDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    try {
      fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: 'autoclaw-native', version: '1.0.0', private: true }));
    } catch (err) {
      return { ok: false, error: `cannot seed package.json: ${(err as Error).message}` };
    }
  }

  const args = buildEmbeddingsInstallArgs(version);
  log?.(`installing ${PACKAGE_NAME}@${version} into ${targetDir} (cwd) (npm ${args.join(' ')})`);
  const run = await runNpm(spawn, npmPath, args, targetDir);
  if (!run.ok) {
    return { ok: false, error: run.error };
  }

  const entryPath = resolveInstalledTransformersEntry(targetDir);
  if (!entryPath) {
    return {
      ok: false,
      error: `${PACKAGE_NAME} installed but its ESM entry could not be resolved`,
    };
  }
  log?.(`embeddings provider ready: ${entryPath}`);
  return { ok: true, entryPath, installedDir: targetDir };
}

/**
 * Run `npm` via the (injectable) async spawn, accumulating stderr/stdout and
 * resolving once the process closes. Never rejects — transport/exit failures
 * resolve as `{ ok:false, error }`.
 */
function runNpm(
  spawn: SpawnFn,
  npmPath: string,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let child: SpawnedChild;
    try {
      child = spawn(npmPath, args, {
        // Install target is conveyed via cwd (NOT --prefix): cwd survives the
        // shell:true argv concatenation that a spaced --prefix path would not.
        // npm installs into <cwd>/node_modules and uses the seeded package.json.
        cwd,
        // npm is a .cmd shim on Windows — run through the shell so it resolves.
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: `npm not runnable: ${(err as Error).message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => resolve({ ok: false, error: `npm not runnable: ${err.message}` }));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const detail = (stderr || stdout).trim().slice(0, 400);
      resolve({ ok: false, error: `npm exited ${code}: ${detail}` });
    });
  });
}
