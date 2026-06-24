/**
 * vector/postgres.ts — PostgreSQL + pgvector vector store for the AutoClaw
 * Intelligence Layer (R1.1-R1.3). Selected by the `vector/index.ts` backend
 * factory when `config.backend === 'postgres'`.
 *
 * Implements the SAME {@link VectorDB} contract as the sqlite-vec backend, so
 * nothing above the vector layer changes when the backend is swapped — the
 * choice is purely config-driven (R1.2). On first use it provisions everything
 * it needs and is otherwise a drop-in for {@link import('./sqliteVec').initVectorDB}:
 *   - `CREATE EXTENSION IF NOT EXISTS vector`
 *   - an items table with a `vector(dim)` column, a `project` namespace column,
 *     and an ivfflat cosine index
 *   - a `meta` table recording the active embedding model + dimension
 *
 * Degrade path (R1.3): `pg` is an optionalDependency and the database may be
 * unreachable. `initPostgresDB` NEVER throws — a missing driver or a failed
 * connection yields a `degraded` handle whose `storeEmbedding` is a no-op and
 * whose `semanticVectorSearch` returns `[]`, surfaced through the injected
 * logger. The factory may then degrade further (postgres → sqlite-vec → none).
 *
 * Lock note: the foundation `acquireLock` guards `.autoclaw/` FILE writes. This
 * backend performs no `.autoclaw` writes — durability + atomicity come from
 * Postgres transactions (BEGIN/COMMIT) — so no advisory file lock is taken here.
 *
 * No `vscode` import; no native require at module load time.
 */

import { DEFAULT_CONFIG, LogFn } from '../config';
import { EmbeddingSignature } from '../types';
import {
  InitVectorDBOptions,
  ListIdsOptions,
  StoreEmbeddingsOptions,
  VectorDB,
  VectorRecord,
  VectorSearchOptions,
  VectorSearchResult,
} from './sqliteVec';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ITEMS_TABLE = 'vec_items';
const META_TABLE = 'vec_meta';
const DEGRADED_MSG = 'vector backend unavailable; using none/no-RAG';

// ---------------------------------------------------------------------------
// Minimal structural type for the `pg` client we rely on (avoids a type dep).
// ---------------------------------------------------------------------------

interface PgQueryResult {
  rows: any[];
  rowCount: number | null;
}

