/**
 * _vectorBackendAvailable.ts — shared test helper (NOT a test suite).
 *
 * The intelligence vector store depends on the native `better-sqlite3` +
 * `sqlite-vec` modules (optionalDependencies). They load fine in the plain-Node
 * unit runner (`npm run test:unit`), but their native bindings are compiled for
 * the system Node ABI and cannot load inside the Electron-based VS Code
 * extension host that the `@vscode/test-cli` integration runner uses without an
 * electron-rebuild. In that runtime the production code degrades to a no-RAG
 * no-op path by design (R3.1).
 *
 * Test suites that require a WORKING native backend use {@link nativeVectorAvailable}
 * in a `suiteSetup` to `this.skip()` when the backend cannot load, so they run
 * fully in plain Node (the authoritative gate) and skip cleanly under Electron
 * instead of failing.
 *
 * This file deliberately does NOT use a `.test` filename suffix, so the
 * integration runner's compiled-test glob never picks it up as a suite.
 */

/** Memoised probe result — the runtime backend can't change mid-process. */
let cached: boolean | undefined;

/**
 * Returns true only when a WORKING native vector backend is present in the
 * current runtime.
 *
 * A plain `require()` of the two native peers is NOT sufficient: under the
 * Electron extension host both modules import successfully (the JS shims are
 * there), yet the native binding degrades at RUNTIME the moment it is actually
 * exercised — `new Database()`, loading the `sqlite-vec` loadable extension, or
 * creating a `vec0` virtual table throws because the binding was compiled for a
 * different ABI. `src/intelligence/vectorEngine.ts` catches that and silently
 * falls back to a no-RAG no-op path (R3.1), which a require-only probe can't see.
 *
 * So this helper performs the exact same sequence of operations the production
 * `initVectorDB` performs — require, open a DB, `sqliteVec.load(db)`, create a
 * `vec0` table — against an in-memory database, inside one try/catch. If ANY
 * step throws it returns false, which is what lets the guarded suites skip under
 * Electron while still running fully in plain Node. Never throws.
 */
export function nativeVectorAvailable(): boolean {
  if (cached !== undefined) {
    return cached;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqliteVec = require('sqlite-vec');

    // Mirror initVectorDB: open a DB, load the loadable extension, and create a
    // vec0 virtual table. Use an in-memory DB so the probe leaves no artifacts.
    const db = new Database(':memory:');
    sqliteVec.load(db);
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS _probe_vec USING vec0(embedding float[4])');
    db.close();

    cached = true;
  } catch {
    // Any failure (missing module, ABI mismatch, loadable-extension refusal,
    // vec0 unavailable) means the backend is not usable here.
    cached = false;
  }
  return cached;
}
