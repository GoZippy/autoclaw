/**
 * licensing.test.ts — offline Ed25519 license-key verification.
 */

import * as assert from 'assert';
import * as crypto from 'crypto';
import {
  signLicenseKey,
  verifyLicenseKey,
  parseLicenseKey,
  isPaid,
  LicensePayload,
} from '../licensing/license';

// A throwaway keypair generated per run — exercises sign+verify end to end
// without depending on the embedded production key.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const NOW = 1_700_000_000; // fixed clock (epoch seconds)

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return { v: 1, tier: 'pro', seats: 1, email: 'a@b.com', iat: NOW, exp: NOW + 86400 * 365, ...over };
}

suite('licensing: valid keys', () => {
  test('a freshly signed key verifies as active and paid', () => {
    const key = signLicenseKey(payload(), PRIV);
    const ent = verifyLicenseKey(key, PUB, NOW);
    assert.strictEqual(ent.valid, true);
    assert.strictEqual(ent.tier, 'pro');
    assert.strictEqual(ent.email, 'a@b.com');
    assert.strictEqual(isPaid(ent), true);
  });

  test('perpetual key (exp=null) is valid far in the future', () => {
    const key = signLicenseKey(payload({ exp: null }), PRIV);
    const ent = verifyLicenseKey(key, PUB, NOW + 86400 * 100000);
    assert.strictEqual(ent.valid, true);
    assert.strictEqual(ent.expiresAt, null);
  });

  test('teams tier carries seats', () => {
    const key = signLicenseKey(payload({ tier: 'teams', seats: 5 }), PRIV);
    const ent = verifyLicenseKey(key, PUB, NOW);
    assert.strictEqual(ent.tier, 'teams');
    assert.strictEqual(ent.seats, 5);
    assert.strictEqual(isPaid(ent), true);
  });
});

suite('licensing: rejection', () => {
  test('expired key is invalid (and not paid)', () => {
    const key = signLicenseKey(payload({ exp: NOW - 10 }), PRIV);
    const ent = verifyLicenseKey(key, PUB, NOW);
    assert.strictEqual(ent.valid, false);
    assert.strictEqual(isPaid(ent), false);
    assert.match(ent.reason, /expired/i);
  });

  test('tampered payload fails signature check', () => {
    const key = signLicenseKey(payload({ tier: 'pro' }), PRIV);
    const parsed = parseLicenseKey(key)!;
    // Forge a teams payload but keep the original (pro) signature.
    const forgedPayload = Buffer.from(JSON.stringify(payload({ tier: 'teams', seats: 99 })), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const sigB64 = key.split('.')[1];
    const forged = `AUTOCLAW-${forgedPayload}.${sigB64}`;
    const ent = verifyLicenseKey(forged, PUB, NOW);
    assert.strictEqual(ent.valid, false);
    assert.match(ent.reason, /signature/i);
    assert.ok(parsed.payload.tier === 'pro');
  });

  test('key signed by a different private key is rejected', () => {
    const other = crypto.generateKeyPairSync('ed25519');
    const otherPriv = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const key = signLicenseKey(payload(), otherPriv);
    const ent = verifyLicenseKey(key, PUB, NOW);
    assert.strictEqual(ent.valid, false);
  });

  test('garbage and empty input fall back to invalid-free', () => {
    assert.strictEqual(verifyLicenseKey('', PUB, NOW).valid, false);
    assert.strictEqual(verifyLicenseKey('not-a-key', PUB, NOW).valid, false);
    assert.strictEqual(verifyLicenseKey('AUTOCLAW-only-one-part', PUB, NOW).valid, false);
    assert.strictEqual(parseLicenseKey('AUTOCLAW-.'), null);
  });
});
