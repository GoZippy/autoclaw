/**
 * conflictDetection.ts — Pre-push overlap warning for parallel agent branches.
 *
 * Workstream C.12: before an agent pushes its work branch, diff it against the
 * other live agent branches with `git diff --stat` and warn when two branches
 * touch the same files. This catches the classic parallel-agent failure mode —
 * two agents racing to merge changes to the same file — before the conflicting
 * push happens, not after.
 *
 * Design:
 *   - `git`-only, no `vscode` import → fully unit-testable in plain Node.
 *   - Read-only: never writes, never pushes, never mutates the repo.
 *   - The orchestrator / a git pre-push hook calls `detectBranchConflicts`
 *     and surfaces the result; this module only computes it.
 *
 * Sprint 4 — C5_statusbar (C.12).
 */

import { execFile } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A pair of branches that touch at least one common file. */
export interface BranchOverlap {
  /** The branch about to be pushed. */
  branch: string;
  /** A peer agent branch that shares files with `branch`. */
  otherBranch: string;
  /** Files modified by both branches (relative repo paths). */
  overlappingFiles: string[];
}

/** Result of a conflict scan for one branch against its peers. */
export interface ConflictReport {
  /** The branch that was scanned. */
  branch: string;
  /** Merge-base ref the diffs were taken against. */
  baseRef: string;
  /** One entry per peer branch that overlaps; empty ⇒ safe to push. */
  overlaps: BranchOverlap[];
  /** True when at least one overlap was found. */
  hasConflict: boolean;
  /** Human-readable warning lines (empty when `hasConflict` is false). */
  warnings: string[];
}

/** Options for {@link detectBranchConflicts}. */
export interface ConflictDetectionOptions {
  /** Absolute path to the git repository working directory. */
  repoDir: string;
  /** The branch about to be pushed. */
  branch: string;
  /** Peer agent branches to compare against (the branch itself is skipped). */
  peerBranches: string[];
  /**
   * Base ref to diff each branch against. Defaults to `origin/main`, falling
   * back to `main` then `master` when `origin/main` does not resolve.
   */
  baseRef?: string;
  /**
   * Injectable git runner — tests pass a stub. Defaults to a real `git`
   * subprocess. Resolves with stdout; rejects on non-zero exit.
   */
  runGit?: GitRunner;
}

/** Runs a git command in `repoDir` and resolves with its stdout. */
export type GitRunner = (repoDir: string, args: string[]) => Promise<string>;

// ---------------------------------------------------------------------------
// Default git runner
// ---------------------------------------------------------------------------

/** Real `git` subprocess runner. */
export const defaultGitRunner: GitRunner = (repoDir, args) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: repoDir, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/**
 * Parse the file list out of `git diff --name-only <base>...<branch>` output.
 * Blank lines are dropped; paths are returned verbatim (repo-relative).
 */
export function parseChangedFiles(nameOnlyOutput: string): string[] {
  return nameOnlyOutput
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

/**
 * Given each branch's changed-file set, compute the overlapping-file pairs
 * for `branch` against every peer. Pure — no I/O.
 */
export function computeOverlaps(
  branch: string,
  branchFiles: Set<string>,
  peerFilesByBranch: Map<string, Set<string>>,
): BranchOverlap[] {
  const overlaps: BranchOverlap[] = [];
  for (const [otherBranch, peerFiles] of peerFilesByBranch) {
    if (otherBranch === branch) { continue; }
    const shared: string[] = [];
    for (const f of branchFiles) {
      if (peerFiles.has(f)) { shared.push(f); }
    }
    if (shared.length > 0) {
      overlaps.push({
        branch,
        otherBranch,
        overlappingFiles: shared.sort(),
      });
    }
  }
  return overlaps.sort((a, b) => a.otherBranch.localeCompare(b.otherBranch));
}

/** Format human-readable warning lines for a set of overlaps. */
export function formatConflictWarnings(overlaps: BranchOverlap[]): string[] {
  const lines: string[] = [];
  for (const o of overlaps) {
    const count = o.overlappingFiles.length;
    lines.push(
      `⚠ "${o.branch}" overlaps "${o.otherBranch}" on ${count} ` +
      `file${count === 1 ? '' : 's'}:`,
    );
    for (const f of o.overlappingFiles) {
      lines.push(`    ${f}`);
    }
    lines.push(
      `  → coordinate with the agent on "${o.otherBranch}" before pushing.`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Base-ref resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a usable base ref. Tries the explicit ref, then `origin/main`,
 * `main`, `master`. Returns the first one `git rev-parse` accepts.
 */
export async function resolveBaseRef(
  repoDir: string,
  runGit: GitRunner,
  explicit?: string,
): Promise<string> {
  const candidates = explicit
    ? [explicit, 'origin/main', 'main', 'master']
    : ['origin/main', 'main', 'master'];
  for (const ref of candidates) {
    try {
      await runGit(repoDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {
      /* try next */
    }
  }
  // Last resort: the empty tree, so the diff lists every tracked file.
  return '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Diff `branch` and each peer branch against a shared base ref, then warn
 * about any file both `branch` and a peer modify.
 *
 * Each branch's changed files come from `git diff --name-only <base>...<ref>`
 * (the three-dot form: changes introduced on the branch since the merge-base).
 * A branch ref that does not resolve is skipped silently — peers may not yet
 * exist locally.
 */
export async function detectBranchConflicts(
  opts: ConflictDetectionOptions,
): Promise<ConflictReport> {
  const runGit = opts.runGit ?? defaultGitRunner;
  const baseRef = await resolveBaseRef(opts.repoDir, runGit, opts.baseRef);

  const changedFilesFor = async (ref: string): Promise<Set<string> | null> => {
    try {
      const out = await runGit(opts.repoDir, [
        'diff', '--name-only', `${baseRef}...${ref}`,
      ]);
      return new Set(parseChangedFiles(out));
    } catch {
      return null; // ref does not resolve — skip
    }
  };

  const branchFiles = (await changedFilesFor(opts.branch)) ?? new Set<string>();

  const peerFilesByBranch = new Map<string, Set<string>>();
  for (const peer of opts.peerBranches) {
    if (peer === opts.branch) { continue; }
    const files = await changedFilesFor(peer);
    if (files) { peerFilesByBranch.set(peer, files); }
  }

  const overlaps = computeOverlaps(opts.branch, branchFiles, peerFilesByBranch);

  return {
    branch: opts.branch,
    baseRef,
    overlaps,
    hasConflict: overlaps.length > 0,
    warnings: formatConflictWarnings(overlaps),
  };
}
