/**
 * vectorEngine.ts — sqlite-vec vector store for the AutoClaw Intelligence Layer.
 *
 * Owns the embedding persistence + semantic-search round-trip described by the
 * core-loop design (R3.1-R3.5, D11):
 *   - `initVectorDB` lazily requires `better-sqlite3` + `sqlite-vec`, opens (or
 *     creates) the `.autoclaw/vector/db.sqlite` database, loads the sqlite-vec
 *     extension, and provisions a `vec0` virtual table plus a `meta` row that
 *     records the active embedding model + dimension.
 *   - `storeEmbedding` writes a row under an `acquireLock(dbPath)` advisory lock.
 *   - `semanticVectorSearch` runs a KNN query, ranks by cosine similarity, filters
 *     by `minSimilarity` and the project namespace, and caps at `limit`.
 *
 * Degrade path (R3.1): the native backend (better-sqlite3 / sqlite-vec) is an
 * optionalDependency. If it cannot load or initialize, `initVectorDB` NEVER
 * throws — it returns a `degraded` handle whose `storeEmbedding` is a no-op and
 * whose `semanticVectorSearch` returns `[]`, and surfaces
 * "vector backend unavailable; using none/no-RAG" through the injected logger.
 *
 * No `vscode` import; no work or native require at module load time.
 */

import { DEFAULT_CONFIG } from './config';
import { LogFn } from './config';
import { EmbeddingSignature } from './types';
import { ensureDir } from './paths';
import { acquireLock } from './fileLock';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A record handed to {@link VectorDB.storeEmbedding}. */
export interface VectorRecord {
  /** Raw content the embedding was computed from. */
  content: string;
  /** The embedding vector. Length must match the DB dimension. */
  embedding: number[];
  /** Source Adapter id (or other provenance tag) that produced the content. */
  source: string;
  /** Resolved project namespace this record belongs to. */
  project: string;
  /** Arbitrary structured metadata, serialized as JSON on disk. */
  metadata?: Record<string, unknown>;
  /** Stable id. Generated when omitted. Re-storing the same id replaces it. */
  id?: string;
  /** Epoch-ms timestamp. Defaults to `Date.now()`. */
  timestamp?: number;
}

/** Options controlling {@link VectorDB.semanticVectorSearch}. */
export interface VectorSearchOptions {
  /** Max results to return. Defaults to `config.search.defaultLimit`. */
  limit?: number;
  /** Minimum cosine similarity (0..1) to keep. Defaults to
   *  `config.search.minSimilarity`. */
  minSimilarity?: number;
  /** Restrict results to a single project namespace (D11 isolation). */
  project?: string;
}

