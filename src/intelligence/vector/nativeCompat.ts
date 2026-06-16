/**
 * vector/nativeCompat.ts — version-controlled compatibility matrix for the
 * intelligence vector backend's SQLite drivers.
 *
 * This is the SINGLE place that records what each driver needs and the
 * last-known-good versions, so:
 *   - the doctor / {@link vectorBackendPreflight} check can give an ACTIONABLE
 *     verdict ("active driver is the ABI-fragile one — do X") instead of silently
 *     degrading, and
 *   - dependency bumps are a deliberate, reviewed edit HERE (kept in lockstep with
 *     `package.json`) rather than guesswork.
 *
 * When to edit this file:
 *   - bump `betterSqlite3.current` (and re-pin it in package.json) when a newer
 *     better-sqlite3 gains a working binary for a host Electron ABI we care about;
 *   - bump `nodeSqlite.minNodeVersion` only if upstream changes the floor at which
 *     `node:sqlite` is usable.
 *
 * No `vscode` import; pure data + types.
 */

export interface NativeCompat {
  /** The driver the vector store prefers — ABI-proof, no rebuild ever. */
  preferredDriver: 'node-sqlite';
  nodeSqlite: {
    /** Lowest Node version where `node:sqlite` is usable (unflagged in Node 24). */
    minNodeVersion: string;
    note: string;
  };
  betterSqlite3: {
    role: 'fallback';
    /** Version pinned in package.json's optionalDependencies. Keep in sync. */
    current: string;
    note: string;
  };
  sqliteVec: {
    /** Version pinned in package.json's optionalDependencies. Keep in sync. */
    current: string;
    note: string;
  };
  /** ISO date this matrix was last reviewed against the shipping deps. */
  lastReviewed: string;
}

export const NATIVE_COMPAT: NativeCompat = {
  preferredDriver: 'node-sqlite',
  nodeSqlite: {
    minNodeVersion: '22.5.0',
    note:
      'node:sqlite is a Node core module — ABI-stable, nothing to rebuild ever. ' +
      'Available unflagged in Node 24 (the Node that ships in Electron >= ~30), ' +
      'which is why IDE / Electron updates no longer break the vector backend.',
  },
  betterSqlite3: {
    role: 'fallback',
    current: '12.10.1',
    note:
      'Native addon — its compiled binary MUST match the host Electron ABI ' +
      '(NODE_MODULE_VERSION). Used ONLY when node:sqlite is unavailable (older ' +
      'IDEs / Node < minNodeVersion). Rebuild it for the host Electron with ' +
      '`npm run rebuild:native`.',
  },
  sqliteVec: {
    current: '0.1.6',
    note:
      'SQLite loadable extension (vec0). It is loaded by SQLite itself, so it is ' +
      'ABI-independent of Node and shared by BOTH drivers — never needs rebuilding.',
  },
  lastReviewed: '2026-06-15',
};
