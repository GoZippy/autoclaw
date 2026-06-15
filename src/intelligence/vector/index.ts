/**
 * vector/index.ts — vector backend factory for the AutoClaw Intelligence Layer.
 *
 * Selects a concrete {@link VectorDB} implementation purely from
 * `config.backend` (D5 default `sqlite-vec`). Every backend implements the
 * identical `VectorDB` contract core-loop already depends on, so nothing above
 * the vector layer changes when a backend is swapped (Phase 4 goal).
 *
 * Backends:
 *   - `sqlite-vec` (default) → {@link ./sqliteVec} (the relocated core-loop store).
 *   - `postgres`  → {@link ./postgres} (pgvector), added by intelligence-backend-flexibility.
 *
 * `getBackendInitializer` never throws: an unknown/unavailable backend degrades
 * to the always-safe sqlite-vec initializer, which itself degrades to a no-op
 * handle when the native stack is absent (R3.1).
 *
 * No `vscode` import; no work at module load.
 */

import { IntelligenceConfig, EmbeddingSignature } from '../types';
import { LogFn } from '../config';
import {
  VectorDB,
  InitVectorDBOptions,
  initVectorDB as initSqliteVecDB,
} from './sqliteVec';
import { initPostgresDB } from './postgres';

/**
 * A backend initializer: open (or create) the vector store for the given
 * embedding signature and return a {@link VectorDB} handle. Mirrors
 * {@link initVectorDB} so callers can stay backend-agnostic.
 */
export type InitVectorDB = (
  dbPath: string,
  signature: EmbeddingSignature,
  log?: LogFn,
  opts?: InitVectorDBOptions,
) => Promise<VectorDB>;

/**
 * Resolve the vector backend initializer for the active configuration. The
 * Postgres backend is wired in by intelligence-backend-flexibility; until then
 * any non-`sqlite-vec` selection falls back to sqlite-vec with a warning.
 */
export function getBackendInitializer(cfg: IntelligenceConfig, log?: LogFn): InitVectorDB {
  const warn: LogFn = log ?? (() => undefined);
  switch (cfg.backend) {
    case 'sqlite-vec':
      return initSqliteVecDB;
    case 'postgres': {
      const connectionString = cfg.postgres?.connectionString;
      if (!connectionString) {
        warn(
          'vector: backend "postgres" selected but no postgres.connectionString set; using sqlite-vec',
        );
        return initSqliteVecDB;
      }
      // The first arg of InitVectorDB is the sqlite dbPath; the postgres backend
      // ignores it and connects via the configured connection string.
      // initPostgresDB self-degrades to a no-op handle on driver/connection
      // failure (R1.3), so activation never fails over a backend choice.
      return (_dbPath, signature, logFn, opts) =>
        initPostgresDB(connectionString, signature, logFn ?? warn, opts);
    }
    default:
      warn(`vector: unknown backend "${String(cfg.backend)}"; using sqlite-vec`);
      return initSqliteVecDB;
  }
}

/**
 * Convenience wrapper: select the backend from `cfg` and open the store in one
 * call. Equivalent to `getBackendInitializer(cfg)(dbPath, signature, log, opts)`.
 */
export function initVectorBackend(
  cfg: IntelligenceConfig,
  dbPath: string,
  signature: EmbeddingSignature,
  log?: LogFn,
  opts?: InitVectorDBOptions,
): Promise<VectorDB> {
  return getBackendInitializer(cfg, log)(dbPath, signature, log, opts);
}

// Re-export the store contract + the sqlite-vec initializer so consumers can
// import everything vector-related from `./vector`.
export * from './sqliteVec';
export { initPostgresDB, InitPostgresDBOptions } from './postgres';
