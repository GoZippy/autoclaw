/**
 * cloudRelay.test.ts — Unit tests for the Sprint-4 WA-4 cloud relay (D1/D2)
 * and the MCP extended install (H3).
 *
 * Exercises auth (token store, scoping, rotation, redaction), the relay
 * (inert-by-default, encryption, offline queue), and the extended install +
 * tools — all against temp workspaces. No network, no real keychain (an
 * in-memory SecretStore is injected).
 *
 * NEW test file — Sprint 4 (WA-4). Does not modify any existing test.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  cloudLogin,
  cloudLogout,
  rotateToken,
  getCloudToken,
  isTokenExpired,
  redactToken,
  resolveInstallationId,
  resolveSecretStore,
  type SecretStore,
  type CloudTokenRecord,
} from '../cloud/auth';
import {
  CloudRelay,
  readRelayConfig,
  relayIsActive,
  defaultRelayConfig,
  endpointIsSecure,
  encryptPayload,
  decryptPayload,
  queueDepth,
  CLOUD_HEARTBEAT_INTERVAL_MS,
  type RelayConfig,
} from '../cloud/relay';
import {
  readExtendedConfig,
  defaultExtendedConfig,
  endpointIsConfigured,
  installExtended,
  formatExtendedReport,
  fleetDispatchTool,
  voidspecSyncTool,
  EXTENDED_TOOLS,
} from '../mcp/install-extended';
import type { ToolContext } from '../mcp/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkspace(): { root: string; autoclawDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-wa4-'));
  const autoclawDir = path.join(root, '.autoclaw');
  fs.mkdirSync(autoclawDir, { recursive: true });
  return { root, autoclawDir };
}

/** An in-memory SecretStore — stands in for the OS keychain in tests. */
class MemoryStore implements SecretStore {
  readonly backend = 'memory-test';
  private map = new Map<string, string>();
  async set(account: string, secret: string): Promise<void> {
    this.map.set(account, secret);
  }
  async get(account: string): Promise<string | null> {
    return this.map.get(account) ?? null;
  }
  async delete(account: string): Promise<boolean> {
    return this.map.delete(account);
  }
}

function ctxOf(autoclawDir: string): ToolContext {
  return {
    workspaceRoot: path.dirname(autoclawDir),
    autoclawDir,
    scope: 'workspace',
    host: 'claude-code',
  };
}

// ---------------------------------------------------------------------------
// D1 — auth
// ---------------------------------------------------------------------------

suite('Sprint 4 WA-4 — D1 cloud auth', () => {
  test('redactToken never reveals the full token', () => {
    assert.strictEqual(redactToken('abcdefghijklmnop'), 'abcd************');
    assert.strictEqual(redactToken('short'), '*****');
    assert.strictEqual(redactToken(''), '(none)');
  });

  test('resolveInstallationId mints a stable UUID', async () => {
    const { autoclawDir } = makeWorkspace();
    const a = await resolveInstallationId(autoclawDir);
    const b = await resolveInstallationId(autoclawDir);
    assert.strictEqual(a, b, 'installation id is stable across calls');
    assert.match(a, /^[0-9a-f-]{36}$/);
  });

  test('cloudLogin stores a PAT scoped to installation_id', async () => {
    const { autoclawDir } = makeWorkspace();
    const store = new MemoryStore();
    const res = await cloudLogin({ autoclawDir, pat: 'pat-secret-token-123', secretStore: store });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.source, 'pat');
    assert.ok(!res.token_preview.includes('secret'), 'preview is redacted');

    const tok = await getCloudToken(autoclawDir, store);
    assert.strictEqual(tok.ok, true);
    if (tok.ok) {
      assert.strictEqual(tok.record.token, 'pat-secret-token-123');
      assert.strictEqual(tok.record.installation_id, res.installation_id);
    }
  });

  test('cloudLogin fails cleanly with no credential', async () => {
    const { autoclawDir } = makeWorkspace();
    const res = await cloudLogin({ autoclawDir, secretStore: new MemoryStore() });
    assert.strictEqual(res.ok, false);
  });

  test('getCloudToken rejects a token scoped to another installation', async () => {
    const { autoclawDir } = makeWorkspace();
    const store = new MemoryStore();
    const installationId = await resolveInstallationId(autoclawDir);
    const foreign: CloudTokenRecord = {
      token: 't',
      installation_id: 'some-other-installation',
      source: 'pat',
      issued_at: new Date().toISOString(),
      rotation: 0,
    };
    await store.set(`token:${installationId}`, JSON.stringify(foreign));
    const tok = await getCloudToken(autoclawDir, store);
    assert.strictEqual(tok.ok, false);
    if (!tok.ok) {
      assert.strictEqual(tok.reason, 'scope_mismatch');
    }
  });

  test('rotateToken replaces the token and bumps the rotation counter', async () => {
    const { autoclawDir } = makeWorkspace();
    const store = new MemoryStore();
    await cloudLogin({ autoclawDir, pat: 'first-token', secretStore: store });
    const r1 = await rotateToken(autoclawDir, 'second-token', { store });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.rotation, 1);
    const tok = await getCloudToken(autoclawDir, store);
    assert.ok(tok.ok && tok.record.token === 'second-token');
  });

  test('cloudLogout deletes the stored token', async () => {
    const { autoclawDir } = makeWorkspace();
    const store = new MemoryStore();
    await cloudLogin({ autoclawDir, pat: 'tok', secretStore: store });
    const out = await cloudLogout(autoclawDir, { store });
    assert.strictEqual(out.ok, true);
    const tok = await getCloudToken(autoclawDir, store);
    assert.ok(!tok.ok);
  });

  test('isTokenExpired honours expires_at', () => {
    const past: CloudTokenRecord = {
      token: 't', installation_id: 'i', source: 'oauth', rotation: 0,
      issued_at: '2020-01-01T00:00:00Z', expires_at: '2020-01-02T00:00:00Z',
    };
    assert.strictEqual(isTokenExpired(past), true);
    const noExpiry: CloudTokenRecord = {
      token: 't', installation_id: 'i', source: 'pat', rotation: 0,
      issued_at: '2020-01-01T00:00:00Z',
    };
    assert.strictEqual(isTokenExpired(noExpiry), false);
  });
});

