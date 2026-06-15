/**
 * intelligence-dimensionguard.test.ts — unit tests for the embedding-signature
 * migration guard (intelligence-backend-flexibility, task 4.3 / R3.1-R3.3).
 *
 * Verifies:
 *  - `checkSignature` reports ok vs mismatch on model OR dimension change
 *  - `requireForceOnMismatch` throws a clear error on an unforced mismatch and
 *    passes through when forced or already ok (R3.2)
 *  - `migrateToNewSignature`:
 *      * is a no-op when signatures already match
 *      * refuses to migrate without `force`
 *      * reindexes into a FRESH namespace, retiring the old one only AFTER the
 *        reindex succeeds (R3.3)
 *      * keeps the old namespace when the reindex FAILS (never calls dropOld)
 *
 * Pure functions with injected reindex/dropOld callbacks — runs in plain Node.
 */

import * as assert from 'assert';

import { EmbeddingSignature } from '../intelligence/types';
import {
  checkSignature,
  requireForceOnMismatch,
  migrateToNewSignature,
  SignatureMismatchError,
} from '../intelligence/vector/dimensionGuard';

const SIG_A: EmbeddingSignature = { model: 'model-a', dimension: 768 };
const SIG_A_BIGGER: EmbeddingSignature = { model: 'model-a', dimension: 1024 };
const SIG_B: EmbeddingSignature = { model: 'model-b', dimension: 768 };

suite('intelligence-dimensionguard', function () {
  suite('checkSignature', function () {
    test('returns ok for identical signatures', function () {
      assert.strictEqual(checkSignature(SIG_A, { ...SIG_A }), 'ok');
    });
    test('returns mismatch on a model change', function () {
      assert.strictEqual(checkSignature(SIG_A, SIG_B), 'mismatch');
    });
    test('returns mismatch on a dimension change', function () {
      assert.strictEqual(checkSignature(SIG_A, SIG_A_BIGGER), 'mismatch');
    });
  });

  suite('requireForceOnMismatch', function () {
    test('throws a SignatureMismatchError on an unforced mismatch', function () {
      assert.throws(
        () => requireForceOnMismatch(SIG_A, SIG_B, false),
        (err: unknown) => {
          assert.ok(err instanceof SignatureMismatchError, 'expected SignatureMismatchError');
          assert.ok(/--force/.test((err as Error).message), 'message should mention --force');
          return true;
        },
      );
    });
    test('passes through (mismatch) when forced', function () {
      assert.strictEqual(requireForceOnMismatch(SIG_A, SIG_B, true), 'mismatch');
    });
    test('passes through (ok) when signatures match, force irrelevant', function () {
      assert.strictEqual(requireForceOnMismatch(SIG_A, { ...SIG_A }, false), 'ok');
    });
  });

  suite('migrateToNewSignature', function () {
    test('is a no-op when signatures already match', async function () {
      let reindexCalled = false;
      const result = await migrateToNewSignature({
        projectKey: '/repo',
        stored: SIG_A,
        active: { ...SIG_A },
        force: true,
        reindex: async () => {
          reindexCalled = true;
          return 0;
        },
      });
      assert.strictEqual(result.migrated, false, 'no migration when signatures match');
      assert.strictEqual(reindexCalled, false, 'reindex must not run');
    });

    test('refuses to migrate a mismatch without force', async function () {
      let reindexCalled = false;
      await assert.rejects(
        () =>
          migrateToNewSignature({
            projectKey: '/repo',
            stored: SIG_A,
            active: SIG_B,
            force: false,
            reindex: async () => {
              reindexCalled = true;
              return 1;
            },
          }),
        SignatureMismatchError,
      );
      assert.strictEqual(reindexCalled, false, 'reindex must not run without force');
    });

    test('reindexes into a fresh namespace and retires the old one AFTER success', async function () {
      const order: string[] = [];
      let reindexTarget = '';
      let dropTarget = '';

      const result = await migrateToNewSignature({
        projectKey: '/repo',
        stored: SIG_A,
        active: SIG_B,
        force: true,
        reindex: async (newNamespace) => {
          order.push('reindex');
          reindexTarget = newNamespace;
          return 42;
        },
        dropOld: async (oldNamespace) => {
          order.push('drop');
          dropTarget = oldNamespace;
          return 10;
        },
      });

      assert.strictEqual(result.migrated, true);
      assert.deepStrictEqual(order, ['reindex', 'drop'], 'reindex must complete before drop');
      assert.notStrictEqual(
        reindexTarget,
        dropTarget,
        'the new namespace must differ from the old one',
      );
      assert.ok(reindexTarget.includes('model-b'), 'new namespace reflects the active model');
      assert.ok(dropTarget.includes('model-a'), 'old namespace reflects the stored model');
      assert.strictEqual(result.reindexed, 42);
      assert.strictEqual(result.oldDropped, 10);
      assert.strictEqual(result.oldKept, false);
    });

    test('keeps the old namespace when the reindex FAILS (R3.3)', async function () {
      let dropCalled = false;
      await assert.rejects(
        () =>
          migrateToNewSignature({
            projectKey: '/repo',
            stored: SIG_A,
            active: SIG_B,
            force: true,
            reindex: async () => {
              throw new Error('reindex blew up');
            },
            dropOld: async () => {
              dropCalled = true;
              return 1;
            },
          }),
        /reindex blew up/,
      );
      assert.strictEqual(dropCalled, false, 'old namespace must survive a failed reindex');
    });

    test('retains the old namespace when no dropOld is supplied', async function () {
      const result = await migrateToNewSignature({
        projectKey: '/repo',
        stored: SIG_A,
        active: SIG_B,
        force: true,
        reindex: async () => 7,
      });
      assert.strictEqual(result.migrated, true);
      assert.strictEqual(result.oldKept, true, 'old namespace retained without dropOld');
      assert.strictEqual(result.oldDropped, 0);
    });
  });
});
