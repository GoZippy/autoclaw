/**
 * intelligence-installembeddings.test.ts — unit tests for the offline embeddings
 * installer (`installEmbeddings.ts`).
 *
 * The critical regression guard: the install target is conveyed via spawn `cwd`,
 * NEVER `npm install --prefix <dir>` (which breaks on spaced Windows paths under
 * shell:true). These tests inject a fake spawn so nothing real is installed.
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
  type SpawnedChild,
  type SpawnFn,
} from '../intelligence/installEmbeddings';

function tmpDir(prefix = 'ac-instemb-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Plant a minimal fake @xenova/transformers package under <dir>/node_modules. */
function plantFakeTransformers(dir: string): void {
  const pkgDir = path.join(dir, 'node_modules', '@xenova', 'transformers');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@xenova/transformers', version: '2.17.2', main: 'index.js' }));
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {};');
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
}

/**
 * A fake async spawn satisfying {@link SpawnFn}. Records the call, optionally
 * plants the fake package into the spawn's `cwd` (simulating a successful npm
 * install), then emits `close(exitCode)`.
 */
function fakeSpawn(calls: SpawnCall[], opts: { exitCode?: number; plant?: boolean } = {}): SpawnFn {
  const exitCode = opts.exitCode ?? 0;
  return (cmd, args, spawnOpts) => {
    calls.push({ cmd, args, opts: spawnOpts });
    let closeCb: ((code: number | null) => void) | undefined;
    const child: SpawnedChild = {
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      on: (event: string, cb: (arg: never) => void) => {
        if (event === 'close') {
          closeCb = cb as unknown as (code: number | null) => void;
        }
      },
    } as unknown as SpawnedChild;
    setImmediate(() => {
      if (opts.plant && exitCode === 0) {
        plantFakeTransformers(String(spawnOpts.cwd));
      }
      closeCb?.(exitCode);
    });
    return child;
  };
}

suite('installEmbeddings: buildEmbeddingsInstallArgs (no --prefix)', function () {
  test('carries no --prefix and no path argument', function () {
    const args = buildEmbeddingsInstallArgs('2.17.2');
    assert.ok(args.includes('install'));
    assert.ok(args.includes('@xenova/transformers@2.17.2'));
    assert.strictEqual(args.includes('--prefix'), false, 'must NOT use --prefix (breaks on spaced paths)');
    // No arg may be a filesystem PATH (target goes via cwd). The scope slash in
    // "@xenova/transformers@2.17.2" is fine; a backslash or `C:`-drive prefix is not.
    assert.strictEqual(
      args.some((a) => a.includes('\\') || /^[a-zA-Z]:/.test(a) || a.startsWith('/')),
      false,
      'args must contain no filesystem path (target goes via cwd)',
    );
  });
});

suite('installEmbeddings: installEmbeddingsProvider', function () {
  test('passes the target via spawn cwd (absolute), not --prefix', async function () {
    const target = tmpDir();
    const calls: SpawnCall[] = [];
    const result = await installEmbeddingsProvider({
      targetDir: target,
      version: '2.17.2',
      spawn: fakeSpawn(calls, { plant: true }),
    });
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(calls.length, 1, 'npm should be spawned once');
    assert.strictEqual(calls[0].opts.cwd, path.resolve(target), 'cwd must be the resolved target dir');
    assert.strictEqual(calls[0].args.includes('--prefix'), false);
    // package.json must be seeded so npm 7+ treats the dir as a package root.
    assert.ok(fs.existsSync(path.join(target, 'package.json')), 'package.json must be seeded');
    assert.ok(result.entryPath && fs.existsSync(result.entryPath), 'resolved entry must exist');
  });

  test('survives a target path WITH SPACES (cwd carries it intact)', async function () {
    const base = tmpDir();
    const target = path.join(base, 'Zippy Claims', 'native');
    const calls: SpawnCall[] = [];
    const result = await installEmbeddingsProvider({
      targetDir: target,
      version: '2.17.2',
      spawn: fakeSpawn(calls, { plant: true }),
    });
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(calls[0].opts.cwd, path.resolve(target), 'spaced cwd must be passed intact');
    // No argument may contain the spaced path (it would split under shell:true).
    assert.strictEqual(calls[0].args.some((a) => a.includes('Zippy')), false);
  });

  test('is idempotent — already-installed returns ok WITHOUT spawning', async function () {
    const target = tmpDir();
    plantFakeTransformers(target);
    const calls: SpawnCall[] = [];
    const result = await installEmbeddingsProvider({
      targetDir: target,
      version: '2.17.2',
      spawn: fakeSpawn(calls, { plant: false }),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.length, 0, 'must not spawn when already installed');
  });

  test('reports ok=false (no throw) when npm exits non-zero', async function () {
    const target = tmpDir();
    const calls: SpawnCall[] = [];
    const result = await installEmbeddingsProvider({
      targetDir: target,
      version: '2.17.2',
      spawn: fakeSpawn(calls, { exitCode: 1 }),
    });
    assert.strictEqual(result.ok, false);
    assert.ok(/npm exited 1/i.test(result.error ?? ''));
  });

  test('reports ok=false when npm succeeds but plants no resolvable entry', async function () {
    const target = tmpDir();
    const calls: SpawnCall[] = [];
    const result = await installEmbeddingsProvider({
      targetDir: target,
      version: '2.17.2',
      spawn: fakeSpawn(calls, { plant: false }),
    });
    assert.strictEqual(result.ok, false);
    assert.ok(/could not be resolved/i.test(result.error ?? ''));
  });
});

suite('installEmbeddings: resolveInstalledTransformersEntry', function () {
  test('resolves the ESM entry of a planted package, undefined otherwise', function () {
    const target = tmpDir();
    assert.strictEqual(isEmbeddingsInstalled(target), false);
    assert.strictEqual(resolveInstalledTransformersEntry(target), undefined);
    plantFakeTransformers(target);
    assert.ok(isEmbeddingsInstalled(target));
    const entry = resolveInstalledTransformersEntry(target);
    assert.ok(entry && entry.endsWith('index.js'));
  });
});
