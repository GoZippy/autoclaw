/**
 * kg/store.ts — KnowledgeGraph implementation over the driver-agnostic
 * {@link SqliteDriver} (node:sqlite first, better-sqlite3 fallback).
 *
 * Ported from `packages/kg-daemon/src/kg.ts` (`SqliteKnowledgeGraph`). Two
 * adaptations from the better-sqlite3 original:
 *   1. All parameters are POSITIONAL (`?`) rather than named (`@x`) so the
 *      same SQL runs unchanged on both drivers.
 *   2. Transactions go through `driver.transaction(fn)` (the driver papers over
 *      better-sqlite3's `.transaction()` vs node:sqlite's BEGIN/COMMIT).
 *
 * Embeddings come from an injected `embed` function (wired by the factory to
 * the Intelligence Layer's `getEmbedding`, default provider `none`), so the
 * store has no embedding dependency of its own and never requires the network.
 */

import { randomUUID } from "node:crypto";
import type { SqliteDriver } from "../vector/sqliteDriver";
import type {
  Edge,
  KgCapabilities,
  KnowledgeGraph,
  SearchOpts,
  Thought,
  ThoughtId,
} from "./types";

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

export interface KgStoreOptions {
  /** Embedding dimension (must match the vec0 table + provider). */
  dimension: number;
  /** Produce an embedding for `text`, or `null` to skip vector indexing. */
  embed?: (text: string) => Promise<number[] | null>;
}

