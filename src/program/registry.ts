/**
 * registry.ts — Workspace-local program scope registry (Workstream C.14).
 *
 * A "program" is a set of repos that AutoClaw treats as one fleet. This module
 * owns `.autoclaw/program/registry.json` — a *workspace-local* file listing the
 * participating repos by absolute path. It is the natural anchor the cloud
 * relay (Workstream D.4) uses for the cross-project rollup.
 *
 * Relationship to `src/program-plane.ts`:
 *   - `program-plane.ts` owns the *user-global* `~/.autoclaw/programs/<id>/`
 *     program (Phase 4) — a heavier, multi-machine construct with a fan-in
 *     comms log and a bus driver.
 *   - This module is the *lightweight, workspace-scoped* registry the V3 plan
 *     §6 C.14 calls for: one JSON file per workspace listing sibling repos,
 *     plus a cross-repo comms tail and a single Agents table that carries a
 *     repo column. The two are complementary; this one is what the Fleet panel
 *     and the "Add Repo to Program" command read and write.
 *
 * Design: zero `vscode` import → fully unit-testable in plain Node. The VS Code
 * command wrapper at the bottom takes its `vscode` dependency by injection so
 * the file still type-checks and tests without a VS Code host.
 *
 * Sprint 4 — C14 (WA-1).
 */

import * as fs from 'fs';
import * as path from 'path';

const fsp = fs.promises;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** One repo participating in the program. */
export interface ProgramRepo {
  /** Absolute path to the repo root (the folder containing `.autoclaw/`). */
  path: string;
  /** Short display label. Defaults to the repo folder basename. */
  label: string;
  /** ISO timestamp the repo was added to the program. */
  added_at: string;
  /**
   * When false, the repo is listed but excluded from rollups / comms tail.
   * Defaults to true. Lets a user park a repo without un-linking it.
   */
  enabled?: boolean;
}

/** The `.autoclaw/program/registry.json` document. */
export interface ProgramScopeRegistry {
  schema_version: '1.0';
  /** Human-friendly program name. */
  program_name: string;
  /** ISO timestamp the registry file was created. */
  created_at: string;
  /** ISO timestamp the registry file was last modified. */
  updated_at: string;
  /** Participating repos. The host workspace is always present. */
  repos: ProgramRepo[];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Directory holding the program-scope registry under a workspace root. */
export function programScopeDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw', 'program');
}

/** Absolute path to `.autoclaw/program/registry.json` for a workspace. */
export function programRegistryPath(workspaceRoot: string): string {
  return path.join(programScopeDir(workspaceRoot), 'registry.json');
}

