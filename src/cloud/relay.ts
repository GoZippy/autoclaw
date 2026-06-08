/**
 * relay.ts — Cloud relay client (Workstream D.2).
 *
 * The relay forwards a SUBSET of AutoClaw's local file-bus state — heartbeats
 * and inbox messages — to a ZippyTech-hosted endpoint so a web dashboard can
 * show a cross-machine fleet view. It is a Pro-tier preview and is **opt-in**.
 *
 * INERT BY DEFAULT — security posture, enforced in this file:
 *   - The relay endpoint URL comes from `.autoclaw/cloud/relay-config.json`
 *     and DEFAULTS TO EMPTY. With no endpoint configured, every send is a
 *     no-op that returns `{ ok: true, skipped: 'relay_disabled' }`. Nothing
 *     leaves the machine.
 *   - `enabled` must also be explicitly `true`. Endpoint set + `enabled:false`
 *     ⇒ still inert.
 *   - A send requires a stored cloud token (see `auth.ts`). No token ⇒ inert.
 *   - The bearer token rides only in the `Authorization` header and is NEVER
 *     written to the offline queue, a log line, or a request body.
 *   - `POST /v1/inbox` payloads are ENCRYPTED (AES-256-GCM) before the network
 *     call — the relay stores ciphertext at rest (V3_PLAN §6.D.5).
 *   - `POST /v1/heartbeat` is batched + gzip-compressed to keep bandwidth low;
 *     cloud heartbeat cadence is 60s (vs the 30s local tick).
 *
 * Offline behaviour: failed sends are appended to a bounded on-disk queue
 * (`.autoclaw/cloud/queue/`) and retried on the next flush. The queue holds
 * already-encrypted inbox payloads and plain heartbeat batches (heartbeats are
 * low-sensitivity fleet telemetry; inbox messages are encrypted).
 *
 * Uses the Node global `fetch`. Zero `vscode` import → unit-testable.
 *
 * Sprint 4 — D2 (WA-4).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

import { getCloudToken, resolveInstallationId, type SecretStore } from './auth';

const fsp = fs.promises;

// ---------------------------------------------------------------------------
// Relay configuration — defaults to DISABLED
// ---------------------------------------------------------------------------

/** Cloud heartbeat cadence — 60s, deliberately slower than the 30s local tick. */
export const CLOUD_HEARTBEAT_INTERVAL_MS = 60_000;

/** Max retry attempts for a single batch before it is dropped from the queue. */
const MAX_RETRIES = 6;

/** Hard cap on queued items, so a long offline period cannot grow unbounded. */
const MAX_QUEUE_ITEMS = 500;

/**
 * The `.autoclaw/cloud/relay-config.json` document.
 *
 * ALL fields are optional and the safe defaults make the relay inert:
 *   - `endpoint` defaults to `''`  → relay disabled.
 *   - `enabled`  defaults to `false`.
 */
export interface RelayConfig {
  /**
   * Base URL of the relay (e.g. `https://relay.gozippy.com`). EMPTY by
   * default — an empty endpoint means the relay is OFF and no-ops every send.
   */
  endpoint: string;
  /** Master switch. Must be explicitly true; defaults to false. */
  enabled: boolean;
  /** Cloud heartbeat cadence override (ms). Defaults to 60s. */
  heartbeatIntervalMs: number;
  /** Per-request timeout (ms). Defaults to 15s. */
  requestTimeoutMs: number;
  // ── GA additions (CF-3) — all optional; absent ⇒ the safe/inert value ──
  /** Release tier. `'ga'` additionally REQUIRES an explicit consent ack. */
  tier?: 'preview' | 'ga';
  /** ISO timestamp of the user's explicit GA opt-in. Null/absent ⇒ no consent. */
  consentAckAt?: string | null;
  /**
   * Per-channel forwarding switches (F3 — heartbeats leave in clear). Absent
   * ⇒ both forward (preview back-compat). A channel set to `false` is skipped.
   */
  forward?: { heartbeats: boolean; inbox: boolean };
}

/** The inert default config — relay OFF, no endpoint. */
export function defaultRelayConfig(): RelayConfig {
  return {
    endpoint: '',
    enabled: false,
    heartbeatIntervalMs: CLOUD_HEARTBEAT_INTERVAL_MS,
    requestTimeoutMs: 15_000,
    tier: 'preview',
    consentAckAt: null,
  };
}

