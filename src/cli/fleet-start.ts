/**
 * fleet-start.ts — `autoclaw fleet start` CLI (Sprint 2 / WA-4 task H1).
 *
 * Boots the AutoClaw runner fleet:
 *
 *   1. Read `.autoclaw/program/registry.json` to learn which runners to
 *      start. If the file is absent, fall back to detecting every known
 *      runner adapter.
 *   2. `detect()` + register every selected runner, in parallel.
 *   3. Start an LMD (Lightweight Monitoring Daemon) health monitor — as a
 *      detached subprocess when an LMD daemon entry exists, otherwise an
 *      in-process {@link HeartbeatReader} (zero-token, pure file I/O).
 *   4. Report which runners started / failed and the LMD status.
 *
 * The module exports {@link fleetStart} for programmatic use; a thin CLI
 * wrapper (`main`) runs it when the file is invoked directly.
 *
 * NO LLM calls — this is pure orchestration: file I/O, detection probes,
 * and process supervision.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RunnerRegistry } from '../runners/registry';
import type { DetectionResult, Runner } from '../runners/types';
import { codexRunner } from '../runners/codex';
import { hermesRunner } from '../runners/hermes';
import { openclawRunner } from '../runners/openclaw';
import { HeartbeatReader } from '../lmd/heartbeatReader';

/* -------------------------------------------------------------------------- */
/*  Known runners                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every runner adapter AutoClaw ships. The registry.json `runners` list is
 * matched against these by `id`; unknown ids in the file are skipped with
 * a warning.
 */
const KNOWN_RUNNERS: Readonly<Record<string, Runner>> = {
  codex: codexRunner,
  hermes: hermesRunner,
  openclaw: openclawRunner,
};

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/** Shape of `.autoclaw/program/registry.json` (only the fields we read). */
interface ProgramRegistry {
  /** Runner ids to start. When absent, all known runners are detected. */
  runners?: string[];
}

/** Per-runner outcome of the fleet-start detection pass. */
export interface RunnerStartResult {
  /** Runner id, e.g. `"codex"`. */
  id: string;
  /** True when `detect()` reported the runner usable. */
  started: boolean;
  /** The detection result, for surfacing version / remediation hints. */
  detection: DetectionResult;
}

/** Status of the LMD health monitor after a fleet-start. */
export interface LmdStatus {
  /** True when the monitor was started successfully. */
  running: boolean;
  /** `"subprocess"` or `"in-process"` — which mode the monitor runs in. */
  mode: 'subprocess' | 'in-process' | 'failed';
  /** OS pid when running as a detached subprocess. */
  pid?: number;
  /** Failure detail when `running` is false. */
  error?: string;
}

/** Aggregate result of {@link fleetStart}. */
export interface FleetStartResult {
  /** Per-runner detection outcomes. */
  runners: RunnerStartResult[];
  /** Runners that detected successfully. */
  started: string[];
  /** Runners that failed detection. */
  failed: string[];
  /** LMD health-monitor status. */
  lmd: LmdStatus;
}

/** Options for {@link fleetStart}. */
export interface FleetStartOptions {
  /** Workspace root. Defaults to `process.cwd()`. */
  workspaceRoot?: string;
  /**
   * When true, do not start the LMD monitor (used by tests and by callers
   * that manage their own monitoring).
   */
  skipLmd?: boolean;
  /** Logger seam. Defaults to `console`. */
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  /**
   * Optional pre-built registry — primarily for tests. When supplied the
   * known-runner set and registry.json are ignored.
   */
  registry?: RunnerRegistry;
}

/* -------------------------------------------------------------------------- */
/*  Registry file loading                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read `.autoclaw/program/registry.json`. Returns `null` when the file is
 * absent or unparseable — callers fall back to detecting all known runners.
 */
function loadProgramRegistry(workspaceRoot: string): ProgramRegistry | null {
  const file = path.join(workspaceRoot, '.autoclaw', 'program', 'registry.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // absent — tolerated per the H1 brief.
  }
  try {
    return JSON.parse(raw) as ProgramRegistry;
  } catch {
    return null; // present but malformed — treat as absent.
  }
}

/**
 * Resolve the set of runners to start: those named in registry.json (when
 * present and non-empty), otherwise every known runner.
 */
function resolveRunners(
  registry: ProgramRegistry | null,
  logger: NonNullable<FleetStartOptions['logger']>,
): Runner[] {
  if (registry?.runners && registry.runners.length > 0) {
    const selected: Runner[] = [];
    for (const id of registry.runners) {
      const runner = KNOWN_RUNNERS[id];
      if (runner) {
        selected.push(runner);
      } else {
        logger.warn(`fleet start: registry.json names unknown runner "${id}" — skipped.`);
      }
    }
    // If the file named only unknown runners, fall back rather than start nothing.
    return selected.length > 0 ? selected : Object.values(KNOWN_RUNNERS);
  }
  return Object.values(KNOWN_RUNNERS);
}

