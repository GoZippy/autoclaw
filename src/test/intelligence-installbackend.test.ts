/**
 * intelligence-installbackend.test.ts — unit tests for the vector-backend
 * installer (`installVectorBackend`) that powers
 * `autoclaw.intelligence.installBackend`.
 *
 * Hermetic: builds a FAKE `sqlite-vec` package on disk (so `require` + a real
 * `getLoadablePath()` resolve) and injects the `spawn` so npm is never actually
 * run. No network, no native modules.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildInstallArgs,
  installVectorBackend,
  isBackendInstalled,
  resolveInstalledLoadable,
  VEC_DIR_ENV,
} from '../intelligence/installBackend';

let tmpRoot: string;

function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}

/** Plant a fake `sqlite-vec` whose getLoadablePath points at a real file. */
function plantFakeSqliteVec(targetDir: string): string {
  const pkgDir = path.join(targetDir, 'node_modules', 'sqlite-vec');
  fs.mkdirSync(pkgDir, { recursive: true });
  const loadable = path.join(pkgDir, 'vec0.fake');
  fs.writeFileSync(loadable, 'binary', 'utf8');
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'sqlite-vec', version: '0.0.0', main: 'index.js' }), 'utf8');
  fs.writeFileSync(
    path.join(pkgDir, 'index.js'),
    `module.exports.getLoadablePath = () => ${JSON.stringify(loadable)};\n`,
    'utf8',
  );
  return loadable;
}

suite('intelligence — install vector backend', () => {
  suiteSetup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-installbackend-'));
  });
  suiteTeardown(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('buildInstallArgs pins the version and installs into the target prefix without saving', () => {
    const args = buildInstallArgs('/tmp/peer', '0.1.6');
    assert.deepStrictEqual(args, [
      'install',
      'sqlite-vec@0.1.6',
      '--prefix',
      '/tmp/peer',
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ]);
  });

  test('resolveInstalledLoadable / isBackendInstalled find a planted sqlite-vec, and miss an empty dir', () => {
    const empty = freshDir('empty');
    assert.strictEqual(resolveInstalledLoadable(empty), undefined);
    assert.strictEqual(isBackendInstalled(empty), false);

    const withPeer = freshDir('with');
    const loadable = plantFakeSqliteVec(withPeer);
    assert.strictEqual(resolveInstalledLoadable(withPeer), loadable);
    assert.strictEqual(isBackendInstalled(withPeer), true);
  });

  test('install is idempotent: a present backend returns ok WITHOUT spawning npm', () => {
    const dir = freshDir('idem');
    const loadable = plantFakeSqliteVec(dir);
    let spawned = false;
    const spawnSpy: any = () => {
      spawned = true;
      return { status: 0 };
    };
    const res = installVectorBackend({ targetDir: dir, version: '0.1.6', spawn: spawnSpy });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.loadablePath, loadable);
    assert.strictEqual(spawned, false, 'must short-circuit when already installed');
  });

  test('a non-zero npm exit surfaces as ok:false with the stderr', () => {
    const dir = freshDir('fail');
    const spawnSpy: any = () => ({ status: 1, stderr: 'ENOTFOUND registry.npmjs.org' });
    const res = installVectorBackend({ targetDir: dir, version: '0.1.6', spawn: spawnSpy });
    assert.strictEqual(res.ok, false);
    assert.ok(/npm exited 1/.test(res.error || ''));
    assert.ok(/ENOTFOUND/.test(res.error || ''));
  });

  test('an unrunnable npm (spawn error) surfaces as ok:false', () => {
    const dir = freshDir('noexec');
    const spawnSpy: any = () => ({ error: new Error('spawn npm ENOENT') });
    const res = installVectorBackend({ targetDir: dir, version: '0.1.6', spawn: spawnSpy });
    assert.strictEqual(res.ok, false);
    assert.ok(/not runnable/.test(res.error || ''));
  });

  test('a successful npm run that yields no resolvable loadable is reported as a failure', () => {
    const dir = freshDir('noloadable');
    // npm "succeeds" but plants nothing, so resolveInstalledLoadable stays empty.
    const spawnSpy: any = () => ({ status: 0 });
    const res = installVectorBackend({ targetDir: dir, version: '0.1.6', spawn: spawnSpy });
    assert.strictEqual(res.ok, false);
    assert.ok(/could not be resolved/.test(res.error || ''));
  });

  test('VEC_DIR_ENV is the documented env var the loader reads', () => {
    assert.strictEqual(VEC_DIR_ENV, 'AUTOCLAW_SQLITE_VEC_DIR');
  });
});