/** Comms directory for a participating repo. */
function repoCommsDir(repoPath: string): string {
  return path.join(repoPath, '.autoclaw', 'orchestrator', 'comms');
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Read the program-scope registry for a workspace. Returns `null` when no
 * registry file exists yet (the workspace is not part of a program).
 */
export async function readProgramRegistry(
  workspaceRoot: string,
): Promise<ProgramScopeRegistry | null> {
  try {
    const raw = await fsp.readFile(programRegistryPath(workspaceRoot), 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as ProgramScopeRegistry;
  } catch {
    return null;
  }
}

/** Write the registry, stamping `updated_at`. Creates the directory. */
export async function writeProgramRegistry(
  workspaceRoot: string,
  reg: ProgramScopeRegistry,
): Promise<void> {
  await fsp.mkdir(programScopeDir(workspaceRoot), { recursive: true });
  reg.updated_at = new Date().toISOString();
  await fsp.writeFile(
    programRegistryPath(workspaceRoot),
    JSON.stringify(reg, null, 2),
    'utf8',
  );
}

/**
 * Read the existing registry, or initialize a fresh one whose only member is
 * the host workspace itself.
 */
export async function ensureProgramRegistry(
  workspaceRoot: string,
  programName?: string,
): Promise<ProgramScopeRegistry> {
  const existing = await readProgramRegistry(workspaceRoot);
  if (existing) { return existing; }
  const now = new Date().toISOString();
  const reg: ProgramScopeRegistry = {
    schema_version: '1.0',
    program_name: programName ?? path.basename(workspaceRoot),
    created_at: now,
    updated_at: now,
    repos: [
      {
        path: path.resolve(workspaceRoot),
        label: path.basename(workspaceRoot),
        added_at: now,
        enabled: true,
      },
    ],
  };
  await writeProgramRegistry(workspaceRoot, reg);
  return reg;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Outcome of {@link addRepoToProgram}. */
export interface AddRepoResult {
  /** The registry after the operation. */
  registry: ProgramScopeRegistry;
  /** True when the repo was newly added; false when it was already a member. */
  added: boolean;
  /** The (resolved) repo path that was acted on. */
  repoPath: string;
}

/**
 * Add a repo to the workspace's program registry. Idempotent: adding a repo
 * already in the program is a no-op (it just touches `updated_at`).
 *
 * The repo path is resolved to an absolute path and de-duplicated case-
 * insensitively on Windows.
 */
export async function addRepoToProgram(
  workspaceRoot: string,
  repoPath: string,
  label?: string,
): Promise<AddRepoResult> {
  const reg = await ensureProgramRegistry(workspaceRoot);
  const resolved = path.resolve(repoPath);
  const samePath = (a: string, b: string): boolean =>
    process.platform === 'win32'
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;

  const exists = reg.repos.some(r => samePath(r.path, resolved));
  if (exists) {
    await writeProgramRegistry(workspaceRoot, reg);
    return { registry: reg, added: false, repoPath: resolved };
  }
  reg.repos.push({
    path: resolved,
    label: label ?? path.basename(resolved),
    added_at: new Date().toISOString(),
    enabled: true,
  });
  await writeProgramRegistry(workspaceRoot, reg);
  return { registry: reg, added: true, repoPath: resolved };
}

/** Remove a repo from the program. Returns true when a repo was removed. */
export async function removeRepoFromProgram(
  workspaceRoot: string,
  repoPath: string,
): Promise<boolean> {
  const reg = await readProgramRegistry(workspaceRoot);
  if (!reg) { return false; }
  const resolved = path.resolve(repoPath);
  const samePath = (a: string, b: string): boolean =>
    process.platform === 'win32'
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  const before = reg.repos.length;
  reg.repos = reg.repos.filter(r => !samePath(r.path, resolved));
  if (reg.repos.length === before) { return false; }
  await writeProgramRegistry(workspaceRoot, reg);
  return true;
}

// ---------------------------------------------------------------------------
// Cross-repo comms tail
// ---------------------------------------------------------------------------

/** A single comms-log line annotated with the repo it came from. */
export interface CrossRepoCommsEntry {
  /** Repo path the entry was read from. */
  repo: string;
  /** Short repo label. */
  repoLabel: string;
  /** ISO timestamp from the log entry (empty when unparseable). */
  timestamp: string;
  /** Message type / event kind. */
  type: string;
  /** Sender agent id. */
  from: string;
  /** Recipient agent id, when present. */
  to?: string;
  /** Human-readable message text. */
  message: string;
  /** The raw parsed entry, for callers that need extra fields. */
  raw: Record<string, unknown>;
}

/** A comms-log line as written by `appendCommsLog` (subset). */
interface RawCommsLine {
  timestamp?: string;
  type?: string;
  from?: string;
  to?: string;
  message?: string;
}

/**
 * Read the tail of `comms-log.jsonl` from every enabled repo in the program
 * and merge them into a single chronologically-sorted list.
 *
 * Each repo is read independently; an unreadable repo log is skipped. The
 * `limit` is applied *after* the merge so the newest N entries across the
 * whole program are returned.
 *
 * This powers the Fleet panel's cross-repo comms tail (C.14).
 */
export async function tailCrossRepoComms(
  workspaceRoot: string,
  options: { limit?: number } = {},
): Promise<CrossRepoCommsEntry[]> {
  const limit = options.limit ?? 100;
  const reg = await readProgramRegistry(workspaceRoot);
  if (!reg) { return []; }

  const all: CrossRepoCommsEntry[] = [];
  for (const repo of reg.repos) {
    if (repo.enabled === false) { continue; }
    const logPath = path.join(repoCommsDir(repo.path), 'comms-log.jsonl');
    let text: string;
    try {
      text = await fsp.readFile(logPath, 'utf8');
    } catch {
      continue; // repo has no comms log yet — skip
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      let parsed: RawCommsLine;
      try {
        parsed = JSON.parse(trimmed) as RawCommsLine;
      } catch {
        continue; // malformed line — skip
      }
      all.push({
        repo: repo.path,
        repoLabel: repo.label,
        timestamp: parsed.timestamp ?? '',
        type: parsed.type ?? 'unknown',
        from: parsed.from ?? 'unknown',
        to: parsed.to,
        message: parsed.message ?? '',
        raw: parsed as Record<string, unknown>,
      });
    }
  }

  all.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime() || 0;
    const tb = new Date(b.timestamp).getTime() || 0;
    return ta - tb;
  });
  return limit > 0 ? all.slice(-limit) : all;
}

// ---------------------------------------------------------------------------
// Cross-repo Agents table (single table, repo column)
// ---------------------------------------------------------------------------

/** One row of the program-wide Agents table. */
export interface ProgramAgentRow {
  /** Repo the agent belongs to. */
  repo: string;
  /** Short repo label — the value of the table's repo column. */
  repoLabel: string;
  /** Agent id. */
  agentId: string;
  /** Display name (falls back to the agent id). */
  name: string;
  /** Role string, when known. */
  role: string;
  /** Live status derived from the heartbeat age. */
  status: ProgramAgentStatus;
  /** ISO timestamp of the agent's last heartbeat, or null when none. */
  lastHeartbeat: string | null;
  /** Current task text, or null when idle. */
  currentTask: string | null;
}

/** Coarse status used by the program-wide Agents table. */
export type ProgramAgentStatus = 'active' | 'idle' | 'stalled' | 'offline';

/** Registry-file shape a participating repo exposes (subset). */
interface RepoRegistryFile {
  agents?: Array<{ id: string; name?: string; role?: string }>;
}

/** Heartbeat-file shape (subset). */
interface RepoHeartbeatFile {
  agent_id?: string;
  timestamp?: string;
  current_task?: string | null;
}

/** Derive a coarse status from a heartbeat age. Mirrors `agentStatusFromHeartbeat`. */
export function programAgentStatus(
  lastHeartbeat: string | null,
  now: number = Date.now(),
): ProgramAgentStatus {
  if (!lastHeartbeat) { return 'offline'; }
  const age = now - new Date(lastHeartbeat).getTime();
  if (isNaN(age)) { return 'offline'; }
  if (age < 2 * 60 * 1000) { return 'active'; }
  if (age < 5 * 60 * 1000) { return 'idle'; }
  if (age < 24 * 60 * 60 * 1000) { return 'stalled'; }
  return 'offline';
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}

/**
 * Build a single Agents table spanning every enabled repo in the program,
 * with a repo column. This is the data builder the Fleet panel renders for
 * the cross-repo Agents view (C.14) and the anchor the cloud relay rollup
 * (D.4) consumes.
 *
 * Reads each repo's `comms/registry.json` for the agent roster and the
 * `comms/heartbeats/<agent>.json` files for live status. Repos that are not
 * yet provisioned (no registry) contribute zero rows.
 */
export async function buildProgramAgentsTable(
  workspaceRoot: string,
  options: { now?: number } = {},
): Promise<ProgramAgentRow[]> {
  const now = options.now ?? Date.now();
  const reg = await readProgramRegistry(workspaceRoot);
  if (!reg) { return []; }

  const rows: ProgramAgentRow[] = [];
  for (const repo of reg.repos) {
    if (repo.enabled === false) { continue; }
    const comms = repoCommsDir(repo.path);
    const repoReg = await readJsonFile<RepoRegistryFile>(
      path.join(comms, 'registry.json'),
    );
    if (!repoReg?.agents) { continue; }

    for (const agent of repoReg.agents) {
      const hb = await readJsonFile<RepoHeartbeatFile>(
        path.join(comms, 'heartbeats', `${path.basename(agent.id)}.json`),
      );
      const lastHeartbeat = hb?.timestamp ?? null;
      rows.push({
        repo: repo.path,
        repoLabel: repo.label,
        agentId: agent.id,
        name: agent.name ?? agent.id,
        role: agent.role ?? '',
        status: programAgentStatus(lastHeartbeat, now),
        lastHeartbeat,
        currentTask: hb?.current_task ?? null,
      });
    }
  }

  // Sort by repo label, then agent id, for a stable table.
  rows.sort((a, b) =>
    a.repoLabel === b.repoLabel
      ? a.agentId.localeCompare(b.agentId)
      : a.repoLabel.localeCompare(b.repoLabel),
  );
  return rows;
}

// ---------------------------------------------------------------------------
// VS Code command — "AutoClaw: Add Repo to Program"
// ---------------------------------------------------------------------------

/**
 * Minimal slice of the `vscode` API this command needs. Declared structurally
 * so the module type-checks without a `@types/vscode` dependency at this layer
 * and stays unit-testable with a stub.
 */
export interface VsCodeAddRepoDeps {
  window: {
    showOpenDialog(opts: {
      canSelectFiles: boolean;
      canSelectFolders: boolean;
      canSelectMany: boolean;
      openLabel?: string;
      title?: string;
    }): Thenable<Array<{ fsPath: string }> | undefined>;
    showInformationMessage(message: string): Thenable<unknown>;
    showWarningMessage(message: string): Thenable<unknown>;
    showErrorMessage(message: string): Thenable<unknown>;
  };
}

/**
 * Implements the "AutoClaw: Add Repo to Program" command.
 *
 * Prompts the user to pick a folder, validates it is a real directory, and
 * adds it to `.autoclaw/program/registry.json` for the current workspace.
 * Idempotent and surfaces a user-facing toast for each outcome.
 *
 * Returns the result, or `null` when the user cancelled the folder picker.
 *
 * TODO(extension.ts): `extension.ts` is owned by a concurrent session. Register
 * this command from `activate()`:
 *
 *   import { addRepoToProgramCommand } from './program/registry';
 *   context.subscriptions.push(
 *     vscode.commands.registerCommand('autoclaw.addRepoToProgram', () =>
 *       addRepoToProgramCommand(vscode, <workspace folder fsPath>)),
 *   );
 *
 * and add to package.json `contributes.commands`:
 *   { "command": "autoclaw.addRepoToProgram",
 *     "title": "AutoClaw: Add Repo to Program" }
 */
export async function addRepoToProgramCommand(
  vscode: VsCodeAddRepoDeps,
  workspaceRoot: string,
): Promise<AddRepoResult | null> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Add to Program',
    title: 'AutoClaw: Add Repo to Program',
  });
  if (!picked || picked.length === 0) {
    return null; // user cancelled
  }

  const repoPath = picked[0].fsPath;
  try {
    const stat = await fsp.stat(repoPath);
    if (!stat.isDirectory()) {
      await vscode.window.showErrorMessage(
        `AutoClaw: "${repoPath}" is not a folder.`,
      );
      return null;
    }
  } catch {
    await vscode.window.showErrorMessage(
      `AutoClaw: "${repoPath}" could not be read.`,
    );
    return null;
  }

  try {
    const result = await addRepoToProgram(workspaceRoot, repoPath);
    if (result.added) {
      await vscode.window.showInformationMessage(
        `AutoClaw: added "${path.basename(result.repoPath)}" to the program ` +
        `(${result.registry.repos.length} repos).`,
      );
    } else {
      await vscode.window.showWarningMessage(
        `AutoClaw: "${path.basename(result.repoPath)}" is already in the program.`,
      );
    }
    return result;
  } catch (err) {
    await vscode.window.showErrorMessage(
      `AutoClaw: failed to update the program registry: ${String(err)}`,
    );
    return null;
  }
}
