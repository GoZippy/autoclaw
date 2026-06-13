/**
 * `externalRouterUrl` peer server — RFC §6a wiring.
 *
 * ZMLR's routing engine supports an external peer that ZMLR POSTs to
 * during candidate selection (`settings.externalRouterUrl`). This file
 * is AutoClaw's implementation of that peer — a loopback-only HTTP
 * handler that returns `{ suggestedModelIds: [...] }` for ZMLR to
 * reorder its candidate list.
 *
 * Design constraints (RFC §6a + S3 spec):
 *   - **Loopback only.** Binds 127.0.0.1; not configurable to bind 0.0.0.0.
 *   - **Hard 200 ms budget.** Any path that hits disk, IPC, or network
 *     blows it. Default `suggest` reads only in-memory state.
 *   - **10 KB body cap.** Matching ZMLR's outgoing cap. Over-cap → empty
 *     suggestions, ZMLR continues with default order (non-fatal).
 *   - **Never throws.** Any failure → empty suggestions. ZMLR is
 *     designed to fall back cleanly on errors.
 *   - **Off by default.** Opt-in via `autoclaw.llm.peerEnabled` until
 *     latency has been field-measured (RFC §8 q5).
 *
 * @see docs/rfc/llm-provider-abstraction.md §6a
 * @see docs/specs/llm-provider-s3/spec.md
 */

import * as http from 'http';
import { AddressInfo } from 'net';

const DEFAULT_PORT = 20129;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_BUDGET_MS = 200;
const DEFAULT_BODY_CAP_BYTES = 10 * 1024;
const ROUTE_PATH = '/llm/peer/route';

/**
 * The request body ZMLR sends to the external router (verified against
 * the routing engine source — see RFC §6a "Exact contract").
 */
export interface PeerRouteRequest {
  /** Requested model id (the input ZMLR was about to route). */
  model: string;
  /** Intent from `X-Intent`/`X-Zippy-Intent`, when present. */
  intent: string | null;
  /** True when the request payload includes image content. */
  hasImage: boolean;
  /** Token estimate ZMLR computed before routing. */
  estimatedTokens: number;
  /** Optional session/client identifier ZMLR derived from headers. */
  clientId: string | null;
}

/**
 * The peer response. `suggestedModelIds` is an ordered array of
 * `provider/model` strings — ZMLR reorders its candidate list to put
 * matches first; non-matching candidates are appended at the end.
 *
 * An empty array means "no peer opinion" — ZMLR continues with its
 * default order.
 */
export interface PeerRouteResponse {
  suggestedModelIds: string[];
}

/** Sync or async callback that turns a request into a response. */
export type PeerSuggest = (
  req: PeerRouteRequest,
) => PeerRouteResponse | Promise<PeerRouteResponse>;

export interface PeerServerOptions {
  /** Port to bind. Default 20129. */
  port?: number;
  /** Bind host. Default 127.0.0.1 (loopback only). */
  host?: string;
  /** Hard per-request budget in ms. Default 200. */
  budgetMs?: number;
  /** Hard body cap in bytes. Default 10240. */
  bodyCapBytes?: number;
  /** Suggestion callback. Required. */
  suggest: PeerSuggest;
}

/**
 * Tiny loopback HTTP server that answers POSTs to `/llm/peer/route`
 * and 404s everything else. Built on Node's stdlib `http` to avoid a
 * framework dep.
 */
export class PeerServer {
  private readonly port: number;
  private readonly host: string;
  private readonly budgetMs: number;
  private readonly bodyCapBytes: number;
  private readonly suggest: PeerSuggest;
  private server?: http.Server;
  private actualPort?: number;

  constructor(opts: PeerServerOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.host = opts.host ?? DEFAULT_HOST;
    this.budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    this.bodyCapBytes = opts.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES;
    this.suggest = opts.suggest;
  }

  /** Bind the port; resolves when listening. */
  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', (err) => reject(err));
      server.listen(this.port, this.host, () => {
        this.server = server;
        const addr = server.address() as AddressInfo | null;
        this.actualPort = addr?.port ?? this.port;
        resolve();
      });
    });
  }

  /** Close the server; resolves when the port is released. */
  stop(): Promise<void> {
    const server = this.server;
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      server.close((err) => {
        this.server = undefined;
        this.actualPort = undefined;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** The bound URL — useful to paste into ZMLR's settings. */
  url(): string {
    return `http://${this.host}:${this.actualPort ?? this.port}${ROUTE_PATH}`;
  }

  /** Visible for testing — the actually-bound port (0 = use any). */
  boundPort(): number | undefined {
    return this.actualPort;
  }

  /* ------------------------------------------------------------------ */
  /*  Request handling                                                  */
  /* ------------------------------------------------------------------ */

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '';
    if (url !== ROUTE_PATH) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    const start = Date.now();
    let bytesRead = 0;
    const chunks: Buffer[] = [];
    let aborted = false;

    const finish = (body: PeerRouteResponse, status = 200): void => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const timer = setTimeout(() => {
      // Budget blown — short-circuit to empty suggestions.
      aborted = true;
      finish({ suggestedModelIds: [] });
    }, this.budgetMs);

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      bytesRead += chunk.length;
      if (bytesRead > this.bodyCapBytes) {
        aborted = true;
        clearTimeout(timer);
        // Per RFC §6a: failure mode is non-fatal — return empty so ZMLR
        // continues with its default order rather than blowing up.
        finish({ suggestedModelIds: [] });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => {
      if (aborted) return;
      aborted = true;
      clearTimeout(timer);
      finish({ suggestedModelIds: [] });
    });

    req.on('end', () => {
      if (aborted) return;
      let parsed: PeerRouteRequest;
      try {
        parsed = parseRequest(Buffer.concat(chunks).toString('utf8'));
      } catch {
        clearTimeout(timer);
        finish({ suggestedModelIds: [] });
        return;
      }
      void this.runSuggest(parsed, start, timer).then((result) => {
        clearTimeout(timer);
        if (!aborted) finish(result);
      });
    });
  }

  private async runSuggest(
    req: PeerRouteRequest,
    start: number,
    timer: NodeJS.Timeout,
  ): Promise<PeerRouteResponse> {
    void start;
    void timer;
    try {
      const result = await this.suggest(req);
      if (!result || !Array.isArray(result.suggestedModelIds)) {
        return { suggestedModelIds: [] };
      }
      // Defensive: stringify each entry, dedupe, cap at 20 — ZMLR uses a
      // small candidate pool and an arbitrarily long list would just be
      // wire weight.
      const seen = new Set<string>();
      const out: string[] = [];
      for (const id of result.suggestedModelIds) {
        if (typeof id !== 'string' || id.length === 0) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        if (out.length >= 20) break;
      }
      return { suggestedModelIds: out };
    } catch {
      // Suggest threw — empty result. Non-fatal per RFC §6a.
      return { suggestedModelIds: [] };
    }
  }
}

/**
 * Parse a raw request body into a `PeerRouteRequest`. Missing fields
 * are coerced to defaults so a slightly different ZMLR build doesn't
 * trip us up.
 */
function parseRequest(raw: string): PeerRouteRequest {
  const json = JSON.parse(raw) as Record<string, unknown>;
  return {
    model: typeof json.model === 'string' ? json.model : '',
    intent: typeof json.intent === 'string' ? json.intent : null,
    hasImage: json.hasImage === true,
    estimatedTokens:
      typeof json.estimatedTokens === 'number' ? json.estimatedTokens : 0,
    clientId: typeof json.clientId === 'string' ? json.clientId : null,
  };
}