export class KnowledgeGraphStore implements KnowledgeGraph {
  constructor(
    private readonly driver: SqliteDriver,
    private readonly caps: KgCapabilities,
    private readonly opts: KgStoreOptions,
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

    let embedding: number[] | null = Array.isArray(t.embedding) ? t.embedding : null;
    if (!embedding && this.opts.embed) {
      embedding = await this.opts.embed(t.text);
    }

    const hasEmbed =
      this.caps.vec && embedding !== null && embedding.length === this.opts.dimension
        ? 1
        : 0;

    this.driver.transaction(() => {
      this.driver
        .prepare(
          `INSERT INTO thoughts
             (id, project, agent, sprint, task_id, kind, text, created_at, meta_json, has_embed, valid_from, valid_to)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          t.project,
          t.agent,
          t.sprint ?? null,
          t.task_id ?? null,
          t.kind,
          t.text,
          createdAt,
          t.meta ? JSON.stringify(t.meta) : null,
          hasEmbed,
          t.valid_from ?? createdAt,
          t.valid_to ?? null,
        );

      if (hasEmbed === 1 && embedding) {
        const row = this.driver
          .prepare(`SELECT rowid FROM thoughts WHERE id = ?`)
          .get(id) as { rowid: number } | undefined;
        if (row) {
          try {
            const buf = Buffer.from(new Float32Array(embedding).buffer);
            // vec0's rowid primary key must bind as an INTEGER. node:sqlite
            // rejects a JS `number` for an integer PK ("Only integers are
            // allowed") — it requires a BigInt. better-sqlite3 accepts BigInt
            // too, so bind BigInt on both drivers.
            this.driver
              .prepare(`INSERT INTO thoughts_vec (rowid, embedding) VALUES (?, ?)`)
              .run(BigInt(row.rowid), buf);
          } catch {
            // Downgrade quietly: keep the row, drop the embedding flag so
            // search falls back to FTS for this thought.
            this.driver
              .prepare(`UPDATE thoughts SET has_embed = 0 WHERE id = ?`)
              .run(id);
          }
        }
      }
    });

    return id;
  }

  async recordRelation(
    from: string,
    kind: string,
    to: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    if (!from || !kind || !to) throw new Error("from, kind, to required");
    this.driver
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
    const strategy = opts.strategy ?? "multi";

    if (strategy === "fts") {
      return this.ftsSearch(text, k, opts);
    }
    if (strategy === "vec") {
      if (!this.caps.vec) return this.ftsSearch(text, k, opts);
      const vec = await this.embedQuery(text);
      if (!vec) return this.ftsSearch(text, k, opts);
      const hits = this.vecSearch(vec, k, opts);
      return hits.length > 0 ? hits : this.ftsSearch(text, k, opts);
    }

    // "multi": vec + fts (+ optional graph) in parallel, merged by rank.
    const arms: Promise<Thought[]>[] = [];

    const vecArm = this.caps.vec
      ? this.embedQuery(text)
          .then((vec) => (vec ? this.vecSearch(vec, k * 2, opts) : ([] as Thought[])))
          .catch(() => [] as Thought[])
      : Promise.resolve([] as Thought[]);
    arms.push(vecArm);

    arms.push(Promise.resolve(this.ftsSearch(text, k * 2, opts)));

    if (opts.graph_seed) {
      const graphArm = this.traverseFrom(
        opts.graph_seed,
        opts.graph_edge_kinds ?? [],
        opts.graph_depth ?? 2,
      )
        .then((thoughts) =>
          thoughts.filter((t) => {
            if (opts.project && t.project !== opts.project) return false;
            if (opts.agent && t.agent !== opts.agent) return false;
            if (opts.since && t.created_at < opts.since) return false;
            if (opts.at) {
              const vf = t.valid_from ?? t.created_at;
              if (vf > opts.at) return false;
              if (t.valid_to && t.valid_to <= opts.at) return false;
            }
            return true;
          }),
        )
        .catch(() => [] as Thought[]);
      arms.push(graphArm);
    }

    const results = await Promise.all(arms);
    return mergeAndRank(results, k);
  }

  async traverseFrom(seed: string, edgeKinds: string[], depth = 2): Promise<Thought[]> {
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
    const rows = this.driver.prepare(sql).all(...params) as ThoughtRow[];
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

  async allThoughts(opts: { limit?: number } = {}): Promise<Thought[]> {
    const limit = clampInt(opts.limit ?? 2000, 1, 20000);
    const rows = this.driver
      .prepare(`SELECT * FROM thoughts ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as ThoughtRow[];
    return rows.map(rowToThought);
  }

  async listEdges(opts: { limit?: number } = {}): Promise<Edge[]> {
    const limit = clampInt(opts.limit ?? 5000, 1, 50000);
    const rows = this.driver
      .prepare(
        `SELECT from_id, kind, to_id, meta_json FROM edges ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as { from_id: string; kind: string; to_id: string; meta_json: string | null }[];
    return rows.map((r) => ({
      from: r.from_id,
      kind: r.kind,
      to: r.to_id,
      ...(r.meta_json ? { meta: safeParse(r.meta_json) } : {}),
    }));
  }

  async *export(
    opts: { project?: string; format?: "jsonl" | "md" } = {},
  ): AsyncIterable<string> {
    const fmt = opts.format ?? "jsonl";
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.project) {
      where.push("project = ?");
      params.push(opts.project);
    }
    const sql = `SELECT * FROM thoughts ${
      where.length ? `WHERE ${where.join(" AND ")}` : ""
    } ORDER BY created_at ASC`;
    // The driver surface exposes `all` (not a streaming iterator) uniformly
    // across both backends; export volumes are bounded by a single project.
    const rows = this.driver.prepare(sql).all(...params) as ThoughtRow[];
    for (const row of rows) {
      const t = rowToThought(row);
      if (fmt === "md") {
        yield `## ${t.created_at} — ${t.agent} (${t.kind})\n\n${t.text}\n\n`;
      } else {
        yield JSON.stringify(t) + "\n";
      }
    }
  }

  /** Realized backend capabilities, for health reporting. */
  capabilities(): KgCapabilities {
    return { ...this.caps };
  }

  // -------- internals --------------------------------------------------

  private async embedQuery(text: string): Promise<number[] | null> {
    if (!this.opts.embed) return null;
    const vec = await this.opts.embed(text);
    return vec && vec.length === this.opts.dimension ? vec : null;
  }

  private filterStream(f: { agent?: string; project?: string; since?: string }): Thought[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.agent) {
      where.push("agent = ?");
      params.push(f.agent);
    }
    if (f.project) {
      where.push("project = ?");
      params.push(f.project);
    }
    if (f.since) {
      where.push("created_at >= ?");
      params.push(f.since);
    }
    const sql = `SELECT * FROM thoughts ${
      where.length ? `WHERE ${where.join(" AND ")}` : ""
    } ORDER BY created_at DESC LIMIT 1000`;
    const rows = this.driver.prepare(sql).all(...params) as ThoughtRow[];
    return rows.map(rowToThought);
  }

  private vecSearch(vec: number[], k: number, opts: SearchOpts): Thought[] {
    try {
      const buf = Buffer.from(new Float32Array(vec).buffer);
      const rows = this.driver
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
    if (!this.caps.fts) {
      const like = `%${text.replace(/[%_]/g, "")}%`;
      const rows = this.driver
        .prepare(`SELECT * FROM thoughts WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`)
        .all(like, k) as ThoughtRow[];
      return applyPostFilters(rows, opts).slice(0, k).map(rowToThought);
    }
    const query = ftsEscape(text);
    try {
      const rows = this.driver
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
    if (opts.at) {
      const vf = r.valid_from ?? r.created_at;
      if (vf > opts.at) return false; // not yet valid
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
    ...(r.valid_to ? { valid_to: r.valid_to } : {}),
    meta: r.meta_json ? safeParse(r.meta_json) : undefined,
  };
}

function safeParse(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Merge results from multiple retrieval arms (multi-strategy recall).
 * Deduplicates by thought ID; arm order is the tie-break (vec, then fts,
 * then graph). Returns at most `k`.
 */
function mergeAndRank(arms: Thought[][], k: number): Thought[] {
  const seen = new Set<string>();
  const merged: Thought[] = [];
  for (const arm of arms) {
    for (const t of arm) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        merged.push(t);
      }
    }
  }
  return merged.slice(0, k);
}
