/**
 * Express HTTP front-end for the AutoClaw KG daemon.
 *
 * All routes live under `/api/v1/*` and respond JSON. Errors match
 * the bridge shape: `{ error: { code, message } }`.
 *
 * Run via `npm start` after `npm run build`. Defaults to
 * 127.0.0.1:9877; override with KG_HOST / KG_PORT / KG_DB_PATH /
 * ZIPPYMESH_URL.
 */

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import type { Server } from "node:http";
import { openDb, type DbHandle } from "./db.js";
import { SqliteKnowledgeGraph } from "./kg.js";
import { pingZippyMesh } from "./embed.js";
import type { KGErrorBody } from "./types.js";

export interface DaemonOpts {
  dbPath?: string;
  host?: string;
  port?: number;
}

export interface DaemonHandle {
  app: Express;
  server: Server;
  kg: SqliteKnowledgeGraph;
  dbHandle: DbHandle;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_PORT = 9877;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DB = "./kg-prototype.db";

export async function startDaemon(opts: DaemonOpts = {}): Promise<DaemonHandle> {
  const dbPath = opts.dbPath ?? process.env.KG_DB_PATH ?? DEFAULT_DB;
  const host = opts.host ?? process.env.KG_HOST ?? DEFAULT_HOST;
  const port = opts.port ?? Number(process.env.KG_PORT) ?? DEFAULT_PORT;

  const dbHandle = openDb(dbPath);
  const kg = new SqliteKnowledgeGraph(dbHandle);
  const app = buildApp(kg, dbHandle);

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.once("error", reject);
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    app,
    server,
    kg,
    dbHandle,
    port: boundPort,
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        dbHandle.close();
        resolve();
      });
    }),
  };
}

