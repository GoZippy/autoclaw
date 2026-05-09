import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  startBridge, stopBridge, createRemoteAgentToken, validateToken,
  generateToken, type BridgeConfig, type BridgeState,
} from '../bridge';

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
