/**
 * llm-ollama.test.ts — Ollama adapter unit tests.
 *
 * Covers detect() via /api/version, models() via /api/tags with rich
 * metadata mapping, and the OpenAI-compat chat path.
 */

import * as assert from 'assert';

import { OllamaProvider } from '../llm/ollama';

interface Capture {
  url: string;
}

function makeRoutedFetch(routes: Record<string, { status: number; body: unknown }>, capture: Capture[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    capture.push({ url });
    for (const [pattern, response] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(response.body), { status: response.status });
      }
    }
    return new Response('{"error":"unknown"}', { status: 404 });
  }) as typeof fetch;
}

suite('OllamaProvider — detect via /api/version', () => {
  test('detect() returns version when /api/version responds 200', async () => {
    const capture: Capture[] = [];
    const fetchImpl = makeRoutedFetch(
      { '/api/version': { status: 200, body: { version: '0.5.7' } } },
      capture,
    );
    const p = new OllamaProvider({ fetchImpl });
    const det = await p.detect();
    assert.strictEqual(det.found, true);
    if (det.found) assert.strictEqual(det.version, '0.5.7');
    assert.ok(capture[0].url.includes('/api/version'));
  });

  test('detect() not_running when version endpoint throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const p = new OllamaProvider({ fetchImpl });
    const det = await p.detect();
    assert.strictEqual(det.found, false);
  });
});

suite('OllamaProvider — models via /api/tags', () => {
  test('models() maps name + parameter_size + family', async () => {
    const capture: Capture[] = [];
    const fetchImpl = makeRoutedFetch(
      {
        '/api/tags': {
          status: 200,
          body: {
            models: [
              {
                name: 'llama3.1:8b',
                details: { family: 'llama', parameter_size: '8.0B' },
              },
              {
                name: 'qwen3:14b',
                details: { family: 'qwen', parameter_size: '14.8B' },
              },
            ],
          },
        },
      },
      capture,
    );
    const p = new OllamaProvider({ fetchImpl });
    const ms = await p.models();
    assert.strictEqual(ms.length, 2);
    assert.strictEqual(ms[0].id, 'llama3.1:8b');
    assert.strictEqual(ms[0].family, 'llama');
    assert.strictEqual(ms[0].sizeB, 8.0);
    assert.strictEqual(ms[0].local, true);
    assert.strictEqual(ms[1].sizeB, 14.8);
  });

  test('models() returns [] when /api/tags fails', async () => {
    const fetchImpl = (async () => new Response('err', { status: 500 })) as typeof fetch;
    const p = new OllamaProvider({ fetchImpl });
    const ms = await p.models();
    assert.deepStrictEqual(ms, []);
  });
});

suite('OllamaProvider — chat path uses /v1/chat/completions', () => {
  test('chat() returns response when /v1/chat/completions responds 200', async () => {
    const capture: Capture[] = [];
    const fetchImpl = makeRoutedFetch(
      {
        '/v1/chat/completions': {
          status: 200,
          body: {
            model: 'llama3.1:8b',
            choices: [{ message: { content: 'OK' } }],
            usage: { prompt_tokens: 8, completion_tokens: 2 },
          },
        },
      },
      capture,
    );
    const p = new OllamaProvider({ fetchImpl });
    const r = await p.chat({ model: 'llama3.1:8b', prompt: 'reply OK' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.servedBy, 'ollama');
    assert.strictEqual(r.tokens?.input, 8);
    assert.strictEqual(r.tokens?.output, 2);
    assert.ok(capture[0].url.includes('/v1/chat/completions'));
  });

  test('capabilities advertise OpenAI prompt harness support', () => {
    const p = new OllamaProvider({ fetchImpl: (async () => new Response('{}')) as typeof fetch });
    assert.deepStrictEqual(p.capabilities.promptHarnesses, ['openai-tools']);
  });
});
