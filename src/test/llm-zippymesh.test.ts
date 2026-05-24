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

suite('ZippyMeshProvider — recommendModel (S1 stopgap)', () => {
  test('recommendModel returns null in S1 (HTTP MCP route not yet wired in ZMLR)', async () => {
    const p = new ZippyMeshProvider({ fetchImpl: (async () => new Response()) as typeof fetch });
    const rec = await p.recommendModel('code', { preferLocal: true });
    assert.strictEqual(rec, null);
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