interface PgClient {
  query(text: string, params?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Format a JS number[] as the pgvector text literal `[1,2,3]`. */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/** Generate a reasonably-unique id when a caller does not supply one. */
function generateId(): string {
  return `vec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Escape SQL LIKE wildcards so a prefix is matched literally (ESCAPE '\'). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Coerce a stored metadata value (JSONB object or JSON string) to an object. */
function parseMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string' && raw !== '' && raw !== '{}') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // malformed metadata is dropped rather than thrown
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Degraded handle (no driver / unreachable DB)
// ---------------------------------------------------------------------------

function degradedHandle(signature: EmbeddingSignature): VectorDB {
  return {
    degraded: true,
    model: signature.model,
    dimension: signature.dimension,
    staleIndex: false,
    async storeEmbedding(): Promise<void> {
      // no-op — nothing to persist without a backend
    },
    async storeEmbeddings(): Promise<number> {
      return 0;
    },
    async deleteByIdPrefix(): Promise<number> {
      return 0;
    },
    async listIds(): Promise<string[]> {
      return [];
    },
    async semanticVectorSearch(): Promise<VectorSearchResult[]> {
      return [];
    },
    async setStale(): Promise<void> {
      // no-op — nothing to persist without a backend
    },
    close(): void {
      // nothing to release
    },
  };
}

// ---------------------------------------------------------------------------
// Active handle (pgvector backed)
// ---------------------------------------------------------------------------

class PostgresVectorDB implements VectorDB {
  readonly degraded = false;

  // Live stale signal — mutable so {@link setStale} keeps it honest after open.
  private _staleIndex: boolean;

  constructor(
    private readonly client: PgClient,
    readonly model: string,
    readonly dimension: number,
    staleIndex: boolean,
    private readonly warn: LogFn,
  ) {
    this._staleIndex = staleIndex;
  }

  get staleIndex(): boolean {
    return this._staleIndex;
  }

  async setStale(stale: boolean): Promise<void> {
    try {
      await this.client.query(
        `INSERT INTO ${META_TABLE} (key, value) VALUES ($1, $2) ` +
          `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        ['stale_index', stale ? '1' : '0'],
      );
      this._staleIndex = stale;
    } catch (err) {
      this.warn(`vector: could not persist stale_index flag: ${(err as Error).message}`);
    }
  }

  async storeEmbedding(record: VectorRecord): Promise<void> {
    await this.storeEmbeddings([record]);
  }

  async storeEmbeddings(
    records: VectorRecord[],
    opts: StoreEmbeddingsOptions = {},
  ): Promise<number> {
    // Normalize + validate up front so the transaction below stays tight and
    // never aborts on a single bad record (mirrors the sqlite-vec backend).
    const rows: Array<{
      id: string;
      embedding: string;
      source: string;
      project: string;
      content: string;
      timestamp: number;
      metadata: string;
    }> = [];
    for (const record of records) {
      if (!Array.isArray(record.embedding) || record.embedding.length !== this.dimension) {
        this.warn(
          `vector: skipping store — embedding length ${record.embedding?.length ?? 0} ` +
            `does not match dimension ${this.dimension}`,
        );
        continue;
      }
      const id = record.id && record.id.trim() !== '' ? record.id : generateId();
      const timestamp =
        typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
          ? record.timestamp
          : Date.now();
      rows.push({
        id,
        embedding: toVectorLiteral(record.embedding),
        source: record.source,
        project: record.project,
        content: record.content,
        timestamp,
        metadata: record.metadata ? JSON.stringify(record.metadata) : '{}',
      });
    }

    const prefixes = (opts.deleteIdPrefixes ?? []).filter((p) => p && p.trim() !== '');
    if (rows.length === 0 && prefixes.length === 0) {
      return 0;
    }

    // One transaction for the whole batch: delete the stale prefixes, then
    // upsert each row. Postgres gives us atomicity without a file lock.
    try {
      await this.client.query('BEGIN');
      for (const prefix of prefixes) {
        await this.client.query(
          `DELETE FROM ${ITEMS_TABLE} WHERE id LIKE $1 ESCAPE '\\'`,
          [`${escapeLike(prefix)}%`],
        );
      }
      for (const row of rows) {
        await this.client.query(
          `INSERT INTO ${ITEMS_TABLE} ` +
            `(id, embedding, source, project, content, ts, metadata) ` +
            `VALUES ($1, $2::vector, $3, $4, $5, $6, $7::jsonb) ` +
            `ON CONFLICT (id) DO UPDATE SET ` +
            `embedding = EXCLUDED.embedding, source = EXCLUDED.source, ` +
            `project = EXCLUDED.project, content = EXCLUDED.content, ` +
            `ts = EXCLUDED.ts, metadata = EXCLUDED.metadata`,
          [
            row.id,
            row.embedding,
            row.source,
            row.project,
            row.content,
            row.timestamp,
            row.metadata,
          ],
        );
      }
      await this.client.query('COMMIT');
      return rows.length;
    } catch (err) {
      try {
        await this.client.query('ROLLBACK');
      } catch {
        // rollback best-effort
      }
      this.warn(`vector: store failed (${(err as Error).message})`);
      return 0;
    }
  }

  async deleteByIdPrefix(prefix: string): Promise<number> {
    if (!prefix || prefix.trim() === '') {
      return 0;
    }
    try {
      const res = await this.client.query(
        `DELETE FROM ${ITEMS_TABLE} WHERE id LIKE $1 ESCAPE '\\'`,
        [`${escapeLike(prefix)}%`],
      );
      return typeof res.rowCount === 'number' ? res.rowCount : 0;
    } catch (err) {
      this.warn(`vector: delete-by-prefix failed (${(err as Error).message})`);
      return 0;
    }
  }

  async listIds(opts: ListIdsOptions = {}): Promise<string[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.project) {
      params.push(opts.project);
      where.push(`project = $${params.length}`);
    }
    if (opts.source) {
      params.push(opts.source);
      where.push(`source = $${params.length}`);
    }
    const sql =
      `SELECT id FROM ${ITEMS_TABLE}` + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
    try {
      const res = await this.client.query(sql, params);
      return res.rows.map((r) => String(r.id));
    } catch (err) {
      this.warn(`vector: listIds failed (${(err as Error).message})`);
      return [];
    }
  }

  async semanticVectorSearch(
    queryEmbedding: number[],
    opts: VectorSearchOptions = {},
  ): Promise<VectorSearchResult[]> {
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length !== this.dimension) {
      this.warn(
        `vector: search skipped — query length ${queryEmbedding?.length ?? 0} ` +
          `does not match dimension ${this.dimension}`,
      );
      return [];
    }

    const limit =
      typeof opts.limit === 'number' && opts.limit > 0
        ? Math.floor(opts.limit)
        : DEFAULT_CONFIG.search.defaultLimit;
    const minSimilarity =
      typeof opts.minSimilarity === 'number'
        ? opts.minSimilarity
        : DEFAULT_CONFIG.search.minSimilarity;

    const queryLiteral = toVectorLiteral(queryEmbedding);
    const params: unknown[] = [queryLiteral];
    let projectFilter = '';
    if (opts.project) {
      params.push(opts.project);
      projectFilter = ` WHERE project = $${params.length}`;
    }
    params.push(limit);
    const limitParam = `$${params.length}`;

    // `<=>` is pgvector's cosine DISTANCE; similarity = 1 - distance. The
    // ivfflat cosine index serves the ORDER BY.
    const sql =
      `SELECT id, content, source, project, ts, metadata, ` +
      `(embedding <=> $1::vector) AS distance ` +
      `FROM ${ITEMS_TABLE}${projectFilter} ` +
      `ORDER BY embedding <=> $1::vector ` +
      `LIMIT ${limitParam}`;

    let rows: any[];
    try {
      const res = await this.client.query(sql, params);
      rows = res.rows;
    } catch (err) {
      this.warn(`vector: search failed (${(err as Error).message})`);
      return [];
    }

    const results: VectorSearchResult[] = [];
    for (const row of rows) {
      const score = 1 - Number(row.distance);
      if (!Number.isFinite(score) || score < minSimilarity) {
        continue;
      }
      const ts = Number(row.ts);
      results.push({
        id: String(row.id),
        content: String(row.content ?? ''),
        source: String(row.source ?? ''),
        project: String(row.project ?? ''),
        score,
        metadata: parseMetadata(row.metadata),
        timestamp: Number.isFinite(ts) ? ts : undefined,
      });
    }
    return results;
  }

  close(): void {
    // pg's `end()` is async; fire-and-forget so `close()` matches the sync
    // VectorDB contract and never throws.
    void this.client.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Schema provisioning + meta reconciliation
// ---------------------------------------------------------------------------

async function readMetaString(client: PgClient, key: string): Promise<string | undefined> {
  try {
    const res = await client.query(`SELECT value FROM ${META_TABLE} WHERE key = $1`, [key]);
    const row = res.rows[0];
    if (row && typeof row.value === 'string') {
      return row.value;
    }
  } catch {
    // meta table may not exist yet on a fresh database
  }
  return undefined;
}

function asNumber(raw: string | undefined): number | undefined {
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Options accepted by {@link initPostgresDB} (extends the shared init options). */
export interface InitPostgresDBOptions extends InitVectorDBOptions {
  /**
   * Test seam: supply a pre-built `pg`-compatible client instead of connecting
   * via `connectionString`. When provided the lazy `require('pg')` is skipped.
   */
  client?: PgClient;
}

/**
 * Open (or create) the pgvector store reachable at `connectionString`, provision
 * the extension/table/index/meta, and persist the active embedding signature.
 * Mirrors {@link import('./sqliteVec').initVectorDB}'s signature so the backend
 * factory can stay backend-agnostic. NEVER throws: a missing `pg` driver or a
 * failed connection returns a degraded no-op handle (R1.3).
 *
 * @param connectionString libpq connection string (`config.postgres.connectionString`).
 * @param signature        the active embedding model + dimension.
 * @param log              optional warning sink (logger-injection convention).
 * @param opts             init options; `forceRebuild` clears the stale-index signal.
 */
export async function initPostgresDB(
  connectionString: string,
  signature: EmbeddingSignature,
  log?: LogFn,
  opts?: InitPostgresDBOptions,
): Promise<VectorDB> {
  const warn: LogFn = log ?? (() => undefined);

  let client: PgClient | undefined = opts?.client;
  try {
    if (!client) {
      // Lazy require — `pg` is an optionalDependency (R1.3). Importing this
      // module never loads it.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pg = require('pg');
      const c = new pg.Client({ connectionString });
      await c.connect();
      client = c as PgClient;
    }

    // pgvector extension — no-op if already installed.
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Meta table records the active embedding identity (model + dimension).
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`,
    );

    // If a prior run fixed the vector column's dimension, adopt the stored value
    // so inserts/queries stay consistent (the dimension guard handles the swap).
    const existingDim = asNumber(await readMetaString(client, 'dimension'));
    let dimension = signature.dimension;
    if (existingDim !== undefined && existingDim !== signature.dimension) {
      warn(
        `vector: configured dimension ${signature.dimension} differs from stored ` +
          `${existingDim}; using stored dimension`,
      );
      dimension = existingDim;
    }

    // A model change at the SAME dimension is not caught by the dimension guard,
    // but mixed-model vectors do not compare meaningfully — persist a stale-index
    // signal that survives reconnect until a `--force` rebuild clears it.
    const existingModel = await readMetaString(client, 'model');
    const modelChanged = existingModel !== undefined && existingModel !== signature.model;

    let staleIndex = (await readMetaString(client, 'stale_index')) === '1';
    if (opts?.forceRebuild) {
      staleIndex = false;
    } else if (modelChanged) {
      staleIndex = true;
    }

    if (modelChanged) {
      warn(
        `vector: embedding model changed from "${existingModel}" to "${signature.model}"; ` +
          `existing vectors were produced by the old model and will not compare ` +
          `meaningfully — re-run /index-code --force (and /learn) to rebuild the index`,
      );
    } else if (staleIndex) {
      warn(
        `vector: index is STALE — it still holds vectors from a previous embedding ` +
          `model and cosine scores across that boundary are meaningless; ` +
          `re-run /index-code --force to rebuild the index`,
      );
    }

    // Items table: vector(dim) embedding, project/source filter columns, content/
    // ts/metadata payload. Dimension is fixed at creation (mirrors vec0).
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${ITEMS_TABLE} (\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding vector(${dimension}),\n` +
        `  source TEXT,\n` +
        `  project TEXT,\n` +
        `  content TEXT,\n` +
        `  ts BIGINT,\n` +
        `  metadata JSONB\n` +
        `)`,
    );

    // ivfflat cosine index for ANN search; project index for namespace filtering.
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${ITEMS_TABLE}_embedding_idx ` +
        `ON ${ITEMS_TABLE} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${ITEMS_TABLE}_project_idx ON ${ITEMS_TABLE} (project)`,
    );

    // Persist the active signature + stale signal.
    await client.query(
      `INSERT INTO ${META_TABLE} (key, value) VALUES ($1, $2) ` +
        `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['model', signature.model],
    );
    await client.query(
      `INSERT INTO ${META_TABLE} (key, value) VALUES ($1, $2) ` +
        `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['dimension', String(dimension)],
    );
    await client.query(
      `INSERT INTO ${META_TABLE} (key, value) VALUES ($1, $2) ` +
        `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['stale_index', staleIndex ? '1' : '0'],
    );

    return new PostgresVectorDB(client, signature.model, dimension, staleIndex, warn);
  } catch (err) {
    if (client) {
      try {
        await client.end();
      } catch {
        // ignore — already failing
      }
    }
    warn(`${DEGRADED_MSG} (${(err as Error).message})`);
    return degradedHandle(signature);
  }
}
