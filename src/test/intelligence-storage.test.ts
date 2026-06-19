/**
 * intelligence-storage.test.ts — user-controllable storage locations + the
 * status snapshot (autoclaw.intelligence.status / install backendDir).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolveBackendDir,
  systemPaths,
  pathSizeBytes,
  formatBytes,
  gatherStorageStatus,
  relocateStore,
} from '../intelligence/storage';

let tmpRoot: string;
function freshDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, `${prefix}-`));
}
const fwd = (p: string) => p.replace(/\\/g, '/');

suite('intelligence — storage locations + status', () => {
  suiteSetup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-storage-'));
  });
  suiteTeardown(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  suite('resolveBackendDir', () => {
    test('defaults PROJECT-LOCAL under <workspace>/.autoclaw/native (never C:)', () => {
      const dir = resolveBackendDir('K:/proj/demo', undefined, 'C:/Users/x/AppData/globalStorage');
      assert.strictEqual(dir, 'K:/proj/demo/.autoclaw/native');
    });
    test('an explicit override wins over the project-local default', () => {
      const dir = resolveBackendDir('K:/proj/demo', 'D:/shared/ac-backend');
      assert.strictEqual(dir, fwd(path.resolve('D:/shared/ac-backend')));
    });
    test('falls back to globalStorage only when there is no workspace', () => {
      const dir = resolveBackendDir(undefined, undefined, 'C:/gs');
      assert.strictEqual(dir, 'C:/gs/native');
    });
  });

  suite('systemPaths', () => {
    test('undefined when no system dir is configured (tier disabled)', () => {
      assert.strictEqual(systemPaths(undefined), undefined);
      assert.strictEqual(systemPaths('   '), undefined);
    });
    test('resolves the system tier paths under the chosen dir', () => {
      const sp = systemPaths('K:/autoclaw-intelligence');
      assert.ok(sp);
      assert.strictEqual(sp.dbPath, fwd(path.resolve('K:/autoclaw-intelligence/vector/db.sqlite')));
      assert.strictEqual(sp.registryPath, fwd(path.resolve('K:/autoclaw-intelligence/projects.json')));
    });
  });

  suite('pathSizeBytes + formatBytes', () => {
    test('0 for an absent path; sums a directory tree', () => {
      assert.strictEqual(pathSizeBytes(path.join(tmpRoot, 'nope')), 0);
      const d = freshDir('sz');
      fs.writeFileSync(path.join(d, 'a.bin'), Buffer.alloc(1000));
      fs.mkdirSync(path.join(d, 'sub'));
      fs.writeFileSync(path.join(d, 'sub', 'b.bin'), Buffer.alloc(24));
      assert.strictEqual(pathSizeBytes(d), 1024);
    });
    test('formatBytes is human-readable', () => {
      assert.strictEqual(formatBytes(0), '0 B');
      assert.strictEqual(formatBytes(512), '512 B');
      assert.strictEqual(formatBytes(1024), '1.0 KB');
      assert.strictEqual(formatBytes(1024 * 1024), '1.0 MB');
    });
  });

  suite('gatherStorageStatus', () => {
    test('assembles paths, sizes, watermark, backend + system flags', () => {
      const ws = freshDir('ws');
      const contractRoot = path.join(ws, '.autoclaw');
      const vectorDir = path.join(contractRoot, 'vector');
      fs.mkdirSync(vectorDir, { recursive: true });
      const dbPath = path.join(vectorDir, 'db.sqlite');
      fs.writeFileSync(dbPath, Buffer.alloc(2048));
      const lastIndexPath = path.join(vectorDir, 'last-index.json');
      fs.writeFileSync(
        lastIndexPath,
        JSON.stringify({ [ws]: { commit: 'abcdef1234', indexedAt: '2026-06-16T02:41:21Z' } }),
      );
      const backendDir = path.join(contractRoot, 'native');

      const status = gatherStorageStatus({
        workspaceRoot: ws,
        contractRoot,
        dbPath,
        lastIndexPath,
        backendDir,
        backendInstalled: false,
        systemDir: undefined,
      });

      assert.strictEqual(status.projectRoot.exists, true);
      assert.strictEqual(status.index.dbSizeBytes, 2048);
      assert.strictEqual(status.index.commit, 'abcdef1234');
      assert.strictEqual(status.index.indexedAt, '2026-06-16T02:41:21Z');
      assert.strictEqual(status.backend.installed, false);
      assert.strictEqual(status.system.enabled, false);
    });

    test('reflects an enabled system tier when a system dir is set', () => {
      const ws = freshDir('ws2');
      const sysDir = freshDir('sys');
      const paths = {
        contractRoot: path.join(ws, '.autoclaw'),
        dbPath: path.join(ws, '.autoclaw', 'vector', 'db.sqlite'),
        lastIndexPath: path.join(ws, '.autoclaw', 'vector', 'last-index.json'),
      };
      const status = gatherStorageStatus({
        workspaceRoot: ws,
        contractRoot: paths.contractRoot,
        dbPath: paths.dbPath,
        lastIndexPath: paths.lastIndexPath,
        backendDir: path.join(ws, '.autoclaw', 'native'),
        backendInstalled: false,
        systemDir: sysDir,
      });
      assert.strictEqual(status.system.enabled, true);
      assert.strictEqual((status.system as { path: string }).path, fwd(sysDir));
      // no index yet → zero size, no watermark
      assert.strictEqual(status.index.dbSizeBytes, 0);
      assert.strictEqual(status.index.indexedAt, undefined);
    });
  });

  suite('relocateStore', () => {
    test('moves a store dir to a new location and removes the source', () => {
      const base = freshDir('reloc');
      const oldDir = path.join(base, 'native');
      fs.mkdirSync(path.join(oldDir, 'node_modules', 'sqlite-vec'), { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'node_modules', 'sqlite-vec', 'vec0.bin'), Buffer.alloc(512));
      const newDir = path.join(base, 'moved');

      const res = relocateStore(oldDir, newDir);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.movedBytes, 512);
      assert.ok(fs.existsSync(path.join(newDir, 'node_modules', 'sqlite-vec', 'vec0.bin')), 'copied');
      assert.strictEqual(fs.existsSync(oldDir), false, 'source removed');
    });

    test('same source/dest is a no-op success', () => {
      const d = freshDir('same');
      const res = relocateStore(d, d);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.movedBytes, 0);
      assert.strictEqual(fs.existsSync(d), true);
    });

    test('a missing source returns ok:false (never throws)', () => {
      const res = relocateStore(path.join(tmpRoot, 'ghost'), path.join(tmpRoot, 'dest'));
      assert.strictEqual(res.ok, false);
      assert.ok(/does not exist/.test(res.error || ''));
    });
  });
});
