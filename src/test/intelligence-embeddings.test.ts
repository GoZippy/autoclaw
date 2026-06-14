/**
 * intelligence-embeddings.test.ts — unit tests for the embeddings module
 * (Phase-1 intelligence-core-loop, Task 2.2).
 *
 * Verifies:
 *  - `none` provider deterministic, correct dimension, empty-text zero vector
 *  - `transformers` fallback to `none` when import fails + warning logged
 *  - Unknown provider fallback to `none` + warning logged
 *  - No work at import time (R2.5)
 *
 * Pure-logic tests — no vscode, no extension host.
 */

import * as assert from 'assert';

import {
  getEmbedding,
  getNoneEmbedding,
  _resetPipelineCache,
} from '../intelligence/embeddings';
import { EmbeddingConfig } from '../intelligence/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noneConfig(dimension = 768): EmbeddingConfig {
  return { provider: 'none', model: 'none', dimension };
}

function transformersConfig(dimension = 768): EmbeddingConfig {
  return { provider: 'transformers', model: 'Xenova/nomic-embed-text-v1.5', dimension };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('intelligence-embeddings: none provider', function () {
  teardown(function () {
    _resetPipelineCache();
  });

  test('returns vector of correct dimension', function () {
    const vec = getNoneEmbedding('hello world', 768);
    assert.strictEqual(vec.length, 768, 'vector must match configured dimension');
  });

  test('returns vector of a different configured dimension', function () {
    const vec = getNoneEmbedding('hello world', 384);
    assert.strictEqual(vec.length, 384);
  });

  test('deterministic — same text produces the same vector', function () {
    const a = getNoneEmbedding('deterministic check', 768);
    const b = getNoneEmbedding('deterministic check', 768);
    assert.deepStrictEqual(a, b, 'same input must yield identical output');
  });

  test('different texts produce different vectors', function () {
    const a = getNoneEmbedding('alpha', 768);
    const b = getNoneEmbedding('beta', 768);
    const same = a.every((v, i) => v === b[i]);
    assert.strictEqual(same, false, 'distinct texts should yield distinct vectors');
  });

  test('empty text returns a zero vector of correct dimension', function () {
    const vec = getNoneEmbedding('', 768);
    assert.strictEqual(vec.length, 768);
    assert.ok(vec.every((v) => v === 0), 'every element must be zero for empty text');
  });
});

suite('intelligence-embeddings: transformers fallback', function () {
  teardown(function () {
    _resetPipelineCache();
  });

  test('falls back to none and logs warning when @xenova/transformers is not loadable', async function () {
    const warnings: string[] = [];
    const config = transformersConfig(768);

    const vec = await getEmbedding('hello', config, (m) => warnings.push(m));

    // Should have produced a valid vector (from the none fallback)
    assert.strictEqual(vec.length, 768, 'fallback must still return correct dimension');
    // Should have logged a warning mentioning the failure
    assert.ok(
      warnings.some((w) => /fall(ing)?\s*back/i.test(w)),
      `expected a fallback warning, got: ${JSON.stringify(warnings)}`,
    );
  });
});

suite('intelligence-embeddings: unknown provider fallback', function () {
  teardown(function () {
    _resetPipelineCache();
  });

  test('unknown provider falls back to none and logs warning', async function () {
    const warnings: string[] = [];
    // Cast to force an unknown provider string through
    const config: EmbeddingConfig = {
      provider: 'bogus' as any,
      model: 'x',
      dimension: 128,
    };

    const vec = await getEmbedding('test', config, (m) => warnings.push(m));

    assert.strictEqual(vec.length, 128, 'fallback must respect configured dimension');
    assert.ok(
      warnings.some((w) => /unknown provider/i.test(w)),
      `expected unknown-provider warning, got: ${JSON.stringify(warnings)}`,
    );
  });
});

suite('intelligence-embeddings: import-time safety', function () {
  teardown(function () {
    _resetPipelineCache();
  });

  test('importing the module does not trigger pipeline loading', function () {
    // The fact that we reach this test without any network error or
    // @xenova/transformers load attempt proves R2.5: the module-scope
    // `cachedPipeline` starts null and the dynamic import is never called
    // until `getEmbedding` is invoked with provider='transformers'.
    //
    // If importing eagerly loaded the pipeline, the test runner would fail
    // at the top-level import with "Cannot find module '@xenova/transformers'"
    // since it's not installed in CI/test.
    assert.strictEqual(typeof getEmbedding, 'function', 'export is available');
    assert.strictEqual(typeof getNoneEmbedding, 'function', 'export is available');
    assert.strictEqual(typeof _resetPipelineCache, 'function', 'export is available');
    // No crash ⇒ no eager loading happened.
  });
});
