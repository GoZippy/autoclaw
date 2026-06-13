/**
 * bridge.ts — OpenClaw HTTP bridge for remote agents.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  sendMessage, readInbox, readSharedInbox, appendCommsLog,
  writeHeartbeat, readRegistry, getAgentStatuses, readClaimAuthor,
  type Message, type Heartbeat,
} from './comms';
import {
  evaluateConsensus, DEFAULT_CONSENSUS_CONFIG,
  applyAcceptanceGate, readManifestTaskGates, runAcceptanceChecks, consensusConfigForTask,
  type ValidationVote, type ConsensusResult, type GateCheckResult, type AcceptanceCheck,
} from './orchestrate';
import { buildCapsule, writeCapsule, summarizeCapsule, readCapsule, listCapsules } from './evidence';
import { recordOutcomeOnce } from './reputation';
import { verifyBiscuitToken } from './biscuit';
import { verifySvid } from './svid';

const fsPromises = fs.promises;

export interface BridgeConfig { port: number; host: string; commsDir: string; tokensPath: string; portBlockBase?: number; /** Workspace root for running manifest-declared acceptance commands (QLT-0b). When set, the bridge consensus endpoint can safely run shell commands in the correct directory. Optional — absent means remote-triggered gating is skipped (safe default). */ workspaceRoot?: string; }
export interface RemoteAgentToken {
  agent_id: string;
  token: string;
  created_at: string;
  expires_at: string;
  scopes: string[];
  /** ISO timestamp at which this token was revoked. `null` / undefined ⇒ active.
   *  Set by `revokeToken`; checked by `validateToken` and `validateRawToken`. */
  revoked_at?: string | null;
}
export interface BridgeState {
  server: http.Server | null;
  config: BridgeConfig;
  running: boolean;
  bus?: BridgeEventBus;
  sseClients?: Set<unknown>;
  wsClients?: Set<unknown>;
}

// ---------------------------------------------------------------------------
// BridgeEventBus — in-process pub/sub for push channels (SSE + WS).
// ---------------------------------------------------------------------------

/** Event types the bridge publishes. Names mirror NATS subjects we'll use later. */
export type BridgeEventType = 'message' | 'heartbeat' | 'consensus';

/** Payload shapes for each event. The data is the JSON object we wrote to disk. */
export interface BridgeEventData {
  message: Message;
  heartbeat: Heartbeat;
  consensus: ConsensusResult;
}

export type BridgeEventHandler<T extends BridgeEventType = BridgeEventType> =
  (data: BridgeEventData[T]) => void;

/** Minimal in-memory pub/sub. Per-event subscriber lists; subscribe returns
 *  an unsubscribe function. publish() catches handler errors so one bad
 *  subscriber can't break the others. */
export class BridgeEventBus {
  private handlers: Map<BridgeEventType, Set<BridgeEventHandler>> = new Map();

  subscribe<T extends BridgeEventType>(eventType: T, handler: BridgeEventHandler<T>): () => void {
    let set = this.handlers.get(eventType);
    if (!set) { set = new Set(); this.handlers.set(eventType, set); }
    set.add(handler as BridgeEventHandler);
    return () => { set!.delete(handler as BridgeEventHandler); };
  }

  publish<T extends BridgeEventType>(eventType: T, data: BridgeEventData[T]): void {
    const set = this.handlers.get(eventType);
    if (!set) { return; }
    for (const h of set) {
      try { (h as BridgeEventHandler<T>)(data); }
      catch (e) { console.error(`BridgeEventBus handler error (${eventType}):`, e); }
    }
  }

  /** Test/diagnostic helper: number of subscribers for an event type. */
  subscriberCount(eventType: BridgeEventType): number {
    return this.handlers.get(eventType)?.size ?? 0;
  }
}

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
  return validateRawToken(tokensPath, auth.slice(7));
}

/** Validate a raw token string (no "Bearer " prefix). Used for SSE/WS where
 *  the token comes via subprotocol or query param rather than Authorization.
 *
 *  Supports three token formats, tried in order:
 *  1. JWT-SVID (SPIFFE Phase 4) — detected by 3-part JWT shape + spiffe:// sub.
 *  2. Biscuit capability tokens (Phase 4) — base64url envelope with HMAC/WASM.
 *  3. UUID-style bearer tokens stored in tokens.json (existing behaviour).
 */
