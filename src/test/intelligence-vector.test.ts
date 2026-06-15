/**
 * intelligence-vector.test.ts — unit tests for the sqlite-vec vector store
 * (Phase-1 intelligence-core-loop, Group 3 / tasks 3.1-3.3).
 *
 * Verifies against a REAL sqlite-vec database in an OS temp dir:
 *  - store -> search round-trip returns the stored item with a similarity score
 *    and respects `limit` + `minSimilarity` ordering (R3.2, R3.4)
 *  - project-namespace isolation: another project's vectors never leak (R3.3, D11)
 *  - degraded mode: a forced-unavailable backend makes storeEmbedding a no-op and
 *    semanticVectorSearch return [] without throwing (R3.1)
 *  - the meta row records the active embedding model + dimension
 *
 * Uses `getNoneEmbedding` for deterministic, offline vectors.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { initVectorDB } from '../intelligence/vector';
import { getNoneEmbedding } from '../intelligence/embeddings';
import { EmbeddingSignature } from '../intelligence/types';
import { nativeVectorAvailable } from './_vectorBackendAvailable';

const DIM = 64;
const SIGNATURE: EmbeddingSignature = { model: 'none-test', dimension: DIM };

function embed(text: string): number[] {
  return getNoneEmbedding(text, DIM);
}

let tmpRoot: string;

function freshDbPath(name = 'db.sqlite'): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'vec-'));
  return path.join(dir, name).replace(/\\/g, '/');
}

suite('intelligence-vector', function () {
  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-vector-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

suite('intelligence-vector: store -> search round-trip', function () {
  suiteSetup(function () {
    // Requires a WORKING native backend; skip cleanly where it cannot load
    // (e.g. the Electron integration runner). Runs fully in plain Node.
    if (!nativeVectorAvailable()) {
      this.skip();
    }
  });

  test('stores items and retrieves the closest by similarity, respecting limit', async function () {
    const dbPath = freshDbPath();
    const db = await initVectorDB(dbPath, SIGNATURE);
    assert.strictEqual(db.degraded, false, 'backend should be available (better-sqlite3 + sqlite-vec installed)');

    try {
      await db.storeEmbedding({
        id: 'a',
        content: 'the quick brown fox jumps over the lazy dog',
        embedding: embed('the quick brown fox jumps over the lazy dog'),
        source: 'unit',
        project: 'proj',
        metadata: { tag: 'animals' },
      });
      await db.storeEmbedding({
        id: 'b',
        content: 'compiling typescript with strict mode enabled',
        embedding: embed('compiling typescript with strict mode enabled'),
        source: 'unit',
        project: 'proj',
      });
      await db.storeEmbedding({
        id: 'c',
        content: 'database indexes accelerate query performance',
        embedding: embed('database indexes accelerate query performance'),
        source: 'unit',
        project: 'proj',
      });

      const results = await db.semanticVectorSearch(
        embed('the quick brown fox jumps over the lazy dog'),
        { project: 'proj', limit: 10, minSimilarity: 0 },
      );

      assert.ok(results.length >= 1, 'at least the exact match should be returned');
      assert.strictEqual(results[0].id, 'a', 'exact match should rank first');
      assert.ok(results[0].score > 0.99, `exact match score should be ~1, got ${results[0].score}`);
      assert.strictEqual(results[0].content, 'the quick brown fox jumps over the lazy dog');
      assert.deepStrictEqual(results[0].metadata, { tag: 'animals' });

      // Scores are returned in descending order (distance ascending).
      for (let i = 1; i < results.length; i++) {
        assert.ok(
          results[i - 1].score >= results[i].score,
          `results must be ordered by descending similarity (${results[i - 1].score} >= ${results[i].score})`,
        );
      }

      // limit is respected.
      const limited = await db.semanticVectorSearch(embed('the quick brown fox jumps over the lazy dog'), {
        project: 'proj',
        limit: 1,
        minSimilarity: 0,
      });
      assert.strictEqual(limited.length, 1, 'limit=1 must cap the result set');
      assert.strictEqual(limited[0].id, 'a');
    } finally {
      db.close();
    }
  });

  test('minSimilarity filters out weak matches', async function () {
    const dbPath = freshDbPath();
    const db = await initVectorDB(dbPath, SIGNATURE);
    try {
      await db.storeEmbedding({
        id: 'x',
        content: 'alpha beta gamma delta',
        embedding: embed('alpha beta gamma delta'),
        source: 'unit',
        project: 'proj',
      });

      // A query that shares no tokens should score low; minSimilarity ~1 drops it.
      const strict = await db.semanticVectorSearch(embed('completely unrelated content here'), {
        project: 'proj',
        minSimilarity: 0.99,
      });
      assert.strictEqual(strict.length, 0, 'a high minSimilarity threshold must filter weak matches');

      // The same query with no floor still returns the only item.
      const loose = await db.semanticVectorSearch(embed('completely unrelated content here'), {
        project: 'proj',
        minSimilarity: -1,
      });
      assert.ok(loose.length >= 1, 'a low threshold should retain the stored item');
    } finally {
      db.close();
    }
  });

  test('meta row records the active embedding model and dimension', async function () {
    const dbPath = freshDbPath();
    const db = await initVectorDB(dbPath, SIGNATURE);
    db.close();

    assert.ok(fs.existsSync(dbPath), 'db.sqlite file should be persisted');

    // Re-open with a raw handle to read the meta row — decoupled from which driver
    // initVectorDB chose. Prefer the ABI-proof node:sqlite, but fall back to
    // better-sqlite3 on hosts where node:sqlite is flagged/absent (Node < 24), so the
    // assertion runs in every runtime instead of throwing ERR_UNKNOWN_BUILTIN_MODULE.
    let raw: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseSync } = require('node:sqlite');
      raw = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      raw = new Database(dbPath, { readonly: true });
    }
    try {
      const model = raw.prepare(`SELECT value FROM meta WHERE key = ?`).get('model');
      const dimension = raw.prepare(`SELECT value FROM meta WHERE key = ?`).get('dimension');
      assert.strictEqual(model.value, 'none-test');
      assert.strictEqual(dimension.value, String(DIM));
    } finally {
      raw.close();
    }
  });
});

suite('intelligence-vector: project namespace isolation (D11)', function () {
  suiteSetup(function () {
    if (!nativeVectorAvailable()) {
      this.skip();
    }
  });

  test('vectors stored under project A are not returned when searching project B', async function () {
    const dbPath = freshDbPath();
    const db = await initVectorDB(dbPath, SIGNATURE);
    try {
      await db.storeEmbedding({
        id: 'a-only',
        content: 'secret notes for project alpha',
        embedding: embed('secret notes for project alpha'),
        source: 'unit',
        project: 'projectA',
      });
      await db.storeEmbedding({
        id: 'b-only',
        content: 'secret notes for project beta',
        embedding: embed('secret notes for project beta'),
        source: 'unit',
        project: 'projectB',
      });

      const fromB = await db.semanticVectorSearch(embed('secret notes for project alpha'), {
        project: 'projectB',
        minSimilarity: -1,
      });
      assert.ok(
        fromB.every((r) => r.project === 'projectB'),
        'searching project B must never return project A vectors',
      );
      assert.ok(
        !fromB.some((r) => r.id === 'a-only'),
        "project A's item must not leak into project B results",
      );

      const fromA = await db.semanticVectorSearch(embed('secret notes for project alpha'), {
        project: 'projectA',
        minSimilarity: -1,
      });
      assert.ok(
        fromA.some((r) => r.id === 'a-only'),
        'project A search should find its own item',
      );
    } finally {
      db.close();
    }
  });
});

suite('intelligence-vector: degraded mode (R3.1)', function () {
  test('an unopenable db path yields a degraded no-op handle that never throws', async function () {
    // Create a regular file, then point the db path *through* it as if it were a
    // directory. ensureDir / DB open then fails, forcing the degraded path.
    const blocker = path.join(fs.mkdtempSync(path.join(tmpRoot, 'blk-')), 'not-a-dir');
    fs.writeFileSync(blocker, 'i am a file');
    const dbPath = `${blocker.replace(/\\/g, '/')}/nested/db.sqlite`;

    const warnings: string[] = [];
    const db = await initVectorDB(dbPath, SIGNATURE, (m) => warnings.push(m));

    assert.strictEqual(db.degraded, true, 'an unopenable path must produce a degraded handle');
    assert.ok(
      warnings.some((w) => /vector backend unavailable/i.test(w)),
      `expected a degrade warning, got: ${JSON.stringify(warnings)}`,
    );

    // storeEmbedding is a no-op and must not throw.
    await db.storeEmbedding({
      id: 'z',
      content: 'anything',
      embedding: embed('anything'),
      source: 'unit',
      project: 'proj',
    });

    // semanticVectorSearch returns [] and must not throw.
    const results = await db.semanticVectorSearch(embed('anything'), { project: 'proj' });
    assert.deepStrictEqual(results, [], 'degraded search must return an empty array');

    db.close(); // must not throw
  });
});

}); // suite('intelligence-vector')
