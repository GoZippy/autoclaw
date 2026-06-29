/**
 * worktree.ts — Coordination Kernel: isolated git worktree lifecycle.
 *
 * The single highest-leverage fix for multi-agent collisions is to stop every
 * agent from editing one shared working tree. Each agent-task gets its OWN git
 * worktree on its own branch; nobody ever sees a peer's half-finished edit; the
 * work lands atomically through the merge gate (mergeGate.ts).
 *
 * Pure helpers (branch naming, porcelain parsing, path derivation) unit-test
 * without git; IO (add/remove/list) takes the same injectable GitRunner as the
 * merge gate.
 */

import * as path from 'path';
import type { GitRunner } from './mergeGate';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Strip leading/trailing dots and dashes (no `..`, no hidden-file/ref-tail surprises). */
function trimEdges(s: string): string {
  return s.replace(/^[.-]+|[.-]+$/g, '');
}

/**
 * Sanitize an id segment so it is safe in a branch name / path component.
 * Hardened (adversarial review): collapses interior `..` runs, strips a `.lock`
 * tail, and re-trims AFTER truncation so `slice()` can never re-introduce a
 * trailing dot (a git-invalid ref / Windows directory alias).
 */
export function sanitizeSegment(s: string): string {
  let r = (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/\.{2,}/g, '.'); // collapse interior `..` runs → single `.`
  r = trimEdges(r).slice(0, 40);
  r = trimEdges(r).replace(/\.lock$/i, ''); // re-trim post-slice; drop a `.lock` tail
  return trimEdges(r);
}

/**
 * Final-pass guard on an assembled branch name: git refs may not end in `.lock`,
 * `/`, `.`, or `-`, and must be non-empty. Returns a safe fallback if empty.
 */
function safeBranchName(name: string): string {
  let n = name.replace(/\.lock$/i, '').replace(/[./-]+$/, '');
  if (!n || n === 'wt') { n = 'wt/agent-task-0'; }
  return n;
}

/**
 * Deterministic branch name for an agent-task worktree:
 * `wt/<agent>-<task>-<session-frag>`. Stable per (agent, task, session) so a
 * re-entry reuses the same branch. Guaranteed to be a valid git ref.
 */
export function worktreeBranchName(agentId: string, taskId: string, sessionFrag: string): string {
  const a = sanitizeSegment(agentId) || 'agent';
  const t = sanitizeSegment(taskId) || 'task';
  const f = trimEdges(sanitizeSegment(sessionFrag).slice(0, 8)) || '0';
  return safeBranchName(`wt/${a}-${t}-${f}`);
}

/**
 * Path to a worktree checkout. Worktrees live OUTSIDE the main checkout (a
 * sibling `.worktrees` dir by default, or an explicit base) so they never
 * pollute the repo working tree or get picked up by tooling.
 */
export function worktreePath(repoRoot: string, branch: string, baseDir?: string): string {
  const leaf = branch.replace(/[\\/]/g, '__');
  const root = baseDir ?? path.join(path.dirname(repoRoot), '.autoclaw-worktrees');
  return path.join(root, `${path.basename(repoRoot)}__${leaf}`);
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  bare?: boolean;
}

/** Parse `git worktree list --porcelain` output into entries. */
export function parseWorktreePorcelain(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      if (cur) { entries.push(cur); }
      cur = { path: line.slice('worktree '.length).trim() };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line.trim() === '' && cur) {
      entries.push(cur);
      cur = null;
    }
  }
  if (cur) { entries.push(cur); }
  return entries;
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

export interface CreateWorktreeInput {
  repoRoot: string;
  agentId: string;
  taskId: string;
  sessionFrag: string;
  /** Branch to base the new worktree on (default 'HEAD'). */
  base?: string;
  /** Override the parent dir worktrees are created under. */
  baseDir?: string;
}

export interface CreateWorktreeResult {
  branch: string;
  path: string;
  created: boolean;
  error?: string;
}

/**
 * Create an isolated worktree for an agent-task on a fresh branch.
 * `git worktree add <path> -b <branch> <base>`. Idempotent-ish: if the branch
 * already exists, falls back to adding a worktree on the existing branch.
 */
export async function createWorktree(git: GitRunner, input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
  const branch = worktreeBranchName(input.agentId, input.taskId, input.sessionFrag);
  const wtPath = worktreePath(input.repoRoot, branch, input.baseDir);
  const base = input.base ?? 'HEAD';

  let res = await git(['worktree', 'add', wtPath, '-b', branch, base], { cwd: input.repoRoot });
  if (res.exitCode !== 0) {
    // Branch may already exist — try attaching a worktree to it instead.
    const retry = await git(['worktree', 'add', wtPath, branch], { cwd: input.repoRoot });
    if (retry.exitCode !== 0) {
      return { branch, path: wtPath, created: false, error: res.stderr.trim() || retry.stderr.trim() };
    }
    res = retry;
  }
  return { branch, path: wtPath, created: true };
}

/** Remove a worktree (force) and prune. Best-effort; returns success. */
export async function removeWorktree(
  git: GitRunner,
  repoRoot: string,
  wtPath: string,
): Promise<{ removed: boolean; error?: string }> {
  const res = await git(['worktree', 'remove', '--force', wtPath], { cwd: repoRoot });
  await git(['worktree', 'prune'], { cwd: repoRoot }).catch(() => undefined);
  if (res.exitCode !== 0) {
    return { removed: false, error: res.stderr.trim() };
  }
  return { removed: true };
}

/** List active worktrees. */
export async function listWorktrees(git: GitRunner, repoRoot: string): Promise<WorktreeEntry[]> {
  const res = await git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (res.exitCode !== 0) { return []; }
  return parseWorktreePorcelain(res.stdout);
}
