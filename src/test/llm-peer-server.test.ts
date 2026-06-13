/**
 * llm-peer-server.test.ts — PeerServer integration tests.
 *
 * Covers the four S3 spec acceptance criteria for the peer server:
 *   1. happy path round-trip
 *   2. budget short-circuit
 *   3. body cap short-circuit
 *   4. clean shutdown + restart
 */

import * as assert from 'assert';
import * as http from 'http';

import { PeerServer, type PeerRouteRequest, type PeerRouteResponse } from '../llm/peer-server';

/** POST JSON to a URL and return the parsed body + status. */
async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; body: PeerRouteResponse }> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(raw).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as PeerRouteResponse });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

/** GET a URL and return the status code (used for 404/405 paths). */
async function getStatus(url: string): Promise<number> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: u.hostname, port: u.port, path: u.pathname },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
  });
}

/** Pick a random high port so parallel test files don't collide. */
function pickPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

suite('PeerServer — happy path round-trip', () => {
  let server: PeerServer;
  const port = pickPort();

  setup(async () => {
    server = new PeerServer({
      port,
      suggest: (req) => ({
        suggestedModelIds: [`echo/${req.intent ?? 'none'}`, 'ollama/llama3.1:8b'],
      }),
    });
    await server.start();
  });
  teardown(async () => {
    await server.stop();
  });

  test('POST /llm/peer/route returns the suggest() result within budget', async () => {
    const start = Date.now();
    const res = await postJson(server.url(), {
      model: 'auto',
      intent: 'code',
      hasImage: false,
      estimatedTokens: 800,
      clientId: null,
    });
    const elapsed = Date.now() - start;
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.suggestedModelIds, [
      'echo/code',
      'ollama/llama3.1:8b',
    ]);
    assert.ok(elapsed < 500, `should complete fast; took ${elapsed}ms`);
  });

  test('GET on the route URL returns 405', async () => {
    const status = await getStatus(server.url());
    assert.strictEqual(status, 405);
  });

  test('POST to an unknown path returns 404', async () => {
    const u = new URL(server.url());
    u.pathname = '/unknown';
    const res = await postJson(u.toString(), { x: 1 });
    assert.strictEqual(res.status, 404);
  });

  test('malformed JSON body returns 200 + empty suggestions (non-fatal)', async () => {
    const res = await postJson(server.url(), '{this is not json}');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.suggestedModelIds, []);
  });
});

suite('PeerServer — body cap short-circuit', () => {
  let server: PeerServer;
  const port = pickPort();

  setup(async () => {
    server = new PeerServer({
      port,
      bodyCapBytes: 256,
      suggest: () => ({ suggestedModelIds: ['ollama/llama3.1:8b'] }),
    });
    await server.start();
  });
  teardown(async () => {
    await server.stop();
  });

  test('over-cap body short-circuits to empty suggestions', async () => {
    const oversized = { model: 'auto', extra: 'x'.repeat(1024) };
    const res = await postJson(server.url(), oversized).catch((err) => ({
      status: 0,
      body: { suggestedModelIds: [], error: err.message } as PeerRouteResponse,
    }));
    // Either the server short-circuits with empty suggestions, or the
    // connection got destroyed mid-write (status 0). Both satisfy the
    // "non-fatal failure" contract — ZMLR continues with default order.
    assert.deepStrictEqual(res.body.suggestedModelIds, []);
  });
});

suite('PeerServer — budget short-circuit', () => {
  let server: PeerServer;
  const port = pickPort();

  setup(async () => {
    server = new PeerServer({
      port,
      budgetMs: 50,
      suggest: async () => {
        // Deliberately slow — past the budget.
        await new Promise<void>((r) => setTimeout(r, 200));
        return { suggestedModelIds: ['ollama/never-arrives'] };
      },
    });
    await server.start();
  });
  teardown(async () => {
    await server.stop();
  });

  test('slow suggest() blows budget → empty suggestions', async () => {
    const res = await postJson(server.url(), {
      model: 'auto',
      intent: 'code',
      hasImage: false,
      estimatedTokens: 100,
      clientId: null,
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.suggestedModelIds, []);
  });
});

suite('PeerServer — clean shutdown + restart', () => {
  test('stop() releases the port; restart on the same port succeeds', async () => {
    const port = pickPort();
    const a = new PeerServer({ port, suggest: () => ({ suggestedModelIds: [] }) });
    await a.start();
    await a.stop();
    const b = new PeerServer({ port, suggest: () => ({ suggestedModelIds: ['x'] }) });
    await b.start();
    const res = await postJson(b.url(), {
      model: 'auto',
      intent: null,
      hasImage: false,
      estimatedTokens: 0,
      clientId: null,
    });
    await b.stop();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.suggestedModelIds, ['x']);
  });

  test('multiple calls to stop() are safe', async () => {
    const port = pickPort();
    const s = new PeerServer({ port, suggest: () => ({ suggestedModelIds: [] }) });
    await s.start();
    await s.stop();
    await s.stop(); // no-throw
    assert.ok(true);
  });
});

suite('PeerServer — defensive output handling', () => {
  test('non-string entries in suggestedModelIds are filtered out', async () => {
    const port = pickPort();
    const s = new PeerServer({
      port,
      suggest: () => ({
        // intentionally malformed
        suggestedModelIds: ['ollama/llama3.1:8b', '', 42 as unknown as string, 'ollama/llama3.1:8b'],
      }),
    });
    await s.start();
    const res = await postJson(s.url(), {
      model: 'auto',
      intent: null,
      hasImage: false,
      estimatedTokens: 0,
      clientId: null,
    });
    await s.stop();
    // Empty filtered out, number filtered out, dupe deduped.
    assert.deepStrictEqual(res.body.suggestedModelIds, ['ollama/llama3.1:8b']);
  });

  test('suggest() throwing returns empty (non-fatal)', async () => {
    const port = pickPort();
    const s = new PeerServer({
      port,
      suggest: () => {
        throw new Error('boom');
      },
    });
    await s.start();
    const res = await postJson(s.url(), {
      model: 'auto',
      intent: 'code',
      hasImage: false,
      estimatedTokens: 0,
      clientId: null,
    });
    await s.stop();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.suggestedModelIds, []);
  });
});

// Keep `PeerRouteRequest` referenced so unused-import lint stays clean
const _typeCheck: PeerRouteRequest | undefined = undefined;
void _typeCheck;
