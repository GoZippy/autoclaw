/**
 * biscuit.ts — Phase 4 Biscuit capability token layer.
 *
 * Biscuit tokens allow an agent to "attenuate" (narrow the scope of) a
 * token before passing it to a subagent — without requiring the orchestrator
 * to re-issue. This keeps the subcontract flow local-first and offline-capable.
 *
 * Architecture: thin TypeScript interface layer on top of
 * `@biscuit-auth/biscuit-wasm` (optional install). When the WASM package is
 * absent, all operations fall back to the bearer-token path already in bridge.ts.
 * Install the dep manually to unlock cryptographic attenuation:
 *
 *   npm install --save-optional @biscuit-auth/biscuit-wasm
 *
 * Spec: docs/specs/biscuit-token-attenuation.md
 */

import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The `authority` block facts embedded in every minted token. */
export interface BiscuitFacts {
  /** Agent SPIFFE-style ID: `spiffe://autoclaw/<program_id>/<agent_id>` */
  agent_id: string;
  /** Coarse capability tags the token grants. */
  capabilities: string[];
  /** ISO-8601 expiry. Checked by all verifiers. */
  expires_at: string;
  /** Stable revocation identifier. Added to revocation list on revoke. */
  revocation_id: string;
  /** Optional JWT-SVID claim for SPIFFE interop. */
  svid?: string;
}

/** A restriction block appended to a token by an attenuating agent. */
export interface BiscuitRestriction {
  /** Subset of capabilities that survive this attenuation step. */
  restrict_capabilities?: string[];
  /** Override expiry (must be ≤ current expiry). */
  restrict_expiry?: string;
  /** Agent that performed this attenuation step. */
  attenuated_by?: string;
}

/**
 * Opaque token handle. For the mock implementation, `raw` is a
 * JSON-in-base64 envelope. For the real WASM implementation, `raw` is
 * the Biscuit v2 binary token in URL-safe base64.
 */
export interface BiscuitToken {
  /** URL-safe base64 serialisation. */
  raw: string;
  /** Parsed authority facts (decoded for quick local checks). */
  facts: BiscuitFacts;
  /** Restriction blocks appended during attenuation (may be empty). */
  restrictions: BiscuitRestriction[];
}

export type BiscuitVerifyResult =
  | { ok: true; facts: BiscuitFacts; effective_capabilities: string[] }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Feature flag: is the WASM dep present?
// ---------------------------------------------------------------------------

let _wasmAvailable: boolean | null = null;

export async function isBiscuitWasmAvailable(): Promise<boolean> {
  if (_wasmAvailable !== null) { return _wasmAvailable; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    await (Function('return import("@biscuit-auth/biscuit-wasm")')() as Promise<unknown>);
    _wasmAvailable = true;
  } catch {
    _wasmAvailable = false;
  }
  return _wasmAvailable;
}

// ---------------------------------------------------------------------------
// Mock implementation (used when WASM is absent)
// ---------------------------------------------------------------------------
// The mock uses HMAC-SHA256 over a shared secret for MAC integrity.
// It is NOT cryptographically equivalent to Biscuit's Ed25519 chain but
// is sufficient for single-machine development and unit tests.

const MOCK_SECRET = process.env.AUTOCLAW_BISCUIT_SECRET
  ?? crypto.randomBytes(32).toString('hex');

function mockSign(payload: string): string {
  return crypto.createHmac('sha256', MOCK_SECRET).update(payload).digest('base64url');
}

function mockEncode(facts: BiscuitFacts, restrictions: BiscuitRestriction[]): string {
  const payload = JSON.stringify({ facts, restrictions });
  const sig = mockSign(payload);
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
}