/**
 * F1 (security audit): a relay endpoint must be HTTPS so the bearer token
 * (Authorization header) and payload metadata are never sent in cleartext.
 * Plain `http://` is allowed ONLY for loopback (local dev). Anything else
 * (or an unparseable URL) is rejected ⇒ the relay stays inert.
 */
export function endpointIsSecure(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol === 'https:') { return true; }
    if (u.protocol === 'http:') {
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
    }
    return false;
  } catch {
    return false;
  }
}

/** Directory holding all cloud-relay state under a workspace `.autoclaw/`. */
export function cloudDir(autoclawDir: string): string {
  return path.join(autoclawDir, 'cloud');
}

/**
 * Read the relay config from `.autoclaw/cloud/relay-config.json`.
 *
 * A missing, empty, or unparseable file resolves to {@link defaultRelayConfig}
 * — i.e. the relay is OFF. This is the load-bearing "inert by default" rule.
 */
export async function readRelayConfig(autoclawDir: string): Promise<RelayConfig> {
  const file = path.join(cloudDir(autoclawDir), 'relay-config.json');
  const base = defaultRelayConfig();
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return base;
  }
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, '')) as Partial<RelayConfig>;
    const fwd = parsed.forward;
    return {
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint.trim() : base.endpoint,
      enabled: parsed.enabled === true,
      heartbeatIntervalMs:
        typeof parsed.heartbeatIntervalMs === 'number' && parsed.heartbeatIntervalMs > 0
          ? parsed.heartbeatIntervalMs
          : base.heartbeatIntervalMs,
      requestTimeoutMs:
        typeof parsed.requestTimeoutMs === 'number' && parsed.requestTimeoutMs > 0
          ? parsed.requestTimeoutMs
          : base.requestTimeoutMs,
      tier: parsed.tier === 'ga' ? 'ga' : 'preview',
      consentAckAt: typeof parsed.consentAckAt === 'string' ? parsed.consentAckAt : null,
      ...(fwd && typeof fwd === 'object'
        ? { forward: { heartbeats: fwd.heartbeats !== false, inbox: fwd.inbox !== false } }
        : {}),
    };
  } catch {
    return base;
  }
}

/**
 * True only when the relay is genuinely active: explicitly enabled AND a
 * non-empty endpoint is configured. Every send path checks this first.
 */
export function relayIsActive(cfg: RelayConfig): boolean {
  if (cfg.enabled !== true) { return false; }
  if (typeof cfg.endpoint !== 'string' || cfg.endpoint.trim().length === 0) { return false; }
  // F1: a configured endpoint must be HTTPS (or loopback http) or we stay inert.
  if (!endpointIsSecure(cfg.endpoint.trim())) { return false; }
  // GA tier additionally requires an explicit, recorded consent acknowledgement.
  if (cfg.tier === 'ga' && !cfg.consentAckAt) { return false; }
  return true;
}

// ---------------------------------------------------------------------------
// Payload encryption (inbox messages are encrypted before the network call)
// ---------------------------------------------------------------------------

/** An AES-256-GCM envelope — what is actually POSTed for inbox payloads. */
export interface EncryptedEnvelope {
  /** Algorithm tag, for forward-compatible decryption. */
  alg: 'aes-256-gcm';
  /** Random 96-bit IV, hex. */
  iv: string;
  /** GCM auth tag, hex. */
  tag: string;
  /** Ciphertext, base64. */
  data: string;
}

/**
 * Derive the payload-encryption key. The key is derived from the cloud token
 * + installation_id via scrypt — the relay never receives the key, only
 * ciphertext, so payloads are encrypted at rest server-side (V3_PLAN §6.D.5).
 *
 * NOTE: deriving from the bearer token couples key rotation to token rotation
 * — acceptable for the MVP. A future revision can negotiate a dedicated
 * data-encryption key during login.
 */
function derivePayloadKey(token: string, installationId: string): Buffer {
  return crypto.scryptSync(token, `autoclaw-relay|${installationId}`, 32);
}

