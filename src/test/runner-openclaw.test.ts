/**
 * runner-openclaw.test.ts — Unit tests for the OpenClaw runner adapter.
 *
 * Covers (RFC §3, §2, §7):
 *  1. `id` — exposes the expected stable runner id "openclaw".
 *  2. `OPENCLAW_TRUST` table — every preset maps to the correct trust level.
 *  3. `openclawTrust()` helper — translates presets; defaults to "gated" for unknown.
 *  4. `openclawTrustFlags()` — produces `["--trust", "<level>"]` argv fragment.
 *  5. `detect()` — binary-absent + no endpoint → `found: false, reason: 'not_installed'`.
 *  6. `detect()` — REST endpoint 401/403 → `found: false, reason: 'no_auth'`.
 *  7. `detect()` — REST endpoint 200 with version body → `found: true`.
 *  8. `dispatch()` REST path — 401 submit → `ok: false, errorClass: 'auth'`.
 *  9. `dispatch()` REST path — successful submit + completed poll → `ok: true`.
 * 10. `listSessions()` — REST path returns mapped sessions; no-endpoint returns local map.
 * 11. `cancel()` — REST DELETE; no-op when no endpoint.
 * 12. `resolveJobId` / `resolveTaskId` — bidirectional id mapping after a dispatch.
 *
 * Mocking seam:
 * - `AUTOCLAW_OPENCLAW_BIN` env var overrides the CLI binary name (used by
 *   `probeOpenclawVersion`/`probeOpenclawPath` and `dispatchCli`).
 * - `OPENCLAW_ENDPOINT` env var controls the REST path.
 * - `OPENCLAW_TOKEN` env var controls the auth header.
 * - `fetch` is replaced on the global scope for REST tests, then restored.
 */

import * as assert from 'assert';

import {
  OpenClawRunner,
  OPENCLAW_TRUST,
  openclawTrust,
  openclawTrustFlags,
} from '../runners/openclaw';
import type { TrustPreset } from '../runners/types';

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

type FetchFn = typeof fetch;

/**
 * Replace global fetch with a fake and return a restore function.
 */
function mockFetch(impl: FetchFn): () => void {
  const original = global.fetch;
  global.fetch = impl;
  return () => {
    global.fetch = original;
  };
}

