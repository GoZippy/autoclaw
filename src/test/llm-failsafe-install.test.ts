/**
 * llm-failsafe-install.test.ts — failsafe installer tests.
 *
 * Covers idempotency, the disabled opt-out, the ollama-missing branch,
 * and the pull-failed branch.
 */

import * as assert from 'assert';

import {
  installFailsafe,
  _resetFailsafeCacheForTests,
  type FailsafeInstallResult,
} from '../llm/failsafe-install';

function fetchAlwaysFails(): typeof fetch {
  return (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
}

function fetchAlwaysOk(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ version: '0.5.7' }), { status: 200 })) as typeof fetch;
}

suite('installFailsafe — disabled', () => {
  test('returns disabled when enabled: false', async () => {
    _resetFailsafeCacheForTests();
    const r = await installFailsafe({ enabled: false });
    assert.deepStrictEqual(r, { installed: false, reason: 'disabled' } as FailsafeInstallResult);
  });
});

suite('installFailsafe — ollama-missing', () => {
  test('returns ollama-missing when both :11434 and :11435 are down', async () => {
    _resetFailsafeCacheForTests();
    const r = await installFailsafe({ fetchImpl: fetchAlwaysFails() });
    assert.strictEqual(r.installed, false);
    if (!r.installed) assert.strictEqual(r.reason, 'ollama-missing');
  });
});

suite('installFailsafe — already-present (idempotent)', () => {
  test('returns alreadyPresent when :11435 is already serving', async () => {
    _resetFailsafeCacheForTests();
    const r = await installFailsafe({
      fetchImpl: fetchAlwaysOk(),
      pullImpl: async () => ({ ok: true }), // shouldn't be called
    });
    assert.strictEqual(r.installed, true);
    if (r.installed) {
      assert.strictEqual(r.alreadyPresent, true);
      assert.ok(r.endpoint.includes('11435'));
    }
  });

  test('cached result reused on second call', async () => {
    _resetFailsafeCacheForTests();
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response(JSON.stringify({ version: '0.5.7' }), { status: 200 });
    }) as typeof fetch;
    await installFailsafe({ fetchImpl });
    await installFailsafe({ fetchImpl });
    // 1 reachability check for :11435 on the first call; second is cached.
    assert.strictEqual(callCount, 1);
  });
});

suite('installFailsafe — pull-failed', () => {
  test('returns pull-failed when main Ollama is up but pull fails', async () => {
    _resetFailsafeCacheForTests();
    // First call: :11435 down. Second call: :11434 up (main Ollama). Pull fails.
    let n = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      n++;
      if (url.includes('11435')) throw new Error('ECONNREFUSED'); // failsafe not up
      if (url.includes('11434')) {
        return new Response(JSON.stringify({ version: '0.5.7' }), { status: 200 });
      }
      throw new Error('unexpected url');
    }) as typeof fetch;
    const r = await installFailsafe({
      fetchImpl,
      pullImpl: async () => ({ ok: false, detail: 'mock pull failure' }),
    });
    assert.strictEqual(r.installed, false);
    if (!r.installed) {
      assert.strictEqual(r.reason, 'pull-failed');
      assert.ok(r.detail?.includes('mock pull failure'));
    }
    assert.ok(n >= 2, 'should probe both :11435 and :11434');
  });
});
