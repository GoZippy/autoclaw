/**
 * vector/sqliteDriver.ts — ABI-proof SQLite driver selection for the sqlite-vec
 * vector store.
 *
 * Why this exists:
 *   The vector store needs SQLite + the `sqlite-vec` (`vec0`) loadable extension.
 *   Historically it opened the database with `better-sqlite3`, a NATIVE Node
 *   addon whose compiled binary must match the host's exact ABI
 *   (NODE_MODULE_VERSION). Inside VS Code the host is Electron, which carries its
 *   own ABI — so every Electron bump in an IDE update could break the binary and
 *   silently degrade the layer to no-RAG.
 *
 *   This module removes that fragility by preferring **`node:sqlite`**, a Node
 *   CORE module (>= 22.5, unflagged in Node 24 / Electron >= ~30). Being part of
 *   Node core, it is ABI-stable — there is no addon to rebuild, ever — so it
 *   survives IDE/Electron updates. `better-sqlite3` is kept as a FALLBACK for
 *   older hosts. The `sqlite-vec` extension is a loadable `.dll`/`.so`/`.dylib`
 *   loaded by SQLite itself, so it is ABI-independent and shared by both drivers.
 *
 * Both drivers are normalized behind {@link SqliteDriver} so the store
 * ({@link import('./sqliteVec').initVectorDB}) is driver-agnostic. The only
 * API differences papered over here are: open + extension-load, `PRAGMA` (via
 * `exec`), and transactions (`better-sqlite3` has `.transaction()`; `node:sqlite`
 * uses explicit BEGIN/COMMIT/ROLLBACK).
 *
 * No `vscode` import; no native/core require at module load time (all lazy).
 */

import { LogFn } from '../config';
import { NATIVE_COMPAT } from './nativeCompat';

/** Concrete SQLite driver backing the sqlite-vec store. */
export type SqliteDriverKind = 'node-sqlite' | 'better-sqlite3';

/** The subset of a prepared-statement API the store relies on. */
export interface SqliteStatement {
  run(...params: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

/** Normalized handle over `node:sqlite` / `better-sqlite3`. */
export interface SqliteDriver {
  readonly kind: SqliteDriverKind;
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /** Run `fn` inside a single transaction (commit on return, rollback on throw). */
  transaction(fn: () => void): void;
  close(): void;
}

/**
 * Driver preference order. `node:sqlite` first — it is ABI-proof and needs no
 * rebuild — then the native `better-sqlite3` fallback for older hosts.
 */
export const DEFAULT_DRIVER_ORDER: readonly SqliteDriverKind[] = ['node-sqlite', 'better-sqlite3'];

/** Resolve the `sqlite-vec` loadable-extension path (lazy require). */
function sqliteVecLoadablePath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sqliteVec = require('sqlite-vec');
  return sqliteVec.getLoadablePath();
}

/** Open `dbPath` with `node:sqlite` and load the sqlite-vec extension. */
function openNodeSqlite(dbPath: string): SqliteDriver {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite');
  const extPath = sqliteVecLoadablePath();
  // `allowExtension` must be set at construction for enableLoadExtension to work.
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  try {
    db.enableLoadExtension(true);
    db.loadExtension(extPath);
    // Re-lock extension loading now that the one extension we need is in.
    db.enableLoadExtension(false);
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore — surfacing the original error matters more
    }
    throw err;
  }
  return {
    kind: 'node-sqlite',
    prepare: (sql: string) => db.prepare(sql) as SqliteStatement,
    exec: (sql: string) => {
      db.exec(sql);
    },
    transaction: (fn: () => void) => {
      db.exec('BEGIN');
      try {
        fn();
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore — original error propagates
        }
        throw err;
      }
    },
    close: () => {
      db.close();
    },
  };
}

/** Open `dbPath` with the native `better-sqlite3` fallback + sqlite-vec. */
function openBetterSqlite(dbPath: string): SqliteDriver {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sqliteVec = require('sqlite-vec');
  const db = new Database(dbPath);
  try {
    sqliteVec.load(db);
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore
    }
    throw err;
  }
  return {
    kind: 'better-sqlite3',
    prepare: (sql: string) => db.prepare(sql) as SqliteStatement,
    exec: (sql: string) => {
      db.exec(sql);
    },
    transaction: (fn: () => void) => {
      db.transaction(fn)();
    },
    close: () => {
      db.close();
    },
  };
}

