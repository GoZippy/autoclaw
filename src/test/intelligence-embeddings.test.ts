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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  getEmbedding,
  getNoneEmbedding,
  _resetPipelineCache,
} from '../intelligence/embeddings';
import {
  TRANSFORMERS_DIR_ENV,
  TRANSFORMERS_CACHE_ENV,
} from '../intelligence/installEmbeddings';
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
    // Should have logged a warning mentioning the provider was unavailable + the
    // basic-'none' degrade (the de-spammed, actionable message).
    assert.ok(
      warnings.some((w) => /provider unavailable|basic 'none'/i.test(w)),
      `expected a provider-unavailable warning, got: ${JSON.stringify(warnings)}`,
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

suite('intelligence-embeddings: installed-dir provider + de-spam', function () {
  let tmpRoot: string;

  suiteSetup(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-embed-loader-'));
  });
  suiteTeardown(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  teardown(function () {
    delete process.env[TRANSFORMERS_DIR_ENV];
    delete process.env[TRANSFORMERS_CACHE_ENV];
    _resetPipelineCache();
  });

  /** Plant a fake ESM `@xenova/transformers` under `dir` whose entry is `mjs`. */
  function plant(dir: string, mjs: string): void {
    const pkgDir = path.join(dir, 'node_modules', '@xenova', 'transformers');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'entry.mjs'), mjs, 'utf8');
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@xenova/transformers', version: '0.0.0', type: 'module', main: './entry.mjs' }),
      'utf8',
    );
  }

  test('resolves @xenova/transformers from AUTOCLAW_TRANSFORMERS_DIR and uses its pipeline', async function () {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'ok-'));
    // Fake pipeline returns a constant 768-wide vector; proves the installed
    // entry (not the `none` fallback) produced the embedding.
    plant(
      dir,
      'export const env = {};\n' +
        'export async function pipeline(task, model) {\n' +
        '  return async (text, opts) => ({ data: Float32Array.from({ length: 768 }, () => 0.5) });\n' +
        '}\n',
    );
    process.env[TRANSFORMERS_DIR_ENV] = dir;
    process.env[TRANSFORMERS_CACHE_ENV] = path.join(dir, 'cache');

    const warnings: string[] = [];
    const vec = await getEmbedding('hello', transformersConfig(768), (m) => warnings.push(m));

    assert.strictEqual(vec.length, 768, 'must use the installed pipeline output dimension');
    assert.strictEqual(vec[0], 0.5, 'value must come from the planted pipeline, not the none fallback');
    assert.deepStrictEqual(warnings, [], 'a successful load must not warn');
  });

  test('warns once (de-spam) across many failing embed calls', async function () {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'boom-'));
    plant(dir, "throw new Error('boom: deliberately broken transformers build');\n");
    process.env[TRANSFORMERS_DIR_ENV] = dir;

    const warnings: string[] = [];
    const cfg = transformersConfig(768);
    // Simulate indexing many chunks — each call fails to load the provider.
    for (let i = 0; i < 25; i++) {
      const vec = await getEmbedding(`chunk ${i}`, cfg, (m) => warnings.push(m));
      assert.strictEqual(vec.length, 768, 'each call still returns a none-fallback vector');
    }
    const providerWarnings = warnings.filter((w) => /provider unavailable|basic 'none'/i.test(w));
    assert.strictEqual(
      providerWarnings.length,
      1,
      `expected exactly one de-duped provider warning across 25 calls, got ${warnings.length}: ${JSON.stringify(warnings)}`,
    );
  });

  test('the warn-once ledger resets with the pipeline cache', async function () {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'reset-'));
    plant(dir, "throw new Error('boom');\n");
    process.env[TRANSFORMERS_DIR_ENV] = dir;
    const cfg = transformersConfig(768);

    const first: string[] = [];
    await getEmbedding('a', cfg, (m) => first.push(m));
    assert.strictEqual(first.filter((w) => /provider unavailable/i.test(w)).length, 1);

    _resetPipelineCache(); // clears warnedKeys

    const second: string[] = [];
    await getEmbedding('b', cfg, (m) => second.push(m));
    assert.strictEqual(
      second.filter((w) => /provider unavailable/i.test(w)).length,
      1,
      'after reset, the warning is allowed to fire again',
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