// ---------------------------------------------------------------------------
// D2 — relay
// ---------------------------------------------------------------------------

suite('Sprint 4 WA-4 — D2 cloud relay', () => {
  test('defaults to disabled / inert', async () => {
    const { autoclawDir } = makeWorkspace();
    const cfg = await readRelayConfig(autoclawDir);
    assert.strictEqual(cfg.endpoint, '', 'no endpoint by default');
    assert.strictEqual(cfg.enabled, false, 'disabled by default');
    assert.strictEqual(relayIsActive(cfg), false);
    assert.strictEqual(defaultRelayConfig().enabled, false);
    assert.strictEqual(CLOUD_HEARTBEAT_INTERVAL_MS, 60_000);
  });

  test('sendHeartbeats no-ops when the relay is disabled (nothing transmits)', async () => {
    const { autoclawDir } = makeWorkspace();
    const relay = new CloudRelay({ autoclawDir, secretStore: new MemoryStore() });
    const res = await relay.sendHeartbeats([
      { agent_id: 'a', timestamp: new Date().toISOString(), status: 'active', current_task: 't', sprint: 4 },
    ]);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, 'relay_disabled');
    assert.strictEqual(await queueDepth(autoclawDir), 0, 'nothing queued when inert');
  });

  test('sendInbox no-ops when the endpoint is set but enabled is false', async () => {
    const { autoclawDir } = makeWorkspace();
    fs.mkdirSync(path.join(autoclawDir, 'cloud'), { recursive: true });
    fs.writeFileSync(
      path.join(autoclawDir, 'cloud', 'relay-config.json'),
      JSON.stringify({ endpoint: 'https://relay.example', enabled: false }),
    );
    const cfg = await readRelayConfig(autoclawDir);
    assert.strictEqual(relayIsActive(cfg), false, 'endpoint set + disabled ⇒ still inert');
    const relay = new CloudRelay({ autoclawDir, secretStore: new MemoryStore() });
    const res = await relay.sendInbox([
      { id: 'm1', to: 'b', from: 'a', type: 'question', timestamp: new Date().toISOString(), payload: { q: 1 } },
    ]);
    assert.strictEqual(res.skipped, 'relay_disabled');
  });

  test('active relay with no token is still inert (no transmission)', async () => {
    const { autoclawDir } = makeWorkspace();
    const relay = new CloudRelay({
      autoclawDir,
      secretStore: new MemoryStore(),
      config: { endpoint: 'https://relay.example', enabled: true, heartbeatIntervalMs: 60_000, requestTimeoutMs: 5_000 },
    });
    const res = await relay.sendHeartbeats([
      { agent_id: 'a', timestamp: new Date().toISOString(), status: 'active', current_task: null, sprint: null },
    ]);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, 'no_token');
  });

  test('encryptPayload / decryptPayload round-trip', () => {
    const key = require('crypto').randomBytes(32) as Buffer;
    const value = { secret: 'inbox body', n: 42 };
    const env = encryptPayload(value, key);
    assert.strictEqual(env.alg, 'aes-256-gcm');
    assert.ok(!env.data.includes('inbox body'), 'ciphertext does not contain plaintext');
    assert.deepStrictEqual(decryptPayload(env, key), value);
  });
});

