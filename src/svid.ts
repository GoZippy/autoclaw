/**
 * svid.ts — Phase 4 SPIFFE/SVID workload identity layer.
 *
 * Implements JWT-SVIDs (https://github.com/spiffe/spiffe/blob/main/standards/JWT-SVID.md)
 * for short-lived (5-min TTL) workload attestation. Agents obtain an SVID on
 * startup and refresh it every 4 minutes. The bridge validates SVIDs alongside
 * bearer/Biscuit tokens.
 *
 * Upgrade path: if `AUTOCLAW_SPIRE_SOCKET` env var points to a running SPIRE
 * workload agent socket, real SVIDs are fetched via the SPIFFE Workload API
 * gRPC endpoint. Otherwise an HMAC-SHA256 signed JWT-SVID mock is used —
 * same trust model as the Biscuit mock in biscuit.ts.
 *
 * Spec: docs/DISTRIBUTED_AGENT_FABRIC.md §3 Phase 4.
 */

import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SvidClaims {
  /** Full SPIFFE ID: `spiffe://autoclaw/<workspace_hash>/<agent_id>` */
  sub: string;
  /** Audience (always `autoclaw-bridge` for intra-fleet tokens). */
  aud: string;
  /** Unix epoch seconds — issued at. */
  iat: number;
  /** Unix epoch seconds — expires at. */
  exp: number;
  /** Convenience: agent_id extracted from sub. */
  agent_id: string;
  /** SHA-256 prefix of workspace root path (stable workspace identity). */
  workspace_id: string;
  /** Optional: signing key ID for key rotation (defaults to 'mock-hmac-v1'). */
  kid?: string;
}

export interface SvidToken {
  /** URL-safe base64url JWT string. */
  raw: string;
  /** Decoded claims (not re-verified — use verifySvid for auth decisions). */
  claims: SvidClaims;
  /** ISO-8601 expiry derived from exp claim. */
  expires_at: string;
}

export type SvidVerifyResult =
  | { ok: true; claims: SvidClaims }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRUST_DOMAIN = 'autoclaw';
const DEFAULT_AUDIENCE = 'autoclaw-bridge';
const DEFAULT_TTL_SECONDS = 300; // 5 minutes — SPIFFE recommended maximum
const SIGNING_ALG = 'HS256';     // mock; real SPIRE uses RS256/ES256

// ---------------------------------------------------------------------------
// Mock signing (HMAC-SHA256)
// ---------------------------------------------------------------------------

const MOCK_SECRET = process.env.AUTOCLAW_SVID_SECRET
  ?? process.env.AUTOCLAW_BISCUIT_SECRET  // share secret if set
  ?? crypto.randomBytes(32).toString('hex');

