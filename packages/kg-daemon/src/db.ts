/**
 * SQLite setup for the KG daemon.
 *
 * - WAL mode for concurrent readers + one writer (the daemon itself).
 * - FTS5 virtual table on `thoughts.text` (kept in sync via triggers).
 * - Optional `sqlite-vec` virtual table for embeddings — if the
 *   extension fails to load, we mark `vec=false` and the rest of the
 *   server falls back to FTS-only.
 * - Idempotent: `init()` is safe to call against an existing file.
 */

import { createRequire } from "node:module";
import Database from "better-sqlite3";
import type { Database as SqliteDb } from "better-sqlite3";
import type { Capabilities } from "./types.js";

const require = createRequire(import.meta.url);

export interface DbHandle {
  db: SqliteDb;
  caps: Capabilities;
  close(): void;
}

const EMBED_DIM = 768; // ZippyMesh default; rows with other dims skip vec0

export function openDb(path: string): DbHandle {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  const caps: Capabilities = { sqlite: true, vec: false, fts: false };

  // Try sqlite-vec. It's an optional dependency — the server keeps
  // running on FTS only if the load fails (missing native binary,
  // ABI mismatch, etc.).
  try {
    // Use createRequire so a missing optional module doesn't break ESM
    // import resolution at startup.
    const sqliteVec = require("sqlite-vec") as { load: (db: SqliteDb) => void };
    sqliteVec.load(db);
    caps.vec = true;
  } catch {
    caps.vec = false;
  }

  createSchema(db, caps);
  return {
    db,
    caps,
    close: () => {
      try { db.close(); } catch { /* ignore */ }
    },
  };
}

function createSchema(db: SqliteDb, caps: Capabilities): void {
  // Core thoughts table.
  db.exec(`
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
      has_embed   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS thoughts_project_created
      ON thoughts(project, created_at DESC);
    CREATE INDEX IF NOT EXISTS thoughts_agent_created
      ON thoughts(agent, created_at DESC);
    CREATE INDEX IF NOT EXISTS thoughts_created
      ON thoughts(created_at DESC);
  `);

  // Bi-temporal validity migration (Graphiti-inspired Phase 4 feature).
  // `valid_from` / `valid_to` record the assertion window so agents can
  // query "what did the fleet believe at sprint N" via ?at=<ISO>.
  // Migration is additive (ALTER TABLE IF column doesn't exist).
  const cols = (db.pragma("table_info(thoughts)") as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('valid_from')) {
    db.exec(`ALTER TABLE thoughts ADD COLUMN valid_from TEXT`);
  }
  if (!cols.includes('valid_to')) {
    db.exec(`ALTER TABLE thoughts ADD COLUMN valid_to   TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS thoughts_valid_from ON thoughts(valid_from);
    CREATE INDEX IF NOT EXISTS thoughts_valid_to   ON thoughts(valid_to);
  `);

  // Edges table — graph half of Tier 1.
  db.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      from_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      to_id      TEXT NOT NULL,
      meta_json  TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (from_id, kind, to_id)
    );
    CREATE INDEX IF NOT EXISTS edges_from_kind ON edges(from_id, kind);
    CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id);
  `);

  // FTS5 virtual table. SQLite ships with FTS5 by default in
  // better-sqlite3 prebuilds; we still feature-detect.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_fts USING fts5(
        text,
        content='thoughts',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);
    // Triggers to keep FTS in sync. CREATE TRIGGER IF NOT EXISTS is
    // supported since SQLite 3.8.0; safe everywhere we run.
    db.exec(`
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

  // Optional vec0 virtual table.
  if (caps.vec) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_vec USING vec0(
          embedding float[${EMBED_DIM}]
        );
      `);
    } catch {
      // If creating the virtual table fails (older sqlite-vec, etc.)
      // disable vec capability — FTS still works.
      caps.vec = false;
    }
  }
}

export const EMBEDDING_DIM = EMBED_DIM;