export async function validateRawToken(tokensPath: string, raw: string | undefined): Promise<RemoteAgentToken | null> {
  if (!raw) { return null; }

  // Try JWT-SVID path (3-part JWT with spiffe:// subject)
  if (raw.split('.').length === 3) {
    const svidResult = await verifySvid(raw).catch(() => ({ ok: false as const, reason: 'exception' }));
    if (svidResult.ok) {
      const expiresAt = new Date(svidResult.claims.exp * 1000).toISOString();
      return {
        agent_id: svidResult.claims.agent_id,
        token: raw,
        created_at: new Date(svidResult.claims.iat * 1000).toISOString(),
        expires_at: expiresAt,
        scopes: [],
      };
    }
  }

  // Try Biscuit path (dynamic — no WASM required; mock is always available)
  const biscuitResult = await verifyBiscuitToken(raw).catch(() => ({ ok: false as const, reason: 'exception' }));
  if (biscuitResult.ok) {
    return {
      agent_id: biscuitResult.facts.agent_id,
      token: raw,
      created_at: biscuitResult.facts.expires_at, // use expiry as proxy — Biscuit tokens are self-contained
      expires_at: biscuitResult.facts.expires_at,
      scopes: biscuitResult.effective_capabilities,
    };
  }

  // Fall back to bearer token DB lookup
  const tokens = await readTokens(tokensPath);
  const m = tokens.find(t => t.token === raw);
  if (!m || new Date(m.expires_at).getTime() < Date.now()) { return null; }
  if (m.revoked_at) { return null; }
  return m;
}

/**
 * Mark a token as revoked by stamping `revoked_at` with the current time.
 * Returns `true` if a matching token was found (and persisted), `false`
 * otherwise. Already-revoked tokens are re-stamped (last-revocation-wins);
 * the operation stays idempotent in the sense that the token remains
 * non-validating either way.
 */