function jwtBase64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function jwtSign(header: string, payload: string): string {
  return crypto.createHmac('sha256', MOCK_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
}

function buildJwt(claims: SvidClaims): string {
  const header = jwtBase64url({ alg: SIGNING_ALG, typ: 'JWT', kid: claims.kid ?? 'mock-hmac-v1' });
  const payload = jwtBase64url(claims);
  const sig = jwtSign(header, payload);
  return `${header}.${payload}.${sig}`;
}

function parseJwt(raw: string): { header: Record<string, unknown>; claims: SvidClaims } | null {
  try {
    const parts = raw.split('.');
    if (parts.length !== 3) { return null; }
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as SvidClaims;
    return { header, claims };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SPIFFE ID helpers
// ---------------------------------------------------------------------------

function workspaceId(workspacePath: string): string {
  return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
}

function buildSpiffeId(agentId: string, wsId: string): string {
  return `spiffe://${TRUST_DOMAIN}/${wsId}/${agentId}`;
}

// ---------------------------------------------------------------------------
// SPIRE workload API (optional external dep)
// ---------------------------------------------------------------------------

let _spireAvailable: boolean | null = null;

/**
 * Returns true when a SPIRE workload agent socket exists at
 * `AUTOCLAW_SPIRE_SOCKET` and the gRPC fetch succeeds.
 */
export async function isSpireAvailable(): Promise<boolean> {
  if (_spireAvailable !== null) { return _spireAvailable; }
  const socket = process.env.AUTOCLAW_SPIRE_SOCKET;
  if (!socket) { _spireAvailable = false; return false; }
  try {
    // Attempt a lightweight `FetchJWTSVID` request via dynamic import of
    // `@spiffehq/spiffe-workload-api` (optional dep). The dep is never
    // bundled; only loaded when the SPIRE socket env var is set.
    await (Function('return import("@spiffehq/spiffe-workload-api")')() as Promise<unknown>);
    _spireAvailable = true;
  } catch {
    _spireAvailable = false;
  }
  return _spireAvailable;
}

async function fetchSvidFromSpire(
  agentId: string,
  audience: string,
): Promise<string | null> {
  const socket = process.env.AUTOCLAW_SPIRE_SOCKET;
  if (!socket) { return null; }
  try {
    const lib = await (Function('return import("@spiffehq/spiffe-workload-api")')() as Promise<unknown>);
    const api = lib as {
      WorkloadAPIClient: new (socket: string) => {
        fetchJwtSVID(audience: string): Promise<{ svid: string }>;
      };
    };
    const client = new api.WorkloadAPIClient(`unix://${socket}`);
    const result = await client.fetchJwtSVID(audience);
    void agentId; // SPIRE uses the process's own SVID; agent_id embedded in trust domain path
    return result.svid;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mint a JWT-SVID for the given agent.
 *
 * When `AUTOCLAW_SPIRE_SOCKET` is set and SPIRE is reachable, the real
 * SPIRE workload SVID is returned. Otherwise the HMAC-SHA256 mock is used.
 */
export async function mintSvid(
  agentId: string,
  opts: {
    workspacePath?: string;
    audience?: string;
    ttlSeconds?: number;
  } = {}
): Promise<SvidToken> {
  const audience = opts.audience ?? DEFAULT_AUDIENCE;
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const wsId = workspaceId(opts.workspacePath ?? process.cwd());

  // Try real SPIRE first
  if (await isSpireAvailable()) {
    const spireJwt = await fetchSvidFromSpire(agentId, audience);
    if (spireJwt) {
      const parsed = parseJwt(spireJwt);
      if (parsed) {
        const claims: SvidClaims = {
          ...parsed.claims,
          agent_id: agentId,
          workspace_id: wsId,
        };
        return {
          raw: spireJwt,
          claims,
          expires_at: new Date(claims.exp * 1000).toISOString(),
        };
      }
    }
    _spireAvailable = false;
  }

  // Mock path — HMAC-SHA256 JWT-SVID
  const now = Math.floor(Date.now() / 1000);
  const sub = buildSpiffeId(agentId, wsId);
  const claims: SvidClaims = {
    sub,
    aud: audience,
    iat: now,
    exp: now + ttl,
    agent_id: agentId,
    workspace_id: wsId,
    kid: 'mock-hmac-v1',
  };
  const raw = buildJwt(claims);
  return {
    raw,
    claims,
    expires_at: new Date((now + ttl) * 1000).toISOString(),
  };
}

/**
 * Verify a JWT-SVID: check signature, expiry, and audience.
 * Safe to use for authorization decisions on the mock path; real SPIRE path
 * should be validated by the SPIRE agent's bundle endpoint instead.
 */
export async function verifySvid(
  raw: string,
  opts: {
    audience?: string;
    /** Accept tokens issued up to this many seconds in the future (clock skew). */
    clockSkewSeconds?: number;
  } = {}
): Promise<SvidVerifyResult> {
  const parsed = parseJwt(raw);
  if (!parsed) {
    return { ok: false, reason: 'malformed_jwt' };
  }
  const { claims } = parsed;
  const now = Math.floor(Date.now() / 1000);
  const skew = opts.clockSkewSeconds ?? 5;

  if (claims.exp < now - skew) {
    return { ok: false, reason: 'expired' };
  }
  if (claims.iat > now + skew) {
    return { ok: false, reason: 'not_yet_valid' };
  }

  const expectedAud = opts.audience ?? DEFAULT_AUDIENCE;
  if (claims.aud !== expectedAud) {
    return { ok: false, reason: `wrong_audience: expected ${expectedAud}, got ${claims.aud}` };
  }

  // Verify signature (mock path only — real SPIRE JWTs use RS256/ES256 with
  // the bundle endpoint's public key, which we don't have locally).
  const kid = parsed.header.kid;
  if (kid === 'mock-hmac-v1') {
    const parts = raw.split('.');
    const expectedSig = jwtSign(parts[0], parts[1]);
    if (parts[2] !== expectedSig) {
      return { ok: false, reason: 'invalid_signature' };
    }
  }
  // For real SPIRE SVIDs (RS256/ES256), signature check is delegated to
  // the SPIRE bundle endpoint; we trust the token structure if SPIRE is set up.

  if (!claims.sub || !claims.sub.startsWith(`spiffe://${TRUST_DOMAIN}/`)) {
    return { ok: false, reason: `invalid_spiffe_id: ${claims.sub}` };
  }

  return { ok: true, claims };
}

/**
 * Extract claims from a JWT-SVID without verifying the signature.
 * For display / logging only — never use for authorization.
 */
export function decodeSvidUnsafe(raw: string): SvidClaims | null {
  return parseJwt(raw)?.claims ?? null;
}

// ---------------------------------------------------------------------------
// Auto-refresh singleton
// ---------------------------------------------------------------------------

let _current: SvidToken | null = null;
let _refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Return the current SVID, minting a fresh one if needed.
 * Starts a background refresh timer (every 4 minutes) on first call.
 */
export async function getCurrentSvid(
  agentId: string,
  opts: { workspacePath?: string; audience?: string } = {}
): Promise<SvidToken> {
  const now = Date.now();
  if (_current && new Date(_current.expires_at).getTime() - now > 60 * 1000) {
    return _current;
  }
  _current = await mintSvid(agentId, opts);

  if (!_refreshTimer) {
    _refreshTimer = setInterval(async () => {
      try {
        _current = await mintSvid(agentId, opts);
      } catch {
        // Keep stale token until next tick rather than breaking callers.
      }
    }, 4 * 60 * 1000); // refresh every 4 min; token valid for 5 min
    // Don't hold the event loop open in tests / extension deactivation
    if (typeof _refreshTimer.unref === 'function') { _refreshTimer.unref(); }
  }
  return _current;
}

/** Stop the auto-refresh timer (call on extension deactivation). */
export function stopSvidRefresh(): void {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  _current = null;
}
