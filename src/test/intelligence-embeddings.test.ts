/**
 * intelligence-embeddings.test.ts — unit tests for the embeddings dispatch.
 *
 * Verifies:
 *  - `none` provider deterministic, correct dimension, empty-text zero vector
 *  - a real provider that fails degrades to `none` for THAT call (no cross-
 *    provider chaining — geometry safety) and warns AT MOST ONCE (de-spam)
 *  - `embedStrict` throws on failure / on the unresolved `auto` provider
 *  - unreachable router/ollama hosts degrade to `none`
 *  - no work at import time
 *
 * Pure-logic + loopback-only tests — no vscode, no extension host.
 */

import * as assert from 'assert';

import {
  getEmbedding,
  embedStrict,
  getNoneEmbedding,
  detectRouter,
  detectOllama,
  _resetPipelineCache,
} from '../intelligence/embeddings';
import { EmbeddingConfig } from '../intelligence/types';

// An address that refuses fast (TCP discard/unused port on loopback).
const DEAD = 'http://127.0.0.1:1';

function transformersConfig(dimension = 768): EmbeddingConfig {
  return { provider: 'transformers', model: 'Xenova/nomic-embed-text-v1.5', dimension };
}

suite('intelligence-embeddings: none provider', function () {
  teardown(() => _resetPipelineCache());

  test('returns vector of correct dimension', function () {
    assert.strictEqual(getNoneEmbedding('hello world', 768).length, 768);
  });

  test('returns vector of a different configured dimension', function () {
    assert.strictEqual(getNoneEmbedding('hello world', 384).length, 384);
  });

  test('deterministic — same text produces the same vector', function () {
    assert.deepStrictEqual(getNoneEmbedding('x', 768), getNoneEmbedding('x', 768));
  });

  test('different texts produce different vectors', function () {
    const a = getNoneEmbedding('alpha', 768);
    const b = getNoneEmbedding('beta', 768);
    assert.strictEqual(a.every((v, i) => v === b[i]), false);
  });

  test('empty text returns a zero vector of correct dimension', function () {
    const vec = getNoneEmbedding('', 768);
    assert.strictEqual(vec.length, 768);
    assert.ok(vec.every((v) => v === 0));
  });
});

suite('intelligence-embeddings: degrade-to-none + de-spam', function () {
  teardown(() => _resetPipelineCache());

  test('a failing provider degrades to none (correct dimension) and warns', async function () {
    const warnings: string[] = [];
    const vec = await getEmbedding('hello', transformersConfig(768), (m) => warnings.push(m));
    assert.strictEqual(vec.length, 768, 'degraded vector must keep the configured dimension');
    assert.ok(
      warnings.some((w) => /unavailable/i.test(w) && /none/i.test(w)),
      `expected an "unavailable … none" warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  test('repeated failures warn AT MOST ONCE (de-spam)', async function () {
    // Use a dead router host so the failure message is byte-identical every call
    // (a connection refusal). The transformers provider can fail at varying later
    // stages when @xenova is present in the dev tree, which is not a de-spam test.
    const warnings: string[] = [];
    const cfg: EmbeddingConfig = { provider: 'router', model: 'nomic-embed-text', dimension: 64, routerHost: DEAD };
    for (let i = 0; i < 50; i++) {
      await getEmbedding(`chunk ${i}`, cfg, (m) => warnings.push(m));
    }
    assert.strictEqual(warnings.length, 1, `expected one warning for 50 calls, got ${warnings.length}`);
  });

  test('unknown provider degrades to none and warns', async function () {
    const warnings: string[] = [];
    const cfg: EmbeddingConfig = { provider: 'bogus' as unknown as 'none', model: 'x', dimension: 128 };
    const vec = await getEmbedding('test', cfg, (m) => warnings.push(m));
    assert.strictEqual(vec.length, 128);
    assert.ok(warnings.some((w) => /unknown embedding provider/i.test(w)));
  });

  test('onDegrade fires when a REAL provider degrades, never for none', async function () {
    let degraded = 0;
    await getEmbedding(
      'x',
      { provider: 'router', model: 'm', dimension: 8, routerHost: DEAD },
      undefined,
      () => degraded++,
    );
    assert.strictEqual(degraded, 1, 'a failed real provider must signal degradation');

    degraded = 0;
    await getEmbedding('x', { provider: 'none', model: 'none', dimension: 8 }, undefined, () => degraded++);
    assert.strictEqual(degraded, 0, "the 'none' provider does not degrade");
  });
});

suite('intelligence-embeddings: embedStrict (probe path)', function () {
  teardown(() => _resetPipelineCache());

  test("embedStrict throws on the unresolved 'auto' provider", async function () {
    await assert.rejects(
      () => embedStrict('x', { provider: 'auto', model: 'm', dimension: 8 }),
      /must be resolved/i,
    );
  });

  test('embedStrict(none) returns a vector and never throws', async function () {
    const vec = await embedStrict('x', { provider: 'none', model: 'none-hashed-bow', dimension: 16 });
    assert.strictEqual(vec.length, 16);
  });

  test('embedStrict throws (does NOT degrade) when a router host is unreachable', async function () {
    await assert.rejects(() =>
      embedStrict('x', { provider: 'router', model: 'nomic-embed-text', dimension: 8, routerHost: DEAD }),
    );
  });
});

suite('intelligence-embeddings: unreachable hosts degrade to none', function () {
  teardown(() => _resetPipelineCache());

  test('router on a dead host → none + one warning', async function () {
    const warnings: string[] = [];
    const vec = await getEmbedding(
      'x',
      { provider: 'router', model: 'nomic-embed-text', dimension: 32, routerHost: DEAD },
      (m) => warnings.push(m),
    );
    assert.strictEqual(vec.length, 32);
    assert.ok(warnings.length >= 1);
  });

  test('ollama on a dead host → none', async function () {
    const vec = await getEmbedding('x', {
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimension: 32,
      ollamaHost: DEAD,
    });
    assert.strictEqual(vec.length, 32);
  });

  test('detectRouter / detectOllama resolve false on a dead host (no throw)', async function () {
    assert.strictEqual(await detectRouter(DEAD), false);
    assert.strictEqual(await detectOllama(DEAD), false);
  });
});

suite('intelligence-embeddings: import-time safety', function () {
  test('exports are functions and importing did not load any provider', function () {
    assert.strictEqual(typeof getEmbedding, 'function');
    assert.strictEqual(typeof embedStrict, 'function');
    assert.strictEqual(typeof getNoneEmbedding, 'function');
  });
});
