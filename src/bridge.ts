/**
 * bridge.ts — OpenClaw HTTP bridge for remote agents.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  sendMessage, readInbox, readSharedInbox, appendCommsLog,
  writeHeartbeat, readRegistry, getAgentStatuses,
  type Message, type Heartbeat,
} from './comms';
import {
  evaluateConsensus, DEFAULT_CONSENSUS_CONFIG,
  type ValidationVote,
} from './orchestrate';

const fsPromises = fs.promises;

export interface BridgeConfig { port: number; host: string; commsDir: string; tokensPath: string; }
export interface RemoteAgentToken { agent_id: string; token: string; created_at: string; expires_at: string; scopes: string[]; }
export interface BridgeState { server: http.Server | null; config: BridgeConfig; running: boolean; }

export function generateToken(): string { return `acl_${crypto.randomBytes(32).toString('hex')}`; }

export async function readTokens(p: string): Promise<RemoteAgentToken[]> {
  try { return JSON.parse(await fsPromises.readFile(p, 'utf8')); } catch { return []; }
}
export async function writeTokens(p: string, t: RemoteAgentToken[]): Promise<void> {
  await fsPromises.writeFile(p, JSON.stringify(t, null, 2), 'utf8');
}

export async function createRemoteAgentToken(tokensPath: string, agentId: string, days: number = 30): Promise<RemoteAgentToken> {
  const tokens = await readTokens(tokensPath);
  const t: RemoteAgentToken = {
    agent_id: agentId, token: generateToken(),
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + days * 86400000).toISOString(),
    scopes: ['message', 'heartbeat', 'consensus', 'status'],
  };
  tokens.push(t);
  await writeTokens(tokensPath, tokens);
  return t;
}

export async function validateToken(tokensPath: string, auth: string | undefined): Promise<RemoteAgentToken | null> {
  if (!auth?.startsWith('Bearer ')) { return null; }
  const tokens = await readTokens(tokensPath);
  const m = tokens.find(t => t.token === auth.slice(7));
  if (!m || new Date(m.expires_at).getTime() < Date.now()) { return null; }
  return m;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const c: Buffer[] = [];
    req.on('data', (d: Buffer) => c.push(d));
    req.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function err(res: http.ServerResponse, status: number, msg: string): void {
  json(res, status, { error: { code: status, message: msg } });
}

export function createBridgeServer(config: BridgeConfig): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const method = req.method?.toUpperCase() || 'GET';
    const p = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (p === '/health' && method === 'GET') { return json(res, 200, { status: 'ok', version: '2.0.0', port: config.port }); }

    if (p.startsWith('/api/')) {
      const token = await validateToken(config.tokensPath, req.headers.authorization);
      if (!token) { return err(res, 401, 'Invalid or expired token'); }

      try {
        if (p === '/api/v1/messages' && method === 'POST') {
          const body = await readBody(req);
          let msg: Message;
          try { msg = JSON.parse(body); } catch { return err(res, 400, 'Invalid JSON'); }
          if (msg.from !== token.agent_id) { return err(res, 403, 'Agent ID mismatch'); }
          const fp = await sendMessage(config.commsDir, msg);
          return json(res, 201, { ok: true, message_id: msg.id, path: fp });
        }
        if (p === '/api/v1/messages' && method === 'GET') {
          const inbox = await readInbox(config.commsDir, token.agent_id);
          const shared = await readSharedInbox(config.commsDir);
          return json(res, 200, { inbox, shared });
        }
        if (p === '/api/v1/heartbeat' && method === 'POST') {
          const body = await readBody(req);
          let hb: Heartbeat;
          try { hb = JSON.parse(body); } catch { return err(res, 400, 'Invalid JSON'); }
          if (hb.agent_id !== token.agent_id) { return err(res, 403, 'Agent ID mismatch'); }
          await writeHeartbeat(config.commsDir, hb);
          return json(res, 200, { ok: true });
        }
        if (p === '/api/v1/status' && method === 'GET') {
          const statuses = await getAgentStatuses(config.commsDir);
          const registry = await readRegistry(config.commsDir);
          return json(res, 200, { agents: statuses, registry });
        }
        if (p === '/api/v1/consensus/vote' && method === 'POST') {
          const body = await readBody(req);
          let vote: Record<string, unknown>;
          try { vote = JSON.parse(body); } catch { return err(res, 400, 'Invalid JSON'); }
          const taskId = vote.task_id as string;
          if (!taskId) { return err(res, 400, 'Missing task_id'); }
          const voteDir = path.join(config.commsDir, 'consensus', 'active');
          await fsPromises.mkdir(voteDir, { recursive: true });
          await fsPromises.writeFile(path.join(voteDir, `${taskId}-${token.agent_id}.json`), JSON.stringify(vote, null, 2), 'utf8');
          await appendCommsLog(config.commsDir, { timestamp: new Date().toISOString(), type: 'consensus_vote', from: token.agent_id, task_id: taskId, message: `${token.agent_id} voted on ${taskId}` });
          return json(res, 201, { ok: true, task_id: taskId });
        }
        // Idempotent consensus evaluation. Reads votes from
        // consensus/active/{tid}-*.json, runs evaluateConsensus, returns
        // the ConsensusResult. Does NOT move any vote files.
        const em = p.match(/^\/api\/v1\/consensus\/([^/]+)\/evaluate$/);
        if (em && method === 'POST') {
          const tid = em[1];
          const vd = path.join(config.commsDir, 'consensus', 'active');
          const votes: ValidationVote[] = [];
          try {
            const files = (await fsPromises.readdir(vd))
              .filter(f => f.startsWith(`${tid}-`) && f.endsWith('.json'));
            for (const f of files) {
              try {
                const raw = (await fsPromises.readFile(path.join(vd, f), 'utf8'))
                  .replace(/^﻿/, '');
                votes.push(JSON.parse(raw) as ValidationVote);
              } catch { /* skip malformed */ }
            }
          } catch { /* no votes yet */ }
          const body = await readBody(req).catch(() => '');
          let round = 1;
          try { const parsed = JSON.parse(body || '{}'); if (typeof parsed.round === 'number') { round = parsed.round; } } catch { /* default round */ }
          const result = evaluateConsensus(votes, round, DEFAULT_CONSENSUS_CONFIG);
          result.task_id = tid;
          await appendCommsLog(config.commsDir, {
            timestamp: new Date().toISOString(),
            type: 'consensus_result',
            from: token.agent_id,
            task_id: tid,
            message: `${token.agent_id} evaluated ${tid}: ${result.status} (${result.final_verdict})`,
          });
          return json(res, 200, result);
        }
        const cm = p.match(/^\/api\/v1\/consensus\/(.+)$/);
        if (cm && method === 'GET') {
          const tid = cm[1];
          const vd = path.join(config.commsDir, 'consensus', 'active');
          try {
            const files = (await fsPromises.readdir(vd)).filter(f => f.startsWith(tid));
            const votes = [];
            for (const f of files) { try { votes.push(JSON.parse(await fsPromises.readFile(path.join(vd, f), 'utf8'))); } catch { /* skip */ } }
            return json(res, 200, { task_id: tid, votes, vote_count: votes.length });
          } catch { return json(res, 200, { task_id: tid, votes: [], vote_count: 0 }); }
        }
      } catch (e) { console.error('Bridge error:', e); return err(res, 500, 'Internal server error'); }
    }
    err(res, 404, 'Not found');
  });
}