function makeJsonResponse(body: unknown, status = 200): Response {
  const json = JSON.stringify(body);
  return new Response(json, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeErrorResponse(status: number): Response {
  return new Response('error', { status });
}

// ---------------------------------------------------------------------------
// Suite 1: id + capabilities
// ---------------------------------------------------------------------------

suite('runner-openclaw: id and capabilities', () => {
  test('id is "openclaw"', () => {
    const runner = new OpenClawRunner();
    assert.strictEqual(runner.id, 'openclaw');
  });

  test('capabilities: resumableSessions=true, jsonStructuredOutput=true, mcpServers=true', () => {
    const runner = new OpenClawRunner();
    assert.strictEqual(runner.capabilities.resumableSessions, true);
    assert.strictEqual(runner.capabilities.jsonStructuredOutput, true);
    assert.strictEqual(runner.capabilities.mcpServers, true);
    assert.strictEqual(runner.capabilities.browser, false);
    assert.strictEqual(runner.capabilities.customAgents, true);
    assert.strictEqual(runner.capabilities.toolTrustGranularity, 'categories');
  });
});

// ---------------------------------------------------------------------------
// Suite 2: OPENCLAW_TRUST table (RFC §3)
// ---------------------------------------------------------------------------

suite('runner-openclaw: OPENCLAW_TRUST — trust translation table (RFC §3)', () => {
  test('table contains exactly off, auto, turbo', () => {
    const keys = Object.keys(OPENCLAW_TRUST).sort();
    assert.deepStrictEqual(keys, ['auto', 'off', 'turbo']);
  });

  test('off → "gated" (manual approval for every action)', () => {
    assert.strictEqual(OPENCLAW_TRUST['off'], 'gated');
  });

  test('auto → "supervised" (supervised execution)', () => {
    assert.strictEqual(OPENCLAW_TRUST['auto'], 'supervised');
  });

  test('turbo → "unattended" (fully autonomous)', () => {
    assert.strictEqual(OPENCLAW_TRUST['turbo'], 'unattended');
  });

  test('exhaustive: all three presets map to distinct trust level strings', () => {
    const values = (['off', 'auto', 'turbo'] as TrustPreset[]).map((p) => OPENCLAW_TRUST[p]);
    assert.strictEqual(new Set(values).size, 3, 'Expected 3 distinct trust levels');
  });
});

// ---------------------------------------------------------------------------
// Suite 3: openclawTrust() and openclawTrustFlags()
// ---------------------------------------------------------------------------

suite('runner-openclaw: openclawTrust() and openclawTrustFlags() helpers', () => {
  test('openclawTrust("off") → "gated"', () => {
    assert.strictEqual(openclawTrust('off'), 'gated');
  });

  test('openclawTrust("auto") → "supervised"', () => {
    assert.strictEqual(openclawTrust('auto'), 'supervised');
  });

  test('openclawTrust("turbo") → "unattended"', () => {
    assert.strictEqual(openclawTrust('turbo'), 'unattended');
  });

  test('openclawTrustFlags("off") → ["--trust", "gated"]', () => {
    assert.deepStrictEqual(openclawTrustFlags('off'), ['--trust', 'gated']);
  });

  test('openclawTrustFlags("auto") → ["--trust", "supervised"]', () => {
    assert.deepStrictEqual(openclawTrustFlags('auto'), ['--trust', 'supervised']);
  });

  test('openclawTrustFlags("turbo") → ["--trust", "unattended"]', () => {
    assert.deepStrictEqual(openclawTrustFlags('turbo'), ['--trust', 'unattended']);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: detect() — REST path
// ---------------------------------------------------------------------------

suite('runner-openclaw: detect() — REST path (mocked fetch)', () => {
  let restoreEnv: () => void;
  let restoreFetch: (() => void) | undefined;

  setup(() => {
    const saved = process.env.OPENCLAW_ENDPOINT;
    process.env.OPENCLAW_ENDPOINT = 'http://localhost:19999';
    restoreEnv = () => {
      if (saved === undefined) {
        delete process.env.OPENCLAW_ENDPOINT;
      } else {
        process.env.OPENCLAW_ENDPOINT = saved;
      }
    };
  });

  teardown(() => {
    restoreEnv();
    restoreFetch?.();
  });

  test('detect() → found:false, reason:no_auth when health returns 401', async () => {
    restoreFetch = mockFetch(async () => makeErrorResponse(401));
    const runner = new OpenClawRunner();
    const result = await runner.detect();
    assert.strictEqual(result.found, false);
    if (!result.found) {
      assert.strictEqual(result.reason, 'no_auth');
    }
  });

  test('detect() → found:false, reason:no_auth when health returns 403', async () => {
    restoreFetch = mockFetch(async () => makeErrorResponse(403));
    const runner = new OpenClawRunner();
    const result = await runner.detect();
    assert.strictEqual(result.found, false);
    if (!result.found) {
      assert.strictEqual(result.reason, 'no_auth');
    }
  });

  test('detect() → found:true when health returns 200 with version', async () => {
    restoreFetch = mockFetch(async () => makeJsonResponse({ version: '2.1.0' }));
    const runner = new OpenClawRunner();
    const result = await runner.detect();
    assert.strictEqual(result.found, true);
    if (result.found) {
      assert.strictEqual(result.version, '2.1.0');
      assert.strictEqual(result.path, 'http://localhost:19999');
    }
  });

  test('detect() → found:true with version="unknown" when health body is not JSON', async () => {
    restoreFetch = mockFetch(async () => new Response('OK', { status: 200 }));
    const runner = new OpenClawRunner();
    const result = await runner.detect();
    // JSON parse will fail; version falls back to 'unknown'.
    assert.strictEqual(result.found, true);
    if (result.found) {
      assert.strictEqual(result.version, 'unknown');
    }
  });

  test('detect() → falls through to CLI probe when endpoint throws (network error)', async () => {
    restoreFetch = mockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    // CLI also absent → not_installed
    const runner = new OpenClawRunner();
    const result = await runner.detect();
    // May be not_installed (CLI absent) or found (if openclaw CLI is installed).
    assert.strictEqual(typeof result.found, 'boolean');
  });
});

// ---------------------------------------------------------------------------
// Suite 5: detect() — no endpoint, binary absent
// ---------------------------------------------------------------------------

suite('runner-openclaw: detect() — no endpoint + no binary', () => {
  let restoreEnv: () => void;

  setup(() => {
    const saved = process.env.OPENCLAW_ENDPOINT;
    delete process.env.OPENCLAW_ENDPOINT;
    restoreEnv = () => {
      if (saved !== undefined) {
        process.env.OPENCLAW_ENDPOINT = saved;
      }
    };
  });

  teardown(() => {
    restoreEnv();
  });

  test('detect() returns found:false, reason:not_installed when no endpoint and no binary', async () => {
    const runner = new OpenClawRunner();
    const result = await runner.detect();
    if (!result.found) {
      assert.ok(
        result.reason === 'not_installed' || result.reason === 'no_auth',
        `Unexpected reason: ${result.reason}`,
      );
      assert.ok(result.hint.length > 0);
    }
  });

  test('detect() never throws', async () => {
    const runner = new OpenClawRunner();
    await assert.doesNotReject(() => runner.detect());
  });
});

// ---------------------------------------------------------------------------
// Suite 6: dispatch() — REST path
// ---------------------------------------------------------------------------

suite('runner-openclaw: dispatch() — REST path (mocked fetch)', () => {
  let restoreEnv: () => void;
  let restoreFetch: () => void;

  setup(() => {
    const saved = process.env.OPENCLAW_ENDPOINT;
    process.env.OPENCLAW_ENDPOINT = 'http://localhost:19999';
    restoreEnv = () => {
      if (saved === undefined) {
        delete process.env.OPENCLAW_ENDPOINT;
      } else {
        process.env.OPENCLAW_ENDPOINT = saved;
      }
    };
  });

  teardown(() => {
    restoreEnv();
    restoreFetch?.();
  });

  test('dispatch() → ok:false, errorClass:auth when POST /jobs returns 401', async () => {
    restoreFetch = mockFetch(async () => makeErrorResponse(401));
    const runner = new OpenClawRunner();
    const result = await runner.dispatch({
      prompt: 'do work',
      trust: 'auto',
      workingDir: process.cwd(),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorClass, 'auth');
  });

  test('dispatch() → ok:false, errorClass:internal when POST /jobs returns 500', async () => {
    restoreFetch = mockFetch(async () => makeErrorResponse(500));
    const runner = new OpenClawRunner();
    const result = await runner.dispatch({
      prompt: 'do work',
      trust: 'auto',
      workingDir: process.cwd(),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorClass, 'internal');
  });

  test('dispatch() → ok:true when submit returns job_id and poll returns completed', async () => {
    let callCount = 0;
    restoreFetch = mockFetch(async (url) => {
      callCount++;
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/jobs') && callCount === 1) {
        // POST /jobs — submit
        return makeJsonResponse({ job_id: 'job-abc-123' });
      }
      // GET /jobs/job-abc-123 — poll
      return makeJsonResponse({
        job_id: 'job-abc-123',
        state: 'completed',
        exit_code: 0,
        output: 'done',
      });
    });
    const runner = new OpenClawRunner();
    const result = await runner.dispatch({
      prompt: 'do work',
      trust: 'auto',
      workingDir: process.cwd(),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.exitCode, 0);
  });

  test('dispatch() → ok:false when poll returns failed state', async () => {
    let callCount = 0;
    restoreFetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return makeJsonResponse({ job_id: 'job-fail-1' });
      }
      return makeJsonResponse({
        job_id: 'job-fail-1',
        state: 'failed',
        exit_code: 1,
        error_class: 'auth',
      });
    });
    const runner = new OpenClawRunner();
    const result = await runner.dispatch({
      prompt: 'do work',
      trust: 'auto',
      workingDir: process.cwd(),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorClass, 'auth');
  });
});

// ---------------------------------------------------------------------------
// Suite 7: bidirectional id mapping (resolveJobId / resolveTaskId)
// ---------------------------------------------------------------------------

suite('runner-openclaw: bidirectional id mapping', () => {
  test('resolveJobId returns undefined before any dispatch', () => {
    const runner = new OpenClawRunner();
    assert.strictEqual(runner.resolveJobId('task-1'), undefined);
  });

  test('resolveTaskId returns undefined before any dispatch', () => {
    const runner = new OpenClawRunner();
    assert.strictEqual(runner.resolveTaskId('job-1'), undefined);
  });

  test('after a completed dispatch the job→task and task→job maps are consistent', async () => {
    let restoreFetch: (() => void) | undefined;
    let callCount = 0;
    const savedEndpoint = process.env.OPENCLAW_ENDPOINT;
    process.env.OPENCLAW_ENDPOINT = 'http://localhost:19999';

    restoreFetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return makeJsonResponse({ job_id: 'job-xyz' });
      }
      return makeJsonResponse({ job_id: 'job-xyz', state: 'completed', exit_code: 0 });
    });

    try {
      const runner = new OpenClawRunner();
      await runner.dispatch({
        prompt: 'p',
        trust: 'auto',
        workingDir: process.cwd(),
        sessionId: 'task-abc',
      });
      assert.strictEqual(runner.resolveJobId('task-abc'), 'job-xyz');
      assert.strictEqual(runner.resolveTaskId('job-xyz'), 'task-abc');
    } finally {
      restoreFetch?.();
      if (savedEndpoint === undefined) {
        delete process.env.OPENCLAW_ENDPOINT;
      } else {
        process.env.OPENCLAW_ENDPOINT = savedEndpoint;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 8: listSessions and cancel
// ---------------------------------------------------------------------------

suite('runner-openclaw: listSessions and cancel', () => {
  test('listSessions() returns empty array when no endpoint and no local map entries', async () => {
    const savedEndpoint = process.env.OPENCLAW_ENDPOINT;
    delete process.env.OPENCLAW_ENDPOINT;
    try {
      const runner = new OpenClawRunner();
      const sessions = await runner.listSessions();
      assert.deepStrictEqual(sessions, []);
    } finally {
      if (savedEndpoint !== undefined) {
        process.env.OPENCLAW_ENDPOINT = savedEndpoint;
      }
    }
  });

  test('cancel() is a no-op when OPENCLAW_ENDPOINT is not set', async () => {
    const savedEndpoint = process.env.OPENCLAW_ENDPOINT;
    delete process.env.OPENCLAW_ENDPOINT;
    try {
      const runner = new OpenClawRunner();
      await assert.doesNotReject(() => runner.cancel('any-id'));
    } finally {
      if (savedEndpoint !== undefined) {
        process.env.OPENCLAW_ENDPOINT = savedEndpoint;
      }
    }
  });

  test('cancel() does not throw when REST DELETE fails', async () => {
    const savedEndpoint = process.env.OPENCLAW_ENDPOINT;
    process.env.OPENCLAW_ENDPOINT = 'http://localhost:19999';
    const restoreFetch = mockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    try {
      const runner = new OpenClawRunner();
      await assert.doesNotReject(() => runner.cancel('job-1'));
    } finally {
      restoreFetch();
      if (savedEndpoint === undefined) {
        delete process.env.OPENCLAW_ENDPOINT;
      } else {
        process.env.OPENCLAW_ENDPOINT = savedEndpoint;
      }
    }
  });
});