/** A ranked semantic-search hit. */
export interface VectorSearchResult {
  id: string;
  content: string;
  source: string;
  project: string;
  /** Cosine similarity in `[0, 1]` — higher is more similar. */
  score: number;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

/** Options controlling {@link VectorDB.storeEmbeddings}. */
export interface StoreEmbeddingsOptions {
  /**
   * Id prefixes to delete before inserting the batch, inside the same lock +
   * transaction. Used by codebase RAG to drop a file's stale chunks (whose ids
   * encode now-shifted line ranges) before re-inserting current ones, so the
   * index converges instead of accumulating orphans.
   */
  deleteIdPrefixes?: string[];
}

/** Filter for {@link VectorDB.listIds}. */
export interface ListIdsOptions {
  /** Restrict to a single project namespace. */
  project?: string;
  /** Restrict to a single source tag. */
  source?: string;
}

/** Options controlling {@link initVectorDB}. */
export interface InitVectorDBOptions {
  /**
   * Mark this open as part of a `--force` index rebuild. A forced rebuild
   * re-embeds the corpus with the active model, so it CLEARS any persisted
   * stale-index signal (see {@link VectorDB.staleIndex}). Without this flag a
   * model change only persists/raises the stale signal; it never clears it.
   */
  forceRebuild?: boolean;
}

/** The handle returned by {@link initVectorDB}. */
export interface VectorDB {
  /** True when the native backend could not load/initialize (no-op mode). */
  readonly degraded: boolean;
  /** Active embedding model recorded in the DB meta row. */
  readonly model: string;
  /** Vector dimension the store was provisioned with. */
  readonly dimension: number;
  /**
   * True when the store holds vectors produced by a previous embedding model
   * (a model change was detected and not yet resolved). The signal is persisted
   * in the DB meta, so it SURVIVES reopen and stays raised until a `--force`
   * index rebuild clears it — it is not a one-shot warning. Cosine scores across
   * a model boundary are meaningless, so a stale index should be rebuilt.
   */
  readonly staleIndex: boolean;
  /** Persist (or replace) one embedding record. No-op when degraded. */
  storeEmbedding(record: VectorRecord): Promise<void>;
  /**
   * Persist (or replace) many records under a SINGLE lock + transaction,
   * optionally deleting id prefixes first. Returns the number stored. No-op
   * (returns 0) when degraded.
   */
  storeEmbeddings(records: VectorRecord[], opts?: StoreEmbeddingsOptions): Promise<number>;
  /**
   * Delete every record whose id begins with `prefix`. Lock-protected. Returns
   * the number of rows removed (0 when degraded).
   */
  deleteByIdPrefix(prefix: string): Promise<number>;
  /** List stored record ids, optionally filtered by project/source. `[]` when degraded. */
  listIds(opts?: ListIdsOptions): Promise<string[]>;
  /** Semantic KNN search. Returns `[]` when degraded. */
  semanticVectorSearch(
    queryEmbedding: number[],
    opts?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]>;
  /** Release native resources. Safe to call when degraded. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VEC_TABLE = 'vec_items';
const DEGRADED_MSG = 'vector backend unavailable; using none/no-RAG';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Serialize a JS number[] into the little-endian float32 buffer sqlite-vec wants. */
function toFloat32Buffer(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

/** Generate a reasonably-unique id when a caller does not supply one. */
function generateId(): string {
  return `vec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Escape SQL LIKE wildcards so a prefix is matched literally (ESCAPE '\'). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function parseMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw === '' || raw === '{}') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — malformed metadata is dropped rather than thrown
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Degraded handle (no native backend)
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
    close(): void {
      // nothing to release
    },
  };
}

// ---------------------------------------------------------------------------
// Active handle (sqlite-vec backed)
// ---------------------------------------------------------------------------

class SqliteVectorDB implements VectorDB {
  readonly degraded = false;

  // Cached prepared statements (avoid re-preparing per chunk — R-perf).
  private readonly insertStmt: any;
  private readonly deleteByIdStmt: any;
  private readonly deleteByPrefixStmt: any;

  constructor(
    private readonly db: any,
    private readonly dbPath: string,
    readonly model: string,
    readonly dimension: number,
    readonly staleIndex: boolean,
    private readonly warn: LogFn,
  ) {
    this.insertStmt = db.prepare(
      `INSERT INTO ${VEC_TABLE} ` +
        `(id, embedding, source, project, content, timestamp, metadata) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.deleteByIdStmt = db.prepare(`DELETE FROM ${VEC_TABLE} WHERE id = ?`);
    this.deleteByPrefixStmt = db.prepare(
      `DELETE FROM ${VEC_TABLE} WHERE id LIKE ? ESCAPE '\\'`,
    );
  }

  async storeEmbedding(record: VectorRecord): Promise<void> {
    await this.storeEmbeddings([record]);
  }

  async storeEmbeddings(
    records: VectorRecord[],
    opts: StoreEmbeddingsOptions = {},
  ): Promise<number> {
    // Normalize + validate up front so the (synchronous) transaction below is
    // tight and never throws on a single bad record.
    const rows: Array<[string, Uint8Array, string, string, string, string, string]> = [];
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
      const metadataJson = record.metadata ? JSON.stringify(record.metadata) : '{}';
      rows.push([
        id,
        toFloat32Buffer(record.embedding),
        record.source,
        record.project,
        record.content,
        String(timestamp),
        metadataJson,
      ]);
    }

    const prefixes = (opts.deleteIdPrefixes ?? []).filter((p) => p && p.trim() !== '');
    if (rows.length === 0 && prefixes.length === 0) {
      return 0;
    }

    // All writes go through the foundation advisory lock (R3.4); batch the
    // deletes + inserts into one synchronous transaction under one lock.
    const release = await acquireLock(this.dbPath);
    try {
      const tx = this.db.transaction(() => {
        for (const prefix of prefixes) {
          this.deleteByPrefixStmt.run(`${escapeLike(prefix)}%`);
        }
        for (const row of rows) {
          // vec0 has no INSERT OR REPLACE; emulate upsert with delete + insert.
          this.deleteByIdStmt.run(row[0]);
          this.insertStmt.run(...row);
        }
      });
      tx();
    } finally {
      release();
    }
    return rows.length;
  }

