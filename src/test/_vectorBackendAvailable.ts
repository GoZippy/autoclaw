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

import { vectorBackendPreflight } from '../intelligence/vector';

/** Memoised probe result — the runtime backend can't change mid-process. */
let cached: boolean | undefined;

/**
 * Returns true when a WORKING vector backend (any driver) is present in the
 * current runtime.
 *
 * A plain `require()` is NOT sufficient: under the Electron extension host a
 * native module's JS shim imports fine yet its binding degrades at RUNTIME the
 * moment it is exercised (an ABI mismatch throws on `new Database()`, loading the
 * `sqlite-vec` extension, or creating a `vec0` table). `initVectorDB` catches
 * that and falls back to a no-RAG no-op path (R3.1), which a require-only probe
 * can't see.
 *
 * So this delegates to {@link vectorBackendPreflight}, which exercises the exact
 * sequence production uses — open a DB, load the sqlite-vec extension, create a
 * `vec0` table — for EACH candidate driver (`node:sqlite` first, then
 * `better-sqlite3`). It reports healthy when ANY driver works, so guarded suites
 * run wherever the store actually works (e.g. `node:sqlite` in plain Node, even
 * if the native addon's ABI is wrong) and skip cleanly only when none load.
 * Never throws.
 */
export function nativeVectorAvailable(): boolean {
  if (cached !== undefined) {
    return cached;
  }
  try {
    cached = vectorBackendPreflight().healthy;
  } catch {
    cached = false;
  }
  return cached;
}
