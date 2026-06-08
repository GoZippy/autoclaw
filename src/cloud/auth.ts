/**
 * auth.ts — `autoclaw cloud login`: cloud-relay authentication (Workstream D.1).
 *
 * The AutoClaw cloud relay is an OPT-IN, Pro-tier preview (V3_PLAN §6.D).
 * Local stays first-class — nothing here transmits, and the relay is INERT
 * until the user both (a) authenticates here and (b) configures a relay
 * endpoint (see `relay.ts`).
 *
 * What this module owns:
 *   - `cloudLogin()`   — acquire a personal access token, either by pasting a
 *                        PAT or by completing a web OAuth device flow, and
 *                        store it scoped to this machine's `installation_id`.
 *   - `cloudLogout()`  — revoke + delete the stored token.
 *   - `rotateToken()`  — replace the stored token (rotation).
 *   - `getCloudToken()`— read the token back for `relay.ts` to use.
 *
 * Security posture (enforced here):
 *   - The token is stored in the OS keychain when available, via a LAZY
 *     `require('keytar')` behind the {@link SecretStore} interface. keytar is
 *     deliberately NOT a package.json dependency — see TODO(keytar-dep).
 *   - When keytar is unavailable, a file-based AES-256-GCM encrypted fallback
 *     is used (`.autoclaw/cloud/credentials.enc`), keyed by a machine-derived
 *     key. The fallback file is chmod 0600 on POSIX.
 *   - Tokens are NEVER logged. `redactToken()` is used for any human output.
 *   - The token record is scoped to `installation_id`; a token minted for a
 *     different installation is rejected on read (`scope_mismatch`).
 *
 * Zero `vscode` import → fully unit-testable in plain Node. Network calls use
 * the Node global `fetch`; they are only made when the caller passes an
 * explicit OAuth issuer URL (web flow) — the manual-PAT path is offline.
 *
 * Sprint 4 — D1 (WA-4).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fsp = fs.promises;

// ---------------------------------------------------------------------------
// Token record
// ---------------------------------------------------------------------------

/** A stored cloud credential, scoped to one installation. */
export interface CloudTokenRecord {
  /** The personal access token / OAuth access token. Treat as a secret. */
  token: string;
  /** The `installation_id` this token is scoped to (fleet identity). */
  installation_id: string;
  /** How the token was acquired. */
  source: 'pat' | 'oauth';
  /** ISO timestamp the token was stored. */
  issued_at: string;
  /** ISO expiry, when the issuer provided one (OAuth). */
  expires_at?: string;
  /** Optional opaque refresh token (OAuth). Treat as a secret. */
  refresh_token?: string;
  /** Monotonic rotation counter — bumped by {@link rotateToken}. */
  rotation: number;
}

// ---------------------------------------------------------------------------
// installation_id — stable per-install fleet identity (V3_PLAN §4)
// ---------------------------------------------------------------------------

/**
 * Resolve this machine's `installation_id`, mirroring Antigravity's precedent
 * (V3_PLAN §4): a stable UUIDv4 at `.autoclaw/runtime/installation_id`.
 * Created on first call when absent. The cloud token is scoped to this value.
 */
export async function resolveInstallationId(autoclawDir: string): Promise<string> {
  const file = path.join(autoclawDir, 'runtime', 'installation_id');
  try {
    const raw = (await fsp.readFile(file, 'utf8')).trim();
    if (raw) {
      return raw;
    }
  } catch {
    // not present — mint one below
  }
  const id = crypto.randomUUID();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, id + '\n', 'utf8');
  return id;
}

// ---------------------------------------------------------------------------
// SecretStore — keytar with an encrypted file fallback
// ---------------------------------------------------------------------------

/** The keychain service name AutoClaw registers under. */
const KEYCHAIN_SERVICE = 'autoclaw-cloud';

/**
 * A minimal secret-storage interface. Two implementations exist: an OS
 * keychain store (lazy `require('keytar')`) and an encrypted file store.
 */
export interface SecretStore {
  /** Human-readable backend name, for the install report (never a secret). */
  readonly backend: string;
  /** Persist a secret string under `account`. */
  set(account: string, secret: string): Promise<void>;
  /** Read a secret string, or null when absent. */
  get(account: string): Promise<string | null>;
  /** Delete the secret. Returns true when something was removed. */
  delete(account: string): Promise<boolean>;
}

/**
 * Shape of the optional `keytar` native module. Declared structurally so this
 * file type-checks WITHOUT `keytar` (or `@types/keytar`) installed — keytar is
 * not a declared dependency.
 *
 * TODO(keytar-dep): if `keytar` is ever promoted to a real dependency in
 * package.json, replace the lazy `require` in {@link loadKeytar} with a static
 * `import type` + runtime import and delete this interface.
 */
