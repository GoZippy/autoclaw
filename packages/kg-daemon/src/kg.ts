/**
 * KnowledgeGraph implementation backed by SQLite (+ optional sqlite-vec).
 * Tier 1 of the AutoClaw fabric. Sync DB calls wrapped in async to
 * match the interface and to leave room for the Tier 2 swap.
 */

import { randomUUID } from "node:crypto";
import { EMBEDDING_DIM, type DbHandle } from "./db.js";
import { embed } from "./embed.js";
import type {
  KnowledgeGraph,
  SearchOpts,
  Thought,
  ThoughtId,
} from "./types.js";

interface ThoughtRow {
  id: string;
  project: string;
  agent: string;
  sprint: string | null;
  task_id: string | null;
  kind: string;
  text: string;
  created_at: string;
  meta_json: string | null;
  has_embed: number;
  rowid: number;
  valid_from: string | null;
  valid_to: string | null;
}

export class SqliteKnowledgeGraph implements KnowledgeGraph {
  constructor(
    private readonly handle: DbHandle,
    private readonly opts: { embedFn?: (text: string) => Promise<number[] | null> } = {},
  ) {}

  // -------- ingest -----------------------------------------------------

  async recordThought(
    t: Omit<Thought, "id" | "created_at"> & { id?: string; created_at?: string },
  ): Promise<ThoughtId> {
    if (!t || typeof t !== "object") throw new Error("thought required");
    if (!t.project || !t.agent || !t.kind || typeof t.text !== "string") {
      throw new Error("project, agent, kind, text required");
    }
    const id = t.id || randomUUID();
    const createdAt = t.created_at || new Date().toISOString();

    // Embedding may already be supplied; otherwise try to fetch one.
    let embedding: number[] | null = Array.isArray(t.embedding) ? t.embedding : null;
    if (!embedding && this.opts.embedFn) {
      embedding = await this.opts.embedFn(t.text);
    } else if (!embedding) {
      embedding = await embed(t.text);
    }

    const hasEmbed =
      this.handle.caps.vec &&
      embedding !== null &&
      embedding.length === EMBEDDING_DIM
        ? 1
        : 0;

    const stmt = this.handle.db.prepare(`
      INSERT INTO thoughts (id, project, agent, sprint, task_id, kind, text, created_at, meta_json, has_embed, valid_from, valid_to)
      VALUES (@id, @project, @agent, @sprint, @task_id, @kind, @text, @created_at, @meta_json, @has_embed, @valid_from, @valid_to)
    `);

    const tx = this.handle.db.transaction(() => {
      stmt.run({
        id,
        project: t.project,
        agent: t.agent,
        sprint: t.sprint ?? null,
        task_id: t.task_id ?? null,
        kind: t.kind,
        text: t.text,
        created_at: createdAt,
        meta_json: t.meta ? JSON.stringify(t.meta) : null,
        has_embed: hasEmbed,
        valid_from: (t as Record<string, unknown>).valid_from as string ?? createdAt,
        valid_to: (t as Record<string, unknown>).valid_to as string ?? null,
      });
      if (hasEmbed === 1 && embedding) {
        const row = this.handle.db
          .prepare(`SELECT rowid FROM thoughts WHERE id = ?`)
          .get(id) as { rowid: number } | undefined;
        if (row) {
          try {
            const buf = Buffer.from(new Float32Array(embedding).buffer);
            this.handle.db
              .prepare(`INSERT INTO thoughts_vec (rowid, embedding) VALUES (?, ?)`)
              .run(row.rowid, buf);
          } catch {
            // If vec insert fails, downgrade quietly: row stays, search
            // will fall back to FTS for this one.
            this.handle.db
              .prepare(`UPDATE thoughts SET has_embed = 0 WHERE id = ?`)
              .run(id);
          }
        }
      }
    });
    tx();

    return id;
  }

