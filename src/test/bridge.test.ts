import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  startBridge, stopBridge, createRemoteAgentToken, validateToken,
  generateToken, BridgeEventBus, SSE_KEEPALIVE_MS, revokeToken,
  type BridgeConfig, type BridgeState, type RemoteAgentToken,
} from '../bridge';
import type { Message, Heartbeat } from '../comms';

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-bridge-'));
  fs.mkdirSync(path.join(d, 'inboxes', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(d, 'consensus', 'active'), { recursive: true });
  fs.mkdirSync(path.join(d, 'heartbeats'), { recursive: true });
  return d;
}

interface RequestResult { status: number; body: string; }

function request(
  state: BridgeState,
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: state.config.host,
      port: state.config.port,
      path: p,
      method,
      headers,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) { req.write(body); }
    req.end();
  });
}

// Pick a random port in 9876–10876 and tear down server in finally.
async function bring(): Promise<BridgeState> {
  const commsDir = tmpDir();
  const tokensPath = path.join(commsDir, 'tokens.json');
  const port = 9876 + Math.floor(Math.random() * 1000);
  const cfg: BridgeConfig = { port, host: '127.0.0.1', commsDir, tokensPath };
  return startBridge(cfg);
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

suite('Bridge — token validation', () => {
  test('generateToken returns a prefixed hex string', () => {
    const t = generateToken();
    assert.match(t, /^acl_[0-9a-f]{64}$/);
  });

  test('validateToken returns null for a missing or non-Bearer header', async () => {
    const dir = tmpDir();
    const tokensPath = path.join(dir, 'tokens.json');
    await createRemoteAgentToken(tokensPath, 'a1');
    assert.strictEqual(await validateToken(tokensPath, undefined), null);
    assert.strictEqual(await validateToken(tokensPath, 'Basic abc'), null);
  });

  test('validateToken returns null for an expired token', async () => {
    const dir = tmpDir();
    const tokensPath = path.join(dir, 'tokens.json');
    const t = await createRemoteAgentToken(tokensPath, 'a1', -1);
    assert.strictEqual(await validateToken(tokensPath, `Bearer ${t.token}`), null);
  });

  test('validateToken returns the record for a valid token', async () => {
    const dir = tmpDir();
    const tokensPath = path.join(dir, 'tokens.json');
    const t = await createRemoteAgentToken(tokensPath, 'a1');
    const got = await validateToken(tokensPath, `Bearer ${t.token}`);
    assert.ok(got);
    assert.strictEqual(got!.agent_id, 'a1');
  });

  test('createRemoteAgentToken appends rather than overwriting', async () => {
    const dir = tmpDir();
    const tokensPath = path.join(dir, 'tokens.json');
    await createRemoteAgentToken(tokensPath, 'a1');
    await createRemoteAgentToken(tokensPath, 'a2');
    const raw = JSON.parse(fs.readFileSync(tokensPath, 'utf8')) as Array<{ agent_id: string }>;
    assert.strictEqual(raw.length, 2);
    assert.deepStrictEqual(raw.map(t => t.agent_id).sort(), ['a1', 'a2']);
  });
});

// ---------------------------------------------------------------------------
// Token revocation
// ---------------------------------------------------------------------------

suite('Bridge — token revocation', () => {
  test('revokeToken stamps revoked_at and persists to disk', async () => {
    const dir = tmpDir();
    const tokensPath = path.join(dir, 'tokens.json');
    const t = await createRemoteAgentToken(tokensPath, 'a1');
    assert.strictEqual(t.revoked_at ?? null, null, 'fresh tokens are not revoked');

    const before = Date.now();
    const ok = await revokeToken(tokensPath, t.token);
    const after = Date.now();
    assert.strictEqual(ok, true);

    const persisted = JSON.parse(fs.readFileSync(tokensPath, 'utf8')) as RemoteAgentToken[];
    const match = persisted.find(x => x.token === t.token)!;
    assert.ok(match.revoked_at, 'revoked_at was set');
    const stampMs = new Date(match.revoked_at!).getTime();
    assert.ok(stampMs >= before && stampMs <= after,
      `revoked_at ${match.revoked_at} should be in [${before}, ${after}]`);
  });

  test('revokeToken returns false for an unknown token', async () => {
    const dir = tmpDir();
    const tokensPath = path.join(dir, 'tokens.json');
    await createRemoteAgentToken(tokensPath, 'a1');
    const ok = await revokeToken(tokensPath, 'acl_does_not_exist');
    assert.strictEqual(ok, false);
  });

  test('revokeToken returns false for an empty/missing token value', async () => {
    const dir = tmpDir();
    const tokensPath = path.join(dir, 'tokens.json');
    await createRemoteAgentToken(tokensPath, 'a1');
    assert.strictEqual(await revokeToken(tokensPath, ''), false);
  });

  test('validateToken returns null for a revoked token even before expiry', async () => {
    const dir = tmpDir();
    const tokensPath = path.join(dir, 'tokens.json');
    const t = await createRemoteAgentToken(tokensPath, 'a1', 30); // 30 days
    // Sanity-check: pre-revocation it validates.
    const pre = await validateToken(tokensPath, `Bearer ${t.token}`);
    assert.ok(pre, 'should validate before revocation');

    await revokeToken(tokensPath, t.token);
    const post = await validateToken(tokensPath, `Bearer ${t.token}`);
    assert.strictEqual(post, null, 'revoked token must not validate');
  });

  test('legacy tokens (no revoked_at field) continue to validate', async () => {
    // Simulate an existing tokens.json written by an older AutoClaw.
    const dir = tmpDir();
    const tokensPath = path.join(dir, 'tokens.json');
    const legacy: RemoteAgentToken = {
      agent_id: 'a1',
      token: 'acl_legacy0000000000000000000000000000000000000000000000000000000',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      scopes: ['message', 'heartbeat', 'consensus', 'status'],
    };
    fs.writeFileSync(tokensPath, JSON.stringify([legacy], null, 2), 'utf8');
    const got = await validateToken(tokensPath, `Bearer ${legacy.token}`);
    assert.ok(got, 'legacy token should still validate');
    assert.strictEqual(got!.revoked_at ?? null, null);
  });
});

// End-to-end revocation through the HTTP endpoint.
suite('Bridge — revocation end-to-end via HTTP', () => {
  let state: BridgeState | null = null;

  teardown(async () => {
    if (state) { await stopBridge(state); state = null; }
  });

  test('create → use (201) → revoke → use again (401)', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    const msg = {
      id: 'm-rev-1', from: 'a1', to: 'a2', type: 'question',
      timestamp: '2026-05-09T00:00:00Z', payload: {}, requires_response: false,
    };
    const post1 = await request(state, 'POST', '/api/v1/messages',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
      JSON.stringify(msg));
    assert.strictEqual(post1.status, 201, 'pre-revocation request should succeed');

    const ok = await revokeToken(state.config.tokensPath, t.token);
    assert.strictEqual(ok, true);

    const post2 = await request(state, 'POST', '/api/v1/messages',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
      JSON.stringify({ ...msg, id: 'm-rev-2' }));
    assert.strictEqual(post2.status, 401, 'post-revocation request must be unauthorized');
  });
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

suite('Bridge — endpoints', () => {
  let state: BridgeState | null = null;

  teardown(async () => {
    if (state) { await stopBridge(state); state = null; }
  });

  test('GET /health returns ok without auth', async () => {
    state = await bring();
    const r = await request(state, 'GET', '/health');
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /"status"\s*:\s*"ok"/);
  });

  test('POST /api/v1/messages without token returns 401', async () => {
    state = await bring();
    const r = await request(state, 'POST', '/api/v1/messages',
      { 'Content-Type': 'application/json' }, '{}');
    assert.strictEqual(r.status, 401);
  });

  test('POST /api/v1/messages then GET /api/v1/messages round-trips the message', async () => {
    state = await bring();
    const t1 = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    const msg = {
      id: 'm1', from: 'a1', to: 'a2', type: 'question',
      timestamp: '2026-05-09T00:00:00Z',
      payload: { q: 'why' }, requires_response: false,
    };
    const post = await request(state, 'POST', '/api/v1/messages',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t1.token}` },
      JSON.stringify(msg));
    assert.strictEqual(post.status, 201);
    const t2 = await createRemoteAgentToken(state.config.tokensPath, 'a2');
    const get = await request(state, 'GET', '/api/v1/messages',
      { Authorization: `Bearer ${t2.token}` });
    assert.strictEqual(get.status, 200);
    assert.match(get.body, /"id":\s*"m1"/);
    assert.match(get.body, /"from":\s*"a1"/);
  });

  test('POST /api/v1/messages with mismatched from returns 403', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    const r = await request(state, 'POST', '/api/v1/messages',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
      JSON.stringify({ from: 'b1', to: 'a2', type: 'question', payload: {}, requires_response: false }));
    assert.strictEqual(r.status, 403);
  });

  test('POST /api/v1/heartbeat persists to heartbeats/{agent}.json', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    const hb = {
      agent_id: 'a1', timestamp: '2026-05-09T00:00:00Z',
      status: 'active', current_task: null, sprint: null,
    };
    const post = await request(state, 'POST', '/api/v1/heartbeat',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
      JSON.stringify(hb));
    assert.strictEqual(post.status, 200);
    const raw = fs.readFileSync(
      path.join(state.config.commsDir, 'heartbeats', 'a1.json'), 'utf8'
    );
    assert.match(raw, /"agent_id":\s*"a1"/);
  });

  test('POST /api/v1/heartbeat with mismatched agent_id returns 403', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    const r = await request(state, 'POST', '/api/v1/heartbeat',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
      JSON.stringify({ agent_id: 'b1', timestamp: '', status: 'active', current_task: null, sprint: null }));
    assert.strictEqual(r.status, 403);
  });

  test('POST /api/v1/consensus/vote then GET /api/v1/consensus/{tid} returns it', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    const vote = { task_id: 'T1', verdict: 'approved', confidence: 0.9, findings: [] };
    const post = await request(state, 'POST', '/api/v1/consensus/vote',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
      JSON.stringify(vote));
    assert.strictEqual(post.status, 201);
    const get = await request(state, 'GET', '/api/v1/consensus/T1',
      { Authorization: `Bearer ${t.token}` });
    assert.strictEqual(get.status, 200);
    assert.match(get.body, /"vote_count":\s*1/);
  });

  test('POST /api/v1/consensus/{tid}/evaluate with no votes returns consensus_pending', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    const r = await request(state, 'POST', '/api/v1/consensus/T1/evaluate',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` }, '{}');
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /"status":\s*"consensus_pending"/);
    assert.match(r.body, /"task_id":\s*"T1"/);
  });

  test('POST /api/v1/consensus/{tid}/evaluate tallies two approve votes to consensus_reached', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    // Stage two vote files directly into consensus/active/ with the
    // {tid}-{agent}.json filename pattern the bridge uses.
    const vd = path.join(state.config.commsDir, 'consensus', 'active');
    fs.writeFileSync(path.join(vd, 'T1-a1.json'), JSON.stringify({
      agent_id: 'a1', provider: 'kiro', verdict: 'approved', confidence: 0.9,
      findings: [], timestamp: '2026-05-09T00:00:00Z',
    }));
    fs.writeFileSync(path.join(vd, 'T1-a2.json'), JSON.stringify({
      agent_id: 'a2', provider: 'claude-code', verdict: 'approved', confidence: 0.9,
      findings: [], timestamp: '2026-05-09T00:00:00Z',
    }));
    const r = await request(state, 'POST', '/api/v1/consensus/T1/evaluate',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` }, '{}');
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /"status":\s*"consensus_reached"/);
    assert.match(r.body, /"final_verdict":\s*"approved"/);
  });

  test('POST /api/v1/consensus/{tid}/evaluate respects block_is_veto', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    const vd = path.join(state.config.commsDir, 'consensus', 'active');
    fs.writeFileSync(path.join(vd, 'T2-a1.json'), JSON.stringify({
      agent_id: 'a1', provider: 'kiro', verdict: 'approved', confidence: 0.9,
      findings: [], timestamp: '2026-05-09T00:00:00Z',
    }));
    fs.writeFileSync(path.join(vd, 'T2-a2.json'), JSON.stringify({
      agent_id: 'a2', provider: 'claude-code', verdict: 'blocked', confidence: 0.9,
      findings: [], timestamp: '2026-05-09T00:00:00Z',
    }));
    const r = await request(state, 'POST', '/api/v1/consensus/T2/evaluate',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` }, '{}');
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /"final_verdict":\s*"blocked"/);
  });

  test('POST /api/v1/consensus/{tid}/evaluate appends a consensus_result entry to comms-log', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    await request(state, 'POST', '/api/v1/consensus/T3/evaluate',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` }, '{}');
    const log = fs.readFileSync(
      path.join(state.config.commsDir, 'comms-log.jsonl'), 'utf8'
    );
    const entries = log.trim().split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
    assert.ok(
      entries.some(e => e.type === 'consensus_result' && e.task_id === 'T3'),
      `expected consensus_result for T3 in log: ${log}`
    );
  });
});

// ---------------------------------------------------------------------------
// Port fallback (Phase 1 Item F)
// ---------------------------------------------------------------------------

suite('Bridge — port fallback on EADDRINUSE', () => {
  let blocker: http.Server | undefined;
  let bridge: BridgeState | undefined;

  teardown(async () => {
    if (bridge) { await stopBridge(bridge); bridge = undefined; }
    if (blocker) {
      await new Promise<void>(resolve => blocker!.close(() => resolve()));
      blocker = undefined;
    }
  });

  test('falls back to next port when configured port is in use', async () => {
    // Pick a port unlikely to collide with other tests; occupy it.
    const startPort = 21000 + Math.floor(Math.random() * 1000);
    blocker = http.createServer(() => { /* no-op */ });
    await new Promise<void>((resolve, reject) => {
      blocker!.once('error', reject);
      blocker!.listen(startPort, '127.0.0.1', () => resolve());
    });

    const commsDir = tmpDir();
    const tokensPath = path.join(commsDir, 'tokens.json');
    bridge = await startBridge({ port: startPort, host: '127.0.0.1', commsDir, tokensPath });

    // The bridge state should reflect the actual port (one of startPort+1..+4).
    assert.notStrictEqual(bridge.config.port, startPort, 'expected fallback to a different port');
    assert.ok(
      bridge.config.port > startPort && bridge.config.port <= startPort + 4,
      `expected port in (${startPort}, ${startPort + 4}], got ${bridge.config.port}`
    );

    // /health should report the resolved port.
    const r = await request(bridge, 'GET', '/health');
    assert.strictEqual(r.status, 200);
    const parsed = JSON.parse(r.body) as { port?: number };
    assert.strictEqual(parsed.port, bridge.config.port);
  });
});

// ---------------------------------------------------------------------------
// BridgeEventBus (Phase 2 — push channels)
// ---------------------------------------------------------------------------

suite('BridgeEventBus — pub/sub', () => {
  test('subscribe → publish delivers payload to handler', () => {
    const bus = new BridgeEventBus();
    let got: Message | null = null;
    bus.subscribe('message', m => { got = m; });
    const msg = {
      id: 'm1', from: 'a1', to: 'a2', type: 'question' as const,
      timestamp: '2026-05-09T00:00:00Z', payload: {}, requires_response: false,
    };
    bus.publish('message', msg);
    assert.deepStrictEqual(got, msg);
  });

  test('unsubscribe stops further deliveries', () => {
    const bus = new BridgeEventBus();
    let calls = 0;
    const off = bus.subscribe('heartbeat', () => { calls++; });
    const hb: Heartbeat = {
      agent_id: 'a1', timestamp: '2026-05-09T00:00:00Z',
      status: 'active', current_task: null, sprint: null,
    };
    bus.publish('heartbeat', hb);
    off();
    bus.publish('heartbeat', hb);
    assert.strictEqual(calls, 1);
    assert.strictEqual(bus.subscriberCount('heartbeat'), 0);
  });

  test('publish with no subscribers is a no-op', () => {
    const bus = new BridgeEventBus();
    bus.publish('consensus', {
      task_id: 'T1', round: 1, status: 'consensus_pending',
      final_verdict: 'inconclusive', votes: [], summary: '',
    } as unknown as Parameters<typeof bus.publish<'consensus'>>[1]);
    // No throw → pass.
    assert.strictEqual(bus.subscriberCount('consensus'), 0);
  });

  test('one handler error does not block others', () => {
    const bus = new BridgeEventBus();
    let secondCalled = false;
    bus.subscribe('message', () => { throw new Error('boom'); });
    bus.subscribe('message', () => { secondCalled = true; });
    const origErr = console.error;
    console.error = (): void => { /* swallow */ };
    try {
      bus.publish('message', {
        id: 'm1', from: 'a1', to: 'a2', type: 'question',
        timestamp: '', payload: {}, requires_response: false,
      });
    } finally {
      console.error = origErr;
    }
    assert.strictEqual(secondCalled, true);
  });
});

// ---------------------------------------------------------------------------
// SSE streaming endpoint (Phase 2 — push channels)
// ---------------------------------------------------------------------------

interface SseHandle {
  req: http.ClientRequest;
  res: http.IncomingMessage;
  buffer: string;
  events: Array<{ type: string; data: string }>;
  close(): void;
}

/** Open an SSE stream and accumulate decoded events. The client lets us
 *  inspect raw frames (incl. `: keepalive` comments) and parsed events. */
function openSse(state: BridgeState, path_: string, headers: Record<string, string>): Promise<SseHandle> {
  return new Promise((resolve, reject) => {
    const events: Array<{ type: string; data: string }> = [];
    let buffer = '';
    const req = http.request({
      host: state.config.host,
      port: state.config.port,
      path: path_,
      method: 'GET',
      headers,
    }, res => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        // Parse complete event blocks (terminated by \n\n).
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          // Skip pure-comment blocks (lines starting with ':').
          let evType = 'message';
          const dataLines: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) { continue; }
            if (line.startsWith('event:')) { evType = line.slice(6).trim(); }
            else if (line.startsWith('data:')) { dataLines.push(line.slice(5).trim()); }
          }
          if (dataLines.length > 0) {
            events.push({ type: evType, data: dataLines.join('\n') });
          }
        }
      });
      const handle: SseHandle = {
        req, res, buffer: '', events,
        close: () => { try { req.destroy(); } catch { /* ignore */ } },
      };
      // Expose live buffer via getter (capture snapshot when read).
      Object.defineProperty(handle, 'buffer', { get: () => buffer });
      resolve(handle);
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 2000, pollMs = 25): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) { throw new Error('waitFor timeout'); }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

suite('Bridge — SSE /api/v1/messages/stream', () => {
  let state: BridgeState | null = null;
  let sse: SseHandle | null = null;

  teardown(async () => {
    if (sse) { sse.close(); sse = null; }
    if (state) { await stopBridge(state); state = null; }
  });

  test('rejects request without a valid token (401)', async () => {
    state = await bring();
    const r = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request({
        host: state!.config.host, port: state!.config.port,
        path: '/api/v1/messages/stream', method: 'GET',
      }, res => { resolve({ status: res.statusCode ?? 0 }); res.resume(); });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(r.status, 401);
  });

  test('opens with text/event-stream content-type and emits message event after POST', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a2');
    const tSender = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    sse = await openSse(state, '/api/v1/messages/stream', {
      Authorization: `Bearer ${t.token}`,
    });
    assert.strictEqual(sse.res.headers['content-type'], 'text/event-stream');
    assert.match(String(sse.res.headers['cache-control'] ?? ''), /no-cache/);

    // Post a message addressed to a2 — the SSE subscriber should receive it.
    const msg = {
      id: 'm-sse-1', from: 'a1', to: 'a2', type: 'question',
      timestamp: '2026-05-09T00:00:00Z', payload: { q: 'hi' },
      requires_response: false,
    };
    const post = await request(state, 'POST', '/api/v1/messages',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${tSender.token}` },
      JSON.stringify(msg));
    assert.strictEqual(post.status, 201);

    await waitFor(() => sse!.events.some(e => e.type === 'message' && e.data.includes('m-sse-1')), 2000);
    const ev = sse.events.find(e => e.type === 'message')!;
    assert.match(ev.data, /"id":\s*"m-sse-1"/);
  });

  test('forwards heartbeat events and respects ?agent= filter', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    const t2 = await createRemoteAgentToken(state.config.tokensPath, 'a2');
    sse = await openSse(state, '/api/v1/messages/stream?agent=a1', {
      Authorization: `Bearer ${t.token}`,
    });

    const hbA1 = { agent_id: 'a1', timestamp: '2026-05-09T00:00:01Z', status: 'active', current_task: null, sprint: null };
    const hbA2 = { agent_id: 'a2', timestamp: '2026-05-09T00:00:02Z', status: 'active', current_task: null, sprint: null };
    await request(state, 'POST', '/api/v1/heartbeat',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
      JSON.stringify(hbA1));
    await request(state, 'POST', '/api/v1/heartbeat',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t2.token}` },
      JSON.stringify(hbA2));

    await waitFor(() => sse!.events.some(e => e.type === 'heartbeat'), 2000);
    const hbs = sse.events.filter(e => e.type === 'heartbeat');
    // a1 included, a2 filtered out.
    assert.ok(hbs.some(e => e.data.includes('"agent_id": "a1"') || e.data.includes('"agent_id":"a1"')));
    assert.ok(!hbs.some(e => e.data.includes('"agent_id": "a2"') || e.data.includes('"agent_id":"a2"')),
      `expected no a2 heartbeats, got: ${JSON.stringify(hbs)}`);
  });

  test('forwards consensus_result events', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    sse = await openSse(state, '/api/v1/messages/stream', {
      Authorization: `Bearer ${t.token}`,
    });
    await request(state, 'POST', '/api/v1/consensus/T-sse/evaluate',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` }, '{}');
    await waitFor(() => sse!.events.some(e => e.type === 'consensus'), 2000);
    const ev = sse.events.find(e => e.type === 'consensus')!;
    assert.match(ev.data, /"task_id":\s*"T-sse"/);
  });

  test('accepts ?token= query-param auth (for EventSource which can not set headers)', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    sse = await openSse(state, `/api/v1/messages/stream?token=${t.token}`, {});
    assert.strictEqual(sse.res.headers['content-type'], 'text/event-stream');
  });

  test('client disconnect unsubscribes the stream', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    sse = await openSse(state, '/api/v1/messages/stream', {
      Authorization: `Bearer ${t.token}`,
    });
    // Wait for the bus subscription to register on the server.
    await waitFor(() => state!.bus!.subscriberCount('message') >= 1, 1000);
    sse.close(); sse = null;
    await waitFor(() => state!.bus!.subscriberCount('message') === 0, 2000);
    assert.strictEqual(state!.bus!.subscriberCount('message'), 0);
    assert.strictEqual(state!.bus!.subscriberCount('heartbeat'), 0);
    assert.strictEqual(state!.bus!.subscriberCount('consensus'), 0);
  });

  test('SSE_KEEPALIVE_MS is sub-60s so proxies do not idle-cull', () => {
    assert.ok(SSE_KEEPALIVE_MS > 0 && SSE_KEEPALIVE_MS < 60_000,
      `keepalive must be in (0, 60_000); got ${SSE_KEEPALIVE_MS}`);
  });
});