interface KeytarModule {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/**
 * Attempt to load the optional `keytar` native module via a lazy `require`.
 * Returns null when it is not installed — the caller then falls back to the
 * encrypted file store. Never throws.
 */
function loadKeytar(): KeytarModule | null {
  try {
    // Indirected through a variable so bundlers / the TS compiler do not treat
    // this as a hard dependency. keytar is an OPTIONAL, lazy require.
    const req = require as (id: string) => unknown;
    const mod = req('keytar') as KeytarModule;
    if (
      mod &&
      typeof mod.setPassword === 'function' &&
      typeof mod.getPassword === 'function' &&
      typeof mod.deletePassword === 'function'
    ) {
      return mod;
    }
    return null;
  } catch {
    return null;
  }
}

/** SecretStore backed by the OS keychain (keytar). */
class KeytarSecretStore implements SecretStore {
  readonly backend = 'os-keychain';
  constructor(private readonly keytar: KeytarModule) {}
  async set(account: string, secret: string): Promise<void> {
    await this.keytar.setPassword(KEYCHAIN_SERVICE, account, secret);
  }
  async get(account: string): Promise<string | null> {
    return this.keytar.getPassword(KEYCHAIN_SERVICE, account);
  }
  async delete(account: string): Promise<boolean> {
    return this.keytar.deletePassword(KEYCHAIN_SERVICE, account);
  }
}

/**
 * SecretStore backed by an AES-256-GCM encrypted file under `.autoclaw/cloud/`.
 *
 * This is the fallback when keytar is absent. The encryption key is derived
 * from a machine-stable seed (hostname + platform + a per-install salt file)
 * via scrypt. This is NOT as strong as an OS keychain — it protects against
 * casual disclosure (a synced dotfile, a shoulder-surf of the JSON) but not
 * against an attacker with code-execution on the box. The keychain path is
 * always preferred; this exists so the relay still works on hosts without a
 * native keychain.
 */
class EncryptedFileSecretStore implements SecretStore {
  readonly backend = 'encrypted-file';
  constructor(private readonly cloudDir: string) {}

  private credFile(): string {
    return path.join(this.cloudDir, 'credentials.enc');
  }
  private saltFile(): string {
    return path.join(this.cloudDir, '.keyseed');
  }

