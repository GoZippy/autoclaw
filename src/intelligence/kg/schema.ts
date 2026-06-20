/**
 * kg/schema.ts — DDL for the in-process Knowledge Graph store.
 *
 * Ported from `packages/kg-daemon/src/db.ts`'s `createSchema`, adapted to the
 * driver-agnostic {@link SqliteDriver} surface (prepare/exec only — no
 * better-sqlite3 `.pragma()`). Because this store is greenfield (a fresh
 * `.autoclaw/kg/kg.db`, no legacy databases), the bi-temporal `valid_from` /
 * `valid_to` columns are defined up front rather than ALTER-migrated.
 *
 * The `vec0` virtual table dimension is bound to the active embedding
 * dimension so rows written by the configured provider (incl. the always-on
 * `none` provider) can be indexed. FTS5 is feature-detected; vec0 is only
 * attempted when the driver actually loaded the sqlite-vec extension.
 */

import type { SqliteDriver } from "../vector/sqliteDriver";
import type { KgCapabilities } from "./types";

/**
 * Provision (idempotently) the KG schema on `driver`. Returns the realized
 * capabilities — `fts`/`vec` reflect what actually succeeded in this runtime.
 *
 * @param dimension embedding dimension for the `vec0` table (e.g. 768).
 */
export function createKgSchema(driver: SqliteDriver, dimension: number): KgCapabilities {
  const caps: KgCapabilities = { sqlite: true, vec: false, fts: false };

  // Core thoughts table (bi-temporal columns inline — greenfield).
  driver.exec(`
    CREATE TABLE IF NOT EXISTS thoughts (
      id          TEXT PRIMARY KEY,
      project     TEXT NOT NULL,
      agent       TEXT NOT NULL,
      sprint      TEXT,
      task_id     TEXT,
      kind        TEXT NOT NULL,
      text        TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      meta_json   TEXT,
      has_embed   INTEGER NOT NULL DEFAULT 0,
      valid_from  TEXT,
      valid_to    TEXT
    );
    CREATE INDEX IF NOT EXISTS thoughts_project_created ON thoughts(project, created_at DESC);
    CREATE INDEX IF NOT EXISTS thoughts_agent_created   ON thoughts(agent, created_at DESC);
    CREATE INDEX IF NOT EXISTS thoughts_created         ON thoughts(created_at DESC);
    CREATE INDEX IF NOT EXISTS thoughts_valid_from      ON thoughts(valid_from);
    CREATE INDEX IF NOT EXISTS thoughts_valid_to        ON thoughts(valid_to);
  `);

  // Edges table — graph half of the KG.
  driver.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      from_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      to_id      TEXT NOT NULL,
      meta_json  TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (from_id, kind, to_id)
    );
    CREATE INDEX IF NOT EXISTS edges_from_kind ON edges(from_id, kind);
    CREATE INDEX IF NOT EXISTS edges_to        ON edges(to_id);
  `);

  // FTS5 virtual table + sync triggers. Feature-detected: a SQLite built
  // without FTS5 leaves caps.fts === false and search degrades to LIKE.
  try {
    driver.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_fts USING fts5(
        text,
        content='thoughts',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);
    driver.exec(`
      CREATE TRIGGER IF NOT EXISTS thoughts_ai AFTER INSERT ON thoughts BEGIN
        INSERT INTO thoughts_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS thoughts_ad AFTER DELETE ON thoughts BEGIN
        INSERT INTO thoughts_fts(thoughts_fts, rowid, text)
          VALUES('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS thoughts_au AFTER UPDATE ON thoughts BEGIN
        INSERT INTO thoughts_fts(thoughts_fts, rowid, text)
          VALUES('delete', old.rowid, old.text);
        INSERT INTO thoughts_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
    caps.fts = true;
  } catch {
    caps.fts = false;
  }

  // Optional vec0 virtual table — only when sqlite-vec actually loaded.
  if (driver.vecLoaded && dimension > 0) {
    try {
      driver.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_vec USING vec0(
          embedding float[${Math.floor(dimension)}]
        );
      `);
      caps.vec = true;
    } catch {
      caps.vec = false;
    }
  }

  return caps;
}