// ---------------------------------------------------------------------------
// Health endpoint includes push-channel counts (Phase 2)
// ---------------------------------------------------------------------------

suite('Bridge — /health push-channel counts', () => {
  let state: BridgeState | null = null;
  let sse: SseHandle | null = null;

  teardown(async () => {
    if (sse) { sse.close(); sse = null; }
    if (state) { await stopBridge(state); state = null; }
  });

  test('reports sse_clients and ws_clients fields', async () => {
    state = await bring();
    const r = await request(state, 'GET', '/health');
    const parsed = JSON.parse(r.body) as { sse_clients?: number; ws_clients?: number; port?: number };
    assert.strictEqual(typeof parsed.port, 'number');
    assert.strictEqual(parsed.sse_clients, 0);
    assert.strictEqual(parsed.ws_clients, 0);
  });

  test('sse_clients increments while a stream is open', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    sse = await openSse(state, '/api/v1/messages/stream', {
      Authorization: `Bearer ${t.token}`,
    });
    // Allow registration to land.
    await waitFor(() => state!.sseClients!.size >= 1, 1000);
    const r = await request(state, 'GET', '/health');
    const parsed = JSON.parse(r.body) as { sse_clients: number };
    assert.strictEqual(parsed.sse_clients, 1);
  });
});