  /** Derive (and persist a salt for) the file-encryption key. */
  private async deriveKey(): Promise<Buffer> {
    let salt: Buffer;
    try {
      salt = Buffer.from((await fsp.readFile(this.saltFile(), 'utf8')).trim(), 'hex');
      if (salt.length !== 32) {
        throw new Error('bad salt');
      }
    } catch {
      salt = crypto.randomBytes(32);
      await fsp.mkdir(this.cloudDir, { recursive: true });
      await fsp.writeFile(this.saltFile(), salt.toString('hex') + '\n', 'utf8');
      await chmod600(this.saltFile());
    }
    // Machine-stable seed — deliberately not a user secret; the salt provides
    // the per-install uniqueness.
    const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|autoclaw-cloud`;
    return crypto.scryptSync(seed, salt, 32);
  }

  /** Read + decrypt the credentials map ({ account: secret }). */
  private async readMap(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.credFile(), 'utf8');
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as { iv: string; tag: string; data: string };
      const key = await this.deriveKey();
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(parsed.iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, 'hex')),
        decipher.final(),
      ]).toString('utf8');
      return JSON.parse(plain) as Record<string, string>;
    } catch {
      // Tampered / unreadable — treat as empty rather than crash.
      return {};
    }
  }

  /** Encrypt + write the credentials map. */
  private async writeMap(map: Record<string, string>): Promise<void> {
    const key = await this.deriveKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([
      cipher.update(JSON.stringify(map), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const doc = JSON.stringify({
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: enc.toString('hex'),
    });
    await fsp.mkdir(this.cloudDir, { recursive: true });
    await fsp.writeFile(this.credFile(), doc, 'utf8');
    await chmod600(this.credFile());
  }

  async set(account: string, secret: string): Promise<void> {
    const map = await this.readMap();
    map[account] = secret;
    await this.writeMap(map);
  }
  async get(account: string): Promise<string | null> {
    const map = await this.readMap();
    return Object.prototype.hasOwnProperty.call(map, account) ? map[account] : null;
  }
  async delete(account: string): Promise<boolean> {
    const map = await this.readMap();
    if (!Object.prototype.hasOwnProperty.call(map, account)) {
      return false;
    }
    delete map[account];
    await this.writeMap(map);
    return true;
  }
}

/** Best-effort chmod 0600 on POSIX; a no-op on Windows. Never throws. */
async function chmod600(file: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  try {
    await fsp.chmod(file, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Resolve the {@link SecretStore} to use: the OS keychain when keytar is
 * available, otherwise the encrypted file fallback under `.autoclaw/cloud/`.
 */
export function resolveSecretStore(autoclawDir: string): SecretStore {
  const keytar = loadKeytar();
  if (keytar) {
    return new KeytarSecretStore(keytar);
  }
  return new EncryptedFileSecretStore(path.join(autoclawDir, 'cloud'));
}

// ---------------------------------------------------------------------------
// Token redaction — tokens NEVER appear in full in logs / reports
// ---------------------------------------------------------------------------

/**
 * Redact a token for human display: keep a 4-char prefix, mask the rest.
 * Short tokens are fully masked. This is the ONLY representation of a token
 * that may be printed.
 */
export function redactToken(token: string): string {
  if (!token) {
    return '(none)';
  }
  if (token.length <= 8) {
    return '*'.repeat(token.length);
  }
  return `${token.slice(0, 4)}${'*'.repeat(token.length - 4)}`;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/** The keychain account name a token record is stored under. */
function tokenAccount(installationId: string): string {
  return `token:${installationId}`;
}

/** Options for {@link cloudLogin}. */
export interface CloudLoginOptions {
  /** Absolute path to the `.autoclaw/` directory. */
  autoclawDir: string;
  /**
   * Manual-PAT path: the personal access token pasted by the user. When set,
   * no network call is made — the token is stored as-is.
   */
  pat?: string;
  /**
   * Web-OAuth path: the issuer base URL (e.g. `https://relay.example/oauth`).
   * When set and `pat` is not, {@link runDeviceFlow} drives an OAuth 2.0
   * device-authorization flow against it.
   */
  oauthIssuer?: string;
  /**
   * Called with the verification URL + user-code during the OAuth device
   * flow so the CLI / panel can show it. Receives no secret material.
   */
  onPrompt?: (info: { verificationUri: string; userCode: string }) => void;
  /** Injectable secret store (tests). Defaults to {@link resolveSecretStore}. */
  secretStore?: SecretStore;
  /** Injectable clock (tests). */
  now?: () => Date;
}

/** Outcome of a {@link cloudLogin} call. */
export interface CloudLoginResult {
  ok: boolean;
  /** The installation id the token was scoped to. */
  installation_id: string;
  /** Secret-store backend used (`os-keychain` | `encrypted-file`). */
  backend: string;
  /** How the token was acquired. */
  source: 'pat' | 'oauth';
  /** Redacted token preview — safe to print. */
  token_preview: string;
  /** Human-readable detail. Never contains the raw token. */
  detail: string;
}

/**
 * `autoclaw cloud login` — acquire and store a cloud-relay token.
 *
 * Two paths, chosen by the options:
 *   - `pat` set    → manual PAT entry. Offline; stores the pasted token.
 *   - `oauthIssuer`→ web OAuth device flow via the Node global `fetch`.
 *
 * The token is stored scoped to `installation_id`. On success the relay can
 * authenticate — but it still does NOT transmit until a relay endpoint is
 * configured (see `relay.ts`).
 */
export async function cloudLogin(opts: CloudLoginOptions): Promise<CloudLoginResult> {
  const now = opts.now ?? (() => new Date());
  const installationId = await resolveInstallationId(opts.autoclawDir);
  const store = opts.secretStore ?? resolveSecretStore(opts.autoclawDir);

  let record: CloudTokenRecord;

  if (opts.pat && opts.pat.trim()) {
    record = {
      token: opts.pat.trim(),
      installation_id: installationId,
      source: 'pat',
      issued_at: now().toISOString(),
      rotation: 0,
    };
  } else if (opts.oauthIssuer && opts.oauthIssuer.trim()) {
    const flow = await runDeviceFlow(opts.oauthIssuer.trim(), opts.onPrompt);
    if (!flow.ok) {
      return {
        ok: false,
        installation_id: installationId,
        backend: store.backend,
        source: 'oauth',
        token_preview: '(none)',
        detail: flow.detail,
      };
    }
    record = {
      token: flow.accessToken,
      installation_id: installationId,
      source: 'oauth',
      issued_at: now().toISOString(),
      ...(flow.expiresAt ? { expires_at: flow.expiresAt } : {}),
      ...(flow.refreshToken ? { refresh_token: flow.refreshToken } : {}),
      rotation: 0,
    };
  } else {
    return {
      ok: false,
      installation_id: installationId,
      backend: store.backend,
      source: 'pat',
      token_preview: '(none)',
      detail: 'no credential supplied — pass a PAT or an OAuth issuer URL',
    };
  }

  await store.set(tokenAccount(installationId), JSON.stringify(record));

  return {
    ok: true,
    installation_id: installationId,
    backend: store.backend,
    source: record.source,
    token_preview: redactToken(record.token),
    detail: `token stored in ${store.backend}, scoped to installation ${installationId}`,
  };
}

// ---------------------------------------------------------------------------
// Token read / rotation / revocation
// ---------------------------------------------------------------------------

/**
 * Read the stored cloud token record for this installation.
 *
 * Returns null when no token is stored. Returns `{ ok: false, reason }` when a
 * record exists but is unusable — notably `scope_mismatch` when the record was
 * minted for a different `installation_id` (per-machine scoping is enforced
 * on read, so a copied credentials file is rejected).
 */
export async function getCloudToken(
  autoclawDir: string,
  store?: SecretStore,
): Promise<
  | { ok: true; record: CloudTokenRecord }
  | { ok: false; reason: 'no_token' | 'scope_mismatch' | 'corrupt' | 'expired'; detail: string }
> {
  const installationId = await resolveInstallationId(autoclawDir);
  const s = store ?? resolveSecretStore(autoclawDir);
  const raw = await s.get(tokenAccount(installationId));
  if (!raw) {
    return { ok: false, reason: 'no_token', detail: 'not logged in to the cloud relay' };
  }
  let record: CloudTokenRecord;
  try {
    record = JSON.parse(raw) as CloudTokenRecord;
  } catch {
    return { ok: false, reason: 'corrupt', detail: 'stored token record is unreadable' };
  }
  if (!record.token || typeof record.token !== 'string') {
    return { ok: false, reason: 'corrupt', detail: 'stored token record has no token' };
  }
  if (record.installation_id !== installationId) {
    // Per-machine scoping: a token minted elsewhere is not valid here.
    return {
      ok: false,
      reason: 'scope_mismatch',
      detail:
        `stored token is scoped to a different installation ` +
        `(${record.installation_id} != ${installationId}); run cloud login again`,
    };
  }
  // F2 (security audit): a token past its expiry must not authenticate. The
  // relay treats this as inert (token_unusable) rather than sending a dead token.
  if (isTokenExpired(record)) {
    return { ok: false, reason: 'expired', detail: 'stored token has expired; run cloud login again' };
  }
  return { ok: true, record };
}

/** True when the stored token's `expires_at` is in the past. */
export function isTokenExpired(record: CloudTokenRecord, now: Date = new Date()): boolean {
  if (!record.expires_at) {
    return false;
  }
  const exp = new Date(record.expires_at).getTime();
  return Number.isFinite(exp) && exp <= now.getTime();
}

/**
 * Rotate the stored token: replace it with `newToken`, bump the rotation
 * counter, and re-stamp `issued_at`. Used both for manual rotation and after
 * an OAuth refresh. The previous token is overwritten in place — there is no
 * second copy on disk.
 */
export async function rotateToken(
  autoclawDir: string,
  newToken: string,
  opts: { store?: SecretStore; expiresAt?: string; refreshToken?: string; now?: () => Date } = {},
): Promise<{ ok: boolean; rotation: number; detail: string }> {
  const now = opts.now ?? (() => new Date());
  const installationId = await resolveInstallationId(autoclawDir);
  const store = opts.store ?? resolveSecretStore(autoclawDir);
  if (!newToken || !newToken.trim()) {
    return { ok: false, rotation: -1, detail: 'rotation requires a non-empty token' };
  }

  const existing = await getCloudToken(autoclawDir, store);
  const priorRotation =
    existing.ok ? existing.record.rotation : 0;
  const source: CloudTokenRecord['source'] =
    existing.ok ? existing.record.source : 'pat';

  const record: CloudTokenRecord = {
    token: newToken.trim(),
    installation_id: installationId,
    source,
    issued_at: now().toISOString(),
    rotation: priorRotation + 1,
    ...(opts.expiresAt ? { expires_at: opts.expiresAt } : {}),
    ...(opts.refreshToken ? { refresh_token: opts.refreshToken } : {}),
  };
  await store.set(tokenAccount(installationId), JSON.stringify(record));
  return {
    ok: true,
    rotation: record.rotation,
    detail: `token rotated (rotation #${record.rotation})`,
  };
}

/**
 * Revoke + delete the stored token (`autoclaw cloud logout`).
 *
 * When a `revokeEndpoint` is supplied, a best-effort `POST` is made to revoke
 * the token server-side before it is deleted locally; a network failure does
 * NOT block the local deletion (the user asked to log out — honour it).
 */
export async function cloudLogout(
  autoclawDir: string,
  opts: { store?: SecretStore; revokeEndpoint?: string } = {},
): Promise<{ ok: boolean; revokedRemotely: boolean; detail: string }> {
  const installationId = await resolveInstallationId(autoclawDir);
  const store = opts.store ?? resolveSecretStore(autoclawDir);

  let revokedRemotely = false;
  if (opts.revokeEndpoint && opts.revokeEndpoint.trim()) {
    const existing = await getCloudToken(autoclawDir, store);
    if (existing.ok) {
      try {
        const resp = await fetch(opts.revokeEndpoint.trim(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Token rides in the Authorization header, never the body / a log.
            authorization: `Bearer ${existing.record.token}`,
          },
          body: JSON.stringify({ installation_id: installationId }),
        });
        revokedRemotely = resp.ok;
      } catch {
        // Best-effort — local deletion proceeds regardless.
        revokedRemotely = false;
      }
    }
  }