  async deleteByIdPrefix(prefix: string): Promise<number> {
    if (!prefix || prefix.trim() === '') {
      return 0;
    }
    const release = await acquireLock(this.dbPath);
    try {
      const info = this.deleteByPrefixStmt.run(`${escapeLike(prefix)}%`);
      return typeof info?.changes === 'number' ? info.changes : 0;
    } catch (err) {
      this.warn(`vector: delete-by-prefix failed (${(err as Error).message})`);
      return 0;
    } finally {
      release();
    }
  }

  async listIds(opts: ListIdsOptions = {}): Promise<string[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.project) {
      where.push('project = ?');
      params.push(opts.project);
    }
    if (opts.source) {
      where.push('source = ?');
      params.push(opts.source);
    }
    const sql =
      `SELECT id FROM ${VEC_TABLE}` + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
    try {
      const rows: any[] = this.db.prepare(sql).all(...params);
      return rows.map((r) => String(r.id));
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

    const buffer = toFloat32Buffer(queryEmbedding);
    const projectFilter = opts.project ? ' AND project = ?' : '';
    const sql =
      `SELECT id, content, source, project, timestamp, metadata, distance ` +
      `FROM ${VEC_TABLE} ` +
      `WHERE embedding MATCH ?${projectFilter} AND k = ? ` +
      `ORDER BY distance`;

    const params: unknown[] = [buffer];
    if (opts.project) {
      params.push(opts.project);
    }
    params.push(limit);

    let rows: any[];
    try {
      rows = this.db.prepare(sql).all(...params);
    } catch (err) {
      this.warn(`vector: search failed (${(err as Error).message})`);
      return [];
    }

    const results: VectorSearchResult[] = [];
    for (const row of rows) {
      // sqlite-vec cosine distance is `1 - cosineSimilarity`; invert it.
      const score = 1 - Number(row.distance);
      if (!Number.isFinite(score) || score < minSimilarity) {
        continue;
      }
      const ts = Number(row.timestamp);
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
    try {
      this.db.close();
    } catch {
      // closing must never throw
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open (or create) the sqlite-vec database at `dbPath`, provision the schema,
 * and persist the active embedding signature. Never throws: on any native
 * load/init failure it returns a degraded no-op handle (R3.1).
 *
 * @param dbPath    forward-slash path to the `db.sqlite` file (see {@link import('./paths').intelligencePaths}).
 * @param signature the active embedding model + dimension.
 * @param log       optional warning sink (logger-injection convention).
 */
export async function initVectorDB(
  dbPath: string,
  signature: EmbeddingSignature,
  log?: LogFn,
  opts?: InitVectorDBOptions,
): Promise<VectorDB> {
  const warn: LogFn = log ?? (() => undefined);

  let db: any;
  try {
    // Lazy require — native modules are optionalDependencies (R3.1).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqliteVec = require('sqlite-vec');

    // Ensure the parent directory exists before opening the DB file.
    const slash = dbPath.replace(/\\/g, '/');
    const lastSlash = slash.lastIndexOf('/');
    if (lastSlash > 0) {
      await ensureDir(slash.slice(0, lastSlash));
    }

    db = new Database(dbPath);
    sqliteVec.load(db);

    // Concurrency hygiene (issue: KDream / parallel agents share `.autoclaw`).
    // WAL lets readers proceed while a writer holds the lock; busy_timeout makes
    // a contended open wait briefly instead of throwing SQLITE_BUSY immediately.
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
    } catch {
      // pragmas are best-effort — never fail init over them
    }

    // Meta table records the active embedding identity (model + dimension).
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

    // If a prior run provisioned the vec0 table, its dimension is fixed — adopt
    // the stored dimension so inserts/queries stay consistent (mismatch guard).
    const existingDim = readMetaNumber(db, 'dimension');
    let dimension = signature.dimension;
    if (existingDim !== undefined && existingDim !== signature.dimension) {
      warn(
        `vector: configured dimension ${signature.dimension} differs from stored ` +
          `${existingDim}; using stored dimension`,
      );
      dimension = existingDim;
    }

    // A model change at the SAME dimension is not caught by the dimension guard,
    // but vectors from different models share no geometry — cosine scores across
    // the boundary are meaningless. The warning alone is one-shot (the meta
    // `model` row is overwritten below), so we ALSO persist a `stale_index` flag
    // that survives reopen and keeps signalling until a `--force` rebuild clears
    // it. A forced rebuild re-embeds the corpus with the active model, so it is
    // the event that resolves the staleness.
    const existingModel = readMetaString(db, 'model');
    const modelChanged = existingModel !== undefined && existingModel !== signature.model;

    let staleIndex = readMetaString(db, 'stale_index') === '1';
    if (opts?.forceRebuild) {
      // Forced rebuild refreshes vectors with the active model — clear staleness.
      staleIndex = false;
    } else if (modelChanged) {
      // Mixed-geometry vectors now coexist — raise the persistent stale signal.
      staleIndex = true;
    }

    if (modelChanged) {
      warn(
        `vector: embedding model changed from "${existingModel}" to "${signature.model}"; ` +
          `existing vectors were produced by the old model and will not compare ` +
          `meaningfully — re-run /index-code --force (and /learn) to rebuild the index`,
      );
    } else if (staleIndex) {
      // Re-surface the persisted signal on every open until a --force rebuild.
      warn(
        `vector: index is STALE — it still holds vectors from a previous embedding ` +
          `model and cosine scores across that boundary are meaningless; ` +
          `re-run /index-code --force to rebuild the index`,
      );
    }

    // vec0 virtual table: cosine distance, project/source as filterable metadata
    // columns, content/timestamp/metadata as auxiliary (`+`) stored columns.
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimension}] distance_metric=cosine,\n` +
        `  source TEXT,\n` +
        `  project TEXT,\n` +
        `  +content TEXT,\n` +
        `  +timestamp TEXT,\n` +
        `  +metadata TEXT\n` +
        `)`,
    );

    const upsertMeta = db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`);
    upsertMeta.run('model', signature.model);
    upsertMeta.run('dimension', String(dimension));
    upsertMeta.run('stale_index', staleIndex ? '1' : '0');

    return new SqliteVectorDB(db, dbPath, signature.model, dimension, staleIndex, warn);
  } catch (err) {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    warn(`${DEGRADED_MSG} (${(err as Error).message})`);
    return degradedHandle(signature);
  }
}

function readMetaNumber(db: any, key: string): number | undefined {
  const raw = readMetaString(db, key);
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function readMetaString(db: any, key: string): string | undefined {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
    if (row && typeof row.value === 'string') {
      return row.value;
    }
  } catch {
    // meta table may not exist yet on a fresh DB
  }
  return undefined;
}
