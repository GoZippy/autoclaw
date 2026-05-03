/**
 * timetravel.ts — Git worktree manager and point-in-time revert.
 */

import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);
const fsPromises = fs.promises;

export interface Snapshot {
  id: string;
  timestamp: string;
  commit_sha: string;
  branch: string;
  agent_id: string;
  sprint: number;
  task_id: string;
  event: 'task_complete' | 'consensus_reached' | 'sprint_merged' | 'manual';
  description: string;
}

export interface WorktreeInfo { path: string; branch: string; commit: string; }

export interface RevertPlan {
  target_snapshot: Snapshot;
  affected_branches: string[];
  has_downstream_dependencies: boolean;
  downstream_tasks: string[];
  revert_type: 'clean' | 'conflict_possible' | 'cascade_required';
  description: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
    return stdout.trim();
  } catch { return ''; }
}

export async function getCurrentCommit(cwd: string): Promise<string> { return git(cwd, ['rev-parse', 'HEAD']); }
export async function getCurrentBranch(cwd: string): Promise<string> { return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']); }

export async function createWorktree(repoRoot: string, branch: string, baseBranch: string = 'main'): Promise<string> {
  const name = branch.replace(/\//g, '-');
  const wtPath = path.join(path.dirname(repoRoot), `worktree-${name}`);
  const exists = await git(repoRoot, ['rev-parse', '--verify', branch]);
  if (!exists) { await git(repoRoot, ['branch', branch, baseBranch]); }
  try { await execFileAsync('git', ['worktree', 'add', wtPath, branch], { cwd: repoRoot, encoding: 'utf8' }); }
  catch (e) { if (!(e as Error).message?.includes('already checked out')) { throw e; } }
  return wtPath;
}

export async function removeWorktree(repoRoot: string, wtPath: string): Promise<void> {
  await git(repoRoot, ['worktree', 'remove', wtPath, '--force']);
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const output = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!output) { return []; }
  const wts: WorktreeInfo[] = [];
  for (const block of output.split('\n\n').filter(b => b.trim())) {
    let p = '', c = '', b = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) { p = line.slice(9); }
      if (line.startsWith('HEAD ')) { c = line.slice(5); }
      if (line.startsWith('branch ')) { b = line.slice(7).replace('refs/heads/', ''); }
    }
    if (p) { wts.push({ path: p, branch: b, commit: c }); }
  }
  return wts;
}

export async function readSnapshots(commsDir: string): Promise<Snapshot[]> {
  try { return JSON.parse(await fsPromises.readFile(path.join(commsDir, 'snapshots.json'), 'utf8')); }
  catch { return []; }
}

export async function writeSnapshots(commsDir: string, snapshots: Snapshot[]): Promise<void> {
  await fsPromises.writeFile(path.join(commsDir, 'snapshots.json'), JSON.stringify(snapshots, null, 2), 'utf8');
}

export async function recordSnapshot(
  repoRoot: string, commsDir: string,
  partial: Omit<Snapshot, 'commit_sha' | 'branch'>
): Promise<Snapshot> {
  const snap: Snapshot = { ...partial, commit_sha: await getCurrentCommit(repoRoot), branch: await getCurrentBranch(repoRoot) };
  const all = await readSnapshots(commsDir);
  all.push(snap);
  await writeSnapshots(commsDir, all);
  return snap;
}

export async function planRevert(commsDir: string, snapshotId: string): Promise<RevertPlan | null> {
  const all = await readSnapshots(commsDir);
  const target = all.find(s => s.id === snapshotId);
  if (!target) { return null; }
  const later = all.slice(all.indexOf(target) + 1);
  const branches = [...new Set(later.map(s => s.branch))];
  const tasks = later.filter(s => s.event === 'task_complete' || s.event === 'consensus_reached').map(s => s.task_id);
  const type: RevertPlan['revert_type'] = branches.length > 1 ? 'cascade_required' : tasks.length > 0 ? 'conflict_possible' : 'clean';
  return {
    target_snapshot: target, affected_branches: branches,
    has_downstream_dependencies: tasks.length > 0, downstream_tasks: tasks,
    revert_type: type,
    description: type === 'clean' ? `Clean revert to ${target.description}`
      : type === 'conflict_possible' ? `Revert — ${tasks.length} downstream task(s) may be affected`
      : `Cascade revert — ${branches.length} branches, ${tasks.length} tasks affected`,
  };
}

export async function executeRevert(repoRoot: string, snapshot: Snapshot): Promise<string> {
  const branch = `revert/${snapshot.id}`;
  await git(repoRoot, ['checkout', '-b', branch, snapshot.commit_sha]);
  return branch;
}
