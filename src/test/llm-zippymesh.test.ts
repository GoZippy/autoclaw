/**
 * llm-zippymesh.test.ts — ZMLR adapter unit tests.
 *
 * Covers acceptance criteria #1 + #2 from
 * docs/specs/llm-provider-s1/spec.md (detect + round-trip chat with
 * BOTH `x-intent` and `x-zippy-intent` header threading).
 */

import * as assert from 'assert';

import { ZippyMeshProvider, zippyMeshAugmentHeaders } from '../llm/zippymesh';

interface Capture {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
}

function makeFetch(
  response: { status: number; body: unknown; headers?: Record<string, string> },
  capture: Capture[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    capture.push({ url, method: init?.method, headers, body });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: response.headers,
    });
  }) as typeof fetch;
}

suite('ZippyMeshProvider — detect', () => {
  test('detect() returns found when /v1/models responds 200', async () => {
    const capture: Capture[] = [];
    const fetchImpl = makeFetch(
      { status: 200, body: { data: [{ id: 'auto' }] } },
      capture,
    );
    const p = new ZippyMeshProvider({ fetchImpl });
    const det = await p.detect();
    assert.strictEqual(det.found, true);
    assert.ok(capture[0]?.url.includes('/v1/models'));
  });

  test('detect() returns not_running when endpoint refuses connection', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const p = new ZippyMeshProvider({ fetchImpl });
    const det = await p.detect();
    assert.strictEqual(det.found, false);
    if (!det.found) {
      assert.strictEqual(det.reason, 'not_running');
    }
  });
});

suite('ZippyMeshProvider — chat header threading', () => {
  test('chat() sends BOTH x-intent and x-zippy-intent when hints.intent is set', async () => {
    const capture: Capture[] = [];
    const fetchImpl = makeFetch(
      {
        status: 200,
        body: {
          model: 'gpt-4o',
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        },
      },
      capture,
    );
    const p = new ZippyMeshProvider({ fetchImpl });
    const result = await p.chat({
      model: 'auto',
      prompt: 'reply OK',
      hints: { intent: 'chat' },
      sessionId: 's-1',
    });
    assert.strictEqual(result.ok, true);
    assert.ok(result.response?.includes('OK'));
    const chatCall = capture.find((c) => c.url.includes('/v1/chat/completions'));
    assert.ok(chatCall, 'chat call should be captured');
    assert.strictEqual(chatCall!.headers['x-intent'], 'chat', 'x-intent must be sent');
    assert.strictEqual(
      chatCall!.headers['x-zippy-intent'],
      'chat',
      'x-zippy-intent must also be sent (legacy compat)',
    );
    assert.strictEqual(chatCall!.headers['x-client'], 'autoclaw');
  });

  test('chat() omits intent headers when hints.intent is absent', async () => {
    const capture: Capture[] = [];
    const fetchImpl = makeFetch(
      {
        status: 200,
        body: { model: 'auto', choices: [{ message: { content: 'X' } }] },
      },
      capture,
    );
    const p = new ZippyMeshProvider({ fetchImpl });
    await p.chat({ prompt: 'no intent' });
    const chatCall = capture[0];
    assert.strictEqual(chatCall.headers['x-intent'], undefined);
    assert.strictEqual(chatCall.headers['x-zippy-intent'], undefined);
  });

  test('chat() sends x-session-parallel + x-session-id when sessionParallel hint is set', async () => {
    const capture: Capture[] = [];
    const fetchImpl = makeFetch(
      {
        status: 200,
        body: { model: 'auto', choices: [{ message: { content: 'X' } }] },
      },
      capture,
    );
    const p = new ZippyMeshProvider({ fetchImpl });
    await p.chat({
      prompt: 'fan out',
      hints: { intent: 'code', sessionParallel: true, sessionId: 'mateam-42' },
    });
    const chatCall = capture[0];
    assert.strictEqual(chatCall.headers['x-session-parallel'], 'true');
    assert.strictEqual(chatCall.headers['x-session-id'], 'mateam-42');
  });
});

