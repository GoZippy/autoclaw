/**
 * sources/discovery.ts — runner-registry-backed source discovery (R1.1-R1.4).
 *
 * Wraps the AutoClaw runner registry (`src/runners/`) so the Intelligence Layer
 * auto-discovers which AI tools are installed and where they keep their session
 * data, instead of hand-configuring paths:
 *
 *   - `discoverInstalledTools(opts)` runs `createDefaultRunnerRegistry().detect()`
 *     (lazily, inside try/catch) and maps every {@link RegisteredRunner} to a
 *     {@link DiscoveredTool} carrying installed-state + per-OS data locations.
 *   - A runner-reported location is preferred; for runner-uncovered tools (and
 *     when detection itself fails), each adapter contributes its own per-OS probe
 *     via {@link runnerDataLocations} (R1.3).
 *   - Discovery NEVER throws (R1.4). A misbehaving registry or runner degrades to
 *     a tool marked unavailable with a hint; the run continues.
 *
 * No `vscode` import. The runner registry is injected (or lazily required) so the
 * module — and its tests — stay host-free and runnable under plain mocha.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { LogFn } from '../config';
import type { AdapterEnv } from '../types';
import { toForwardSlash } from '../paths';
import { resolveCursorBaseDir } from './cursor';

// A runner detection result, structurally typed so tests can stub the registry
// without constructing the real `RunnerRegistry`.
import type { RegisteredRunner } from '../../runners';

/** Minimal structural shape of the runner registry this module consumes. */
export interface RunnerDetector {
  detect(): Promise<RegisteredRunner[]>;
}

/** A tool discovered (or probed for) on this machine. */
export interface DiscoveredTool {
  /** Runner id (e.g. `claude-code`); also the discovery key. */
  id: string;
  /** The Source Adapter id this tool maps to, when one exists. */
  adapterId?: string;
  /** Human-readable tool name. */
  displayName: string;
  /** Whether the runner reported the host as installed + usable. */
  installed: boolean;
  /** Concrete data locations found on disk (forward-slash), newest probe wins. */
  dataLocations: string[];
  /** Reported host version, when detection produced one. */
  version?: string;
  /** Remediation/explanation hint when unavailable or partially available. */
  hint?: string;
}

/** Options for {@link discoverInstalledTools}. */
export interface DiscoverToolsOptions {
  /** Discovery/probe environment (home dir, platform, env vars). */
  env: AdapterEnv;
  /**
   * Injected runner registry (tests). When omitted, `createDefaultRunnerRegistry`
   * is lazily required and `detect()`-ed inside a try/catch.
   */
  registry?: RunnerDetector;
  /** Optional warning sink (logger-injection convention). */
  log?: LogFn;
}

/** Friendly display names per runner id. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'OpenAI Codex',
  cursor: 'Cursor',
  kiro: 'Kiro',
  'gemini-cli': 'Gemini CLI',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  autogpt: 'AutoGPT',
};

/** Runner id → Source Adapter id (only the tools the layer ingests). */
export const RUNNER_TO_ADAPTER: Readonly<Record<string, string>> = {
  'claude-code': 'claude-code',
  'claude-desktop': 'claude-desktop',
  kiro: 'kiro',
  'gemini-cli': 'gemini',
  cursor: 'cursor',
};

