/**
 * server.ts — the AutoClaw relay server (AF-10). A small, dependency-free
 * Node HTTP server you can self-host so your machines coordinate cross-machine
 * for free. The hosted (paid) variant adds the entitlement check from
 * docs/specs/relay-entitlement.spec.md at the same auth seam.
 *
 * Run: `node out/relay-server/server.js` (or `npm run relay:serve`).
 * Config via env: AUTOCLAW_RELAY_TOKENS="tok1:acct1,tok2:acct1",
 *                 AUTOCLAW_RELAY_DATA_DIR=./relay-data, AUTOCLAW_RELAY_PORT=8787.
 */

import * as http from 'http';
import * as zlib from 'zlib';

import { RelayStore } from './store';
import { resolveAccount, loadConfig, type RelayServerConfig } from './auth';
import {
  handleHeartbeatPost, handleInboxPost, handleInboxGet, handleHeartbeatGet,
  type HandlerResult,
} from './handlers';

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) { chunks.push(c as Buffer); }
  let buf = Buffer.concat(chunks);
  if ((req.headers['content-encoding'] ?? '').includes('gzip') && buf.length > 0) {
    try { buf = zlib.gunzipSync(buf); } catch { /* not actually gzipped */ }
  }
  if (buf.length === 0) { return {}; }
  try { return JSON.parse(buf.toString('utf8')) as Record<string, unknown>; } catch { return {}; }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Build (but do not start) the relay HTTP server. Exposed for tests. */
export function createRelayServer(config: RelayServerConfig): http.Server {
  const store = new RelayStore(config.dataDir);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;
      const method = req.method ?? 'GET';

      // Health is unauthenticated.
      if (method === 'GET' && p === '/v1/health') {
        return send(res, 200, { ok: true, service: 'autoclaw-relay' });
      }

      const account = resolveAccount(req.headers['authorization'], config.tokens);
      if (!account) { return send(res, 401, { ok: false, error: 'unauthorized' }); }

      let result: HandlerResult;
      if (method === 'POST' && p === '/v1/heartbeat') {
        result = await handleHeartbeatPost(store, account, await readJsonBody(req));
      } else if (method === 'POST' && p === '/v1/inbox') {
        result = await handleInboxPost(store, account, await readJsonBody(req));
      } else if (method === 'GET' && p === '/v1/inbox') {
        result = await handleInboxGet(store, account, url.searchParams.get('to') ?? undefined);
      } else if (method === 'GET' && p === '/v1/heartbeat') {
        result = await handleHeartbeatGet(store, account);
      } else {
        return send(res, 404, { ok: false, error: 'not found' });
      }
      send(res, result.status, result.body);
    } catch (err) {
      send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// CLI entry — `node out/relay-server/server.js`.
if (require.main === module) {
  const config = loadConfig(process.env, null);
  if (Object.keys(config.tokens).length === 0) {
    // eslint-disable-next-line no-console
    console.error('[autoclaw-relay] no tokens configured — set AUTOCLAW_RELAY_TOKENS="<token>:<account>". Refusing to start an open relay.');
    process.exit(1);
  }
  const server = createRelayServer(config);
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[autoclaw-relay] listening on :${config.port} (data: ${config.dataDir}, accounts: ${new Set(Object.values(config.tokens)).size})`);
  });
}
