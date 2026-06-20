// ZIPPY OPEN MATERIAL
//
// Pure, offline license-key verification. No `vscode` import so it is unit
// testable directly. License keys are Ed25519-signed, so they verify entirely
// offline against the embedded public key — no license server, no phone-home,
// nothing that costs us anything to run.
//
// Key format:  AUTOCLAW-<base64url(payload)>.<base64url(signature)>
// payload (JSON): { v, tier, seats, email, iat, exp, ... }
//   - exp = null  -> perpetual (perpetual-major one-time licenses)
//   - exp = epoch seconds -> expires at that time (subscriptions / trials)
//   - updatesUntil -> end of the included-updates window; does NOT invalidate
//     use, only marks whether updates are "active".

import * as crypto from 'crypto';

export type LicenseTier =
  | 'free'
  | 'solo'
  | 'pro'
  | 'teams'
  | 'enterprise';

/** How a license is sold/scoped. */
export type LicenseKind =
  | 'free'
  | 'trial'
  | 'perpetual-major'
  | 'subscription'
  | 'enterprise';

export interface LicensePayload {
  /** Schema version. */
  v: number;
  /** Product guard. Must be "autoclaw" when present. */
  product?: 'autoclaw';
  tier: LicenseTier;
  /** License style. */
  licenseKind?: LicenseKind;
  /** Seats covered (1 for Solo/Pro). */
  seats: number;
  /** Licensee email (informational). */
  email?: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds, or null for perpetual (perpetual-major). */
  exp: number | null;
  /** Major version this license applies to (e.g. 1, 2, 3). */
  majorVersion?: number;
  /** End of the included-updates window, epoch seconds. User keeps the last
   *  eligible version after this date. Does not invalidate the license. */
  updatesUntil?: number;
  /** Optional explicit feature grants for special licenses. */
  features?: string[];
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
  product?: 'autoclaw';
  licenseKind?: LicenseKind;
  majorVersion?: number;
  updatesUntil?: number;
  features?: string[];
  /** True when this entitlement grants commercial-use rights. */
  commercialUseAllowed?: boolean;
  /** True when the included-updates window is still open. */
  updatesActive?: boolean;
}

const KEY_PREFIX = 'AUTOCLAW-';

export const FREE_ENTITLEMENT: Entitlement = {
  tier: 'free',
  valid: true,
  reason: 'Free Community mode: personal, educational, open-source, and evaluation use.',
  licenseKind: 'free',
  commercialUseAllowed: false,
  updatesActive: false,
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

// ---------------------------------------------------------------------------
// Tier / entitlement helpers
// ---------------------------------------------------------------------------

/** Numeric rank for tier comparisons (higher = more access). */
export function tierRank(tier: LicenseTier): number {
  switch (tier) {
    case 'enterprise': return 4;
    case 'teams': return 3;
    case 'pro': return 2;
    case 'solo': return 1;
    case 'free':
    default: return 0;
  }
}

/** True when the entitlement is a valid paid (commercial) tier. */
export function isCommercialTier(ent: Entitlement): boolean {
  return ent.valid && ['solo', 'pro', 'teams', 'enterprise'].includes(ent.tier);
}

/** Does this entitlement grant paid (commercial) access? */
export function isPaid(ent: Entitlement): boolean {
  return isCommercialTier(ent);
}

/** True when the entitlement is valid and at least the required tier. */
export function hasTierAtLeast(ent: Entitlement, required: LicenseTier): boolean {
  return ent.valid && tierRank(ent.tier) >= tierRank(required);
}

/** Extract the major version number from an extension version string. */
export function getCurrentMajorVersion(extensionVersion: string): number {
  const major = Number(String(extensionVersion).split('.')[0]);
  return Number.isFinite(major) && major > 0 ? major : 1;
}

/**
 * Verify a license key against the public key and return an Entitlement.
 * `nowSec` is injectable for testing; defaults to the real clock (seconds).
 */
export function verifyLicenseKey(
  rawKey: string,
  publicKeyPem: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Entitlement {
  const invalid = (reason: string, extra: Partial<Entitlement> = {}): Entitlement => ({
    tier: 'free', valid: false, reason, commercialUseAllowed: false, updatesActive: false, ...extra,
  });

  const parsed = parseLicenseKey(rawKey);
  if (!parsed) {
    return invalid('Not a valid AutoClaw license key.');
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
    return invalid('License signature is invalid (key was altered or not issued by us).');
  }

  const p = parsed.payload;
  // Product guard: an explicit non-autoclaw product is rejected. Absent = legacy
  // key (pre-product field) — accepted for backward compatibility.
  if (p.product && p.product !== 'autoclaw') {
    return invalid('License is not for AutoClaw.');
  }

  const { tier, seats, email, exp, licenseKind, majorVersion, updatesUntil, features } = p;

  // Expiry applies to subscriptions/trials. exp:null = perpetual-major (valid).
  if (exp !== null && typeof exp === 'number' && nowSec > exp) {
    return invalid('License has expired. Renew to keep commercial features.', {
      tier, email, seats, expiresAt: exp, product: p.product, licenseKind,
      majorVersion, updatesUntil, features,
    });
  }

  const ent: Entitlement = {
    tier,
    valid: true,
    reason: 'Active commercial license.',
    email,
    seats,
    expiresAt: exp,
    product: p.product,
    licenseKind,
    majorVersion,
    updatesUntil,
    features,
    // The update window does not invalidate use — it only marks update access.
    updatesActive: updatesUntil == null ? true : nowSec <= updatesUntil,
  };
  ent.commercialUseAllowed = isCommercialTier(ent);
  return ent;
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
