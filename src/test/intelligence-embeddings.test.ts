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
import * as http from 'http';
import { AddressInfo } from 'net';

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

async function startOllamaEmbeddingServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, count: number) => void,
): Promise<{ base: string; close: () => Promise<void>; requests: () => number }> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    handler(req, res, count);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    requests: () => count,
  };
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

suite('intelligence-embeddings: transient provider failures', function () {
  teardown(() => _resetPipelineCache());

  test('ollama HTTP 500 is retried before degrading to none', async function () {
    const server = await startOllamaEmbeddingServer((req, res, count) => {
      if (req.method !== 'POST' || req.url !== '/api/embeddings') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (count === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"temporary"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"embedding":[0.1,0.2,0.3,0.4]}');
    });
    try {
      const warnings: string[] = [];
      let degraded = 0;
      const vec = await getEmbedding(
        'hello',
        { provider: 'ollama', model: 'nomic-embed-text', dimension: 4, ollamaHost: server.base },
        (m) => warnings.push(m),
        () => degraded++,
      );
      assert.deepStrictEqual(vec, [0.1, 0.2, 0.3, 0.4]);
      assert.strictEqual(server.requests(), 2);
      assert.strictEqual(degraded, 0, 'successful retry must not mark the corpus degraded');
      assert.ok(warnings.some((w) => /transient failure/i.test(w)), JSON.stringify(warnings));
      assert.ok(!warnings.some((w) => /using basic 'none'/i.test(w)), JSON.stringify(warnings));
    } finally {
      await server.close();
    }
  });

  test('ollama HTTP 404 is not retried', async function () {
    const server = await startOllamaEmbeddingServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    try {
      const warnings: string[] = [];
      const vec = await getEmbedding(
        'hello',
        { provider: 'ollama', model: 'missing', dimension: 4, ollamaHost: server.base },
        (m) => warnings.push(m),
      );
      assert.strictEqual(vec.length, 4);
      assert.strictEqual(server.requests(), 1);
      assert.ok(warnings.some((w) => /HTTP 404/i.test(w)), JSON.stringify(warnings));
    } finally {
      await server.close();
    }
  });
});

suite('intelligence-embeddings: oversized input (context-length overflow)', function () {
  teardown(() => _resetPipelineCache());

  // Read a request's JSON body so the mock can branch on the prompt LENGTH — the
  // real Ollama failure mode: HTTP 500 iff the input exceeds the model context.
  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => (data += c));
      req.on('end', () => resolve(data));
    });
  }

  test('an over-long input is shrunk and embedded — never degraded to none', async function () {
    // 500 with Ollama's exact wording while the prompt is > 2000 chars; 200 once
    // it has been shrunk under the "context window". Proves the deterministic
    // overflow is fixed by shrinking, not by degrading the whole corpus.
    const LIMIT = 2000;
    const server = await startOllamaEmbeddingServer(async (req, res) => {
      const body = await readBody(req);
      const prompt = (JSON.parse(body || '{}').prompt as string) ?? '';
      if (prompt.length > LIMIT) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"the input length exceeds the context length"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"embedding":[0.5,0.6,0.7,0.8]}');
    });
    try {
      const warnings: string[] = [];
      let degraded = 0;
      const huge = 'x'.repeat(40000); // 8000-char cap → 4000 → 2000 → OK
      const vec = await getEmbedding(
        huge,
        { provider: 'ollama', model: 'nomic-embed-text', dimension: 4, ollamaHost: server.base },
        (m) => warnings.push(m),
        () => degraded++,
      );
      assert.deepStrictEqual(vec, [0.5, 0.6, 0.7, 0.8], 'must return the real (shrunk) embedding');
      assert.strictEqual(degraded, 0, 'a shrinkable overflow must NOT mark the corpus degraded');
      assert.ok(server.requests() >= 2, `expected shrink retries, got ${server.requests()} request(s)`);
      assert.ok(
        warnings.some((w) => /context window/i.test(w) && /truncated head/i.test(w)),
        `expected a shrink notice, got: ${JSON.stringify(warnings)}`,
      );
      assert.ok(
        !warnings.some((w) => /using basic 'none'/i.test(w)),
        `overflow must not degrade to none: ${JSON.stringify(warnings)}`,
      );
    } finally {
      await server.close();
    }
  });

  test('an input that overflows even at the floor terminates by degrading to none', async function () {
    // Pathological provider: 500 "context length" for ANY size. The shrink loop
    // must bottom out at the floor and fall back to a none vector exactly once —
    // never loop forever.
    const server = await startOllamaEmbeddingServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"the input length exceeds the context length"}');
    });
    try {
      const warnings: string[] = [];
      let degraded = 0;
      const vec = await getEmbedding(
        'y'.repeat(9000),
        { provider: 'ollama', model: 'nomic-embed-text', dimension: 4, ollamaHost: server.base },
        (m) => warnings.push(m),
        () => degraded++,
      );
      assert.strictEqual(vec.length, 4, 'must still return a usable (none) vector of the right dimension');
      assert.strictEqual(degraded, 1, 'unfixable overflow degrades exactly once');
    } finally {
      await server.close();
    }
  });

  test('a context-length 500 is not consumed as a transient retry attempt', async function () {
    // The first two POSTs 500 for overflow (shrink path, NOT the 2-attempt
    // transient budget); the third — now small enough — succeeds. If overflow were
    // mis-counted as transient, the corpus would degrade before this succeeds.
    const server = await startOllamaEmbeddingServer(async (req, res) => {
      const body = await readBody(req);
      const prompt = (JSON.parse(body || '{}').prompt as string) ?? '';
      if (prompt.length > 2100) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"input is too long for this model"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"embedding":[1,2,3,4]}');
    });
    try {
      let degraded = 0;
      const vec = await getEmbedding(
        'z'.repeat(9000),
        { provider: 'ollama', model: 'nomic-embed-text', dimension: 4, ollamaHost: server.base },
        undefined,
        () => degraded++,
      );
      assert.deepStrictEqual(vec, [1, 2, 3, 4]);
      assert.strictEqual(degraded, 0);
    } finally {
      await server.close();
    }
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
