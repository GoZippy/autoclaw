/**
 * doctor.ts — workspace "truth health" checks (config vs reality).
 *
 * Surfaces drift that reconcile alone cannot see because it only compares
 * state.json / sprint YAML / comms-log. Here we check:
 *   1. state.total_sprints vs actual sprint-*.yaml files on disk
 *   2. configured baseBranch vs actual git branches
 *   3. .git presence (is this actually a git repo?)
 *
 * Pure: no vscode, no cross-module imports beyond fs/path. Findings are
 * returned as DoctorFinding[] so callers (reconcile, board health, CLI)
 * decide how to surface them.
 */

import * as fs from 'fs';
import * as path from 'path';

const fsp = fs.promises;

export type DoctorFindingKind =
  | 'total_sprints_mismatch'
  | 'base_branch_missing'
  | 'git_repo_absent'
  | 'git_repo_present_but_config_disabled';

export interface DoctorFinding {
  kind: DoctorFindingKind;
  description: string;
  /** Suggested fix hint. */
  hint: string;
}

interface DoctorOptions {
  /** Base branch configured in settings. Defaults to 'main'. */
  configuredBaseBranch?: string;
  /** Whether git coordination is enabled in settings. Defaults to true. */
  gitEnabled?: boolean;
  /** Injectable exec for tests. */
  exec?: (cmd: string, cwd: string) => string;
}

function listSprintFiles(sprintsDir: string): number {
  try {
    const files = fs.readdirSync(sprintsDir);
    return files.filter(f => /^sprint-\d+\.yaml$/.test(f)).length;
  } catch {
    return 0;
  }
}

function hasGitRepo(workspaceRoot: string): boolean {
  try {
    return fs.existsSync(path.join(workspaceRoot, '.git'));
  } catch {
    return false;
  }
}

function branchExists(branch: string, workspaceRoot: string, exec: (cmd: string, cwd: string) => string): boolean {
  try {
    const out = exec(`git rev-parse --verify ${branch}`, workspaceRoot);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function defaultExec(cmd: string, cwd: string): string {
  return require('child_process').execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

export function runDoctorChecks(workspaceRoot: string, opts: DoctorOptions = {}): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  if (!workspaceRoot) { return findings; }

  const exec = opts.exec ?? defaultExec;
  const baseBranch = opts.configuredBaseBranch ?? 'main';
  const gitEnabled = opts.gitEnabled ?? true;

  const orchestratorDir = path.join(workspaceRoot, '.autoclaw', 'orchestrator');
  const sprintsDir = path.join(orchestratorDir, 'sprints');

  // Only run checks when the workspace is actually using AutoClaw.
  const hasAutoclaw = fs.existsSync(orchestratorDir);
  if (!hasAutoclaw) { return findings; }

  // 1. total_sprints vs actual sprint files.
  const statePath = path.join(orchestratorDir, 'state.json');
  let declaredSprints = -1;
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(raw.replace(/^﻿/, '')) as { total_sprints?: number };
    if (typeof state.total_sprints === 'number') {
      declaredSprints = state.total_sprints;
    }
  } catch { /* no state.json — skip this check */ }

  const actualSprints = listSprintFiles(sprintsDir);
  if (declaredSprints >= 0 && actualSprints !== declaredSprints) {
    findings.push({
      kind: 'total_sprints_mismatch',
      description: `state.total_sprints=${declaredSprints} but ${actualSprints} sprint-*.yaml file(s) exist.`,
      hint: `Update state.total_sprints to ${actualSprints} or remove stale sprint files.`,
    });
  }

  // 2. baseBranch existence (check even without .git — config might be wrong).
  const hasGit = hasGitRepo(workspaceRoot);
  if (!branchExists(baseBranch, workspaceRoot, exec)) {
    findings.push({
      kind: 'base_branch_missing',
      description: `Configured base branch "${baseBranch}" does not exist in this repo.`,
      hint: `Create the branch with: git checkout -b ${baseBranch}`,
    });
  }

  // 3. .git presence.
  if (!hasGit) {
    findings.push({
      kind: 'git_repo_absent',
      description: 'No .git directory found in workspace root.',
      hint: 'Run git init if you want git-based coordination, or ignore this for pure local use.',
    });
  }

  // 4. Git present but config says disabled.
  if (hasGit && !gitEnabled) {
    findings.push({
      kind: 'git_repo_present_but_config_disabled',
      description: 'A .git directory exists but git coordination is disabled in settings.',
      hint: 'Enable git coordination or remove .git if this is not a git project.',
    });
  }

  return findings;
}
