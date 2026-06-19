import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  startBridge, stopBridge,
  type BridgeConfig, type BridgeState,
} from '../bridge';
import { closeKnowledgeGraph } from '../intelligence/kg/service';

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-bridge-kg-'));
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

// Bring a bridge whose workspaceRoot is a fresh temp dir so the KG opens a
// throwaway `.autoclaw/kg/kg.db`. The comms dir lives in its own temp tree.
async function bringWithWorkspace(): Promise<{ state: BridgeState; workspaceRoot: string }> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-kg-ws-'));
  const commsDir = tmpDir();
  const tokensPath = path.join(commsDir, 'tokens.json');
  const port = 9876 + Math.floor(Math.random() * 1000);
  const cfg: BridgeConfig = { port, host: '127.0.0.1', commsDir, tokensPath, workspaceRoot };
  const state = await startBridge(cfg);
  return { state, workspaceRoot };
}

suite('Bridge — KG routes (KGC-3)', () => {
  let state: BridgeState | null = null;

  teardown(async () => {
    if (state) { await stopBridge(state); state = null; }
    // The KG handle is process-cached and keyed by workspaceRoot; drop it so a
    // later test reopens against its own temp db.
    closeKnowledgeGraph();
  });

  test('GET /api/v1/kg/health returns the capability + embedding shape without auth', async () => {
    ({ state } = await bringWithWorkspace());
    const r = await request(state, 'GET', '/api/v1/kg/health');
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.body) as {
      ok: boolean; sqlite: boolean; vec: boolean; fts: boolean; degraded: boolean;
      embedding: { provider: string; model: string; dimension: number };
    };
    assert.strictEqual(typeof body.ok, 'boolean');
    assert.strictEqual(typeof body.sqlite, 'boolean');
    assert.strictEqual(typeof body.vec, 'boolean');
    assert.strictEqual(typeof body.fts, 'boolean');
    assert.strictEqual(typeof body.degraded, 'boolean');
    assert.ok(body.embedding, 'embedding metadata present');
    assert.strictEqual(typeof body.embedding.provider, 'string');
    assert.strictEqual(typeof body.embedding.model, 'string');
    assert.strictEqual(typeof body.embedding.dimension, 'number');
  });

  test('POST /api/v1/kg/thoughts then GET /api/v1/kg/thoughts/search round-trips a thought', async () => {
    ({ state } = await bringWithWorkspace());

    const thought = {
      project: 'demo-project',
      agent: 'claude-code',
      kind: 'finding',
      text: 'the bridge KG route block lives before the bearer-token gate',
    };
    const post = await request(state, 'POST', '/api/v1/kg/thoughts',
      { 'Content-Type': 'application/json' }, JSON.stringify(thought));
    assert.strictEqual(post.status, 201);
    const posted = JSON.parse(post.body) as { id: string };
    assert.ok(typeof posted.id === 'string' && posted.id.length > 0, 'returns a non-empty id');

    const search = await request(state, 'GET',
      '/api/v1/kg/thoughts/search?q=' + encodeURIComponent('bridge KG route block') + '&project=demo-project');
    assert.strictEqual(search.status, 200);
    const found = JSON.parse(search.body) as { thoughts: Array<{ id: string; text: string }> };
    assert.ok(Array.isArray(found.thoughts), 'search returns a thoughts array');
    assert.ok(
      found.thoughts.some(t => t.id === posted.id),
      `expected the posted thought ${posted.id} in search results: ${search.body}`,
    );
  });

  test('POST /api/v1/kg/thoughts rejects a missing required field with 400', async () => {
    ({ state } = await bringWithWorkspace());
    const r = await request(state, 'POST', '/api/v1/kg/thoughts',
      { 'Content-Type': 'application/json' },
      JSON.stringify({ project: 'p', agent: 'a', kind: 'finding' })); // no text
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /"code":\s*400/);
    assert.match(r.body, /text/);
  });

  test('GET /api/v1/kg/thoughts/search without q returns 400', async () => {
    ({ state } = await bringWithWorkspace());
    const r = await request(state, 'GET', '/api/v1/kg/thoughts/search');
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /'q'/);
  });

  test('unknown /api/v1/kg/* path returns 404', async () => {
    ({ state } = await bringWithWorkspace());
    const r = await request(state, 'GET', '/api/v1/kg/nope');
    assert.strictEqual(r.status, 404);
  });
});
