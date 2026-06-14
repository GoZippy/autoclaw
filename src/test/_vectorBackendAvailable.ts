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

/**
 * Returns true when both native peers of the vector store can be required in
 * the current runtime, mirroring the lazy `require` used by
 * `src/intelligence/vectorEngine.ts`. Never throws.
 */
export function nativeVectorAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('better-sqlite3');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}