// ---------------------------------------------------------------------------
// WebSocket /api/v1/messages/stream (Phase 2 — push channels)
// ---------------------------------------------------------------------------

// Use the `ws` client we already depend on for server-side. Importing the
// module here is also what triggers the bridge-ws.ts side-effect that
// registers the WebSocket attach hook with bridge.ts.
import { WebSocket, type RawData as WsRawData } from 'ws';
import '../bridge-ws';

interface WsHandle {
  ws: WebSocket;
  frames: Array<{ type: string; data: unknown }>;
  open: Promise<void>;
  close(): void;
}

function openWs(state: BridgeState, p: string, headers: Record<string, string> = {}): WsHandle {
  const url = `ws://${state.config.host}:${state.config.port}${p}`;
  const subproto = headers['Sec-WebSocket-Protocol']
    ? headers['Sec-WebSocket-Protocol'].split(',').map(s => s.trim())
    : undefined;
  const ws = new WebSocket(url, subproto, { headers });
  const frames: Array<{ type: string; data: unknown }> = [];
  ws.on('message', (raw: WsRawData) => {
    try { frames.push(JSON.parse(raw.toString('utf8'))); } catch { /* ignore */ }
  });
  const open = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req: unknown, res: http.IncomingMessage) => {
      reject(new Error(`unexpected-response ${res.statusCode}`));
    });
  });
  return {
    ws, frames, open,
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}

