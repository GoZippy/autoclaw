// ZIPPY OPEN MATERIAL
//
// Pure, offline license-key verification. No `vscode` import so it is unit
// testable directly. License keys are Ed25519-signed, so they verify entirely
// offline against the embedded public key — no license server, no phone-home,
// nothing that costs us anything to run.
//
// Key format:  AUTOCLAW-<base64url(payload)>.<base64url(signature)>
// payload (JSON): { v, tier, seats, email, iat, exp }
//   - exp = null  -> perpetual
//   - exp = epoch seconds -> expires at that time

import * as crypto from 'crypto';

export type LicenseTier = 'free' | 'pro' | 'teams' | 'enterprise';

export interface LicensePayload {
  /** Schema version. */
  v: number;
  tier: LicenseTier;
  /** Seats covered (1 for Pro). */
  seats: number;
  /** Licensee email (informational). */
  email?: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds, or null for perpetual. */
  exp: number | null;
}

export interface Entitlement {
  tier: LicenseTier;
  valid: boolean;
  /** Why it is/why it isn't valid (for UI + diagnostics). */
  reason: string;
  email?: string;
  seats?: number;
  /** Epoch seconds, null = perpetual, undefined = n/a (free). */
  expiresAt?: number | null;
}

const KEY_PREFIX = 'AUTOCLAW-';

export const FREE_ENTITLEMENT: Entitlement = {
  tier: 'free',
  valid: true,
  reason: 'Free for personal and educational use.',
};

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface ParsedKey {
  payloadB64: string;
  signature: Buffer;
  payload: LicensePayload;
}

/** Structurally parse a key. Returns null on malformed input. Does NOT verify. */
export function parseLicenseKey(rawKey: string): ParsedKey | null {
  if (typeof rawKey !== 'string') return null;
  const key = rawKey.trim();
  if (!key.startsWith(KEY_PREFIX)) return null;
  const body = key.slice(KEY_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot === body.length - 1) return null;
  const payloadB64 = body.slice(0, dot);
  const sigB64 = body.slice(dot + 1);
  try {
    const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as LicensePayload;
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.tier !== 'string' || typeof payload.iat !== 'number') return null;
    return { payloadB64, signature: b64urlDecode(sigB64), payload };
  } catch {
    return null;
  }
}

/**
 * Verify a license key against the public key and return an Entitlement.
 * `nowSec` is injectable for testing; defaults to the real clock.
 */
export function verifyLicenseKey(
  rawKey: string,
  publicKeyPem: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Entitlement {
  const parsed = parseLicenseKey(rawKey);
  if (!parsed) {
    return { tier: 'free', valid: false, reason: 'Not a valid AutoClaw license key.' };
  }

  let signatureOk = false;
  try {
    signatureOk = crypto.verify(
      null,
      Buffer.from(parsed.payloadB64, 'utf8'),
      publicKeyPem,
      parsed.signature,
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return { tier: 'free', valid: false, reason: 'License signature is invalid (key was altered or not issued by us).' };
  }

  const { tier, seats, email, exp } = parsed.payload;
  if (exp !== null && typeof exp === 'number' && nowSec > exp) {
    return {
      tier,
      valid: false,
      reason: 'License has expired. Renew to keep commercial features.',
      email,
      seats,
      expiresAt: exp,
    };
  }

  return {
    tier,
    valid: true,
    reason: 'Active commercial license.',
    email,
    seats,
    expiresAt: exp,
  };
}

/** Does this entitlement grant paid (commercial) access? */
export function isPaid(ent: Entitlement): boolean {
  return ent.valid && (ent.tier === 'pro' || ent.tier === 'teams' || ent.tier === 'enterprise');
}

// ---------------------------------------------------------------------------
// Signing — used ONLY by the maintainer key-issuing script (needs the private
// key). Exported here so it is covered by the same unit tests as verification.
// ---------------------------------------------------------------------------

export function signLicenseKey(payload: LicensePayload, privateKeyPem: string): string {
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.sign(null, Buffer.from(payloadB64, 'utf8'), privateKeyPem);
  return `${KEY_PREFIX}${payloadB64}.${b64urlEncode(sig)}`;
}
