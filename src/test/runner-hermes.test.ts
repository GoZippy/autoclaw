/**
 * runner-hermes.test.ts — Unit tests for the Hermes runner adapter.
 *
 * Covers (RFC §3, §2, §7):
 *  1. `id` — exposes the expected stable runner id "hermes".
 *  2. `HERMES_AUTONOMY` table — every preset maps to the correct autonomy value.
 *  3. `hermesAutonomy()` helper — translates presets; defaults to "manual" for unknown.
 *  4. `detect()` — no endpoint → `found: false, reason: 'not_installed'`.
 *  5. `detect()` — endpoint 401 → `found: false, reason: 'no_auth'`.
 *  6. `detect()` — endpoint 200 with version → `found: true`, capabilities refreshed.
 *  7. `dispatch()` — no endpoint → `ok: false, errorClass: 'auth'` (failFast).
 *  8. `dispatch()` — POST /tasks 401 → `ok: false, errorClass: 'auth'`.
 *  9. `dispatch()` — submit ok + completed poll → `ok: true`, token data forwarded.
 * 10. `dispatch()` — submit ok + failed poll with error_class → correct errorClass.
 * 11. `listSessions()` — parses task list from REST response.
 * 12. `listSessions()` — returns empty list when endpoint is absent.
 * 13. `cancel()` — sends DELETE; does not throw on network error.
 * 14. `health()` — reports ok:false when endpoint absent.
 *
 * Mocking seam: `HERMES_ENDPOINT` env var controls the REST path.
 *               `HERMES_TOKEN` env var controls the auth header.
 *               `fetch` is replaced on the global scope, then restored.
 */

import * as assert from 'assert';

import {
  HermesRunner,
  HERMES_AUTONOMY,
  hermesAutonomy,
} from '../runners/hermes';
import type { TrustPreset } from '../runners/types';

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

type FetchFn = typeof fetch;