/** Encrypt a JSON-serialisable value into an {@link EncryptedEnvelope}. */
export function encryptPayload(value: unknown, key: Buffer): EncryptedEnvelope {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: enc.toString('base64'),
  };
}

/** Decrypt an {@link EncryptedEnvelope} produced by {@link encryptPayload}. */
export function decryptPayload<T = unknown>(env: EncryptedEnvelope, key: Buffer): T {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(env.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plain) as T;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** A heartbeat as forwarded to the relay (a low-sensitivity subset). */
export interface RelayHeartbeat {
  agent_id: string;
  timestamp: string;
  status: string;
  current_task: string | null;
  sprint: number | null;
  session_id?: string;
  current_llm?: string;
}

/** An inbox message as forwarded to the relay (the body is encrypted). */
export interface RelayInboxMessage {
  /** Message id — kept in clear so the relay can de-dupe. */
  id: string;
  /** Recipient agent id — clear, for routing. */
  to: string;
  /** Sender agent id — clear, for routing. */
  from: string;
  /** Message type — clear, for the dashboard's coarse filtering. */
  type: string;
  /** ISO timestamp — clear, for ordering. */
  timestamp: string;
  /** The encrypted message payload (the sensitive part). */
  encrypted: EncryptedEnvelope;
}

/** A unit of work in the offline queue. */
interface QueueItem {
  /** Endpoint path the item targets. */
  kind: 'heartbeat' | 'inbox';
  /** ISO timestamp the item was queued. */
  queued_at: string;
  /** Retry attempts so far. */
  attempts: number;
  /** The request body (already gzip-ready JSON-able value). */
  body: unknown;
}

// ---------------------------------------------------------------------------
// Offline queue (bounded, on disk)
// ---------------------------------------------------------------------------

function queueDir(autoclawDir: string): string {
  return path.join(cloudDir(autoclawDir), 'queue');
}

/** Append an item to the on-disk offline queue, bounded at {@link MAX_QUEUE_ITEMS}. */
async function enqueue(autoclawDir: string, item: QueueItem): Promise<void> {
  const dir = queueDir(autoclawDir);
  await fsp.mkdir(dir, { recursive: true });
  // Drop oldest when over the cap.
  const existing = (await listQueue(autoclawDir)).sort();
  while (existing.length >= MAX_QUEUE_ITEMS) {
    const oldest = existing.shift();
    if (!oldest) {
      break;
    }
    try {
      await fsp.unlink(path.join(dir, oldest));
    } catch {
      /* already gone */
    }
  }
  const name = `${Date.now().toString().padStart(15, '0')}-${crypto
    .randomBytes(4)
    .toString('hex')}.json`;
  await fsp.writeFile(path.join(dir, name), JSON.stringify(item), 'utf8');
}

/** List queue filenames (sorted oldest-first by their timestamp prefix). */
async function listQueue(autoclawDir: string): Promise<string[]> {
  try {
    const names = await fsp.readdir(queueDir(autoclawDir));
    return names.filter(n => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/** Count of items waiting in the offline queue. */
export async function queueDepth(autoclawDir: string): Promise<number> {
  return (await listQueue(autoclawDir)).length;
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

/** Outcome of one relay POST. */
export interface RelaySendResult {
  ok: boolean;
  /** Set when the call did not actually transmit (relay off, no token, …). */
  skipped?: 'relay_disabled' | 'no_token' | 'token_unusable' | 'channel_disabled';
  /** HTTP status when a request was made. */
  status?: number;
  /** Items written to the offline queue because the send failed. */
  queued?: number;
  /** Human-readable detail. Never contains the token. */
  detail: string;
}

/**
 * POST a JSON value to `{endpoint}{pathSuffix}` with gzip + bearer auth.
 *
 * The body is gzip-compressed; the token is sent ONLY in the `Authorization`
 * header. Returns the HTTP status, or `status: 0` on a network error.
 */
async function postJson(
  endpoint: string,
  pathSuffix: string,
  token: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; detail: string }> {
  const url = endpoint.replace(/\/+$/, '') + pathSuffix;
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(body), 'utf8'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        // The bearer token lives ONLY here — never in a body or a log.
        authorization: `Bearer ${token}`,
      },
      body: gz,
      signal: controller.signal,
    });
    return {
      ok: resp.ok,
      status: resp.status,
      detail: resp.ok ? 'sent' : `relay returned HTTP ${resp.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: `network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Relay client
// ---------------------------------------------------------------------------

/** Options for constructing a {@link CloudRelay}. */
export interface CloudRelayOptions {
  /** Absolute path to the `.autoclaw/` directory. */
  autoclawDir: string;
  /** Injectable secret store (tests). Defaults to the resolved store. */
  secretStore?: SecretStore;
  /** Pre-loaded config (tests). Defaults to {@link readRelayConfig}. */
  config?: RelayConfig;
}

/**
 * The cloud relay client. Construct one and call `sendHeartbeats` /
 * `sendInbox` / `flushQueue`. Every method is a SAFE no-op when the relay is
 * not active — callers do not need to guard their call sites.
 */
export class CloudRelay {
  private readonly autoclawDir: string;
  private readonly secretStore?: SecretStore;
  private configOverride?: RelayConfig;

  constructor(opts: CloudRelayOptions) {
    this.autoclawDir = opts.autoclawDir;
    this.secretStore = opts.secretStore;
    this.configOverride = opts.config;
  }

  /** Resolve the active config (override wins; else read from disk). */
  private async config(): Promise<RelayConfig> {
    return this.configOverride ?? readRelayConfig(this.autoclawDir);
  }

  /**
   * Resolve `{ token, key }` for an active relay, or a `skipped` reason.
   * The encryption key is derived here and never stored.
   */
  private async credentials(): Promise<
    | { ok: true; token: string; key: Buffer; installationId: string }
    | { ok: false; skipped: RelaySendResult['skipped']; detail: string }
  > {
    const tok = await getCloudToken(this.autoclawDir, this.secretStore);
    if (!tok.ok) {
      return {
        ok: false,
        skipped: tok.reason === 'no_token' ? 'no_token' : 'token_unusable',
        detail: tok.detail,
      };
    }
    const installationId = await resolveInstallationId(this.autoclawDir);
    return {
      ok: true,
      token: tok.record.token,
      key: derivePayloadKey(tok.record.token, installationId),
      installationId,
    };
  }

  /**
   * `POST /v1/heartbeat` — forward a BATCH of heartbeats, gzip-compressed.
   *
   * No-ops (returns `{ ok: true, skipped }`) when the relay is inactive or no
   * token is stored. On a transient failure the batch is queued for retry.
   */
  async sendHeartbeats(heartbeats: RelayHeartbeat[]): Promise<RelaySendResult> {
    const cfg = await this.config();
    if (!relayIsActive(cfg)) {
      return { ok: true, skipped: 'relay_disabled', detail: 'cloud relay is disabled (inert)' };
    }
    // F3: heartbeats leave in clear — honour an explicit opt-out.
    if (cfg.forward && cfg.forward.heartbeats === false) {
      return { ok: true, skipped: 'channel_disabled', detail: 'heartbeat forwarding disabled' };
    }
    if (heartbeats.length === 0) {
      return { ok: true, detail: 'no heartbeats to send' };
    }
    const cred = await this.credentials();
    if (!cred.ok) {
      return { ok: true, skipped: cred.skipped, detail: cred.detail };
    }

    const body = {
      installation_id: cred.installationId,
      batched_at: new Date().toISOString(),
      heartbeats,
    };
    const res = await postJson(cfg.endpoint, '/v1/heartbeat', cred.token, body, cfg.requestTimeoutMs);
    if (!res.ok) {
      await enqueue(this.autoclawDir, {
        kind: 'heartbeat',
        queued_at: new Date().toISOString(),
        attempts: 0,
        body,
      });
      return { ok: false, status: res.status, queued: 1, detail: `${res.detail}; queued for retry` };
    }
    return { ok: true, status: res.status, detail: `${heartbeats.length} heartbeat(s) sent` };
  }

  /**
   * `POST /v1/inbox` — forward inbox messages with each payload ENCRYPTED at
   * rest before the network call (V3_PLAN §6.D.5).
   *
   * Accepts plain inbox messages `{ id, to, from, type, timestamp, payload }`;
   * the `payload` is encrypted into an {@link EncryptedEnvelope} here. The
   * relay only ever stores ciphertext for the message body.
   */
  async sendInbox(
    messages: Array<{
      id: string;
      to: string;
      from: string;
      type: string;
      timestamp: string;
      payload: unknown;
    }>,
  ): Promise<RelaySendResult> {
    const cfg = await this.config();
    if (!relayIsActive(cfg)) {
      return { ok: true, skipped: 'relay_disabled', detail: 'cloud relay is disabled (inert)' };
    }
    if (cfg.forward && cfg.forward.inbox === false) {
      return { ok: true, skipped: 'channel_disabled', detail: 'inbox forwarding disabled' };
    }
    if (messages.length === 0) {
      return { ok: true, detail: 'no inbox messages to send' };
    }
    const cred = await this.credentials();
    if (!cred.ok) {
      return { ok: true, skipped: cred.skipped, detail: cred.detail };
    }

    // Encrypt every payload BEFORE it touches the network or the queue.
    const wire: RelayInboxMessage[] = messages.map(m => ({
      id: m.id,
      to: m.to,
      from: m.from,
      type: m.type,
      timestamp: m.timestamp,
      encrypted: encryptPayload(m.payload, cred.key),
    }));
    const body = {
      installation_id: cred.installationId,
      batched_at: new Date().toISOString(),
      messages: wire,
    };
    const res = await postJson(cfg.endpoint, '/v1/inbox', cred.token, body, cfg.requestTimeoutMs);
    if (!res.ok) {
      // The queued body already contains only ciphertext for message bodies.
      await enqueue(this.autoclawDir, {
        kind: 'inbox',
        queued_at: new Date().toISOString(),
        attempts: 0,
        body,
      });
      return { ok: false, status: res.status, queued: 1, detail: `${res.detail}; queued for retry` };
    }
    return { ok: true, status: res.status, detail: `${messages.length} inbox message(s) sent` };
  }

  /**
   * Flush the offline queue: retry every queued batch. Items that succeed are
   * deleted; items that fail have their `attempts` bumped and are re-queued
   * until {@link MAX_RETRIES}, after which they are dropped.
   *
   * A no-op when the relay is inactive.
   */
  async flushQueue(): Promise<{ ok: boolean; sent: number; dropped: number; remaining: number; detail: string }> {
    const cfg = await this.config();
    if (!relayIsActive(cfg)) {
      return {
        ok: true,
        sent: 0,
        dropped: 0,
        remaining: await queueDepth(this.autoclawDir),
        detail: 'cloud relay is disabled (inert) — queue untouched',
      };
    }
    const cred = await this.credentials();
    if (!cred.ok) {
      return {
        ok: true,
        sent: 0,
        dropped: 0,
        remaining: await queueDepth(this.autoclawDir),
        detail: cred.detail,
      };
    }

    const dir = queueDir(this.autoclawDir);
    const names = await listQueue(this.autoclawDir);
    let sent = 0;
    let dropped = 0;

    for (const name of names) {
      const file = path.join(dir, name);
      let item: QueueItem;
      try {
        item = JSON.parse(await fsp.readFile(file, 'utf8')) as QueueItem;
      } catch {
        // Corrupt queue file — discard it.
        await safeUnlink(file);
        dropped++;
        continue;
      }
      const suffix = item.kind === 'heartbeat' ? '/v1/heartbeat' : '/v1/inbox';
      const res = await postJson(cfg.endpoint, suffix, cred.token, item.body, cfg.requestTimeoutMs);
      if (res.ok) {
        await safeUnlink(file);
        sent++;
      } else {
        item.attempts += 1;
        if (item.attempts >= MAX_RETRIES) {
          await safeUnlink(file);
          dropped++;
        } else {
          await fsp.writeFile(file, JSON.stringify(item), 'utf8');
        }
      }
    }

    const remaining = await queueDepth(this.autoclawDir);
    return {
      ok: true,
      sent,
      dropped,
      remaining,
      detail: `flushed ${sent} sent, ${dropped} dropped, ${remaining} remaining`,
    };
  }
}

/** Delete a file, ignoring "already gone". */
async function safeUnlink(file: string): Promise<void> {
  try {
    await fsp.unlink(file);
  } catch {
    /* already gone */
  }
}
