/**
 * llm-oracle.test.ts — Oracle ladder + rate-limit + failsafe tests.
 *
 * Covers acceptance criteria #3, #4, #5 from
 * docs/specs/llm-provider-s1/spec.md (oracle takes over when ZMLR
 * unreachable; failsafe path; rate-limit exclusion incl. ZMLR-as-rung).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Oracle, detectCapabilities, estimateSize } from '../llm/oracle';

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-oracle-'));
}

/**
 * Build a fetch mock that responds to specific URL patterns. Endpoints
 * not in the map return an "ECONNREFUSED" simulated error.
 */
function makeFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    for (const [pattern, response] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(response.body), { status: response.status });
      }
    }
    throw new Error(`ECONNREFUSED ${url}`);
  }) as typeof fetch;
}

suite('Oracle — capability detection helpers (ported from model-oracle.mjs)', () => {
  test('detectCapabilities flags llama3.1:8b as tool-capable', () => {
    const c = detectCapabilities('llama3.1:8b');
    assert.strictEqual(c.supportsTools, true);
    assert.strictEqual(c.sizeB, 8);
  });

  test('detectCapabilities flags deepseek-r1 as thinking-capable', () => {
    const c = detectCapabilities('deepseek-r1:32b');
    assert.strictEqual(c.supportsThinking, true);
  });

  test('detectCapabilities flags llava as vision-capable', () => {
    const c = detectCapabilities('llava:7b');
    assert.strictEqual(c.supportsVision, true);
  });

  test('estimateSize parses qwen3:14b as 14B', () => {
    assert.strictEqual(estimateSize('qwen3:14b'), 14);
  });
});

suite('Oracle — refresh + pick (ZMLR unreachable, Ollama up)', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('refresh() marks Ollama online when /api/version + /api/tags respond', async () => {
    const oracle = new Oracle({
      workspaceRoot: workspace,
      ephemeral: true,
      fetchImpl: makeFetch({
        // ZMLR offline (no route match → throws)
        '127.0.0.1:11434/api/version': { status: 200, body: { version: '0.5.7' } },
        '127.0.0.1:11434/api/tags': {
          status: 200,
          body: {
            models: [
              { name: 'llama3.1:8b', details: { family: 'llama', parameter_size: '8B' } },
            ],
          },
        },
      }),
    });
    const eps = await oracle.refresh();
    const zmlr = eps.find((e) => e.id === 'zmlr-local')!;
    const ollama = eps.find((e) => e.id === 'ollama-local')!;
    assert.strictEqual(zmlr.online, false);
    assert.strictEqual(ollama.online, true);
    assert.strictEqual(ollama.modelCount, 1);
  });

  test('pick(agent) returns Ollama model when ZMLR is down', async () => {
    const oracle = new Oracle({
      workspaceRoot: workspace,
      ephemeral: true,
      fetchImpl: makeFetch({
        '127.0.0.1:11434/api/version': { status: 200, body: { version: '0.5.7' } },
        '127.0.0.1:11434/api/tags': {
          status: 200,
          body: {
            models: [
              { name: 'llama3.1:8b', details: { family: 'llama', parameter_size: '8B' } },
            ],
          },
        },
      }),
    });
    await oracle.refresh();
    const decision = oracle.pick('agent');
    assert.ok(decision.recommended, 'recommended should not be null');
    assert.strictEqual(decision.recommended!.id, 'llama3.1:8b');
    assert.strictEqual(decision.recommended!.endpointId, 'ollama-local');
    assert.strictEqual(decision.failsafe, false);
  });
});

