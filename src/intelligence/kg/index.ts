/**
 * kg/index.ts — factory for the in-process Knowledge Graph.
 *
 * `openKnowledgeGraph` opens the ABI-proof SQLite driver (node:sqlite first,
 * better-sqlite3 fallback), provisions the KG schema, and wires the embedding
 * provider from the Intelligence config. It NEVER throws: if no SQLite driver
 * loads at all, it returns a `degraded` handle whose writes are no-ops and
 * whose reads return `[]` — mirroring `initVectorDB`'s degrade contract (R3.1)
 * so extension activation never fails over the KG.
 *
 * The always-available `none` embedding provider means a bare install (no
 * sqlite-vec, no transformers) still records and recalls thoughts via FTS5 —
 * the feature works out of the box, with vector search layering on silently
 * when sqlite-vec + a real embedding model are present.
 *
 * No `vscode` import; all native/core requires are lazy (inside the driver).
 */

import * as fs from "fs";
import * as path from "path";

import { loadConfig, type LogFn } from "../config";
import type { IntelligenceConfig } from "../types";
import { getEmbedding } from "../embeddings";
import { intelligencePaths } from "../paths";
import {
  openSqliteDriver,
  DEFAULT_DRIVER_ORDER,
  type SqliteDriver,
  type SqliteDriverKind,
} from "../vector/sqliteDriver";
import { createKgSchema } from "./schema";
import { KnowledgeGraphStore } from "./store";
import type { Edge, KgCapabilities, KnowledgeGraph, SearchOpts, Thought, ThoughtId } from "./types";

export interface OpenKgOptions {
  /** Workspace root containing `.autoclaw/`. Used to resolve the db path + config. */
  workspaceRoot?: string;
  /** Explicit db file path (overrides the `.autoclaw/kg/kg.db` default). */
  dbPath?: string;
  /** Pre-loaded config; loaded from the workspace when omitted. */
  config?: IntelligenceConfig;
  /** Warning sink for degrade/fallback messages. */
  log?: LogFn;
}

export interface KgHandle {
  /** The KnowledgeGraph API (real store, or a no-op when `degraded`). */
  kg: KnowledgeGraph;
  /** Realized backend capabilities. */
  caps: KgCapabilities;
  /** Which SQLite driver is live, or `null` when degraded. */
  driverKind: SqliteDriverKind | null;
  /** Active embedding provider + dimension (for health/doctor). */
  embedding: { provider: string; model: string; dimension: number };
  /** `true` when no SQLite driver loaded — writes no-op, reads return []. */
  degraded: boolean;
  /** Absolute db path in use (empty string when degraded). */
  dbPath: string;
  close(): void;
}

/**
 * The no-op KnowledgeGraph returned when no SQLite driver loads. Exported so the
 * degrade contract (writes no-op, reads return `[]`) can be asserted directly in
 * tests without needing to force a driver failure cross-platform.
 */
export const DEGRADED_KG: KnowledgeGraph = {
  async recordThought(): Promise<ThoughtId> {
    return ""; // no-op id
  },
  async recordRelation(): Promise<void> {
    /* no-op */
  },
  async searchSimilar(): Promise<Thought[]> {
    return [];
  },
  async traverseFrom(): Promise<Thought[]> {
    return [];
  },
  async forAgent(): Promise<Thought[]> {
    return [];
  },
  async forProject(): Promise<Thought[]> {
    return [];
  },
  async since(): Promise<Thought[]> {
    return [];
  },
  async thoughtsForTask(): Promise<Thought[]> {
    return [];
  },
  async edgesForNode(): Promise<Edge[]> {
    return [];
  },
  async allThoughts(): Promise<Thought[]> {
    return [];
  },
  async listEdges(): Promise<Edge[]> {
    return [];
  },
  // eslint-disable-next-line require-yield
  async *export(): AsyncIterable<string> {
    return;
  },
};

/**
 * Open (or create) the in-process Knowledge Graph. Never throws.
 */
export function openKnowledgeGraph(opts: OpenKgOptions = {}): KgHandle {
  const warn: LogFn = opts.log ?? (() => undefined);
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const config = opts.config ?? loadConfig(workspaceRoot, warn);
  const dbPath = opts.dbPath ?? intelligencePaths(workspaceRoot).kgDbPath;
  const dimension = config.embedding.dimension;
  const embeddingMeta = {
    provider: config.embedding.provider,
    model: config.embedding.model,
    dimension,
  };

  let driver: SqliteDriver;
  try {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    // requireVec:false — the KG runs FTS-only when sqlite-vec is absent.
    driver = openSqliteDriver(dbPath, warn, DEFAULT_DRIVER_ORDER, { requireVec: false });
  } catch (err) {
    warn(`kg: no sqlite driver available (${(err as Error).message}); knowledge graph degraded`);
    return {
      kg: DEGRADED_KG,
      caps: { sqlite: false, vec: false, fts: false },
      driverKind: null,
      embedding: embeddingMeta,
      degraded: true,
      dbPath: "",
      close: () => undefined,
    };
  }

  // Pragmas for a single-writer local store. node:sqlite + better-sqlite3 both
  // accept these via exec; ignore failures (e.g. a read-only FS).
  try {
    driver.exec("PRAGMA journal_mode = WAL;");
    driver.exec("PRAGMA synchronous = NORMAL;");
    driver.exec("PRAGMA foreign_keys = ON;");
  } catch {
    /* non-fatal */
  }

  const caps = createKgSchema(driver, dimension);

  const embed = async (text: string): Promise<number[] | null> => {
    try {
      return await getEmbedding(text, config.embedding, warn);
    } catch {
      return null;
    }
  };

  const store = new KnowledgeGraphStore(driver, caps, { dimension, embed });

  return {
    kg: store,
    caps,
    driverKind: driver.kind,
    embedding: embeddingMeta,
    degraded: false,
    dbPath,
    close: () => {
      try {
        driver.close();
      } catch {
        /* ignore */
      }
    },
  };
}

export type { KnowledgeGraph, SearchOpts, Thought, ThoughtId, KgCapabilities } from "./types";
export { KnowledgeGraphStore } from "./store";
