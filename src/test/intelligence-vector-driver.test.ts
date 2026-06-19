/**
 * intelligence-vector-driver.test.ts — the ABI-proof SQLite driver layer and the
 * vector-backend preflight/compat surface (the "detect mismatch" hook).
 *
 * Verifies in plain Node (where `node:sqlite` is present, unflagged on Node 24):
 *  - the driver preference order prefers the ABI-proof `node:sqlite`;
 *  - `vectorBackendPreflight` reports healthy + ABI-proof and names the active
 *    driver, with no remediation when the preferred driver loads;
 *  - `probeDriver('node-sqlite')` exercises open + sqlite-vec load + vec0 create;
 *  - `openSqliteDriver` gives a working normalized handle: prepare/exec/query and
 *    a transaction that COMMITs on return and ROLLBACKs on throw;
 *  - the version-controlled compat manifest stays self-consistent.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_DRIVER_ORDER,
  openSqliteDriver,
  probeDriver,
  vectorBackendPreflight,
  NATIVE_COMPAT,
} from '../intelligence/vector';
import { nativeVectorAvailable } from './_vectorBackendAvailable';

// node:sqlite is a Node-core module, but it is FLAGGED before Node 24 and absent
// entirely on Node < 22.5. The plain-Node test runner may be an older Node, so the
// node:sqlite-specific assertions below skip cleanly when the preferred driver is not
// present — the production code falls back to better-sqlite3 there, and the
// driver-agnostic suites (transaction round-trip, compat manifest) still cover it.
let hasNodeSqlite = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('node:sqlite');
  hasNodeSqlite = true;
} catch {
  hasNodeSqlite = false;
}

suite('intelligence-vector-driver', function () {
  let tmpRoot: string;

  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-vecdrv-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  function freshDbPath(): string {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'd-'));
    return path.join(dir, 'db.sqlite').replace(/\\/g, '/');
  }

  test('node:sqlite is the preferred (first) driver — ABI-proof default', function () {
    assert.strictEqual(DEFAULT_DRIVER_ORDER[0], 'node-sqlite');
    assert.strictEqual(NATIVE_COMPAT.preferredDriver, 'node-sqlite');
    assert.strictEqual(NATIVE_COMPAT.betterSqlite3.role, 'fallback');
  });

  test('preflight reports a healthy, ABI-proof backend in plain Node', function () {
    if (!hasNodeSqlite) {
      this.skip();
      return;
    }
    const pf = vectorBackendPreflight();
    assert.strictEqual(pf.healthy, true, 'node:sqlite should make the backend healthy');
    assert.strictEqual(pf.active, 'node-sqlite', 'node:sqlite should be the active driver');
    assert.strictEqual(pf.abiProof, true);
    assert.strictEqual(pf.remediation, null, 'no remediation when the preferred driver loads');
    assert.ok(pf.runtime.node.startsWith('v'), 'runtime captures the node version');
    assert.ok(typeof pf.runtime.modules === 'string' && pf.runtime.modules.length > 0);
    // The shared test gate agrees with the preflight.
    assert.strictEqual(nativeVectorAvailable(), true);
  });

  test('probeDriver(node-sqlite) exercises open + sqlite-vec load + vec0 create', function () {
    if (!hasNodeSqlite) {
      this.skip();
      return;
    }
    const probe = probeDriver('node-sqlite');
    assert.strictEqual(probe.kind, 'node-sqlite');
    assert.strictEqual(probe.available, true, `probe failed: ${probe.error ?? ''}`);
  });

  test('openSqliteDriver yields a working handle: prepare/exec/query', function () {
    if (!hasNodeSqlite) {
      this.skip();
      return;
    }
    const driver = openSqliteDriver(freshDbPath(), () => undefined);
    try {
      assert.strictEqual(driver.kind, 'node-sqlite');
      driver.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)');
      driver.prepare('INSERT INTO t (id, n) VALUES (?, ?)').run('a', 1);
      const row = driver.prepare('SELECT n FROM t WHERE id = ?').get('a');
      assert.strictEqual(Number(row.n), 1);
    } finally {
      driver.close();
    }
  });

  test('transaction COMMITs on return and ROLLBACKs on throw', function () {
    const driver = openSqliteDriver(freshDbPath(), () => undefined);
    try {
      driver.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
      const insert = driver.prepare('INSERT INTO t (id) VALUES (?)');
      const count = () => Number(driver.prepare('SELECT COUNT(*) c FROM t').get().c);

      // Commit path.
      driver.transaction(() => {
        insert.run('x');
        insert.run('y');
      });
      assert.strictEqual(count(), 2, 'committed rows persist');

      // Rollback path — the throw propagates and no partial rows remain.
      assert.throws(() => {
        driver.transaction(() => {
          insert.run('z');
          throw new Error('boom');
        });
      }, /boom/);
      assert.strictEqual(count(), 2, 'a throwing transaction leaves no partial rows');
    } finally {
      driver.close();
    }
  });

  test('compat manifest stays self-consistent', function () {
    assert.ok(/^\d+\.\d+\.\d+$/.test(NATIVE_COMPAT.betterSqlite3.current), 'better-sqlite3 pin is a version');
    assert.ok(/^\d+\.\d+\.\d+$/.test(NATIVE_COMPAT.sqliteVec.current), 'sqlite-vec pin is a version');
    assert.ok(/^\d+\.\d+\.\d+$/.test(NATIVE_COMPAT.nodeSqlite.minNodeVersion), 'min node is a version');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(NATIVE_COMPAT.lastReviewed), 'lastReviewed is an ISO date');
  });
});