  async recordRelation(
    from: string,
    kind: string,
    to: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    if (!from || !kind || !to) throw new Error("from, kind, to required");
    this.handle.db
      .prepare(
        `INSERT OR REPLACE INTO edges (from_id, kind, to_id, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(from, kind, to, meta ? JSON.stringify(meta) : null, new Date().toISOString());
  }

  // -------- retrieval --------------------------------------------------

  async searchSimilar(text: string, opts: SearchOpts = {}): Promise<Thought[]> {
    if (typeof text !== "string" || text.length === 0) return [];
    const k = clampInt(opts.k ?? 10, 1, 200);

    // Try vector search first when available; fall back to FTS.
    if (this.handle.caps.vec) {
      const vec = await embed(text);
      if (vec && vec.length === EMBEDDING_DIM) {
        const hits = this.vecSearch(vec, k, opts);
        if (hits.length > 0) return hits;
      }
    }
    return this.ftsSearch(text, k, opts);
  }

  async traverseFrom(
    seed: string,
    edgeKinds: string[],
    depth = 2,
  ): Promise<Thought[]> {
    if (!seed) return [];
    const d = clampInt(depth, 0, 8);
    const kinds = edgeKinds && edgeKinds.length > 0 ? edgeKinds : null;
    const placeholders = kinds ? kinds.map(() => "?").join(",") : "";
    const kindFilter = kinds ? `AND e.kind IN (${placeholders})` : "";

    const sql = `
      WITH RECURSIVE walk(id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT e.to_id, w.depth + 1
          FROM edges e
          JOIN walk w ON e.from_id = w.id
         WHERE w.depth < ${d}
           ${kindFilter}
      )
      SELECT t.* FROM thoughts t
        JOIN walk w ON w.id = t.id
       WHERE t.id != ?
       ORDER BY t.created_at DESC
       LIMIT 500
    `;
    const params: unknown[] = [seed];
    if (kinds) params.push(...kinds);
    params.push(seed);
    const rows = this.handle.db.prepare(sql).all(...params) as ThoughtRow[];
    return rows.map(rowToThought);
  }

  async forAgent(agent: string, opts: { since?: string } = {}): Promise<Thought[]> {
    return this.filterStream({ agent, since: opts.since });
  }
  async forProject(project: string, opts: { since?: string } = {}): Promise<Thought[]> {
    return this.filterStream({ project, since: opts.since });
  }
  async since(iso: string): Promise<Thought[]> {
    return this.filterStream({ since: iso });
  }

  async *export(opts: { project?: string; format?: "jsonl" | "md" } = {}):
    AsyncIterable<string> {
    const fmt = opts.format ?? "jsonl";
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.project) { where.push("project = ?"); params.push(opts.project); }
    const sql = `SELECT * FROM thoughts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC`;
    const iter = this.handle.db.prepare(sql).iterate(...params) as IterableIterator<ThoughtRow>;
    for (const row of iter) {
      const t = rowToThought(row);
      if (fmt === "md") {
        yield `## ${t.created_at} — ${t.agent} (${t.kind})\n\n${t.text}\n\n`;
      } else {
        yield JSON.stringify(t) + "\n";
      }
    }
  }

  // -------- internals --------------------------------------------------

  private filterStream(f: { agent?: string; project?: string; since?: string }): Thought[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.agent)   { where.push("agent = ?");   params.push(f.agent); }
    if (f.project) { where.push("project = ?"); params.push(f.project); }
    if (f.since)   { where.push("created_at >= ?"); params.push(f.since); }
    const sql = `SELECT * FROM thoughts ${
      where.length ? `WHERE ${where.join(" AND ")}` : ""
    } ORDER BY created_at DESC LIMIT 1000`;
    const rows = this.handle.db.prepare(sql).all(...params) as ThoughtRow[];
    return rows.map(rowToThought);
  }

  private vecSearch(vec: number[], k: number, opts: SearchOpts): Thought[] {
    try {
      const buf = Buffer.from(new Float32Array(vec).buffer);
      // KNN over thoughts_vec, then join back to thoughts and apply
      // post-filters. We over-fetch a bit so post-filters still leave
      // ~k results.
      const rows = this.handle.db
        .prepare(
          `SELECT t.*, v.distance AS distance
             FROM thoughts_vec v
             JOIN thoughts t ON t.rowid = v.rowid
            WHERE v.embedding MATCH ? AND k = ?
            ORDER BY v.distance ASC`,
        )
        .all(buf, Math.max(k * 3, k)) as (ThoughtRow & { distance: number })[];
      return applyPostFilters(rows, opts).slice(0, k).map(rowToThought);
    } catch {
      return [];
    }
  }

  private ftsSearch(text: string, k: number, opts: SearchOpts): Thought[] {
    if (!this.handle.caps.fts) {
      // Last-resort: LIKE.
      const like = `%${text.replace(/[%_]/g, "")}%`;
      const rows = this.handle.db
        .prepare(`SELECT * FROM thoughts WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`)
        .all(like, k) as ThoughtRow[];
      return applyPostFilters(rows, opts).slice(0, k).map(rowToThought);
    }
    const query = ftsEscape(text);
    try {
      const rows = this.handle.db
        .prepare(
          `SELECT t.*, bm25(thoughts_fts) AS distance
             FROM thoughts_fts
             JOIN thoughts t ON t.rowid = thoughts_fts.rowid
            WHERE thoughts_fts MATCH ?
            ORDER BY bm25(thoughts_fts)
            LIMIT ?`,
        )
        .all(query, Math.max(k * 3, k)) as (ThoughtRow & { distance: number })[];
      return applyPostFilters(rows, opts).slice(0, k).map(rowToThought);
    } catch {
      return [];
    }
  }
}

// ----- helpers --------------------------------------------------------

function clampInt(n: unknown, lo: number, hi: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

function ftsEscape(s: string): string {
  // Tokenize on whitespace, drop FTS metacharacters, wrap each token
  // with quotes so user input can't accidentally express FTS syntax.
  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(/["()*:^]/g, "").trim())
    .filter(Boolean)
    .map((t) => `"${t}"`);
  return tokens.length > 0 ? tokens.join(" OR ") : `""`;
}

function applyPostFilters<R extends ThoughtRow>(rows: R[], opts: SearchOpts): R[] {
  return rows.filter((r) => {
    if (opts.project && r.project !== opts.project) return false;
    if (opts.agent && r.agent !== opts.agent) return false;
    if (opts.since && r.created_at < opts.since) return false;
    // Bi-temporal validity filter: when ?at= is provided, only include thoughts
    // that were asserted by that instant and not yet retracted.
    if (opts.at) {
      const vf = r.valid_from ?? r.created_at;
      if (vf > opts.at) return false;          // not yet valid
      if (r.valid_to && r.valid_to <= opts.at) return false; // already retracted
    }
    return true;
  });
}

function rowToThought(r: ThoughtRow): Thought {
  return {
    id: r.id,
    project: r.project,
    agent: r.agent,
    sprint: r.sprint ?? undefined,
    task_id: r.task_id ?? undefined,
    kind: r.kind,
    text: r.text,
    created_at: r.created_at,
    ...(r.valid_from ? { valid_from: r.valid_from } : {}),
    ...(r.valid_to   ? { valid_to:   r.valid_to   } : {}),
    meta: r.meta_json ? safeParse(r.meta_json) : undefined,
  };
}

function safeParse(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return undefined; }
}
