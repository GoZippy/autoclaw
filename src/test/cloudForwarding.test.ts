/**
 * cloudForwarding.test.ts — RELAY-WIRE (live heartbeat forwarding + consent
 * config writer). vscode-free, node-runnable.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { gatherHeartbeatsForRelay, forwardHeartbeats, gatherInboxForRelay, forwardInbox, applyFetchedToInboxes, applyFetchedHeartbeats, readRemoteHeartbeats } from '../cloud/forwarding';
import { getState } from '../comms/inboxState';
import { CloudRelay, readRelayConfig, writeRelayConfig, defaultRelayConfig } from '../cloud/relay';

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-fwd-'));
  const autoclawDir = path.join(root, '.autoclaw');
  fs.mkdirSync(autoclawDir, { recursive: true });
  return autoclawDir;
}

function writeHeartbeat(autoclawDir: string, name: string, hb: Record<string, unknown>): void {
  const dir = path.join(autoclawDir, 'orchestrator', 'comms', 'heartbeats');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(hb));
}

class MemoryStore {
  readonly backend = 'memory-test';
  private map = new Map<string, string>();
  async set(a: string, s: string) { this.map.set(a, s); }
  async get(a: string) { return this.map.get(a) ?? null; }
  async delete(a: string) { return this.map.delete(a); }
}

suite('RELAY-WIRE — gatherHeartbeatsForRelay', () => {
  test('maps heartbeat files to the wire subset and DROPS session_id (SEC-1)', async () => {
    const dir = makeWorkspace();
    writeHeartbeat(dir, 'claude-code.json', {
      agent_id: 'claude-code', session_id: 'SECRET-UUID', timestamp: '2026-06-09T00:00:00Z',
      status: 'active', current_task: 'B1', sprint: 2, cycle: 3, current_llm: 'ollama:llama3.1',
    });
    const hbs = await gatherHeartbeatsForRelay(dir);
    assert.strictEqual(hbs.length, 1);
    const h = hbs[0];
    assert.strictEqual(h.agent_id, 'claude-code');
    assert.strictEqual(h.current_task, 'B1');
    assert.strictEqual(h.sprint, 2);
    assert.strictEqual(h.current_llm, 'ollama:llama3.1');
    assert.ok(!('session_id' in h), 'session_id must not be forwarded');
  });

  test('tolerates missing dir, malformed files, and missing fields', async () => {
    const dir = makeWorkspace();
    assert.deepStrictEqual(await gatherHeartbeatsForRelay(dir), [], 'no heartbeats dir ⇒ []');
    writeHeartbeat(dir, 'good.json', { agent_id: 'a', timestamp: 't' });
    fs.writeFileSync(path.join(dir, 'orchestrator', 'comms', 'heartbeats', 'bad.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'orchestrator', 'comms', 'heartbeats', 'note.txt'), 'ignored');
    const hbs = await gatherHeartbeatsForRelay(dir);
    assert.strictEqual(hbs.length, 1, 'only the one valid json heartbeat');
    assert.strictEqual(hbs[0].status, 'unknown');
    assert.strictEqual(hbs[0].current_task, null);
    assert.strictEqual(hbs[0].sprint, null);
  });
});

suite('RELAY-WIRE — forwardHeartbeats is inert unless opted-in', () => {
  test('no relay config ⇒ relay_disabled, nothing transmitted', async () => {
    const dir = makeWorkspace();
    writeHeartbeat(dir, 'a.json', { agent_id: 'a', timestamp: 't', status: 'active' });
    const relay = new CloudRelay({ autoclawDir: dir, secretStore: new MemoryStore() });
    const res = await forwardHeartbeats(dir, relay);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, 'relay_disabled');
  });

  test('enabled + https endpoint but no token ⇒ no_token (still inert)', async () => {
    const dir = makeWorkspace();
    writeHeartbeat(dir, 'a.json', { agent_id: 'a', timestamp: 't', status: 'active' });
    const relay = new CloudRelay({
      autoclawDir: dir, secretStore: new MemoryStore(),
      config: { endpoint: 'https://relay.example', enabled: true, heartbeatIntervalMs: 60_000, requestTimeoutMs: 5_000, tier: 'ga', consentAckAt: '2026-06-09T00:00:00Z' },
    });
    const res = await forwardHeartbeats(dir, relay);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, 'no_token');
  });
});

function writeInboxMsg(autoclawDir: string, agent: string, file: string, msg: Record<string, unknown>): void {
  const dir = path.join(autoclawDir, 'orchestrator', 'comms', 'inboxes', agent);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(msg));
}

async function storeToken(autoclawDir: string, store: MemoryStore): Promise<void> {
  const { resolveInstallationId } = await import('../cloud/auth');
  const id = await resolveInstallationId(autoclawDir);
  await store.set(`token:${id}`, JSON.stringify({
    token: 'tok', installation_id: id, source: 'pat', issued_at: new Date().toISOString(), rotation: 0,
  }));
}

suite('AF-7 — inbox forwarding', () => {
  const baseActive = { endpoint: 'https://relay.example', enabled: true, heartbeatIntervalMs: 60_000, requestTimeoutMs: 1_000, tier: 'ga' as const, consentAckAt: '2026-06-11T00:00:00Z' };

  test('gatherInboxForRelay returns unforwarded messages oldest-first, skips _state', async () => {
    const dir = makeWorkspace();
    writeInboxMsg(dir, 'kilocode', 'm2.json', { id: 'm2', to: 'kilocode', from: 'a', type: 'question', timestamp: '2026-06-11T00:00:02Z', payload: { q: 2 } });
    writeInboxMsg(dir, 'kilocode', 'm1.json', { id: 'm1', to: 'kilocode', from: 'a', type: 'question', timestamp: '2026-06-11T00:00:01Z', payload: { q: 1 } });
    // a state file must not be treated as a message
    fs.mkdirSync(path.join(dir, 'orchestrator', 'comms', 'inboxes', 'kilocode', '_state'), { recursive: true });
    const items = await gatherInboxForRelay(dir);
    assert.deepStrictEqual(items.map(i => i.msg.id), ['m1', 'm2'], 'oldest first, _state ignored');
  });

  test('inert relay ⇒ skipped ⇒ messages NOT marked (re-tried later)', async () => {
    const dir = makeWorkspace();
    writeInboxMsg(dir, 'kiro', 'm1.json', { id: 'm1', to: 'kiro', from: 'a', type: 'question', timestamp: '2026-06-11T00:00:01Z', payload: {} });
    const relay = new CloudRelay({ autoclawDir: dir, secretStore: new MemoryStore() }); // no config ⇒ inert
    const res = await forwardInbox(dir, relay);
    assert.strictEqual(res.skipped, 'relay_disabled');
    assert.strictEqual((await gatherInboxForRelay(dir)).length, 1, 'still pending — not marked');
  });

  test('active relay (queues on network fail) ⇒ marked forwarded once, then drained', async () => {
    const dir = makeWorkspace();
    const store = new MemoryStore();
    await storeToken(dir, store);
    writeInboxMsg(dir, 'kiro', 'm1.json', { id: 'm1', to: 'kiro', from: 'a', type: 'question', timestamp: '2026-06-11T00:00:01Z', payload: { secret: 'x' } });
    const relay = new CloudRelay({ autoclawDir: dir, secretStore: store, config: baseActive });
    const res = await forwardInbox(dir, relay);
    assert.strictEqual(res.skipped, undefined, 'transmitted or queued (not skipped)');
    const st = await getState(path.join(dir, 'orchestrator', 'comms', 'inboxes', 'kiro'), 'm1', { strict: true });
    assert.ok(st?.forwarded_at, 'message marked forwarded');
    assert.strictEqual((await gatherInboxForRelay(dir)).length, 0, 'no longer pending — no double-send');
  });
});

suite('AF-7b — cross-machine pull (fetchInbox + applyFetchedToInboxes)', () => {
  test('fetchInbox is inert (no fetch) when the relay is disabled', async () => {
    const dir = makeWorkspace();
    const relay = new CloudRelay({ autoclawDir: dir, secretStore: new MemoryStore() });
    const res = await relay.fetchInbox(['kilocode']);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, 'relay_disabled');
    assert.deepStrictEqual(res.messages, []);
  });

  test('fetchInbox is inert (no_token) when enabled but not logged in', async () => {
    const dir = makeWorkspace();
    const relay = new CloudRelay({
      autoclawDir: dir, secretStore: new MemoryStore(),
      config: { endpoint: 'https://relay.example', enabled: true, heartbeatIntervalMs: 60_000, requestTimeoutMs: 1_000, tier: 'ga', consentAckAt: '2026-06-11T00:00:00Z' },
    });
    const res = await relay.fetchInbox();
    assert.strictEqual(res.skipped, 'no_token');
  });

  test('applyFetchedToInboxes writes to recipient inboxes and dedups by id', async () => {
    const dir = makeWorkspace();
    const msgs = [
      { id: 'r1', to: 'kilocode', from: 'a', type: 'question', timestamp: '2026-06-11T00:00:01Z', payload: { q: 1 } },
      { id: 'r2', to: 'kiro', from: 'a', type: 'answer', timestamp: '2026-06-11T00:00:02Z', payload: { a: 2 } },
    ];
    const first = await applyFetchedToInboxes(dir, msgs);
    assert.deepStrictEqual(first, { written: 2, skipped: 0 });
    assert.ok(fs.existsSync(path.join(dir, 'orchestrator', 'comms', 'inboxes', 'kilocode', 'fetched-r1.json')));
    assert.ok(fs.existsSync(path.join(dir, 'orchestrator', 'comms', 'inboxes', 'kiro', 'fetched-r2.json')));
    // Re-applying the same pull is idempotent — no duplicates.
    const second = await applyFetchedToInboxes(dir, msgs);
    assert.deepStrictEqual(second, { written: 0, skipped: 2 });
  });
});

suite('AF-10c — cross-machine fleet heartbeats', () => {
  const hb = (agent: string, inst: string, ts: string) => ({ agent_id: agent, timestamp: ts, status: 'active', current_task: null, sprint: null, installation_id: inst });

  test('fetchHeartbeats is inert when the relay is disabled', async () => {
    const dir = makeWorkspace();
    const relay = new CloudRelay({ autoclawDir: dir, secretStore: new MemoryStore() });
    const res = await relay.fetchHeartbeats();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.skipped, 'relay_disabled');
    assert.deepStrictEqual(res.heartbeats, []);
  });

  test('applyFetchedHeartbeats caches REMOTE rows (drops own machine), latest per agent/host', async () => {
    const dir = makeWorkspace();
    const rows = [
      hb('claude-code', 'me', '2026-06-11T00:00:05Z'),     // own machine — dropped
      hb('kilocode', 'machine-B', '2026-06-11T00:00:01Z'),
      hb('kilocode', 'machine-B', '2026-06-11T00:00:09Z'), // newer wins
      hb('kiro', 'machine-C', '2026-06-11T00:00:02Z'),
    ];
    const n = await applyFetchedHeartbeats(dir, rows, 'me');
    assert.strictEqual(n, 2, 'two remote machines, own dropped');
    const cached = await readRemoteHeartbeats(dir);
    assert.strictEqual(cached.length, 2);
    const kilo = cached.find(c => c.agent_id === 'kilocode')!;
    assert.strictEqual(kilo.host, 'machine-B');
    assert.strictEqual(kilo.origin, 'relay');
    assert.strictEqual(kilo.timestamp, '2026-06-11T00:00:09Z', 'latest kept');
    assert.ok(!cached.some(c => c.agent_id === 'claude-code'), 'own machine excluded');
  });

  test('readRemoteHeartbeats is [] when nothing cached', async () => {
    assert.deepStrictEqual(await readRemoteHeartbeats(makeWorkspace()), []);
  });
});

suite('RELAY-WIRE — writeRelayConfig (consent flow)', () => {
  test('round-trips through readRelayConfig', async () => {
    const dir = makeWorkspace();
    await writeRelayConfig(dir, {
      ...defaultRelayConfig(),
      endpoint: 'https://relay.example', enabled: true, tier: 'ga',
      consentAckAt: '2026-06-09T12:00:00Z', forward: { heartbeats: true, inbox: false },
    });
    const cfg = await readRelayConfig(dir);
    assert.strictEqual(cfg.endpoint, 'https://relay.example');
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.tier, 'ga');
    assert.strictEqual(cfg.consentAckAt, '2026-06-09T12:00:00Z');
    assert.deepStrictEqual(cfg.forward, { heartbeats: true, inbox: false });
  });

  test('disabling preserves the endpoint but flips enabled off', async () => {
    const dir = makeWorkspace();
    await writeRelayConfig(dir, { ...defaultRelayConfig(), endpoint: 'https://r.example', enabled: true, tier: 'ga', consentAckAt: '2026-06-09T00:00:00Z' });
    const current = await readRelayConfig(dir);
    await writeRelayConfig(dir, { ...current, enabled: false });
    const after = await readRelayConfig(dir);
    assert.strictEqual(after.enabled, false);
    assert.strictEqual(after.endpoint, 'https://r.example', 'endpoint kept for easy re-enable');
  });
});