export async function revokeToken(tokensPath: string, tokenValue: string): Promise<boolean> {
  if (!tokenValue) { return false; }
  const tokens = await readTokens(tokensPath);
  const idx = tokens.findIndex(t => t.token === tokenValue);
  if (idx < 0) { return false; }
  tokens[idx] = { ...tokens[idx], revoked_at: new Date().toISOString() };
  await writeTokens(tokensPath, tokens);
  return true;
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

export interface CreateBridgeServerOptions {
  /** Optional shared event bus. If omitted, the server creates its own. */
  bus?: BridgeEventBus;
  /** Optional shared SSE-client set. */
  sseClients?: Set<http.ServerResponse>;
  /** Optional shared WS-client set (opaque — ws lib types not pulled into core). */
  wsClients?: Set<unknown>;
}

export function createBridgeServer(
  config: BridgeConfig,
  opts: CreateBridgeServerOptions = {}
): http.Server {
  const bus = opts.bus ?? new BridgeEventBus();
  const sseClients = opts.sseClients ?? new Set<http.ServerResponse>();
  const wsClients = opts.wsClients ?? new Set<unknown>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const method = req.method?.toUpperCase() || 'GET';
    const p = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (p === '/health' && method === 'GET') {
      return json(res, 200, {
        status: 'ok', version: '2.0.0', port: config.port,
        sse_clients: sseClients.size, ws_clients: wsClients.size,
      });
    }
    if (p === '/api/v1/health' && method === 'GET') {
      return json(res, 200, {
        status: 'ok', version: '2.0.0', port: config.port,
        sse_clients: sseClients.size, ws_clients: wsClients.size,
      });
    }

    if (p.startsWith('/api/')) {
      // SSE stream: handled separately because handshake needs different headers
      // and a long-lived response. Token comes from Authorization header OR a
      // ?token= query param so plain `EventSource` can authenticate.
      if (p === '/api/v1/messages/stream' && method === 'GET') {
        const headerTok = req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7) : undefined;
        const queryTok = url.searchParams.get('token') ?? undefined;
        const tok = await validateRawToken(config.tokensPath, headerTok ?? queryTok);
        if (!tok) { return err(res, 401, 'Invalid or expired token'); }
        return handleSseStream(req, res, url, tok, bus, sseClients);
      }

      const token = await validateToken(config.tokensPath, req.headers.authorization);
      if (!token) { return err(res, 401, 'Invalid or expired token'); }

      try {
        if (p === '/api/v1/messages' && method === 'POST') {
          const body = await readBody(req);
          let msg: Message;
          try { msg = JSON.parse(body); } catch { return err(res, 400, 'Invalid JSON'); }
          if (msg.from !== token.agent_id) { return err(res, 403, 'Agent ID mismatch'); }
          const fp = await sendMessage(config.commsDir, msg);
          bus.publish('message', msg);
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
          bus.publish('heartbeat', hb);
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
          // Verifier independence: drop the task author's self-vote from the tally.
          const author = await readClaimAuthor(config.commsDir, tid);
          const result = evaluateConsensus(votes, round, DEFAULT_CONSENSUS_CONFIG, { author_agent_id: author });
          result.task_id = tid;
          // QLT-0b: acceptance command gate (bridge path).
          // When workspaceRoot is configured, run manifest-declared acceptance
          // commands in the correct directory — safe because the bridge owner
          // controls the workspace. Absent workspaceRoot → skip (safe default).
          // Acceptance recipe (the checks themselves) — captured onto the capsule
          // so a verifier can replay only the failed gates later.
          let acceptanceChecks: AcceptanceCheck[] | undefined;
          if (config.workspaceRoot) {
            try {
              const manifestDir = path.join(config.commsDir, '..', 'sprints');
              const { tasks: gateMap } = await readManifestTaskGates(manifestDir);
              const taskGates = gateMap.get(tid);
              if (taskGates?.acceptance && taskGates.acceptance.length > 0) {
                acceptanceChecks = taskGates.acceptance;
                const gateChecks: GateCheckResult[] = await runAcceptanceChecks(
                  taskGates.acceptance,
                  { cwd: config.workspaceRoot },
                );
                applyAcceptanceGate(result, gateChecks, { criticality: taskGates.criticality });
              }
            } catch { /* best-effort: gate failure does not block consensus */ }
          }
          // Persist a durable evidence capsule (crabbox run-handle pattern): a
          // re-inspectable bundle a fresh-context verifier can read or replay,
          // instead of discarding the result after evaluation.
          const capsule = buildCapsule(result, {
            author_agent_id: author, evaluated_by: token.agent_id, acceptance_checks: acceptanceChecks,
          });
          await writeCapsule(config.commsDir, capsule).catch(() => { /* best-effort */ });
          // Reputation join (REP-1): when consensus is reached, record the
          // outcome for the agent whose work was reviewed so the router can later
          // prefer agents with a track record. Dedup-guarded (evaluate is polled)
          // and best-effort — never blocks the response.
          if (author && result.status === 'consensus_reached') {
            await recordOutcomeOnce(config.commsDir, {
              task_id: tid,
              agent_id: author,
              verdict: result.final_verdict,
              gate_passed: capsule.gates_passed,
              rework_rounds: result.rounds,
              timestamp: capsule.evaluated_at,
            }).catch(() => { /* best-effort */ });
          }
          await appendCommsLog(config.commsDir, {
            timestamp: new Date().toISOString(),
            type: 'consensus_result',
            from: token.agent_id,
            task_id: tid,
            message: `${token.agent_id} evaluated ${tid}: ${summarizeCapsule(capsule)}`,
          });
          bus.publish('consensus', result);
          return json(res, 200, { ...result, run_id: capsule.run_id });
        }
        // Evidence capsules (crabbox run-handle analog). List by task, or fetch one
        // by run handle so a fresh-context verifier can re-inspect a review cycle.
        if (p === '/api/v1/capsules' && method === 'GET') {
          const task = url.searchParams.get('task') ?? undefined;
          const capsules = await listCapsules(config.commsDir, task);
          return json(res, 200, { capsules, count: capsules.length });
        }
        const km = p.match(/^\/api\/v1\/capsules\/([^/]+)$/);
        if (km && method === 'GET') {
          const capsule = await readCapsule(config.commsDir, km[1]);
          if (!capsule) { return err(res, 404, 'No such capsule'); }
          return json(res, 200, capsule);
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

  // Stash the bus & client sets on the server object so startBridge can wire
  // the WebSocket upgrade handler against the same instances.
  (server as unknown as { __bridgeBus: BridgeEventBus }).__bridgeBus = bus;
  (server as unknown as { __sseClients: Set<http.ServerResponse> }).__sseClients = sseClients;
  (server as unknown as { __wsClients: Set<unknown> }).__wsClients = wsClients;

  return server;
}

// ---------------------------------------------------------------------------
// SSE handler — long-lived `text/event-stream` response.
// ---------------------------------------------------------------------------

/** SSE keepalive interval (ms). Must be < typical proxy idle timeout (~60s). */
export const SSE_KEEPALIVE_MS = 25_000;

function sseWrite(res: http.ServerResponse, eventType: string, data: unknown): void {
  // Each SSE event is `event: <type>\ndata: <json>\n\n`. We JSON.stringify the
  // payload on a single line; SSE forbids a literal newline inside a data
  // field unless it's split into multiple `data:` lines.
  const line = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  try { res.write(line); } catch { /* client gone — disconnect handler will clean up */ }
}

function handleSseStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  token: RemoteAgentToken,
  bus: BridgeEventBus,
  sseClients: Set<http.ServerResponse>,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Initial flush so the client sees the response headers immediately.
  res.write(': connected\n\n');
  sseClients.add(res);

  // Per-stream filters. ?agent= scopes heartbeat events to a single agent.
  // Inbox messages are scoped server-side: we only forward messages whose
  // `to` matches the authenticated agent or 'shared'.
  const heartbeatAgent = url.searchParams.get('agent') ?? undefined;

  const onMessage = (msg: Message): void => {
    if (msg.to !== token.agent_id && msg.to !== 'shared') { return; }
    sseWrite(res, 'message', msg);
  };
  const onHeartbeat = (hb: Heartbeat): void => {
    if (heartbeatAgent && hb.agent_id !== heartbeatAgent) { return; }
    sseWrite(res, 'heartbeat', hb);
  };
  const onConsensus = (result: ConsensusResult): void => {
    sseWrite(res, 'consensus', result);
  };

  const unsubMessage = bus.subscribe('message', onMessage);
  const unsubHeartbeat = bus.subscribe('heartbeat', onHeartbeat);
  const unsubConsensus = bus.subscribe('consensus', onConsensus);

  // Keepalive: SSE comments (`: ...\n\n`) keep idle proxies from culling.
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
  }, SSE_KEEPALIVE_MS);
  // Don't keep the event loop alive solely on this timer.
  if (typeof keepalive.unref === 'function') { keepalive.unref(); }

  const cleanup = (): void => {
    clearInterval(keepalive);
    unsubMessage();
    unsubHeartbeat();
    unsubConsensus();
    sseClients.delete(res);
    try { res.end(); } catch { /* ignore */ }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
}

/** Hook for WebSocket support. Replaced with the real implementation in
 *  bridge-ws.ts once the `ws` dependency lands. Default no-op so SSE works
 *  on its own. */
let attachWebSocketIfAvailable: (
  server: http.Server, config: BridgeConfig,
  bus: BridgeEventBus, wsClients: Set<unknown>
) => void = () => { /* no-op until bridge-ws.ts is wired */ };

/** Internal: replace the WS attach hook. Called by bridge-ws.ts at module load. */
export function setWebSocketAttacher(fn: typeof attachWebSocketIfAvailable): void {
  attachWebSocketIfAvailable = fn;
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
  const blockBase = config.portBlockBase ?? config.port;
  const maxPort = blockBase + BRIDGE_PORT_FALLBACK_COUNT;
  const startPort = config.port;
  let lastErr: NodeJS.ErrnoException | undefined;
  let currentPort = startPort;
  while (currentPort <= maxPort) {
    const port = currentPort;
    const bus = new BridgeEventBus();
    const sseClients = new Set<http.ServerResponse>();
    const wsClients = new Set<unknown>();
    const server = createBridgeServer({ ...config, port }, { bus, sseClients, wsClients });
    try {
      await tryListen(server, config.host, port);
      const effectiveConfig: BridgeConfig = { ...config, port };
      try { await import('./bridge-ws'); } catch (e) {
        console.warn('Bridge: WebSocket support unavailable:', (e as Error).message);
      }
      attachWebSocketIfAvailable(server, effectiveConfig, bus, wsClients);
      console.log(`AutoClaw bridge on ${config.host}:${port}`);
      return { server, config: effectiveConfig, running: true, bus, sseClients, wsClients };
    } catch (e) {
      lastErr = e as NodeJS.ErrnoException;
      try { server.close(); } catch { /* ignore */ }
      if (lastErr.code !== 'EADDRINUSE') {
        throw lastErr;
      }
    }
    currentPort++;
  }
  throw lastErr ?? new Error(
    `Bridge could not bind to any port in range ${startPort}-${maxPort}`
  );
}

export function stopBridge(state: BridgeState): Promise<void> {
  return new Promise(resolve => {
    // Force-close any active SSE responses so server.close() can complete.
    if (state.sseClients) {
      for (const res of state.sseClients) {
        try { (res as http.ServerResponse).end(); } catch { /* ignore */ }
      }
      state.sseClients.clear();
    }
    // Force-close any open WS clients.
    if (state.wsClients) {
      for (const ws of state.wsClients) {
        try { (ws as { terminate?: () => void }).terminate?.(); } catch { /* ignore */ }
      }
      state.wsClients.clear();
    }
    if (state.server) { state.server.close(() => { state.running = false; resolve(); }); }
    else { resolve(); }
  });
}

export const DEFAULT_BRIDGE_CONFIG: Omit<BridgeConfig, 'commsDir' | 'tokensPath'> = { port: 9876, host: '127.0.0.1' };

export const IDE_BRIDGE_PORT_RANGES: Record<string, { base: number; count: number }> = {
  vscode:      { base: 9876,  count: 4 },
  cursor:      { base: 10876, count: 4 },
  kiro:        { base: 11876, count: 4 },
  windsurf:    { base: 12876, count: 4 },
  antigravity: { base: 13876, count: 4 },
  other:       { base: 14876, count: 4 },
};