/* -------------------------------------------------------------------------- */
/*  LMD monitor                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Start the LMD health monitor.
 *
 * Prefers a detached subprocess (`out/lmd/daemon.js`) when one has been
 * built; otherwise starts an in-process {@link HeartbeatReader}. The
 * in-process reader is pure file I/O and costs no LLM tokens, so it is a
 * safe default.
 */
function startLmdMonitor(
  workspaceRoot: string,
  logger: NonNullable<FleetStartOptions['logger']>,
): LmdStatus {
  // Look for a built LMD daemon entry point next to the compiled output.
  const daemonEntry = path.join(workspaceRoot, 'out', 'lmd', 'daemon.js');
  if (fs.existsSync(daemonEntry)) {
    try {
      const child = spawn(process.execPath, [daemonEntry, '--workspace', workspaceRoot], {
        cwd: workspaceRoot,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      logger.info(`fleet start: LMD monitor running as subprocess (pid ${child.pid}).`);
      return { running: true, mode: 'subprocess', pid: child.pid };
    } catch (err) {
      logger.warn(
        `fleet start: failed to spawn LMD subprocess (${err instanceof Error ? err.message : String(err)}); falling back to in-process monitor.`,
      );
    }
  }

  // In-process fallback: a HeartbeatReader polling the heartbeats directory.
  try {
    const reader = new HeartbeatReader(workspaceRoot);
    reader.start();
    logger.info('fleet start: LMD monitor running in-process (HeartbeatReader).');
    return { running: true, mode: 'in-process' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`fleet start: LMD monitor failed to start: ${message}`);
    return { running: false, mode: 'failed', error: message };
  }
}

/* -------------------------------------------------------------------------- */
/*  fleetStart                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Boot the AutoClaw runner fleet: detect + register all selected runners in
 * parallel and start the LMD health monitor.
 *
 * @param opts - fleet-start options; all optional.
 * @returns the aggregate result (per-runner outcomes + LMD status).
 */
export async function fleetStart(opts: FleetStartOptions = {}): Promise<FleetStartResult> {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const logger = opts.logger ?? console;

  // ---- Resolve + register runners ----------------------------------------
  const registry = opts.registry ?? new RunnerRegistry();
  if (!opts.registry) {
    const programRegistry = loadProgramRegistry(workspaceRoot);
    if (programRegistry === null) {
      logger.info(
        'fleet start: no .autoclaw/program/registry.json — detecting all known runners.',
      );
    }
    for (const runner of resolveRunners(programRegistry, logger)) {
      registry.register(runner);
    }
  }

  // ---- Detect in parallel -------------------------------------------------
  const detected = await registry.detect();
  const runners: RunnerStartResult[] = detected.map((entry) => ({
    id: entry.runner.id,
    started: entry.enabled,
    detection: entry.detection ?? {
      found: false,
      reason: 'not_installed',
      hint: 'detection did not run',
    },
  }));

  const started = runners.filter((r) => r.started).map((r) => r.id);
  const failed = runners.filter((r) => !r.started).map((r) => r.id);

  for (const r of runners) {
    if (r.started && r.detection.found) {
      logger.info(`fleet start: runner "${r.id}" started (v${r.detection.version}).`);
    } else if (!r.detection.found) {
      logger.warn(`fleet start: runner "${r.id}" not started — ${r.detection.hint}`);
    }
  }

  // ---- LMD monitor --------------------------------------------------------
  const lmd: LmdStatus = opts.skipLmd
    ? { running: false, mode: 'failed', error: 'skipped by caller' }
    : startLmdMonitor(workspaceRoot, logger);

  logger.info(
    `fleet start: ${started.length} runner(s) started, ${failed.length} failed; LMD ${lmd.running ? lmd.mode : 'not running'}.`,
  );

  return { runners, started, failed, lmd };
}

/* -------------------------------------------------------------------------- */
/*  CLI wrapper                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Thin CLI entry point for `autoclaw fleet start`.
 *
 * Exits non-zero when no runner could be started, so CI / scripts can gate
 * on a successful fleet boot.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // Support `--workspace <path>`; default to cwd.
  const wsIdx = argv.indexOf('--workspace');
  const workspaceRoot = wsIdx >= 0 && argv[wsIdx + 1] ? argv[wsIdx + 1] : process.cwd();

  const result = await fleetStart({ workspaceRoot });

  if (result.started.length === 0) {
    console.error('fleet start: no runners could be started — see hints above.');
    process.exitCode = 1;
    return;
  }
  console.log(
    `fleet start: ready — runners [${result.started.join(', ')}]` +
      (result.failed.length > 0 ? `, unavailable [${result.failed.join(', ')}]` : '') +
      `; LMD ${result.lmd.mode}.`,
  );
}

// Run as a CLI when invoked directly (not when imported).
if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error('fleet start: fatal error:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
