/**
 * gitRunner.ts — Coordination Kernel: the production GitRunner.
 *
 * mergeGate.ts and worktree.ts take an injectable `GitRunner` so their logic
 * unit-tests without a repo. This is the real one, backed by child_process —
 * argv array (NOT a shell string), so paths/globs with spaces or metacharacters
 * are never shell-interpreted (no injection, no Windows-quoting surprises).
 */

import { spawn } from 'child_process';
import type { GitRunner, GitResult } from './mergeGate';

/**
 * Run `git <args...>` in `opts.cwd`. Never throws — a spawn error (git missing,
 * etc.) resolves to a non-zero `exitCode` with the message on stderr, so callers
 * (the merge gate) treat it as a failed git operation and fail closed.
 */
export const execGit: GitRunner = (args, opts) =>
  new Promise<GitResult>((resolve) => {
    let proc;
    try {
      proc = spawn('git', args, { cwd: opts?.cwd, windowsHide: true });
    } catch (e) {
      resolve({ exitCode: 127, stdout: '', stderr: `spawn git failed: ${(e as Error).message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => resolve({ exitCode: 127, stdout, stderr: stderr || `git error: ${e.message}` }));
    proc.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