function mockFetch(impl: FetchFn): () => void {
  const original = global.fetch;
  global.fetch = impl;
  return () => {
    global.fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number): Response {
  return new Response('error', { status });
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function setEndpoint(url: string): () => void {
  const saved = process.env.HERMES_ENDPOINT;
  process.env.HERMES_ENDPOINT = url;
  return () => {
    if (saved === undefined) {
      delete process.env.HERMES_ENDPOINT;
    } else {
      process.env.HERMES_ENDPOINT = saved;
    }
  };
}

function clearEndpoint(): () => void {
  const saved = process.env.HERMES_ENDPOINT;
  delete process.env.HERMES_ENDPOINT;
  return () => {
    if (saved !== undefined) {
      process.env.HERMES_ENDPOINT = saved;
    }
  };
}

// ---------------------------------------------------------------------------
// Suite 1: id + capabilities
// ---------------------------------------------------------------------------

suite('runner-hermes: id and capabilities', () => {
  test('id is "hermes"', () => {
    const runner = new HermesRunner();
    assert.strictEqual(runner.id, 'hermes');
  });

  test('default capabilities: resumableSessions=true, jsonStructuredOutput=true, customAgents=true', () => {
    const runner = new HermesRunner();
    assert.strictEqual(runner.capabilities.resumableSessions, true);
    assert.strictEqual(runner.capabilities.jsonStructuredOutput, true);
    assert.strictEqual(runner.capabilities.mcpServers, false);
    assert.strictEqual(runner.capabilities.browser, false);
    assert.strictEqual(runner.capabilities.customAgents, true);
    assert.strictEqual(runner.capabilities.toolTrustGranularity, 'categories');
  });
});

// ---------------------------------------------------------------------------
// Suite 2: HERMES_AUTONOMY table (RFC §3)
// ---------------------------------------------------------------------------

suite('runner-hermes: HERMES_AUTONOMY — trust translation table (RFC §3)', () => {
  test('table contains exactly off, auto, turbo', () => {
    const keys = Object.keys(HERMES_AUTONOMY).sort();
    assert.deepStrictEqual(keys, ['auto', 'off', 'turbo']);
  });

  test('off → "manual" (manual approval for every action)', () => {
    assert.strictEqual(HERMES_AUTONOMY['off'], 'manual');
  });

  test('auto → "assisted" (supervised execution)', () => {
    assert.strictEqual(HERMES_AUTONOMY['auto'], 'assisted');
  });

  test('turbo → "autonomous" (fully autonomous)', () => {
    assert.strictEqual(HERMES_AUTONOMY['turbo'], 'autonomous');
  });

  test('exhaustive: all three presets map to distinct autonomy strings', () => {
    const values = (['off', 'auto', 'turbo'] as TrustPreset[]).map((p) => HERMES_AUTONOMY[p]);
    assert.strictEqual(new Set(values).size, 3, 'Expected 3 distinct autonomy values');
  });
});

// ---------------------------------------------------------------------------
// Suite 3: hermesAutonomy() helper
// ---------------------------------------------------------------------------

suite('runner-hermes: hermesAutonomy() helper', () => {
  test('hermesAutonomy("off") → "manual"', () => {
    assert.strictEqual(hermesAutonomy('off'), 'manual');
  });

  test('hermesAutonomy("auto") → "assisted"', () => {
    assert.strictEqual(hermesAutonomy('auto'), 'assisted');
  });

  test('hermesAutonomy("turbo") → "autonomous"', () => {
    assert.strictEqual(hermesAutonomy('turbo'), 'autonomous');
  });
});

// ---------------------------------------------------------------------------
// Suite 4: detect() — endpoint absent
// ---------------------------------------------------------------------------

suite('runner-hermes: detect() — no HERMES_ENDPOINT', () => {
  test('detect() returns found:false, reason:not_installed when endpoint is not set', async () => {
    const restore = clearEndpoint();
    try {
      const runner = new HermesRunner();
      const result = await runner.detect();
      assert.strictEqual(result.found, false);
      if (!result.found) {
        assert.strictEqual(result.reason, 'not_installed');
        assert.ok(result.hint.includes('HERMES_ENDPOINT'), 'Hint should mention HERMES_ENDPOINT');
      }
    } finally {
      restore();
    }
  });

  test('detect() never throws when endpoint is absent', async () => {
    const restore = clearEndpoint();
    try {
      const runner = new HermesRunner();
      await assert.doesNotReject(() => runner.detect());
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 5: detect() — REST path (mocked fetch)
// ---------------------------------------------------------------------------

suite('runner-hermes: detect() — REST path (mocked fetch)', () => {
  test('detect() → found:false, reason:no_auth when health returns 401', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    const restoreFetch = mockFetch(async () => errorResponse(401));
    try {
      const runner = new HermesRunner();
      const result = await runner.detect();
      assert.strictEqual(result.found, false);
      if (!result.found) {
        assert.strictEqual(result.reason, 'no_auth');
      }
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  test('detect() → found:false, reason:not_installed when health returns 503', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    const restoreFetch = mockFetch(async () => errorResponse(503));
    try {
      const runner = new HermesRunner();
      const result = await runner.detect();
      assert.strictEqual(result.found, false);
      if (!result.found) {
        assert.strictEqual(result.reason, 'not_installed');
      }
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  test('detect() → found:true with version when health returns 200 and JSON body', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    // Health returns version; capabilities endpoint fails gracefully.
    const restoreFetch = mockFetch(async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/health')) {
        return jsonResponse({ version: '1.5.2' });
      }
      // /capabilities — return minimal object
      return jsonResponse({ mcpServers: true });
    });
    try {
      const runner = new HermesRunner();
      const result = await runner.detect();
      assert.strictEqual(result.found, true);
      if (result.found) {
        assert.strictEqual(result.version, '1.5.2');
        assert.strictEqual(result.path, 'http://localhost:18888');
      }
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  test('detect() refreshes capabilities from /capabilities on success', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    const restoreFetch = mockFetch(async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/health')) {
        return jsonResponse({ version: '2.0.0' });
      }
      return jsonResponse({ mcpServers: true, browser: true });
    });
    try {
      const runner = new HermesRunner();
      await runner.detect();
      // capabilities should be refreshed from the /capabilities response.
      assert.strictEqual(runner.capabilities.mcpServers, true);
      assert.strictEqual(runner.capabilities.browser, true);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  test('detect() → found:false, reason:not_installed when fetch throws (network error)', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    const restoreFetch = mockFetch(async () => { throw new Error('ECONNREFUSED'); });
    try {
      const runner = new HermesRunner();
      const result = await runner.detect();
      assert.strictEqual(result.found, false);
      if (!result.found) {
        assert.strictEqual(result.reason, 'not_installed');
      }
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 6: dispatch() — no endpoint (failFast path)
// ---------------------------------------------------------------------------

suite('runner-hermes: dispatch() — no endpoint failFast', () => {
  test('dispatch() → ok:false, errorClass:auth when endpoint is not configured', async () => {
    const restore = clearEndpoint();
    try {
      const runner = new HermesRunner();
      const result = await runner.dispatch({
        prompt: 'do work',
        trust: 'auto',
        workingDir: process.cwd(),
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.errorClass, 'auth');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 7: dispatch() — REST path (mocked fetch)
// ---------------------------------------------------------------------------

suite('runner-hermes: dispatch() — REST path (mocked fetch)', () => {
  test('dispatch() → ok:false, errorClass:auth when POST /tasks returns 401', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    const restoreFetch = mockFetch(async () => errorResponse(401));
    try {
      const runner = new HermesRunner();
      const result = await runner.dispatch({
        prompt: 'do work',
        trust: 'auto',
        workingDir: process.cwd(),
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.errorClass, 'auth');
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  test('dispatch() → ok:false, errorClass:internal when POST /tasks returns 500', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    const restoreFetch = mockFetch(async () => errorResponse(500));
    try {
      const runner = new HermesRunner();
      const result = await runner.dispatch({
        prompt: 'do work',
        trust: 'auto',
        workingDir: process.cwd(),
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.errorClass, 'internal');
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  test('dispatch() → ok:true when submit ok + completed poll', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    let callCount = 0;
    const restoreFetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return jsonResponse({ id: 'task-ok-1' });
      }
      return jsonResponse({
        id: 'task-ok-1',
        state: 'completed',
        exit_code: 0,
        output: 'all done',
        tokens: { input: 42, output: 7 },
      });
    });
    try {
      const runner = new HermesRunner();
      const result = await runner.dispatch({
        prompt: 'do work',
        trust: 'turbo',
        workingDir: process.cwd(),
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.exitCode, 0);
      assert.deepStrictEqual(result.tokens, { input: 42, output: 7 });
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  test('dispatch() → ok:false, errorClass correct when poll returns failed + error_class', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    let callCount = 0;
    const restoreFetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return jsonResponse({ id: 'task-fail-1' });
      }
      return jsonResponse({
        id: 'task-fail-1',
        state: 'failed',
        exit_code: 1,
        error_class: 'tool_denied',
        error: 'tool approval refused',
      });
    });
    try {
      const runner = new HermesRunner();
      const result = await runner.dispatch({
        prompt: 'do work',
        trust: 'off',
        workingDir: process.cwd(),
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.errorClass, 'tool_denied');
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  test('dispatch() maps error_class "mcp" → "mcp_startup"', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    let callCount = 0;
    const restoreFetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return jsonResponse({ id: 'task-mcp-1' });
      return jsonResponse({
        id: 'task-mcp-1',
        state: 'error',
        exit_code: 3,
        error_class: 'mcp',
      });
    });
    try {
      const runner = new HermesRunner();
      const result = await runner.dispatch({
        prompt: 'p',
        trust: 'auto',
        workingDir: process.cwd(),
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.errorClass, 'mcp_startup');
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  test('dispatch() sends autonomy field matching the trust preset', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    let capturedBody: Record<string, unknown> = {};
    const restoreFetch = mockFetch(async (url, init) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/tasks') && (init as RequestInit | undefined)?.method === 'POST') {
        capturedBody = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
        return jsonResponse({ id: 'task-body-1' });
      }
      return jsonResponse({ id: 'task-body-1', state: 'completed', exit_code: 0 });
    });
    try {
      const runner = new HermesRunner();
      await runner.dispatch({ prompt: 'p', trust: 'turbo', workingDir: '/ws' });
      assert.strictEqual(capturedBody['autonomy'], 'autonomous');
      assert.strictEqual(capturedBody['prompt'], 'p');
      assert.strictEqual(capturedBody['working_dir'], '/ws');
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 8: listSessions()
// ---------------------------------------------------------------------------

suite('runner-hermes: listSessions()', () => {
  test('returns empty array when endpoint is not set', async () => {
    const restore = clearEndpoint();
    try {
      const runner = new HermesRunner();
      const sessions = await runner.listSessions();
      assert.deepStrictEqual(sessions, []);
    } finally {
      restore();
    }
  });

  test('returns mapped sessions when REST GET /tasks succeeds', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    const restoreFetch = mockFetch(async () =>
      jsonResponse({
        tasks: [
          {
            id: 't-1',
            state: 'completed',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T01:00:00.000Z',
            prompt_preview: 'do work',
          },
          {
            id: 't-2',
            state: 'running',
            created_at: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
    );
    try {
      const runner = new HermesRunner();
      const sessions = await runner.listSessions();
      assert.strictEqual(sessions.length, 2);
      assert.strictEqual(sessions[0].sessionId, 't-1');
      assert.strictEqual(sessions[0].status, 'completed');
      assert.strictEqual(sessions[0].promptPreview, 'do work');
      assert.strictEqual(sessions[1].sessionId, 't-2');
      assert.strictEqual(sessions[1].status, 'active');
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  test('returns empty array when GET /tasks fails', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    const restoreFetch = mockFetch(async () => errorResponse(503));
    try {
      const runner = new HermesRunner();
      const sessions = await runner.listSessions();
      assert.deepStrictEqual(sessions, []);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  test('returns empty array when fetch throws', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    const restoreFetch = mockFetch(async () => { throw new Error('ECONNREFUSED'); });
    try {
      const runner = new HermesRunner();
      const sessions = await runner.listSessions();
      assert.deepStrictEqual(sessions, []);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 9: cancel()
// ---------------------------------------------------------------------------

suite('runner-hermes: cancel()', () => {
  test('cancel() is a no-op when endpoint is not set', async () => {
    const restore = clearEndpoint();
    try {
      const runner = new HermesRunner();
      await assert.doesNotReject(() => runner.cancel('task-1'));
    } finally {
      restore();
    }
  });

  test('cancel() does not throw when DELETE /tasks/{id} fails', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    const restoreFetch = mockFetch(async () => { throw new Error('ECONNREFUSED'); });
    try {
      const runner = new HermesRunner();
      await assert.doesNotReject(() => runner.cancel('task-1'));
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  test('cancel() sends DELETE to /tasks/{id}', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    let capturedUrl = '';
    let capturedMethod = '';
    const restoreFetch = mockFetch(async (url, init) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedMethod = (init as RequestInit | undefined)?.method ?? '';
      return new Response('', { status: 200 });
    });
    try {
      const runner = new HermesRunner();
      await runner.cancel('task-xyz');
      assert.ok(capturedUrl.endsWith('/tasks/task-xyz'), `Unexpected URL: ${capturedUrl}`);
      assert.strictEqual(capturedMethod, 'DELETE');
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 10: health()
// ---------------------------------------------------------------------------

suite('runner-hermes: health()', () => {
  test('health() reports ok:false when endpoint is absent', async () => {
    const restore = clearEndpoint();
    try {
      const runner = new HermesRunner();
      const h = await runner.health();
      assert.strictEqual(h.ok, false);
    } finally {
      restore();
    }
  });

  test('health() reports ok:true when detect() succeeds', async () => {
    const restoreEnv = setEndpoint('http://localhost:18888');
    const restoreFetch = mockFetch(async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/health')) return jsonResponse({ version: '1.0.0' });
      return jsonResponse({});
    });
    try {
      const runner = new HermesRunner();
      const h = await runner.health();
      assert.strictEqual(h.ok, true);
      assert.strictEqual(h.cliVersion, '1.0.0');
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });
});