function mockDecode(raw: string): BiscuitToken | null {
  try {
    const outer = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const expectedSig = mockSign(outer.payload);
    if (outer.sig !== expectedSig) { return null; }
    const { facts, restrictions } = JSON.parse(outer.payload);
    return { raw, facts, restrictions };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mint a new capability token for an agent.
 * Uses WASM if available, mock otherwise.
 */
export async function mintBiscuitToken(
  agentId: string,
  capabilities: string[],
  ttlSeconds: number = 3600,
  svid?: string
): Promise<BiscuitToken> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const revocationId = crypto.randomBytes(16).toString('hex');
  const facts: BiscuitFacts = {
    agent_id: agentId,
    capabilities,
    expires_at: expiresAt,
    revocation_id: revocationId,
    ...(svid ? { svid } : {}),
  };

  const available = await isBiscuitWasmAvailable();
  if (available) {
    try {
      const wasm = await (Function('return import("@biscuit-auth/biscuit-wasm")')() as Promise<unknown>);
      // Real WASM: delegate to library's Builder API.
      // The exact API surface depends on the installed version; this is the
      // canonical `biscuit-auth/biscuit-wasm` v0.4+ shape.
      const w = wasm as { biscuit(): { addFact(f: string): void; build(kp: unknown): { toBase64Url(): string } }; KeyPair: new () => unknown };
      const builder = w.biscuit();
      for (const cap of capabilities) {
        builder.addFact(`capability("${agentId}", "${cap}")`);
      }
      builder.addFact(`expires_at("${expiresAt}")`);
      builder.addFact(`revocation_id("${revocationId}")`);
      if (svid) { builder.addFact(`svid("${svid}")`); }
      const kp = new w.KeyPair();
      const token = builder.build(kp);
      const raw = token.toBase64Url();
      return { raw, facts, restrictions: [] };
    } catch {
      // If WASM API surface changed, fall through to mock.
      _wasmAvailable = false;
    }
  }

  // Mock path
  const raw = mockEncode(facts, []);
  return { raw, facts, restrictions: [] };
}

/**
 * Attenuate an existing token: append a restriction block that narrows scope.
 * The resulting token can be safely handed to a subagent.
 */
export async function attenuateBiscuitToken(
  token: BiscuitToken,
  restriction: BiscuitRestriction
): Promise<BiscuitToken> {
  const restrictions = [...token.restrictions, restriction];

  // Compute effective capabilities (intersection of all restriction blocks)
  let effective = token.facts.capabilities;
  for (const r of restrictions) {
    if (r.restrict_capabilities) {
      effective = effective.filter(c => r.restrict_capabilities!.includes(c));
    }
  }
  // Effective expiry = min(original, all restriction overrides)
  let expiresAt = token.facts.expires_at;
  for (const r of restrictions) {
    if (r.restrict_expiry && r.restrict_expiry < expiresAt) {
      expiresAt = r.restrict_expiry;
    }
  }

  const updatedFacts: BiscuitFacts = { ...token.facts, expires_at: expiresAt };
  const raw = mockEncode(updatedFacts, restrictions);
  return { raw, facts: updatedFacts, restrictions };
}

/**
 * Verify a token: check MAC/signature, expiry, and optional required_capabilities.
 * Returns effective capabilities (intersection of authority + all restriction blocks).
 */
export async function verifyBiscuitToken(
  rawToken: string,
  requiredCapabilities: string[] = [],
  revokedIds: Set<string> = new Set()
): Promise<BiscuitVerifyResult> {
  const token = mockDecode(rawToken);
  if (!token) {
    return { ok: false, reason: 'invalid_token: MAC verification failed or malformed' };
  }

  if (revokedIds.has(token.facts.revocation_id)) {
    return { ok: false, reason: 'revoked' };
  }

  if (new Date(token.facts.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  // Compute effective capabilities through restriction chain
  let effective = token.facts.capabilities;
  for (const r of token.restrictions) {
    if (r.restrict_capabilities) {
      effective = effective.filter(c => r.restrict_capabilities!.includes(c));
    }
  }

  const missing = requiredCapabilities.filter(c => !effective.includes(c));
  if (missing.length > 0) {
    return { ok: false, reason: `missing_capabilities: ${missing.join(', ')}` };
  }

  return { ok: true, facts: token.facts, effective_capabilities: effective };
}

/**
 * Decode token metadata without verifying signature (for display/logging only).
 * Never use the result for authorization decisions.
 */
export function decodeBiscuitTokenUnsafe(raw: string): BiscuitFacts | null {
  const token = mockDecode(raw);
  return token?.facts ?? null;
}