function openByKind(kind: SqliteDriverKind, dbPath: string): SqliteDriver {
  return kind === 'node-sqlite' ? openNodeSqlite(dbPath) : openBetterSqlite(dbPath);
}

/**
 * Open the first working SQLite driver for `dbPath` (with the sqlite-vec
 * extension loaded), trying `order` in sequence and `warn`-ing each miss.
 *
 * Throws only if EVERY candidate fails — the caller ({@link initVectorDB}) turns
 * that into the degraded no-op handle, so activation never fails over a driver.
 */
export function openSqliteDriver(
  dbPath: string,
  warn: LogFn,
  order: readonly SqliteDriverKind[] = DEFAULT_DRIVER_ORDER,
): SqliteDriver {
  let lastErr: unknown;
  for (const kind of order) {
    try {
      return openByKind(kind, dbPath);
    } catch (err) {
      lastErr = err;
      warn(`vector: sqlite driver "${kind}" unavailable (${(err as Error).message})`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('no usable sqlite driver');
}

// ---------------------------------------------------------------------------
// Preflight detection ("detect mismatches in the future")
// ---------------------------------------------------------------------------

/** Result of exercising one driver end-to-end. */
export interface DriverProbe {
  kind: SqliteDriverKind;
  available: boolean;
  error?: string;
}

/**
 * Exercise a driver exactly the way the store does — open an in-memory DB, load
 * the sqlite-vec extension, create a `vec0` table — so an ABI mismatch or a
 * missing module is caught here rather than at first write. Never throws.
 */
export function probeDriver(kind: SqliteDriverKind): DriverProbe {
  try {
    const db = openByKind(kind, ':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS _probe_vec USING vec0(embedding float[4])');
    } finally {
      db.close();
    }
    return { kind, available: true };
  } catch (err) {
    return { kind, available: false, error: (err as Error).message };
  }
}

/** Structured health of the vector backend in the current runtime. */
export interface VectorBackendPreflight {
  runtime: { node: string; modules: string; electron: string | null };
  drivers: DriverProbe[];
  /** The driver that would actually be used, or `none` if all failed. */
  active: SqliteDriverKind | 'none';
  /** True when at least one driver loads (RAG works). */
  healthy: boolean;
  /** True when the active driver is the ABI-proof `node:sqlite`. */
  abiProof: boolean;
  /** Actionable next step when not healthy, or only the fragile fallback loads. */
  remediation: string | null;
}

/**
 * Probe every candidate driver and summarise the vector backend's health for the
 * doctor / activation log. This is the "detect mismatch" hook: it reports which
 * driver is live and whether it is the ABI-fragile one, with an actionable
 * remediation — instead of silently degrading.
 */
export function vectorBackendPreflight(
  order: readonly SqliteDriverKind[] = DEFAULT_DRIVER_ORDER,
): VectorBackendPreflight {
  const drivers = order.map(probeDriver);
  const active = drivers.find((p) => p.available)?.kind ?? 'none';
  const healthy = active !== 'none';
  const abiProof = active === 'node-sqlite';

  let remediation: string | null = null;
  if (!healthy) {
    remediation =
      `No SQLite vector driver loaded. node:sqlite needs Node >= ` +
      `${NATIVE_COMPAT.nodeSqlite.minNodeVersion} (this host runs ${process.version}); ` +
      `the better-sqlite3 fallback must match the host ABI — rebuild it with ` +
      `\`npm run rebuild:native\`.`;
  } else if (!abiProof) {
    remediation =
      `Vector backend is using the native better-sqlite3 fallback, which is ABI-bound ` +
      `and can break on an IDE/Electron update. node:sqlite (ABI-proof) was not ` +
      `available here — upgrade the host to Node >= ${NATIVE_COMPAT.nodeSqlite.minNodeVersion}.`;
  }

  return {
    runtime: {
      node: process.version,
      modules: process.versions.modules,
      electron: process.versions.electron ?? null,
    },
    drivers,
    active,
    healthy,
    abiProof,
    remediation,
  };
}