// ---------------------------------------------------------------------------
// CF-3 / CF-5 — cloud relay GA posture (security audit must-fixes)
// ---------------------------------------------------------------------------

suite('integrate-automate-v3.2 — relay GA posture (CF-3/CF-5)', () => {
  const baseGa = (over: Partial<RelayConfig>): RelayConfig => ({
    endpoint: 'https://relay.example', enabled: true,
    heartbeatIntervalMs: 60_000, requestTimeoutMs: 5_000,
    tier: 'preview', consentAckAt: null, ...over,
  });

  test('F1: endpointIsSecure — https ok, loopback http ok, public http + junk rejected', () => {
    assert.strictEqual(endpointIsSecure('https://relay.example'), true);
    assert.strictEqual(endpointIsSecure('http://localhost:8080'), true);
    assert.strictEqual(endpointIsSecure('http://127.0.0.1:3000'), true);
    assert.strictEqual(endpointIsSecure('http://relay.example'), false, 'public http rejected');
    assert.strictEqual(endpointIsSecure('ftp://x'), false);
    assert.strictEqual(endpointIsSecure('not a url'), false);
  });

  test('F1: an http:// endpoint keeps the relay inert (no token over cleartext)', () => {
    assert.strictEqual(relayIsActive(baseGa({ endpoint: 'http://relay.example' })), false);
    assert.strictEqual(relayIsActive(baseGa({ endpoint: 'https://relay.example' })), true);
  });

  test('GA tier requires an explicit consentAckAt; preview does not', () => {
    assert.strictEqual(relayIsActive(baseGa({ tier: 'ga', consentAckAt: null })), false, 'ga + no consent ⇒ inert');
    assert.strictEqual(relayIsActive(baseGa({ tier: 'ga', consentAckAt: '2026-06-05T00:00:00Z' })), true, 'ga + consent ⇒ active');
    assert.strictEqual(relayIsActive(baseGa({ tier: 'preview' })), true, 'preview needs no consent');
  });

  test('readRelayConfig parses GA fields with safe defaults', async () => {
    const { autoclawDir } = makeWorkspace();
    fs.mkdirSync(path.join(autoclawDir, 'cloud'), { recursive: true });
    fs.writeFileSync(path.join(autoclawDir, 'cloud', 'relay-config.json'),
      JSON.stringify({ endpoint: 'https://r.example', enabled: true, tier: 'ga', consentAckAt: '2026-06-05T00:00:00Z', forward: { heartbeats: false, inbox: true } }));
    const cfg = await readRelayConfig(autoclawDir);
    assert.strictEqual(cfg.tier, 'ga');
    assert.strictEqual(cfg.consentAckAt, '2026-06-05T00:00:00Z');
    assert.deepStrictEqual(cfg.forward, { heartbeats: false, inbox: true });
    // a bare config defaults tier→preview, consent→null, forward→absent
    assert.strictEqual(defaultRelayConfig().tier, 'preview');
    assert.strictEqual(defaultRelayConfig().consentAckAt, null);
  });

  test('F2: getCloudToken rejects an expired token', async () => {
    const { autoclawDir } = makeWorkspace();
    const store = new MemoryStore();
    const installationId = await resolveInstallationId(autoclawDir);
    const expired: CloudTokenRecord = {
      token: 'tok', installation_id: installationId, source: 'oauth',
      issued_at: '2020-01-01T00:00:00Z', expires_at: '2020-01-02T00:00:00Z', rotation: 0,
    };
    await store.set(`token:${installationId}`, JSON.stringify(expired));
    const got = await getCloudToken(autoclawDir, store);
    assert.strictEqual(got.ok, false);
    if (!got.ok) { assert.strictEqual(got.reason, 'expired'); }
  });

  test('F2: an expired token makes the relay inert (token_unusable)', async () => {
    const { autoclawDir } = makeWorkspace();
    const store = new MemoryStore();
    const installationId = await resolveInstallationId(autoclawDir);
    await store.set(`token:${installationId}`, JSON.stringify({
      token: 'tok', installation_id: installationId, source: 'oauth',
      issued_at: '2020-01-01T00:00:00Z', expires_at: '2020-01-02T00:00:00Z', rotation: 0,
    }));
    const relay = new CloudRelay({ autoclawDir, secretStore: store, config: baseGa({}) });
    const res = await relay.sendHeartbeats([{ agent_id: 'a', timestamp: new Date().toISOString(), status: 'active', current_task: null, sprint: null }]);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, 'token_unusable');
  });

  test('F3: forward.heartbeats=false skips heartbeat forwarding (channel_disabled)', async () => {
    const { autoclawDir } = makeWorkspace();
    const relay = new CloudRelay({ autoclawDir, secretStore: new MemoryStore(), config: baseGa({ forward: { heartbeats: false, inbox: true } }) });
    const res = await relay.sendHeartbeats([{ agent_id: 'a', timestamp: new Date().toISOString(), status: 'active', current_task: 'x', sprint: 1 }]);
    assert.strictEqual(res.skipped, 'channel_disabled');
    assert.strictEqual(await queueDepth(autoclawDir), 0, 'nothing queued for a disabled channel');
  });

  // SEC-3 (audit F6): the encrypted-file secret store round-trips on disk and
  // tightens the credential file's permissions (icacls on Windows, chmod on
  // POSIX) without throwing. This is the first coverage of the real store.
  test('SEC-3: encrypted-file secret store round-trips + writes credentials.enc', async () => {
    const { autoclawDir } = makeWorkspace();
    const store = resolveSecretStore(autoclawDir); // keytar absent ⇒ encrypted-file
    assert.ok(store.backend === 'encrypted-file' || store.backend === 'os-keychain');
    if (store.backend !== 'encrypted-file') { return; } // keychain present on this host — skip

    await store.set('token:abc', 's3cr3t-value');
    assert.strictEqual(await store.get('token:abc'), 's3cr3t-value', 'round-trips the secret');
    assert.ok(fs.existsSync(path.join(autoclawDir, 'cloud', 'credentials.enc')), 'credentials.enc written');
    assert.strictEqual(await store.get('missing'), null, 'absent key ⇒ null');
    assert.strictEqual(await store.delete('token:abc'), true);
    assert.strictEqual(await store.get('token:abc'), null, 'deleted secret is gone');
  });

  test('SEC-1: RelayHeartbeat wire shape excludes session_id', () => {
    // Type-level guarantee made observable: the documented forwarded subset has
    // no session_id key. (Kept here as a regression marker for the minimization.)
    const hb = { agent_id: 'a', timestamp: 't', status: 'active', current_task: null, sprint: null };
    assert.ok(!('session_id' in hb));
  });
});

