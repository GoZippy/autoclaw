/**
 * intelligence-foundation.test.ts — unit tests for the Phase-0 Intelligence
 * skeleton: config load/merge/validation, the `.autoclaw/` path contract +
 * ensureDir, and the advisory file lock (acquire / contention / timeout /
 * double-release).
 *
 * Pure-logic tests — no vscode, no extension host. All filesystem work happens
 * in an OS temp dir that is removed in teardown.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_CONFIG,
  defaultConfig,
  loadConfig,
  getActiveEmbeddingSignature,
} from '../intelligence/config';
import {
  intelligencePaths,
  ensureDir,
  isInsideContract,
  toForwardSlash,
} from '../intelligence/paths';
import { acquireLock, lockDirFor } from '../intelligence/fileLock';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-intel-'));
}

function writeConfig(root: string, obj: unknown): void {
  const { vectorDir, configPath } = intelligencePaths(root);
  fs.mkdirSync(vectorDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(obj), 'utf8');
}

function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

suite('intelligence-foundation: config', function () {
  let root: string;
  setup(function () {
    root = makeTempRoot();
  });
  teardown(function () {
    rmrf(root);
  });

  test('returns defaults when no config file exists (and writes nothing)', function () {
    const cfg = loadConfig(root);
    assert.deepStrictEqual(cfg, defaultConfig());
    // No file should have been created.
    const { configPath } = intelligencePaths(root);
    assert.strictEqual(fs.existsSync(configPath), false, 'loadConfig must not write a file');
  });

  test('defaultConfig returns a fresh, mutation-safe copy', function () {
    const a = defaultConfig();
    a.search.defaultLimit = 999;
    a.rag.ignoredDirs.push('zzz');
    assert.strictEqual(DEFAULT_CONFIG.search.defaultLimit, 10, 'module constant must not mutate');
    assert.ok(!DEFAULT_CONFIG.rag.ignoredDirs.includes('zzz'));
  });

  test('deep-merges a partial config over defaults', function () {
    writeConfig(root, { search: { defaultLimit: 5 }, embedding: { provider: 'none' } });
    const cfg = loadConfig(root);
    assert.strictEqual(cfg.search.defaultLimit, 5, 'override applied');
    assert.strictEqual(cfg.search.minSimilarity, DEFAULT_CONFIG.search.minSimilarity, 'sibling default kept');
    assert.strictEqual(cfg.embedding.provider, 'none', 'embedding override applied');
    assert.strictEqual(cfg.embedding.model, DEFAULT_CONFIG.embedding.model, 'embedding sibling default kept');
    assert.strictEqual(cfg.backend, DEFAULT_CONFIG.backend, 'untouched top-level default kept');
  });

  test('replaces invalid fields with defaults and reports warnings', function () {
    const warnings: string[] = [];
    writeConfig(root, {
      backend: 'bogus',
      embedding: { provider: 'nope', dimension: -1 },
      search: { minSimilarity: 5, defaultLimit: 0 },
      rag: { incremental: 'yes' },
    });
    const cfg = loadConfig(root, (m) => warnings.push(m));
    assert.strictEqual(cfg.backend, DEFAULT_CONFIG.backend);
    assert.strictEqual(cfg.embedding.provider, DEFAULT_CONFIG.embedding.provider);
    assert.strictEqual(cfg.embedding.dimension, DEFAULT_CONFIG.embedding.dimension);
    assert.strictEqual(cfg.search.minSimilarity, DEFAULT_CONFIG.search.minSimilarity);
    assert.strictEqual(cfg.search.defaultLimit, DEFAULT_CONFIG.search.defaultLimit);
    assert.strictEqual(cfg.rag.incremental, DEFAULT_CONFIG.rag.incremental);
    assert.ok(warnings.length >= 5, `expected several warnings, got ${warnings.length}`);
  });

  test('never throws on invalid JSON; degrades to defaults with a warning', function () {
    const { vectorDir, configPath } = intelligencePaths(root);
    fs.mkdirSync(vectorDir, { recursive: true });
    fs.writeFileSync(configPath, '{ not valid json', 'utf8');
    const warnings: string[] = [];
    const cfg = loadConfig(root, (m) => warnings.push(m));
    assert.deepStrictEqual(cfg, defaultConfig());
    assert.ok(warnings.some((w) => /invalid JSON/i.test(w)), 'expected an invalid-JSON warning');
  });

  test('accepts a valid postgres backend block', function () {
    writeConfig(root, { backend: 'postgres', postgres: { connectionString: 'postgres://x/y' } });
    const cfg = loadConfig(root);
    assert.strictEqual(cfg.backend, 'postgres');
    assert.deepStrictEqual(cfg.postgres, { connectionString: 'postgres://x/y' });
  });

  test('getActiveEmbeddingSignature reflects the active model + dimension', function () {
    const sig = getActiveEmbeddingSignature(defaultConfig());
    assert.deepStrictEqual(sig, { model: 'Xenova/nomic-embed-text-v1.5', dimension: 768 });
  });
});

suite('intelligence-foundation: paths', function () {
  let root: string;
  setup(function () {
    root = makeTempRoot();
  });
  teardown(function () {
    rmrf(root);
  });

  test('resolves the contract under <root>/.autoclaw with forward slashes', function () {
    const p = intelligencePaths(root);
    assert.ok(p.configPath.endsWith('.autoclaw/vector/config.json'), p.configPath);
    assert.ok(p.dbPath.endsWith('.autoclaw/vector/db.sqlite'), p.dbPath);
    assert.ok(p.locksDir.endsWith('.autoclaw/.locks'), p.locksDir);
    assert.ok(p.memoryPath.endsWith('.autoclaw/kdream/memory/MEMORY.md'), p.memoryPath);
    for (const v of Object.values(p)) {
      assert.ok(!v.includes('\\'), `path should use forward slashes: ${v}`);
    }
  });

  test('ensureDir creates nested dirs idempotently', async function () {
    const target = path.join(root, '.autoclaw', 'vector', 'nested');
    await ensureDir(target);
    assert.ok(fs.existsSync(target));
    await ensureDir(target); // second call is a no-op, must not throw
    assert.ok(fs.existsSync(target));
  });

  test('isInsideContract guards against escaping the .autoclaw root', function () {
    assert.strictEqual(isInsideContract(root, path.join(root, '.autoclaw', 'vector', 'db.sqlite')), true);
    assert.strictEqual(isInsideContract(root, path.join(root, '.autoclaw')), true);
    assert.strictEqual(isInsideContract(root, path.join(root, 'elsewhere.txt')), false);
    assert.strictEqual(isInsideContract(root, path.join(root, '.autoclaw', '..', '..', 'etc')), false);
  });

  test('toForwardSlash normalizes backslashes', function () {
    assert.strictEqual(toForwardSlash('a\\b\\c'), 'a/b/c');
  });
});

suite('intelligence-foundation: fileLock', function () {
  let root: string;
  let target: string;
  setup(function () {
    root = makeTempRoot();
    target = path.join(root, '.autoclaw', 'vector', 'config.json');
  });
  teardown(function () {
    rmrf(root);
  });

  test('acquires a lock and releases it', async function () {
    const release = await acquireLock(target, 2000);
    assert.ok(fs.existsSync(lockDirFor(target)), 'lock dir should exist while held');
    release();
    assert.ok(!fs.existsSync(lockDirFor(target)), 'lock dir should be gone after release');
  });

  test('blocks a second acquire until the first releases', async function () {
    const first = await acquireLock(target, 2000);
    let secondAcquired = false;
    const secondPromise = acquireLock(target, 3000).then((rel) => {
      secondAcquired = true;
      return rel;
    });
    // Give the contender a moment; it must still be waiting.
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(secondAcquired, false, 'second acquire must wait while lock is held');
    first();
    const secondRelease = await secondPromise;
    assert.strictEqual(secondAcquired, true, 'second acquire should succeed after release');
    secondRelease();
  });

  test('times out with a descriptive error naming the contended path', async function () {
    const release = await acquireLock(target, 2000);
    try {
      await acquireLock(target, 300);
      assert.fail('expected a lock timeout');
    } catch (err) {
      const msg = (err as Error).message;
      assert.ok(/lock timeout/i.test(msg), `message should mention timeout: ${msg}`);
      assert.ok(msg.includes(toForwardSlash(target)), `message should name the path: ${msg}`);
    } finally {
      release();
    }
  });

  test('double-release is a no-op and never throws', async function () {
    const release = await acquireLock(target, 2000);
    release();
    assert.doesNotThrow(() => release(), 'second release must not throw');
  });
});