/** Number of fallback ports the bridge will try after the configured port if it is busy.
 *  e.g. 9876 in use → 9877, 9878, 9879, 9880 are tried in order. */
export const BRIDGE_PORT_FALLBACK_COUNT = 4;

/** Try to bind a single server instance on the supplied (host, port).
 *  Resolves on `listening`; rejects with the first `error` event. */
function tryListen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(e);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startBridge(config: BridgeConfig): Promise<BridgeState> {
  const startPort = config.port;
  let lastErr: NodeJS.ErrnoException | undefined;
  for (let i = 0; i <= BRIDGE_PORT_FALLBACK_COUNT; i++) {
    const port = startPort + i;
    const server = createBridgeServer({ ...config, port });
    try {
      await tryListen(server, config.host, port);
      const effectiveConfig: BridgeConfig = { ...config, port };
      console.log(`AutoClaw bridge on ${config.host}:${port}`);
      return { server, config: effectiveConfig, running: true };
    } catch (e) {
      lastErr = e as NodeJS.ErrnoException;
      // Close and try next port only on EADDRINUSE; bubble up any other error.
      try { server.close(); } catch { /* ignore */ }
      if (lastErr.code !== 'EADDRINUSE') {
        throw lastErr;
      }
    }
  }
  throw lastErr ?? new Error(
    `Bridge could not bind to any port in range ${startPort}-${startPort + BRIDGE_PORT_FALLBACK_COUNT}`
  );
}

export function stopBridge(state: BridgeState): Promise<void> {
  return new Promise(resolve => {
    if (state.server) { state.server.close(() => { state.running = false; resolve(); }); }
    else { resolve(); }
  });
}

export const DEFAULT_BRIDGE_CONFIG: Omit<BridgeConfig, 'commsDir' | 'tokensPath'> = { port: 9876, host: '127.0.0.1' };
