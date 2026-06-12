/**
 * relayServer.test.ts — the self-hostable relay server (AF-10).
 * Store + handlers + auth (pure) and a real HTTP round-trip (gzip + auth + drain).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';

import { RelayStore } from '../relay-server/store';
import { resolveAccount, loadConfig } from '../relay-server/auth';
import { handleInboxPost, handleInboxGet, handleHeartbeatPost, handleHeartbeatGet } from '../relay-server/handlers';
import { createRelayServer } from '../relay-server/server';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-relaysrv-')); }
const msg = (id: string, to: string, ts: string) => ({ id, to, from: 'a', type: 'question', timestamp: ts, encrypted: { alg: 'aes-256-gcm', iv: 'x', tag: 'y', data: 'z' } });

suite('relay-server store', () => {
  test('messages: put then drain (returns + deletes); second drain empty', async () => {
    const store = new RelayStore(tmp());
    await store.putMessages('acct', [msg('m2', 'kilocode', '2026-06-11T00:00:02Z'), msg('m1', 'kilocode', '2026-06-11T00:00:01Z')]);
    const first = await store.drainMessages('acct', ['kilocode']);
    assert.deepStrictEqual(first.map(m => m.id), ['m1', 'm2'], 'oldest first');
    assert.deepStrictEqual(await store.drainMessages('acct', ['kilocode']), [], 'drained — gone');
  });

  test('drain with no recipients returns every recipient', async () => {
    const store = new RelayStore(tmp());
    await store.putMessages('acct', [msg('m1', 'kilocode', '2026-06-11T00:00:01Z'), msg('m2', 'kiro', '2026-06-11T00:00:02Z')]);
    const all = await store.drainMessages('acct');
    assert.strictEqual(all.length, 2);
  });

  test('account isolation: one account cannot drain another', async () => {
    const store = new RelayStore(tmp());
    await store.putMessages('acctA', [msg('m1', 'kilocode', '2026-06-11T00:00:01Z')]);
    assert.deepStrictEqual(await store.drainMessages('acctB', ['kilocode']), []);
  });

  test('heartbeats upsert latest-per-agent + read back', async () => {
    const store = new RelayStore(tmp());
    await store.putHeartbeats('acct', 'inst-1', [{ agent_id: 'claude-code', timestamp: 't1', status: 'active', current_task: 'B1', sprint: 2 }]);
    await store.putHeartbeats('acct', 'inst-1', [{ agent_id: 'claude-code', timestamp: 't2', status: 'idle', current_task: null, sprint: null }]);
    const hbs = await store.getHeartbeats('acct');
    assert.strictEqual(hbs.length, 1, 'latest per agent');
    assert.strictEqual(hbs[0].status, 'idle');
    assert.strictEqual(hbs[0].installation_id, 'inst-1');
  });
});

suite('relay-server auth', () => {
  test('resolveAccount maps a bearer token to its account; rejects others', () => {
    const tokens = { 'tok-1': 'acct-1' };
    assert.strictEqual(resolveAccount('Bearer tok-1', tokens), 'acct-1');
    assert.strictEqual(resolveAccount('Bearer nope', tokens), null);
    assert.strictEqual(resolveAccount(undefined, tokens), null);
    assert.strictEqual(resolveAccount('tok-1', tokens), null, 'missing Bearer prefix');
  });

  test('loadConfig parses env tokens + dir + port', () => {
    const cfg = loadConfig({ AUTOCLAW_RELAY_TOKENS: 't1:a1,t2:a1', AUTOCLAW_RELAY_PORT: '9999', AUTOCLAW_RELAY_DATA_DIR: '/d' } as NodeJS.ProcessEnv);
    assert.deepStrictEqual(cfg.tokens, { t1: 'a1', t2: 'a1' });
    assert.strictEqual(cfg.port, 9999);
    assert.strictEqual(cfg.dataDir, '/d');
  });
});

suite('relay-server handlers', () => {
  test('inbox post then get drains for the account', async () => {
    const store = new RelayStore(tmp());
    await handleInboxPost(store, 'acct', { installation_id: 'i1', messages: [msg('m1', 'kilocode', '2026-06-11T00:00:01Z')] });
    const res = await handleInboxGet(store, 'acct', 'kilocode');
    assert.strictEqual((res.body as { messages: unknown[] }).messages.length, 1);
  });

  test('heartbeat post then get', async () => {
    const store = new RelayStore(tmp());
    await handleHeartbeatPost(store, 'acct', { installation_id: 'i1', heartbeats: [{ agent_id: 'a', timestamp: 't', status: 'active', current_task: null, sprint: null }] });
    const res = await handleHeartbeatGet(store, 'acct');
    assert.strictEqual((res.body as { heartbeats: unknown[] }).heartbeats.length, 1);
  });
});

suite('relay-server HTTP round-trip', () => {
  test('gzip POST /v1/inbox + GET drains; bad token ⇒ 401; health is open', async () => {
    const server = createRelayServer({ tokens: { 'tok-1': 'acct-1' }, dataDir: tmp(), port: 0 });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      // health: no auth
      const h = await fetch(`${base}/v1/health`);
      assert.strictEqual(h.status, 200);

      // unauthorized
      const un = await fetch(`${base}/v1/inbox`, { headers: { authorization: 'Bearer wrong' } });
      assert.strictEqual(un.status, 401);

      // gzip POST inbox
      const body = zlib.gzipSync(Buffer.from(JSON.stringify({ installation_id: 'i1', messages: [msg('m1', 'kilocode', '2026-06-11T00:00:01Z')] })));
      const post = await fetch(`${base}/v1/inbox`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body,
      });
      assert.strictEqual(post.status, 200);
      assert.strictEqual((await post.json() as { stored: number }).stored, 1);

      // GET drains
      const get = await fetch(`${base}/v1/inbox?to=kilocode`, { headers: { authorization: 'Bearer tok-1' } });
      assert.strictEqual(get.status, 200);
      const drained = await get.json() as { messages: Array<{ id: string }> };
      assert.deepStrictEqual(drained.messages.map(m => m.id), ['m1']);

      // second GET is empty (drained)
      const get2 = await fetch(`${base}/v1/inbox?to=kilocode`, { headers: { authorization: 'Bearer tok-1' } });
      assert.strictEqual((await get2.json() as { messages: unknown[] }).messages.length, 0);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});
