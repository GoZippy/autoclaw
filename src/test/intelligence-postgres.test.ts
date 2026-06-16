/**
 * intelligence-postgres.test.ts — contract-parity tests for the pgvector backend
 * (intelligence-backend-flexibility, task 2.3 / R1.1-R1.3).
 *
 * GATED: the whole suite is skipped unless `process.env.TEST_PG_URL` points at a
 * disposable Postgres database with the `vector` extension available. This keeps
 * `test:unit` green on machines without a test DB (R5.1 — `pg` stays optional).
 *
 * When a DB is present it verifies the SAME store -> search round-trip, project
 * isolation, and degraded-mode contract the sqlite-vec suite asserts, proving the
 * backend is swappable by config alone.
 *
 * Run with, e.g.:
 *   TEST_PG_URL=postgres://user:pass@localhost:5432/autoclaw_test npm run test:unit
 */

import * as assert from 'assert';

import { initPostgresDB } from '../intelligence/vector/postgres';
import { getNoneEmbedding } from '../intelligence/embeddings';
import { EmbeddingSignature } from '../intelligence/types';

const PG_URL = process.env.TEST_PG_URL;
const DIM = 64;
const SIGNATURE: EmbeddingSignature = { model: 'none-test', dimension: DIM };

function embed(text: string): number[] {
  return getNoneEmbedding(text, DIM);
}

suite('intelligence-postgres', function () {
  // pgvector ops + an ANN index build can exceed the default mocha timeout.
  this.timeout(60000);

  suite('pgvector store -> search round-trip', function () {
    suiteSetup(function () {
      if (!PG_URL) {
        this.skip();
      }
    });

    test('stores items and retrieves the closest by similarity, respecting limit', async function () {
      const db = await initPostgresDB(PG_URL as string, SIGNATURE);
      assert.strictEqual(db.degraded, false, 'backend should be available (pg + pgvector reachable)');
      try {
        // Clean any prior rows for a deterministic assertion.
        await db.deleteByIdPrefix('pg-test:');

        await db.storeEmbeddings([
          {
            id: 'pg-test:a',
            content: 'the quick brown fox jumps over the lazy dog',
            embedding: embed('the quick brown fox jumps over the lazy dog'),
            source: 'unit',
            project: 'proj',
            metadata: { tag: 'animals' },
          },
          {
            id: 'pg-test:b',
            content: 'compiling typescript with strict mode enabled',
            embedding: embed('compiling typescript with strict mode enabled'),
            source: 'unit',
            project: 'proj',
          },
        ]);

        const results = await db.semanticVectorSearch(
          embed('the quick brown fox jumps over the lazy dog'),
          { project: 'proj', limit: 10, minSimilarity: 0 },
        );
        assert.ok(results.length >= 1, 'at least the exact match should be returned');
        assert.strictEqual(results[0].id, 'pg-test:a', 'exact match should rank first');
        assert.ok(results[0].score > 0.99, `exact match score should be ~1, got ${results[0].score}`);
        assert.deepStrictEqual(results[0].metadata, { tag: 'animals' });

        const limited = await db.semanticVectorSearch(
          embed('the quick brown fox jumps over the lazy dog'),
          { project: 'proj', limit: 1, minSimilarity: 0 },
        );
        assert.strictEqual(limited.length, 1, 'limit=1 must cap the result set');
      } finally {
        await db.deleteByIdPrefix('pg-test:');
        db.close();
      }
    });

    test('project namespace isolation (D11) — A vectors never leak into B', async function () {
      const db = await initPostgresDB(PG_URL as string, SIGNATURE);
      try {
        await db.deleteByIdPrefix('pg-iso:');
        await db.storeEmbeddings([
          {
            id: 'pg-iso:a',
            content: 'secret notes for project alpha',
            embedding: embed('secret notes for project alpha'),
            source: 'unit',
            project: 'projectA',
          },
          {
            id: 'pg-iso:b',
            content: 'secret notes for project beta',
            embedding: embed('secret notes for project beta'),
            source: 'unit',
            project: 'projectB',
          },
        ]);

        const fromB = await db.semanticVectorSearch(embed('secret notes for project alpha'), {
          project: 'projectB',
          minSimilarity: -1,
        });
        assert.ok(
          fromB.every((r) => r.project === 'projectB'),
          'searching project B must never return project A vectors',
        );
        assert.ok(!fromB.some((r) => r.id === 'pg-iso:a'), "project A's item must not leak");
      } finally {
        await db.deleteByIdPrefix('pg-iso:');
        db.close();
      }
    });
  });

  suite('pgvector degraded mode (R1.3)', function () {
    test('an unreachable connection yields a degraded no-op handle that never throws', async function () {
      const warnings: string[] = [];
      // Port 1 is reserved and never listening — connect must fail fast.
      const db = await initPostgresDB(
        'postgres://user:pass@127.0.0.1:1/nope',
        SIGNATURE,
        (m) => warnings.push(m),
      );
      assert.strictEqual(db.degraded, true, 'an unreachable DB must produce a degraded handle');
      assert.ok(
        warnings.some((w) => /vector backend unavailable/i.test(w)),
        `expected a degrade warning, got: ${JSON.stringify(warnings)}`,
      );
      await db.storeEmbedding({
        id: 'z',
        content: 'anything',
        embedding: embed('anything'),
        source: 'unit',
        project: 'proj',
      });
      const results = await db.semanticVectorSearch(embed('anything'), { project: 'proj' });
      assert.deepStrictEqual(results, [], 'degraded search must return an empty array');
      db.close();
    });
  });
});