  const removed = await store.delete(tokenAccount(installationId));
  return {
    ok: true,
    revokedRemotely,
    detail: removed
      ? `token deleted from ${store.backend}` +
        (revokedRemotely ? ' and revoked server-side' : '')
      : 'no token was stored',
  };
}

// ---------------------------------------------------------------------------
// OAuth 2.0 device-authorization flow (web login)
// ---------------------------------------------------------------------------

/** Result of {@link runDeviceFlow}. */
interface DeviceFlowResult {
  ok: boolean;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  detail: string;
}

/** Subset of the RFC 8628 device-authorization response we consume. */
interface DeviceAuthResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
}

/** Subset of the token-endpoint response we consume. */
interface DeviceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

/**
 * Drive an OAuth 2.0 device-authorization flow (RFC 8628) against `issuer`.
 *
 *   POST {issuer}/device   → device_code + user_code + verification_uri
 *   (user visits the URL and approves)
 *   POST {issuer}/token    → polled until access_token | error
 *
 * Uses the Node global `fetch`. Bounded: stops polling at `expires_in`. The
 * raw token is returned to {@link cloudLogin} and never logged here.
 *
 * This is wired as code only — no real issuer is contacted unless the user
 * passes a live `oauthIssuer` URL.
 */
async function runDeviceFlow(
  issuer: string,
  onPrompt?: (info: { verificationUri: string; userCode: string }) => void,
): Promise<DeviceFlowResult> {
  const base = issuer.replace(/\/+$/, '');
  let auth: DeviceAuthResponse;
  try {
    const resp = await fetch(`${base}/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'fleet.relay' }),
    });
    if (!resp.ok) {
      return {
        ok: false,
        accessToken: '',
        detail: `device-authorization request failed (HTTP ${resp.status})`,
      };
    }
    auth = (await resp.json()) as DeviceAuthResponse;
  } catch (err) {
    return {
      ok: false,
      accessToken: '',
      detail: `device-authorization request error: ${errMsg(err)}`,
    };
  }

  if (!auth.device_code || !auth.user_code) {
    return { ok: false, accessToken: '', detail: 'issuer returned an incomplete device response' };
  }

  onPrompt?.({
    verificationUri: auth.verification_uri_complete || auth.verification_uri || base,
    userCode: auth.user_code,
  });

  const intervalMs = Math.max(1, auth.interval ?? 5) * 1000;
  const deadline = Date.now() + Math.max(60, auth.expires_in ?? 600) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let token: DeviceTokenResponse;
    try {
      const resp = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: auth.device_code,
        }),
      });
      token = (await resp.json()) as DeviceTokenResponse;
    } catch (err) {
      return { ok: false, accessToken: '', detail: `token poll error: ${errMsg(err)}` };
    }
    if (token.access_token) {
      return {
        ok: true,
        accessToken: token.access_token,
        ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
        ...(token.expires_in
          ? { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }
          : {}),
        detail: 'OAuth device flow completed',
      };
    }
    // `authorization_pending` / `slow_down` ⇒ keep polling; anything else is fatal.
    if (token.error && token.error !== 'authorization_pending' && token.error !== 'slow_down') {
      return { ok: false, accessToken: '', detail: `OAuth flow rejected: ${token.error}` };
    }
  }
  return { ok: false, accessToken: '', detail: 'OAuth device flow timed out' };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
