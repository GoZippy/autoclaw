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
  isCommercialTier,
  hasTierAtLeast,
  tierRank,
  getCurrentMajorVersion,
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

suite('licensing: extended schema (solo / perpetual-major / product / updates)', () => {
  test('solo tier verifies as paid + commercial', () => {
    const key = signLicenseKey(payload({ tier: 'solo' }), PRIV);
    const ent = verifyLicenseKey(key, PUB, NOW);
    assert.strictEqual(ent.valid, true);
    assert.strictEqual(ent.tier, 'solo');
    assert.strictEqual(isPaid(ent), true);
    assert.strictEqual(ent.commercialUseAllowed, true);
  });

  test('perpetual-major (exp:null) carries licenseKind + majorVersion', () => {
    const key = signLicenseKey(payload({ exp: null, licenseKind: 'perpetual-major', majorVersion: 3 }), PRIV);
    const ent = verifyLicenseKey(key, PUB, NOW + 86400 * 9999);
    assert.strictEqual(ent.valid, true);
    assert.strictEqual(ent.licenseKind, 'perpetual-major');
    assert.strictEqual(ent.majorVersion, 3);
    assert.strictEqual(ent.expiresAt, null);
  });

  test('wrong product is rejected; explicit autoclaw + legacy (absent) are accepted', () => {
    const wrong = verifyLicenseKey(signLicenseKey(payload({ product: 'other' as 'autoclaw' }), PRIV), PUB, NOW);
    assert.strictEqual(wrong.valid, false);
    assert.match(wrong.reason, /not for AutoClaw/i);
    assert.strictEqual(verifyLicenseKey(signLicenseKey(payload({ product: 'autoclaw' }), PRIV), PUB, NOW).valid, true);
    // Legacy keys (no product field) still verify.
    assert.strictEqual(verifyLicenseKey(signLicenseKey(payload(), PRIV), PUB, NOW).valid, true);
  });

  test('updatesUntil does not invalidate use; only flips updatesActive', () => {
    // Update window closed, but the perpetual license is still usable.
    const key = signLicenseKey(payload({ exp: null, updatesUntil: NOW - 10 }), PRIV);
    const ent = verifyLicenseKey(key, PUB, NOW);
    assert.strictEqual(ent.valid, true);
    assert.strictEqual(ent.updatesActive, false);
    // Window open → updatesActive true.
    const key2 = signLicenseKey(payload({ exp: null, updatesUntil: NOW + 86400 }), PRIV);
    assert.strictEqual(verifyLicenseKey(key2, PUB, NOW).updatesActive, true);
  });

  test('tier helpers rank + gate correctly', () => {
    assert.ok(tierRank('enterprise') > tierRank('teams'));
    assert.ok(tierRank('teams') > tierRank('pro'));
    assert.ok(tierRank('pro') > tierRank('solo'));
    assert.ok(tierRank('solo') > tierRank('free'));
    const proEnt = verifyLicenseKey(signLicenseKey(payload({ tier: 'pro' }), PRIV), PUB, NOW);
    assert.strictEqual(hasTierAtLeast(proEnt, 'solo'), true);
    assert.strictEqual(hasTierAtLeast(proEnt, 'pro'), true);
    assert.strictEqual(hasTierAtLeast(proEnt, 'teams'), false);
    assert.strictEqual(isCommercialTier(proEnt), true);
  });

  test('getCurrentMajorVersion parses extension version', () => {
    assert.strictEqual(getCurrentMajorVersion('3.6.2'), 3);
    assert.strictEqual(getCurrentMajorVersion('12.0.0'), 12);
    assert.strictEqual(getCurrentMajorVersion('garbage'), 1);
  });
});