function existsDir(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Per-OS candidate data locations a runner's transcripts live in. Returns the
 * canonical locations whether or not they currently exist; callers filter to the
 * present ones (and fall back to the canonical path + hint when none exist).
 *
 * Cross-OS: paths are derived from {@link AdapterEnv.homeDir} / `env` — never a
 * hardcoded `/home` or `~`.
 */
export function runnerDataLocations(runnerId: string, env: AdapterEnv): string[] {
  const home = env.homeDir;
  switch (runnerId) {
    case 'claude-code':
    case 'claude-desktop': {
      const locs = home ? [path.join(home, '.claude', 'projects')] : [];
      // The desktop runner also persists a session index inside the workspace.
      if (runnerId === 'claude-desktop' && env.workspaceRoot) {
        locs.push(path.join(env.workspaceRoot, '.autoclaw', 'runners'));
      }
      return locs;
    }
    case 'kiro': {
      const locs: string[] = [];
      if (home) {
        locs.push(path.join(home, '.kiro'));
      }
      if (env.workspaceRoot) {
        locs.push(path.join(env.workspaceRoot, '.kiro', 'specs'));
      }
      return locs;
    }
    case 'gemini-cli':
      return home ? [path.join(home, '.gemini')] : [];
    case 'codex':
      return home ? [path.join(home, '.codex')] : [];
    case 'cursor': {
      const base = resolveCursorBaseDir(env);
      return base ? [path.join(base, 'User', 'globalStorage', 'state.vscdb')] : [];
    }
    default:
      return [];
  }
}

/** Probe the canonical locations for `runnerId`, returning those that exist. */
function probeLocations(runnerId: string, env: AdapterEnv): string[] {
  return runnerDataLocations(runnerId, env)
    .filter((p) => existsDir(p))
    .map((p) => toForwardSlash(p));
}

/** Lazily obtain the default runner registry; never throws. */
function lazyDefaultRegistry(log: LogFn): RunnerDetector | undefined {
  try {
    // Lazy require keeps the heavy runner graph off the import path so plain
    // mocha unit tests (which inject a stub) never load it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../runners');
    if (mod && typeof mod.createDefaultRunnerRegistry === 'function') {
      return mod.createDefaultRunnerRegistry() as RunnerDetector;
    }
  } catch (err) {
    log(`discovery: could not load runner registry (${(err as Error).message})`);
  }
  return undefined;
}

/**
 * Discover installed AI tools and their data locations by reusing the runner
 * registry's detection. Never throws (R1.4): a registry that fails to load or
 * whose `detect()` rejects degrades to a per-runner probe-only result.
 */
export async function discoverInstalledTools(
  opts: DiscoverToolsOptions,
): Promise<DiscoveredTool[]> {
  const log: LogFn = opts.log ?? (() => undefined);
  const env = opts.env;
  const registry = opts.registry ?? lazyDefaultRegistry(log);

  let registered: RegisteredRunner[] = [];
  if (registry) {
    try {
      registered = await registry.detect();
    } catch (err) {
      // The real RunnerRegistry.detect already isolates per-runner failures, so
      // a rejection here is an unexpected registry-level fault — degrade to the
      // known runner ids probed directly.
      log(`discovery: registry detect failed (${(err as Error).message}); probing known tools`);
      registered = [];
    }
  }

  if (registered.length > 0) {
    return registered.map((entry) => toDiscoveredTool(entry, env));
  }

  // Fallback (R1.3): no registry / empty detection — probe the known tool ids.
  return Object.keys(RUNNER_TO_ADAPTER).map((id) => probeOnly(id, env));
}

/** Map one detected runner to a {@link DiscoveredTool}, isolating any fault. */
function toDiscoveredTool(entry: RegisteredRunner, env: AdapterEnv): DiscoveredTool {
  const id = entry.runner?.id ?? 'unknown';
  const displayName = DISPLAY_NAMES[id] ?? id;
  const adapterId = RUNNER_TO_ADAPTER[id];
  try {
    const detection = entry.detection;
    const installed = entry.enabled === true || detection?.found === true;
    const locations = probeLocations(id, env);
    const hint = buildHint(id, installed, locations, detection);
    return {
      id,
      adapterId,
      displayName,
      installed,
      dataLocations: locations,
      version: detection && detection.found ? detection.version : undefined,
      hint,
    };
  } catch (err) {
    // Per-runner isolation — never let one mapping abort discovery.
    return {
      id,
      adapterId,
      displayName,
      installed: false,
      dataLocations: [],
      hint: `discovery failed: ${(err as Error).message}`,
    };
  }
}

/** Probe-only discovery for a tool id when no detection info is available. */
function probeOnly(id: string, env: AdapterEnv): DiscoveredTool {
  const locations = probeLocations(id, env);
  return {
    id,
    adapterId: RUNNER_TO_ADAPTER[id],
    displayName: DISPLAY_NAMES[id] ?? id,
    installed: locations.length > 0,
    dataLocations: locations,
    hint:
      locations.length > 0
        ? undefined
        : `no data found; probed ${runnerDataLocations(id, env)
            .map((p) => toForwardSlash(p))
            .join(', ') || '(no known location for this platform)'}`,
  };
}

function buildHint(
  id: string,
  installed: boolean,
  locations: string[],
  detection: RegisteredRunner['detection'],
): string | undefined {
  if (!installed && detection && !detection.found) {
    return detection.hint;
  }
  if (locations.length === 0) {
    return `${DISPLAY_NAMES[id] ?? id} detected but no session data found on disk yet`;
  }
  return undefined;
}