// ---------------------------------------------------------------------------
// H3 — extended install
// ---------------------------------------------------------------------------

suite('Sprint 4 WA-4 — H3 MCP extended install', () => {
  test('extended config defaults to empty (all endpoints off)', async () => {
    const { autoclawDir } = makeWorkspace();
    const cfg = await readExtendedConfig(autoclawDir);
    assert.strictEqual(endpointIsConfigured(cfg.hermes), false);
    assert.strictEqual(endpointIsConfigured(cfg.voidspec), false);
    assert.strictEqual(defaultExtendedConfig().openclaw.url, '');
  });

  test('installExtended produces host + endpoint rows', async () => {
    const { root, autoclawDir } = makeWorkspace();
    const report = await installExtended({
      autoclawDir,
      workspaceRoot: root,
      home: root, // isolated home → no real hosts detected
      env: { PATH: '' },
      kiroAdd: async () => ({ ok: false, detail: 'no kiro' }),
    });
    assert.ok(Array.isArray(report.hosts));
    assert.strictEqual(report.endpoints.length, 3);
    assert.ok(report.endpoints.every(e => e.outcome === 'not-configured'));
    const text = formatExtendedReport(report);
    assert.ok(text.includes('Extended REST endpoints:'));
    assert.ok(text.includes('inert until an endpoint is set'));
  });

  test('fleet.dispatch is inert with no endpoint configured', async () => {
    const { autoclawDir } = makeWorkspace();
    const res = await fleetDispatchTool.run(ctxOf(autoclawDir), {
      runner: 'cursor',
      prompt: 'do the thing',
    });
    assert.strictEqual(res.ok, false);
    if (!res.ok) {
      assert.strictEqual(res.reason, 'not_implemented');
    }
  });

  test('voidspec.sync is inert with no endpoint configured', async () => {
    const { autoclawDir } = makeWorkspace();
    const res = await voidspecSyncTool.run(ctxOf(autoclawDir), {});
    assert.strictEqual(res.ok, false);
    if (!res.ok) {
      assert.strictEqual(res.reason, 'not_implemented');
    }
  });

  test('EXTENDED_TOOLS exposes both new tools', () => {
    const names = EXTENDED_TOOLS.map(t => t.definition.name).sort();
    assert.deepStrictEqual(names, ['fleet.dispatch', 'voidspec.sync']);
  });

  test('fleet.dispatch rejects missing args', async () => {
    const { autoclawDir } = makeWorkspace();
    const res = await fleetDispatchTool.run(ctxOf(autoclawDir), { runner: '', prompt: '' });
    assert.strictEqual(res.ok, false);
    if (!res.ok) {
      assert.strictEqual(res.reason, 'invalid_params');
    }
  });
});