suite('Bridge — WebSocket /api/v1/messages/stream', () => {
  let state: BridgeState | null = null;
  let wsh: WsHandle | null = null;

  teardown(async () => {
    if (wsh) { wsh.close(); wsh = null; }
    if (state) { await stopBridge(state); state = null; }
  });

  test('rejects upgrade without a valid token (401)', async () => {
    state = await bring();
    wsh = openWs(state, '/api/v1/messages/stream');
    let caught: Error | null = null;
    try { await wsh.open; } catch (e) { caught = e as Error; }
    assert.ok(caught, 'expected upgrade to fail');
    assert.match(caught!.message, /401|Unexpected server response: 401|unexpected-response 401/);
  });

  test('accepts bearer.<token> via Sec-WebSocket-Protocol and forwards heartbeat events', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    wsh = openWs(state, '/api/v1/messages/stream', {
      'Sec-WebSocket-Protocol': `bearer.${t.token}`,
    });
    await wsh.open;
    await waitFor(() => state!.wsClients!.size >= 1, 1000);

    const hb = {
      agent_id: 'a1', timestamp: '2026-05-09T00:00:00Z',
      status: 'active', current_task: null, sprint: null,
    };
    await request(state, 'POST', '/api/v1/heartbeat',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
      JSON.stringify(hb));

    await waitFor(() => wsh!.frames.some(f => f.type === 'heartbeat'), 2000);
    const f = wsh.frames.find(x => x.type === 'heartbeat')!;
    assert.deepStrictEqual((f.data as { agent_id: string }).agent_id, 'a1');
  });

  test('accepts ?token= query-param auth', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    wsh = openWs(state, `/api/v1/messages/stream?token=${t.token}`);
    await wsh.open;
    assert.strictEqual(wsh.ws.readyState, WebSocket.OPEN);
  });

  test('forwards inbox messages addressed to the authenticated agent', async () => {
    state = await bring();
    const tA2 = await createRemoteAgentToken(state.config.tokensPath, 'a2');
    const tA1 = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    wsh = openWs(state, '/api/v1/messages/stream', {
      'Sec-WebSocket-Protocol': `bearer.${tA2.token}`,
    });
    await wsh.open;
    await waitFor(() => state!.wsClients!.size >= 1, 1000);

    await request(state, 'POST', '/api/v1/messages',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${tA1.token}` },
      JSON.stringify({
        id: 'm-ws-1', from: 'a1', to: 'a2', type: 'question',
        timestamp: '2026-05-09T00:00:00Z', payload: {}, requires_response: false,
      }));

    await waitFor(() => wsh!.frames.some(f => f.type === 'message'), 2000);
    const f = wsh.frames.find(x => x.type === 'message')!;
    assert.strictEqual((f.data as { id: string }).id, 'm-ws-1');
  });

  test('ws_clients in /health reflects open WebSocket', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    wsh = openWs(state, '/api/v1/messages/stream', {
      'Sec-WebSocket-Protocol': `bearer.${t.token}`,
    });
    await wsh.open;
    await waitFor(() => state!.wsClients!.size >= 1, 1000);
    const r = await request(state, 'GET', '/health');
    const parsed = JSON.parse(r.body) as { ws_clients: number };
    assert.strictEqual(parsed.ws_clients, 1);
  });

  test('client close removes ws_clients entry and unsubscribes from bus', async () => {
    state = await bring();
    const t = await createRemoteAgentToken(state.config.tokensPath, 'a1');
    wsh = openWs(state, '/api/v1/messages/stream', {
      'Sec-WebSocket-Protocol': `bearer.${t.token}`,
    });
    await wsh.open;
    await waitFor(() => state!.wsClients!.size >= 1, 1000);
    const before = state.bus!.subscriberCount('message');
    assert.ok(before >= 1);
    wsh.close(); wsh = null;
    await waitFor(() => state!.wsClients!.size === 0, 2000);
    assert.strictEqual(state.bus!.subscriberCount('message'), before - 1);
  });
});