export function buildApp(
  kg: SqliteKnowledgeGraph,
  dbHandle: DbHandle,
): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
  });

  app.options("*", (_req, res) => res.status(204).end());

  // ----- health ------------------------------------------------------
  app.get("/api/v1/health", async (_req, res) => {
    const zm = await pingZippyMesh();
    res.json({
      ok: true,
      sqlite: dbHandle.caps.sqlite,
      vec: dbHandle.caps.vec,
      fts: dbHandle.caps.fts,
      zippymesh: zm,
    });
  });

  // ----- ingest ------------------------------------------------------
  app.post("/api/v1/thoughts", asyncH(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") return sendErr(res, 400, "JSON body required");
    const required = ["project", "agent", "kind", "text"] as const;
    for (const k of required) {
      if (typeof body[k] !== "string" || (body[k] as string).length === 0) {
        return sendErr(res, 400, `field '${k}' must be a non-empty string`);
      }
    }
    if (body.embedding !== undefined && !Array.isArray(body.embedding)) {
      return sendErr(res, 400, "field 'embedding' must be a number[]");
    }
    if (body.meta !== undefined && (typeof body.meta !== "object" || body.meta === null)) {
      return sendErr(res, 400, "field 'meta' must be an object");
    }
    try {
      const id = await kg.recordThought({
        project: body.project as string,
        agent: body.agent as string,
        sprint: typeof body.sprint === "string" ? body.sprint : undefined,
        task_id: typeof body.task_id === "string" ? body.task_id : undefined,
        kind: body.kind as string,
        text: body.text as string,
        embedding: body.embedding as number[] | undefined,
        meta: body.meta as Record<string, unknown> | undefined,
      });
      res.status(201).json({ id });
    } catch (e) {
      sendErr(res, 400, (e as Error).message);
    }
  }));

  app.post("/api/v1/relations", asyncH(async (req, res) => {
    const b = req.body as Record<string, unknown> | undefined;
    if (!b) return sendErr(res, 400, "JSON body required");
    const { from, kind, to, meta } = b as { from?: string; kind?: string; to?: string; meta?: unknown };
    if (typeof from !== "string" || typeof kind !== "string" || typeof to !== "string") {
      return sendErr(res, 400, "fields 'from', 'kind', 'to' must all be strings");
    }
    if (meta !== undefined && (typeof meta !== "object" || meta === null)) {
      return sendErr(res, 400, "field 'meta' must be an object");
    }
    try {
      await kg.recordRelation(from, kind, to, meta as Record<string, unknown> | undefined);
      res.status(201).json({ ok: true });
    } catch (e) {
      sendErr(res, 400, (e as Error).message);
    }
  }));

  // ----- search ------------------------------------------------------
  app.get("/api/v1/thoughts/search", asyncH(async (req, res) => {
    const q = strParam(req, "q");
    if (!q) return sendErr(res, 400, "query param 'q' required");
    const k = numParam(req, "k", 10);
    const project = strParam(req, "project");
    const agent = strParam(req, "agent");
    const since = strParam(req, "since");
    const hits = await kg.searchSimilar(q, {
      k,
      project: project || undefined,
      agent: agent || undefined,
      since: since || undefined,
    });
    res.json({ thoughts: hits });
  }));

  // ----- traverse ----------------------------------------------------
  app.get("/api/v1/thoughts/traverse", asyncH(async (req, res) => {
    const seed = strParam(req, "seed");
    if (!seed) return sendErr(res, 400, "query param 'seed' required");
    const kindsRaw = strParam(req, "kinds");
    const kinds = kindsRaw ? kindsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const depth = numParam(req, "depth", 2);
    const thoughts = await kg.traverseFrom(seed, kinds, depth);
    res.json({ thoughts });
  }));

  // ----- filter streams (forAgent / forProject / since) -------------
  app.get("/api/v1/thoughts", asyncH(async (req, res) => {
    const agent = strParam(req, "agent");
    const project = strParam(req, "project");
    const since = strParam(req, "since");

    let thoughts;
    if (agent) {
      thoughts = await kg.forAgent(agent, { since: since || undefined });
    } else if (project) {
      thoughts = await kg.forProject(project, { since: since || undefined });
    } else if (since) {
      thoughts = await kg.since(since);
    } else {
      return sendErr(res, 400, "one of 'agent', 'project', 'since' required");
    }
    res.json({ thoughts });
  }));

  // ----- export (streamed) ------------------------------------------
  app.get("/api/v1/thoughts/export", asyncH(async (req, res) => {
    const project = strParam(req, "project");
    const fmt = (strParam(req, "format") ?? "jsonl") as "jsonl" | "md";
    if (fmt !== "jsonl" && fmt !== "md") {
      return sendErr(res, 400, "format must be 'jsonl' or 'md'");
    }
    res.setHeader(
      "Content-Type",
      fmt === "jsonl" ? "application/x-ndjson" : "text/markdown; charset=utf-8",
    );
    try {
      for await (const chunk of kg.export({ project: project || undefined, format: fmt })) {
        res.write(chunk);
      }
      res.end();
    } catch (e) {
      // Best-effort: if headers already went out, just close.
      if (!res.headersSent) sendErr(res, 500, (e as Error).message);
      else res.end();
    }
  }));

  // ----- 404 / error fallthrough ------------------------------------
  app.use((_req, res) => sendErr(res, 404, "not found"));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    sendErr(res, 500, (err as Error)?.message ?? "internal error");
  });

  return app;
}

// ----- helpers --------------------------------------------------------

function asyncH(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function sendErr(res: Response, code: number, message: string): void {
  const body: KGErrorBody = { error: { code, message } };
  res.status(code).json(body);
}

function strParam(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numParam(req: Request, name: string, fallback: number): number {
  const v = req.query[name];
  if (typeof v !== "string") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ----- entrypoint -----------------------------------------------------

const isMain = (() => {
  try {
    const here = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? resolvePath(process.argv[1]) : "";
    return entry !== "" && resolvePath(here) === entry;
  } catch {
    return false;
  }
})();

if (isMain) {
  startDaemon().then((h) => {
    // eslint-disable-next-line no-console
    console.log(
      `[kg-daemon] listening on http://${process.env.KG_HOST ?? DEFAULT_HOST}:${h.port} ` +
      `(sqlite=${h.dbHandle.caps.sqlite} vec=${h.dbHandle.caps.vec} fts=${h.dbHandle.caps.fts})`,
    );
    const shutdown = async () => { await h.close(); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[kg-daemon] failed to start:", e);
    process.exit(1);
  });
}