suite('ZippyMeshProvider — error mapping', () => {
  test('chat() maps 429 to httpStatus + ok=false', async () => {
    const fetchImpl = makeFetch({ status: 429, body: { error: 'rate' } }, []);
    const p = new ZippyMeshProvider({ fetchImpl });
    const r = await p.chat({ prompt: 'x' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.httpStatus, 429);
    assert.strictEqual(r.servedBy, 'zippymesh');
  });

  test('chat() maps 401 to errorClass=auth', async () => {
    const fetchImpl = makeFetch({ status: 401, body: { error: 'no auth' } }, []);
    const p = new ZippyMeshProvider({ fetchImpl });
    const r = await p.chat({ prompt: 'x' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errorClass, 'auth');
  });
});

suite('ZippyMeshProvider — recommendModel (S2 HTTP)', () => {
  test('happy path — newer ZMLR with recommendations array', async () => {
    const capture: Capture[] = [];
    const fetchImpl = makeFetch(
      {
        status: 200,
        body: {
          success: true,
          recommendations: [
            { model: 'openai/gpt-4o', score: 92 },
            { model: 'ollama/llama3.1:70b' },
          ],
          fallbackChain: ['ollama/llama3.1:70b', 'ollama/llama3.1:8b'],
        },
      },
      capture,
    );
    const p = new ZippyMeshProvider({ fetchImpl });
    const rec = await p.recommendModel('code', { preferLocal: true, maxLatencyMs: 2000 });
    assert.ok(rec, 'recommendation should not be null');
    assert.strictEqual(rec!.model, 'openai/gpt-4o');
    assert.deepStrictEqual(rec!.fallbackChain, ['ollama/llama3.1:70b', 'ollama/llama3.1:8b']);

    const mcpCall = capture.find((c) => c.url.endsWith('/mcp'));
    assert.ok(mcpCall, 'must POST to /mcp');
    assert.strictEqual(mcpCall!.method, 'POST');
    // Constraints must be snake_cased to match ZMLR's handler shape
    assert.strictEqual((mcpCall!.body as Record<string, unknown>).tool, 'recommend_model');
    const input = (mcpCall!.body as { input: Record<string, unknown> }).input;
    assert.strictEqual(input.intent, 'code');
    const constraints = input.constraints as Record<string, unknown>;
    assert.strictEqual(constraints.prefer_local, true);
    assert.strictEqual(constraints.max_latency_ms, 2000);
  });

  test('legacy shape — single `recommendation` field (older ZMLR)', async () => {
    const fetchImpl = makeFetch(
      {
        status: 200,
        body: {
          success: true,
          recommendation: 'ollama/llama3.1:8b',
          fallbackChain: [],
        },
      },
      [],
    );
    const p = new ZippyMeshProvider({ fetchImpl });
    const rec = await p.recommendModel('chat');
    assert.ok(rec);
    assert.strictEqual(rec!.model, 'ollama/llama3.1:8b');
  });

  test('404 — older ZMLR without the /mcp route → null (no throw)', async () => {
    const fetchImpl = makeFetch({ status: 404, body: { error: 'route_not_found' } }, []);
    const p = new ZippyMeshProvider({ fetchImpl });
    const rec = await p.recommendModel('code');
    assert.strictEqual(rec, null);
  });

  test('handler self-reports failure → null', async () => {
    const fetchImpl = makeFetch(
      { status: 200, body: { success: false, error: 'discovery service down' } },
      [],
    );
    const p = new ZippyMeshProvider({ fetchImpl });
    const rec = await p.recommendModel('code');
    assert.strictEqual(rec, null);
  });

  test('502 → null', async () => {
    const fetchImpl = makeFetch({ status: 502, body: { error: 'upstream' } }, []);
    const p = new ZippyMeshProvider({ fetchImpl });
    const rec = await p.recommendModel('code');
    assert.strictEqual(rec, null);
  });

  test('transport failure → null (no throw)', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const p = new ZippyMeshProvider({ fetchImpl });
    const rec = await p.recommendModel('code');
    assert.strictEqual(rec, null);
  });

  test('falls back to fallbackChain[0] when neither recommendation nor recommendations is set', async () => {
    const fetchImpl = makeFetch(
      {
        status: 200,
        body: {
          success: true,
          fallbackChain: ['ollama/llama3.1:8b', 'ollama/qwen3:14b'],
        },
      },
      [],
    );
    const p = new ZippyMeshProvider({ fetchImpl });
    const rec = await p.recommendModel('code');
    assert.ok(rec);
    assert.strictEqual(rec!.model, 'ollama/llama3.1:8b');
  });

  test('/mcp URL is derived by stripping /v1 from baseUrl', async () => {
    const capture: Capture[] = [];
    const fetchImpl = makeFetch(
      { status: 200, body: { success: true, recommendation: 'x' } },
      capture,
    );
    const p = new ZippyMeshProvider({ host: 'http://example.com:9999', fetchImpl });
    await p.recommendModel('chat');
    const mcpCall = capture.find((c) => c.url.endsWith('/mcp'));
    assert.ok(mcpCall);
    assert.strictEqual(mcpCall!.url, 'http://example.com:9999/mcp');
  });
});

suite('ZippyMeshProvider — embed() (first-class /v1/embeddings)', () => {
  test('embed() POSTs to /v1/embeddings with x-intent:embed and returns vectors', async () => {
    const capture: Capture[] = [];
    const fetchImpl = makeFetch(
      {
        status: 200,
        body: {
          model: 'nomic-embed-text',
          data: [
            { index: 0, embedding: [0.1, 0.2, 0.3] },
            { index: 1, embedding: [0.4, 0.5, 0.6] },
          ],
          usage: { prompt_tokens: 7 },
        },
      },
      capture,
    );
    const p = new ZippyMeshProvider({ fetchImpl });
    const r = await p.embed!({ input: ['alpha', 'beta'], model: 'nomic-embed-text' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dimension, 3);
    assert.strictEqual(r.vectors?.length, 2);
    assert.deepStrictEqual(r.vectors?.[0], [0.1, 0.2, 0.3]);
    assert.strictEqual(r.tokens?.input, 7);
    assert.strictEqual(r.tokens?.output, 0);
    const call = capture.find((c) => c.url.includes('/v1/embeddings'));
    assert.ok(call, 'must POST to /v1/embeddings');
    assert.strictEqual(call!.method, 'POST');
    assert.strictEqual(call!.headers['x-intent'], 'embed', 'must tag the request as an embed intent');
    assert.deepStrictEqual((call!.body as { input: unknown }).input, ['alpha', 'beta']);
  });

  test('embed() reorders out-of-order data by index', async () => {
    const fetchImpl = makeFetch(
      {
        status: 200,
        body: {
          model: 'm',
          data: [
            { index: 1, embedding: [9, 9] },
            { index: 0, embedding: [1, 1] },
          ],
        },
      },
      [],
    );
    const p = new ZippyMeshProvider({ fetchImpl });
    const r = await p.embed!({ input: ['first', 'second'] });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.vectors?.[0], [1, 1], 'index 0 must come first');
    assert.deepStrictEqual(r.vectors?.[1], [9, 9]);
  });

  test('embed() maps 401 to errorClass=auth (no throw)', async () => {
    const fetchImpl = makeFetch({ status: 401, body: { error: 'no auth' } }, []);
    const p = new ZippyMeshProvider({ fetchImpl });
    const r = await p.embed!({ input: 'x' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errorClass, 'auth');
    assert.strictEqual(r.httpStatus, 401);
  });

  test('embed() returns ok=false when the response carries no usable vectors', async () => {
    const fetchImpl = makeFetch({ status: 200, body: { model: 'm', data: [] } }, []);
    const p = new ZippyMeshProvider({ fetchImpl });
    const r = await p.embed!({ input: 'x' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errorClass, 'internal');
  });

  test('embed() threads session hints via augmentHeaders while keeping x-intent:embed', async () => {
    const capture: Capture[] = [];
    const fetchImpl = makeFetch(
      { status: 200, body: { model: 'm', data: [{ index: 0, embedding: [1, 2] }] } },
      capture,
    );
    const p = new ZippyMeshProvider({ fetchImpl });
    await p.embed!({ input: 'x', hints: { intent: 'code', sessionParallel: true, sessionId: 'e-1' } });
    const call = capture.find((c) => c.url.includes('/v1/embeddings'));
    assert.ok(call);
    assert.strictEqual(call!.headers['x-intent'], 'embed', 'embed intent must win regardless of hints');
    assert.strictEqual(call!.headers['x-session-parallel'], 'true', 'session-parallel hint must thread through');
    assert.strictEqual(call!.headers['x-session-id'], 'e-1', 'session-id hint must thread through');
  });

  test('capabilities.embeddings is advertised true', () => {
    const p = new ZippyMeshProvider({ fetchImpl: (async () => new Response('{}')) as typeof fetch });
    assert.strictEqual(p.capabilities.embeddings, true);
    assert.strictEqual(typeof p.embed, 'function');
  });

  test('capabilities advertise supported prompt harnesses', () => {
    const p = new ZippyMeshProvider({ fetchImpl: (async () => new Response('{}')) as typeof fetch });
    assert.ok(p.capabilities.promptHarnesses?.includes('openai-tools'));
    assert.ok(p.capabilities.promptHarnesses?.includes('qwen-xml-tools'));
    assert.ok(p.capabilities.promptHarnesses?.includes('claude-tools'));
  });
});

suite('zippyMeshAugmentHeaders pure function', () => {
  test('empty hints → empty headers', () => {
    const h = zippyMeshAugmentHeaders({});
    assert.deepStrictEqual(h, {});
  });

  test('intent only', () => {
    const h = zippyMeshAugmentHeaders({ hints: { intent: 'plan' } });
    assert.strictEqual(h['x-intent'], 'plan');
    assert.strictEqual(h['x-zippy-intent'], 'plan');
  });
});