suite('Oracle — failsafe path', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('pick() returns failsafe entry when only :11435 responds', async () => {
    const oracle = new Oracle({
      workspaceRoot: workspace,
      ephemeral: true,
      fetchImpl: makeFetch({
        '127.0.0.1:11435/api/version': { status: 200, body: { version: '0.5.7' } },
        '127.0.0.1:11435/api/tags': {
          status: 200,
          body: {
            models: [
              { name: 'qwen3:0.6b', details: { family: 'qwen', parameter_size: '0.6B' } },
            ],
          },
        },
      }),
    });
    await oracle.refresh();
    const decision = oracle.pick('agent');
    assert.ok(decision.recommended, 'failsafe should still produce a recommendation');
    assert.strictEqual(decision.failsafe, true);
    assert.strictEqual(decision.recommended!.id, 'qwen3:0.6b');
  });

  test('pick() returns null when nothing is online (incl. no failsafe)', async () => {
    const oracle = new Oracle({
      workspaceRoot: workspace,
      ephemeral: true,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    await oracle.refresh();
    const decision = oracle.pick('agent');
    assert.strictEqual(decision.recommended, null);
  });
});

suite('Oracle — rate-limit map (in-memory)', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('recordRateLimit excludes the model from subsequent pick()', async () => {
    const oracle = new Oracle({
      workspaceRoot: workspace,
      ephemeral: true,
      fetchImpl: makeFetch({
        '127.0.0.1:11434/api/version': { status: 200, body: { version: '0.5.7' } },
        '127.0.0.1:11434/api/tags': {
          status: 200,
          body: {
            models: [
              { name: 'llama3.1:70b', details: { family: 'llama', parameter_size: '70B' } },
              { name: 'llama3.1:8b', details: { family: 'llama', parameter_size: '8B' } },
            ],
          },
        },
      }),
    });
    await oracle.refresh();
    const before = oracle.pick('agent');
    assert.strictEqual(before.recommended!.id, 'llama3.1:70b'); // bigger scores higher

    oracle.recordRateLimit('llama3.1:70b', 'ollama-local', 3600);
    const after = oracle.pick('agent');
    assert.strictEqual(after.recommended!.id, 'llama3.1:8b');
  });

  test('isRateLimited returns true within window, false after expiry', () => {
    const oracle = new Oracle({ workspaceRoot: workspace, ephemeral: true });
    oracle.recordRateLimit('m', 'ep', 60);
    assert.strictEqual(oracle.isRateLimited('m', 'ep'), true);
    // We don't wait for 60s — instead force-expire via negative TTL.
    oracle.recordRateLimit('m', 'ep', -1);
    assert.strictEqual(oracle.isRateLimited('m', 'ep'), false);
  });
});

suite('Oracle — persistent state across instances', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('rate-limit written by one instance is read by a fresh one (S1 persistence)', async () => {
    // First instance writes the rate limit.
    const a = new Oracle({ workspaceRoot: workspace });
    a.recordRateLimit('gpt-4o', 'zmlr-local', 3600);
    assert.strictEqual(a.isRateLimited('gpt-4o', 'zmlr-local'), true);

    // Second instance — should read the same map on construction.
    const b = new Oracle({ workspaceRoot: workspace });
    assert.strictEqual(b.isRateLimited('gpt-4o', 'zmlr-local'), true);
  });

  test('expired entries are not loaded by a fresh instance', async () => {
    const a = new Oracle({ workspaceRoot: workspace });
    a.recordRateLimit('m', 'ep', -1); // already expired
    const b = new Oracle({ workspaceRoot: workspace });
    assert.strictEqual(b.isRateLimited('m', 'ep'), false);
  });
});

suite('Oracle — ZMLR as a ladder rung', () => {
  let workspace: string;
  setup(() => {
    workspace = mkWorkspace();
  });
  teardown(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('ZMLR is enumerated alongside Ollama and can serve via the ladder', async () => {
    const oracle = new Oracle({
      workspaceRoot: workspace,
      ephemeral: true,
      fetchImpl: makeFetch({
        '127.0.0.1:20128/api/health': { status: 200, body: { version: '1.2.1' } },
        '127.0.0.1:20128/v1/models': {
          status: 200,
          body: { data: [{ id: 'claude-3.5-sonnet' }] },
        },
      }),
    });
    await oracle.refresh();
    const status = oracle.status();
    const zmlr = status.endpoints.find((e) => e.id === 'zmlr-local')!;
    assert.strictEqual(zmlr.online, true);
    assert.strictEqual(zmlr.modelCount, 1);
    const decision = oracle.pick('agent');
    assert.ok(decision.recommended);
    assert.strictEqual(decision.recommended!.endpointId, 'zmlr-local');
  });
});
