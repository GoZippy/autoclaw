/**
 * fileLock.ts — advisory, cross-platform file locking with zero runtime deps.
 *
 * Concurrency model: AutoClaw runs alongside KDream and parallel agents, all of
 * which may touch shared `.autoclaw/` state. `acquireLock` uses an atomic
 * `mkdir` (a directory either gets created by exactly one caller or fails with
 * EEXIST — true on Windows, macOS, and Linux) as the mutual-exclusion primitive.
 *
 * No `vscode` import. Stale-lock cleanup is a deliberate Phase-6 refinement
 * target; foundation keeps the primitive minimal and correct.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Call to release a previously-acquired lock. Safe to call more than once. */
export type ReleaseFn = () => void;

const DEFAULT_TIMEOUT_MS = 15000;
const RETRY_INTERVAL_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Derive the lock directory path for a target file: `<dir>/.locks/<base>.lock`.
 * The basename is sanitized so unusual file names can't escape the `.locks`
 * directory or collide via path separators.
 */
export function lockDirFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, '.locks', `${safe}.lock`);
}

/**
 * Acquire an advisory lock for `filePath`. Resolves with a {@link ReleaseFn}
 * once the lock is held. If the lock is already held, retries every ~150ms
 * until `timeoutMs` elapses, then rejects with an error naming the contended
 * path.
 *
 * @param filePath  the file being protected (the lock lives beside it under `.locks/`)
 * @param timeoutMs max time to wait for contention to clear (default 15000ms)
 */
export async function acquireLock(
  filePath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ReleaseFn> {
  const lockDir = lockDirFor(filePath);
  const parent = path.dirname(lockDir);
  // Ensure the `.locks` parent exists; this is not the lock itself.
  await fs.promises.mkdir(parent, { recursive: true });

  const deadline = Date.now() + Math.max(0, timeoutMs);

  for (;;) {
    try {
      // Atomic: non-recursive mkdir fails with EEXIST if another holder won.
      fs.mkdirSync(lockDir, { recursive: false });
      return makeRelease(lockDir);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') {
        throw new Error(`lock error for ${filePath.replace(/\\/g, '/')}: ${e.message}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`lock timeout for ${filePath.replace(/\\/g, '/')}`);
      }
      await sleep(RETRY_INTERVAL_MS);
    }
  }
}

function makeRelease(lockDir: string): ReleaseFn {
  let released = false;
  return () => {
    if (released) {
      return; // double-release is a no-op, never throws
    }
    released = true;
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // Already gone or never fully created — releasing must never throw.
    }
  };
}
