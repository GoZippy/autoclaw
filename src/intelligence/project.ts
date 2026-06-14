/**
 * project.ts — resolve the project namespace key for session tagging and
 * namespace scoping (D11).
 *
 * The key is the git repository root (normalized to forward slashes) so
 * identical workspaces always produce identical keys regardless of sub-folder
 * open. When no git repo is detected the workspace path itself is used as the
 * fallback.
 *
 * No `vscode` import — stays host-free and unit-testable.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import { toForwardSlash } from './paths';

/**
 * Resolve a stable project namespace key.
 *
 * Strategy:
 * 1. Run `git rev-parse --show-toplevel` from `workspacePath`.
 * 2. If that succeeds, return the git root normalized to forward slashes.
 * 3. If git is unavailable or the directory is not a repo, fall back to
 *    the workspace path normalized to forward slashes.
 *
 * @param workspacePath - The workspace root directory to resolve from.
 * @returns A forward-slash normalized absolute path used as the project key.
 */
export function resolveProjectKey(workspacePath: string): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: workspacePath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], // suppress stderr from leaking
    }).trim();

    if (gitRoot) {
      return toForwardSlash(path.resolve(gitRoot));
    }
  } catch {
    // Not a git repo or git not installed — fall through to workspace fallback.
  }

  return toForwardSlash(path.resolve(workspacePath));
}
