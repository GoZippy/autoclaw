/**
 * intelligence-installembeddings.test.ts — unit tests for the embeddings-provider
 * installer (`installEmbeddingsProvider`) that powers
 * `autoclaw.intelligence.installEmbeddings`.
 *
 * Hermetic: plants a FAKE `@xenova/transformers` package on disk (so the ESM
 * entry resolves) and injects an async `spawn` so npm is never actually run.
 * No network, no native modules. The installer is ASYNC (non-blocking spawn),
 * so the fake child emits `close`/`error` on the next tick.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildEmbeddingsInstallArgs,
  installEmbeddingsProvider,
  isEmbeddingsInstalled,
  resolveInstalledTransformersEntry,
  SpawnFn,
  SpawnedChild,
  TRANSFORMERS_DIR_ENV,
  TRANSFORMERS_CACHE_ENV,
} from '../intelligence/installEmbeddings';

let tmpRoot: string;

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

/**
 * Plant a fake `@xenova/transformers` with a given manifest + a real entry file.
 * Returns the absolute entry path the resolver should produce.
 */
function plantFakeTransformers(
  targetDir: string,
  manifest: Record<string, unknown>,
  entryRel: string,
): string {
  const pkgDir = path.join(targetDir, 'node_modules', '@xenova', 'transformers');
  const entryAbs = path.join(pkgDir, entryRel);
  fs.mkdirSync(path.dirname(entryAbs), { recursive: true });
  fs.writeFileSync(entryAbs, 'export const pipeline = () => {};\n', 'utf8');
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@xenova/transformers', version: '2.17.2', ...manifest }),
    'utf8',
  );
  return entryAbs;
}

/**
 * Build an async spawn stub. By default emits `close(0)`. Options drive the
 * failure paths: a non-zero exit (+ stderr), an emitted `error`, or a synchronous
 * throw from spawn itself.
 */
function fakeSpawn(opts: {
  code?: number;
  stderr?: string;
  emitError?: string;
  throwOnSpawn?: boolean;
  onCalled?: () => void;
}): SpawnFn {
  return () => {
    opts.onCalled?.();
    if (opts.throwOnSpawn) {
      throw new Error('spawn npm ENOENT');
    }
    const child: SpawnedChild = {
      stdout: { on: () => undefined },
      stderr: {
        on: (_event, cb) => {
          if (opts.stderr) {
            cb(Buffer.from(opts.stderr)); // accumulate synchronously, before close
          }
        },
      },
      on: (event: 'error' | 'close', cb: (arg: never) => void) => {
        if (event === 'error' && opts.emitError) {
          setImmediate(() => cb(new Error(opts.emitError) as never));
        }
        if (event === 'close' && !opts.emitError) {
          setImmediate(() => cb((opts.code ?? 0) as never));
        }
      },
    };
    return child;
  };
}

suite('intelligence — install embeddings provider', () => {
  suiteSetup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-installembed-'));
  });
  suiteTeardown(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('buildEmbeddingsInstallArgs pins the version and installs into the prefix without saving', () => {
    const args = buildEmbeddingsInstallArgs('/tmp/peer', '2.17.2');
    assert.deepStrictEqual(args, [
      'install',
      '@xenova/transformers@2.17.2',
      '--prefix',
      '/tmp/peer',
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ]);
  });

  test('resolver finds a planted package via `main`, and misses an empty dir', () => {
    const empty = freshDir('empty');
    assert.strictEqual(resolveInstalledTransformersEntry(empty), undefined);
    assert.strictEqual(isEmbeddingsInstalled(empty), false);

    const withPeer = freshDir('main');
    const entry = plantFakeTransformers(withPeer, { main: './src/transformers.js', type: 'module' }, 'src/transformers.js');
    assert.strictEqual(resolveInstalledTransformersEntry(withPeer), entry);
    assert.strictEqual(isEmbeddingsInstalled(withPeer), true);
  });

  test('resolver honors a nested conditional `exports["."].node.import` shape', () => {
    const dir = freshDir('exports');
    const entry = plantFakeTransformers(
      dir,
      { main: './wrong.js', exports: { '.': { node: { import: './dist/right.js' } } } },
      'dist/right.js',
    );
    assert.strictEqual(resolveInstalledTransformersEntry(dir), entry);
  });

  test('resolver returns undefined when the manifest entry file is missing', () => {
    const dir = freshDir('noentry');
    const pkgDir = path.join(dir, 'node_modules', '@xenova', 'transformers');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@xenova/transformers', main: './ghost.js' }),
      'utf8',
    );
    assert.strictEqual(resolveInstalledTransformersEntry(dir), undefined);
  });

  test('install is idempotent: a present package returns ok WITHOUT spawning npm', async () => {
    const dir = freshDir('idem');
    const entry = plantFakeTransformers(dir, { main: './m.js', type: 'module' }, 'm.js');
    let spawned = false;
    const res = await installEmbeddingsProvider({
      targetDir: dir,
      version: '2.17.2',
      spawn: fakeSpawn({ onCalled: () => (spawned = true) }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.entryPath, entry);
    assert.strictEqual(spawned, false, 'must short-circuit when already installed');
  });

  test('a non-zero npm exit surfaces as ok:false with the stderr', async () => {
    const dir = freshDir('fail');
    const res = await installEmbeddingsProvider({
      targetDir: dir,
      version: '2.17.2',
      spawn: fakeSpawn({ code: 1, stderr: 'ENOTFOUND registry.npmjs.org' }),
    });
    assert.strictEqual(res.ok, false);
    assert.ok(/npm exited 1/.test(res.error || ''), res.error);
    assert.ok(/ENOTFOUND/.test(res.error || ''), res.error);
  });

  test('an unrunnable npm (spawn throws) surfaces as ok:false', async () => {
    const dir = freshDir('noexec');
    const res = await installEmbeddingsProvider({
      targetDir: dir,
      version: '2.17.2',
      spawn: fakeSpawn({ throwOnSpawn: true }),
    });
    assert.strictEqual(res.ok, false);
    assert.ok(/not runnable/.test(res.error || ''), res.error);
  });

  test('an emitted child `error` surfaces as ok:false', async () => {
    const dir = freshDir('childerr');
    const res = await installEmbeddingsProvider({
      targetDir: dir,
      version: '2.17.2',
      spawn: fakeSpawn({ emitError: 'EACCES' }),
    });
    assert.strictEqual(res.ok, false);
    assert.ok(/not runnable/.test(res.error || ''), res.error);
  });

  test('a successful npm run that plants no resolvable entry is reported as a failure', async () => {
    const dir = freshDir('noresolve');
    // npm "succeeds" (close 0) but plants nothing, so the entry never resolves.
    const res = await installEmbeddingsProvider({
      targetDir: dir,
      version: '2.17.2',
      spawn: fakeSpawn({ code: 0 }),
    });
    assert.strictEqual(res.ok, false);
    assert.ok(/could not be resolved/.test(res.error || ''), res.error);
  });

  test('env var names are the documented values the loader reads', () => {
    assert.strictEqual(TRANSFORMERS_DIR_ENV, 'AUTOCLAW_TRANSFORMERS_DIR');
    assert.strictEqual(TRANSFORMERS_CACHE_ENV, 'AUTOCLAW_TRANSFORMERS_CACHE');
  });
});
