/**
 * cloudSection.ts — "Remote Agents" Fleet-panel section (Workstream D.3).
 *
 * A read-only render-data builder for the Fleet panel's cross-machine view.
 * It produces TWO things:
 *
 *   1. A "Remote Agents" table — one row per agent, carrying a `machine`
 *      column — assembled from per-repo registries + heartbeats across the
 *      program. This is the local mirror of what the cloud web dashboard
 *      shows; it works fully offline.
 *   2. A cross-project rollup — per-repo agent counts + health — powered by
 *      `.autoclaw/program/registry.json` (Workstream C.14 / D.4).
 *
 * Consistent with the Sprint-3 `src/panel/` builders (fleetData.ts):
 *   - READ-ONLY. Never writes the orchestrator or program tree.
 *   - No `vscode` import — pure Node `fs`/`path`, unit-testable.
 *   - No LLM / network. Pure file I/O. (The cloud relay itself lives in
 *     `src/cloud/`; this section renders local + relay-status data only.)
 *
 * The relay's posture is surfaced honestly: when the relay is inert (no
 * endpoint / disabled / not logged in) the section says so, so the panel
 * never implies data is leaving the machine when it is not.
 *
 * Sprint 4 — D3 (WA-4).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readRelayConfig, relayIsActive, queueDepth } from '../cloud/relay';
import { getCloudToken } from '../cloud/auth';

const fsp = fs.promises;

// ---------------------------------------------------------------------------
// Render-data shapes
// ---------------------------------------------------------------------------

/** Coarse status for a remote agent — mirrors program registry semantics. */
export type RemoteAgentStatus = 'active' | 'idle' | 'stalled' | 'offline';

/** One row of the "Remote Agents" table — the machine column is first-class. */
export interface RemoteAgentRow {
  /** Agent id. */
  agentId: string;
  /** Display name (falls back to the agent id). */
  name: string;
  /** Role string, when known. */
  role: string;
  /** The MACHINE column — host machine the agent runs on. */
  machine: string;
  /** Repo the agent belongs to (absolute path). */
  repo: string;
  /** Short repo label. */
  repoLabel: string;
  /** Live status derived from heartbeat age. */
  status: RemoteAgentStatus;
  /** ISO timestamp of the last heartbeat, or null when none. */
  lastHeartbeat: string | null;
  /** Current task text, or null when idle. */
  currentTask: string | null;
}

/** One repo's slice of the cross-project rollup. */
export interface ProjectRollupRow {
  /** Repo path. */
  repo: string;
  /** Short repo label. */
  repoLabel: string;
  /** Whether the repo is enabled in the program registry. */
  enabled: boolean;
  /** Total agents seen in the repo. */
  agentCount: number;
  /** Count of agents currently `active`. */
  activeCount: number;
  /** Count of agents `stalled`. */
  stalledCount: number;
  /** Count of agents `offline`. */
  offlineCount: number;
}

/** The relay's current posture — surfaced so the panel is honest about transmission. */
export interface RelayStatusView {
  /** True only when enabled AND a non-empty endpoint is configured. */
  active: boolean;
  /** True when a cloud token is stored for this installation. */
  loggedIn: boolean;
  /** Configured endpoint host, or empty when none. The full URL is not shown. */
  endpointHost: string;
  /** Items waiting in the offline retry queue. */
  queuedItems: number;
  /** A short human-readable posture line. */
  summary: string;
}

/** The complete render-data for the "Remote Agents" Fleet section. */
export interface CloudSectionModel {
  /** The program name, when the workspace is part of a program. */
  programName: string | null;
  /** The "Remote Agents" table rows, sorted by machine then agent. */
  remoteAgents: RemoteAgentRow[];
  /** The cross-project rollup, one row per program repo. */
  projectRollup: ProjectRollupRow[];
  /** The cloud relay posture. */
  relay: RelayStatusView;
  /** True when no program registry exists (single-repo workspace). */
  standalone: boolean;
}

// ---------------------------------------------------------------------------
// Local file shapes (subset — kept local; no cross-module type coupling)
// ---------------------------------------------------------------------------

