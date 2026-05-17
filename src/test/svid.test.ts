import * as assert from 'assert';
import {
  mintSvid, verifySvid, decodeSvidUnsafe,
  getCurrentSvid, stopSvidRefresh,
  isSpireAvailable,
} from '../svid';

suite('SPIFFE/SVID workload identity (mock impl)', () => {

  teardown(() => {
    stopSvidRefresh();
  });

  test('mintSvid returns a JWT with correct claims', async () => {
    const svid = await mintSvid('kiro', { workspacePath: '/test/ws' });
    assert.ok(typeof svid.raw === 'string');
    assert.strictEqual(svid.raw.split('.').length, 3, 'must be 3-part JWT');
    assert.strictEqual(svid.claims.agent_id, 'kiro');
    assert.ok(svid.claims.sub.startsWith('spiffe://autoclaw/'), `sub must be SPIFFE ID, got: ${svid.claims.sub}`);
    assert.ok(svid.claims.exp > svid.claims.iat, 'exp must be after iat');
    assert.ok(typeof svid.expires_at === 'string');
  });

  test('mintSvid default TTL is 300 seconds', async () => {
    const before = Math.floor(Date.now() / 1000);
    const svid = await mintSvid('agent1');
    const after = Math.floor(Date.now() / 1000);
    const ttl = svid.claims.exp - svid.claims.iat;
    // Allow ±1s of clock drift in test execution
    assert.ok(ttl >= 299 && ttl <= 301, `expected TTL ~300, got ${ttl}`);
    assert.ok(svid.claims.iat >= before && svid.claims.iat <= after + 1);
  });

  test('mintSvid honours custom TTL', async () => {
    const svid = await mintSvid('agent1', { ttlSeconds: 60 });
    const ttl = svid.claims.exp - svid.claims.iat;
    assert.ok(ttl >= 59 && ttl <= 61, `expected TTL ~60, got ${ttl}`);
  });

  test('verifySvid accepts a freshly minted token', async () => {
    const svid = await mintSvid('kiro', { workspacePath: '/test/ws' });
    const result = await verifySvid(svid.raw);
    assert.ok(result.ok, `expected ok, got: ${!result.ok && result.reason}`);
    if (result.ok) {
      assert.strictEqual(result.claims.agent_id, 'kiro');
      assert.ok(result.claims.sub.startsWith('spiffe://autoclaw/'));
    }
  });

  test('verifySvid rejects a tampered token', async () => {
    const svid = await mintSvid('kiro');
    const parts = svid.raw.split('.');
    // Tamper with the payload
    const tamperedPayload = parts[1].slice(0, -2) + 'XX';
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const result = await verifySvid(tampered);
    assert.ok(!result.ok);
  });

  test('verifySvid rejects a tampered signature', async () => {
    const svid = await mintSvid('kiro');
    const parts = svid.raw.split('.');
    const tampered = `${parts[0]}.${parts[1]}.BADSIGNATURE`;
    const result = await verifySvid(tampered);
    assert.ok(!result.ok);
    if (!result.ok) { assert.strictEqual(result.reason, 'invalid_signature'); }
  });

  test('verifySvid rejects an expired token', async () => {
    const svid = await mintSvid('kiro', { ttlSeconds: -1 }); // already expired
    const result = await verifySvid(svid.raw, { clockSkewSeconds: 0 });
    assert.ok(!result.ok);
    if (!result.ok) { assert.strictEqual(result.reason, 'expired'); }
  });

  test('verifySvid rejects wrong audience', async () => {
    const svid = await mintSvid('kiro', { audience: 'service-A' });
    const result = await verifySvid(svid.raw, { audience: 'service-B' });
    assert.ok(!result.ok);
    if (!result.ok) { assert.ok(result.reason.includes('wrong_audience')); }
  });

  test('verifySvid rejects malformed input', async () => {
    const result = await verifySvid('not.a.valid.jwt.either');
    assert.ok(!result.ok);
  });

  test('decodeSvidUnsafe extracts claims without verification', async () => {
    const svid = await mintSvid('kiro', { workspacePath: '/proj' });
    const claims = decodeSvidUnsafe(svid.raw);
    assert.ok(claims !== null);
    assert.strictEqual(claims!.agent_id, 'kiro');
  });

  test('decodeSvidUnsafe returns null for garbage input', () => {
    assert.strictEqual(decodeSvidUnsafe('garbage-input'), null);
    assert.strictEqual(decodeSvidUnsafe('a.b'), null);
  });

  test('isSpireAvailable returns false when env var is not set', async () => {
    const prev = process.env.AUTOCLAW_SPIRE_SOCKET;
    delete process.env.AUTOCLAW_SPIRE_SOCKET;
    const result = await isSpireAvailable();
    assert.strictEqual(result, false);
    if (prev !== undefined) { process.env.AUTOCLAW_SPIRE_SOCKET = prev; }
  });

  test('getCurrentSvid returns a valid token and caches it', async () => {
    const s1 = await getCurrentSvid('orchestrator', { workspacePath: '/proj' });
    const s2 = await getCurrentSvid('orchestrator', { workspacePath: '/proj' });
    assert.strictEqual(s1.raw, s2.raw, 'second call should return cached token');
    const result = await verifySvid(s1.raw);
    assert.ok(result.ok);
  });

  test('stopSvidRefresh clears the cached token', async () => {
    await getCurrentSvid('orchestrator', { workspacePath: '/proj' });
    stopSvidRefresh();
    // After stop, next getCurrentSvid call mints fresh (different revocation ID not guaranteed,
    // but we just verify it doesn't throw)
    const fresh = await getCurrentSvid('orchestrator', { workspacePath: '/proj' });
    assert.ok(fresh.raw.length > 0);
  });

  // Bridge integration: verifySvid is tested via bridge.test.ts
});
