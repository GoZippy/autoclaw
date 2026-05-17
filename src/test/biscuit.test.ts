import * as assert from 'assert';
import {
  mintBiscuitToken, attenuateBiscuitToken, verifyBiscuitToken,
  decodeBiscuitTokenUnsafe,
} from '../biscuit';

suite('Biscuit capability tokens (mock impl)', () => {

  test('mintBiscuitToken returns a token with correct facts', async () => {
    const tok = await mintBiscuitToken('kiro', ['typescript', 'review'], 3600);
    assert.strictEqual(tok.facts.agent_id, 'kiro');
    assert.deepStrictEqual(tok.facts.capabilities, ['typescript', 'review']);
    assert.ok(tok.facts.revocation_id.length > 0);
    assert.ok(new Date(tok.facts.expires_at).getTime() > Date.now());
    assert.ok(tok.raw.length > 0);
    assert.deepStrictEqual(tok.restrictions, []);
  });

  test('verifyBiscuitToken accepts a freshly minted token', async () => {
    const tok = await mintBiscuitToken('kiro', ['typescript'], 3600);
    const result = await verifyBiscuitToken(tok.raw);
    assert.ok(result.ok);
    if (result.ok) {
      assert.strictEqual(result.facts.agent_id, 'kiro');
      assert.deepStrictEqual(result.effective_capabilities, ['typescript']);
    }
  });

  test('verifyBiscuitToken rejects a tampered token', async () => {
    const tok = await mintBiscuitToken('kiro', ['typescript'], 3600);
    const tampered = tok.raw.slice(0, -4) + 'XXXX';
    const result = await verifyBiscuitToken(tampered);
    assert.ok(!result.ok);
    if (!result.ok) { assert.ok(result.reason.includes('invalid_token')); }
  });

  test('verifyBiscuitToken rejects an expired token', async () => {
    const tok = await mintBiscuitToken('kiro', ['typescript'], -1); // already expired
    const result = await verifyBiscuitToken(tok.raw);
    assert.ok(!result.ok);
    if (!result.ok) { assert.strictEqual(result.reason, 'expired'); }
  });

  test('verifyBiscuitToken rejects a revoked token', async () => {
    const tok = await mintBiscuitToken('kiro', ['typescript'], 3600);
    const revokedIds = new Set([tok.facts.revocation_id]);
    const result = await verifyBiscuitToken(tok.raw, [], revokedIds);
    assert.ok(!result.ok);
    if (!result.ok) { assert.strictEqual(result.reason, 'revoked'); }
  });

  test('verifyBiscuitToken rejects when required capabilities are missing', async () => {
    const tok = await mintBiscuitToken('kiro', ['typescript'], 3600);
    const result = await verifyBiscuitToken(tok.raw, ['rust']);
    assert.ok(!result.ok);
    if (!result.ok) { assert.ok(result.reason.includes('missing_capabilities')); }
  });

  test('attenuateBiscuitToken narrows capabilities in child token', async () => {
    const parent = await mintBiscuitToken('orchestrator', ['typescript', 'review', 'deploy'], 3600);
    const child = await attenuateBiscuitToken(parent, {
      restrict_capabilities: ['typescript'],
      attenuated_by: 'orchestrator',
    });
    assert.strictEqual(child.restrictions.length, 1);

    const result = await verifyBiscuitToken(child.raw, ['typescript']);
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepStrictEqual(result.effective_capabilities, ['typescript']);
    }
  });

  test('attenuateBiscuitToken prevents privilege escalation: child cannot gain review', async () => {
    const parent = await mintBiscuitToken('orchestrator', ['typescript'], 3600);
    const child = await attenuateBiscuitToken(parent, {
      restrict_capabilities: ['typescript', 'review'], // tries to add 'review'
    });
    // 'review' is not in parent, so effective caps stay as ['typescript']
    const result = await verifyBiscuitToken(child.raw);
    assert.ok(result.ok);
    if (result.ok) {
      assert.ok(!result.effective_capabilities.includes('review'), 'review must not be added by attenuation');
    }
  });

  test('attenuateBiscuitToken shrinks expiry when restriction is earlier', async () => {
    const parent = await mintBiscuitToken('orchestrator', ['typescript'], 3600);
    const earlyExpiry = new Date(Date.now() + 60 * 1000).toISOString(); // 60s from now
    const child = await attenuateBiscuitToken(parent, { restrict_expiry: earlyExpiry });
    assert.strictEqual(child.facts.expires_at, earlyExpiry);
  });

  test('decodeBiscuitTokenUnsafe returns facts without signature check', async () => {
    const tok = await mintBiscuitToken('kiro', ['typescript'], 3600);
    const facts = decodeBiscuitTokenUnsafe(tok.raw);
    assert.ok(facts);
    assert.strictEqual(facts!.agent_id, 'kiro');
  });

  test('decodeBiscuitTokenUnsafe returns null for garbage input', () => {
    const facts = decodeBiscuitTokenUnsafe('not-a-valid-token');
    assert.strictEqual(facts, null);
  });
});