interface ProgramRepoEntry {
  path: string;
  label?: string;
  enabled?: boolean;
}
interface ProgramRegistryFile {
  program_name?: string;
  repos?: ProgramRepoEntry[];
}
interface RepoRegistryFile {
  agents?: Array<{
    id: string;
    name?: string;
    role?: string;
    machine_id?: string;
  }>;
}
interface RepoHeartbeatFile {
  agent_id?: string;
  timestamp?: string;
  current_task?: string | null;
  current_llm?: string;
}

// ---------------------------------------------------------------------------
// Path + read helpers (all swallow errors → null / [])
// ---------------------------------------------------------------------------

function autoclawDirOf(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.autoclaw');
}
function programRegistryPath(workspaceRoot: string): string {
  return path.join(autoclawDirOf(workspaceRoot), 'program', 'registry.json');
}
function repoCommsDir(repoPath: string): string {
  return path.join(repoPath, '.autoclaw', 'orchestrator', 'comms');
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw.replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status derivation — mirrors program/registry.ts `programAgentStatus`
// ---------------------------------------------------------------------------

/** Derive a coarse status from a heartbeat age. */
export function remoteAgentStatus(
  lastHeartbeat: string | null,
  now: number = Date.now(),
): RemoteAgentStatus {
  if (!lastHeartbeat) {
    return 'offline';
  }
  const age = now - new Date(lastHeartbeat).getTime();
  if (!Number.isFinite(age)) {
    return 'offline';
  }
  if (age < 2 * 60 * 1000) {
    return 'active';
  }
  if (age < 5 * 60 * 1000) {
    return 'idle';
  }
  if (age < 24 * 60 * 60 * 1000) {
    return 'stalled';
  }
  return 'offline';
}

// ---------------------------------------------------------------------------
// Remote-agent table + rollup
// ---------------------------------------------------------------------------

/**
 * Build the "Remote Agents" table by walking every repo in the program
 * registry. Each repo's `comms/registry.json` supplies the roster and each
 * agent's `comms/heartbeats/<agent>.json` supplies live status + machine.
 *
 * The MACHINE column is resolved from, in order: the heartbeat's host hint,
 * the registry entry's `machine_id`, else `os.hostname()` for the local repo
 * (a sibling repo with no machine hint is reported as `unknown`).
 */
async function buildRemoteAgents(
  workspaceRoot: string,
  repos: ProgramRepoEntry[],
  now: number,
): Promise<{ rows: RemoteAgentRow[]; rollup: ProjectRollupRow[] }> {
  const localHost = os.hostname();
  const localRoot = path.resolve(workspaceRoot);
  const rows: RemoteAgentRow[] = [];
  const rollup: ProjectRollupRow[] = [];

  for (const repo of repos) {
    const repoPath = path.resolve(repo.path);
    const repoLabel = repo.label ?? path.basename(repoPath);
    const enabled = repo.enabled !== false;

    const repoRows: RemoteAgentRow[] = [];
    if (enabled) {
      const comms = repoCommsDir(repoPath);
      const repoReg = await readJson<RepoRegistryFile>(path.join(comms, 'registry.json'));
      for (const agent of repoReg?.agents ?? []) {
        const hb = await readJson<RepoHeartbeatFile>(
          path.join(comms, 'heartbeats', `${path.basename(agent.id)}.json`),
        );
        const lastHeartbeat = hb?.timestamp ?? null;
        const isLocalRepo =
          process.platform === 'win32'
            ? repoPath.toLowerCase() === localRoot.toLowerCase()
            : repoPath === localRoot;
        const machine =
          agent.machine_id ||
          (isLocalRepo ? localHost : 'unknown');
        repoRows.push({
          agentId: agent.id,
          name: agent.name ?? agent.id,
          role: agent.role ?? '',
          machine,
          repo: repoPath,
          repoLabel,
          status: remoteAgentStatus(lastHeartbeat, now),
          lastHeartbeat,
          currentTask: hb?.current_task ?? null,
        });
      }
    }

    rows.push(...repoRows);
    rollup.push({
      repo: repoPath,
      repoLabel,
      enabled,
      agentCount: repoRows.length,
      activeCount: repoRows.filter(r => r.status === 'active').length,
      stalledCount: repoRows.filter(r => r.status === 'stalled').length,
      offlineCount: repoRows.filter(r => r.status === 'offline').length,
    });
  }

  // Sort the table by machine, then repo label, then agent id — a stable view.
  rows.sort((a, b) => {
    if (a.machine !== b.machine) {
      return a.machine.localeCompare(b.machine);
    }
    if (a.repoLabel !== b.repoLabel) {
      return a.repoLabel.localeCompare(b.repoLabel);
    }
    return a.agentId.localeCompare(b.agentId);
  });
  rollup.sort((a, b) => a.repoLabel.localeCompare(b.repoLabel));

  return { rows, rollup };
}

// ---------------------------------------------------------------------------
// Relay status view
// ---------------------------------------------------------------------------

/**
 * Build the relay posture view. Honest by construction: it reports `active:
 * false` whenever the relay is disabled, has no endpoint, or has no stored
 * token — so the panel never implies transmission that is not happening.
 */
async function buildRelayStatus(workspaceRoot: string): Promise<RelayStatusView> {
  const autoclawDir = autoclawDirOf(workspaceRoot);
  const cfg = await readRelayConfig(autoclawDir);
  const active = relayIsActive(cfg);

  let loggedIn = false;
  try {
    const tok = await getCloudToken(autoclawDir);
    loggedIn = tok.ok;
  } catch {
    loggedIn = false;
  }

  let endpointHost = '';
  if (cfg.endpoint) {
    try {
      endpointHost = new URL(cfg.endpoint).host;
    } catch {
      endpointHost = cfg.endpoint;
    }
  }

  const queued = await queueDepth(autoclawDir).catch(() => 0);

  let summary: string;
  if (!cfg.endpoint) {
    summary = 'Cloud relay disabled — no endpoint configured (local-only).';
  } else if (!cfg.enabled) {
    summary = `Endpoint set (${endpointHost}) but relay is disabled — not transmitting.`;
  } else if (!loggedIn) {
    summary = `Relay enabled (${endpointHost}) but not logged in — run "autoclaw cloud login".`;
  } else {
    summary =
      `Relay active → ${endpointHost}` +
      (queued > 0 ? ` (${queued} item(s) queued offline)` : '');
  }

  return { active: active && loggedIn, loggedIn, endpointHost, queuedItems: queued, summary };
}

// ---------------------------------------------------------------------------
// Top-level builder
// ---------------------------------------------------------------------------

/** Options for {@link buildCloudSection}. */
export interface CloudSectionOptions {
  /** Workspace root containing `.autoclaw/`. */
  workspaceRoot: string;
  /** Injectable clock for deterministic tests. */
  now?: number;
}

/**
 * Build the complete "Remote Agents" Fleet-panel section render-data.
 *
 * The single function the panel calls. When the workspace is not part of a
 * program (no `.autoclaw/program/registry.json`), it falls back to surveying
 * just the host workspace so the section still renders meaningfully — with
 * `standalone: true` so the panel can label it.
 *
 * Pure read-only file I/O; safe to poll on the panel's refresh interval.
 */
export async function buildCloudSection(
  opts: CloudSectionOptions,
): Promise<CloudSectionModel> {
  const now = opts.now ?? Date.now();
  const workspaceRoot = opts.workspaceRoot;

  const programReg = await readJson<ProgramRegistryFile>(programRegistryPath(workspaceRoot));
  const standalone = programReg === null;

  // Program repos, or just the host workspace when standalone.
  const repos: ProgramRepoEntry[] =
    programReg?.repos && programReg.repos.length > 0
      ? programReg.repos
      : [{ path: path.resolve(workspaceRoot), label: path.basename(path.resolve(workspaceRoot)), enabled: true }];

  const [{ rows, rollup }, relay] = await Promise.all([
    buildRemoteAgents(workspaceRoot, repos, now),
    buildRelayStatus(workspaceRoot),
  ]);

  return {
    programName: programReg?.program_name ?? null,
    remoteAgents: rows,
    projectRollup: rollup,
    relay,
    standalone,
  };
}
