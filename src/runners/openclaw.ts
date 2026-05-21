/**
 * openclaw.ts — `runner-openclaw` adapter (Sprint 2 / WA-4 task F3).
 *
 * OpenClaw is a hybrid host: it ships a CLI (`openclaw`) and, when
 * configured, an HTTP endpoint. This adapter prefers whichever surface is
 * available, in this order:
 *
 *   1. `OPENCLAW_ENDPOINT` set + reachable → REST mode.
 *   2. `openclaw` CLI on PATH                → CLI mode.
 *
 * - `detect()`   — CLI `openclaw --version`, or endpoint health.
 * - `dispatch()` — `openclaw submit --manifest <file>` (CLI) or `POST /jobs` (REST).
 * - Task IDs     — OpenClaw mints its own job IDs; this adapter keeps a
 *                  bidirectional map between OpenClaw job IDs and AutoClaw
 *                  sprint task IDs (carried as `sessionId`).
 *
 * NO direct LLM calls — OpenClaw is the agent host.
 *
 * @see docs/rfc/runner-bridge-contract.md §2, §3, §7
 */

import { spawn, execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  Capabilities,
  DetectionResult,
  DispatchOptions,
  DispatchResult,
  ErrorClass,
  HealthReport,
  Runner,
  SessionSummary,
  TrustPreset,
} from './types';

/* -------------------------------------------------------------------------- */
/*  Trust translation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * OpenClaw exposes a `--trust` flag (CLI) / `trust` field (REST) with three
 * levels that line up 1:1 with the AutoClaw presets.
 */
export const OPENCLAW_TRUST: Readonly<Record<TrustPreset, string>> = {
  off: 'gated',
  auto: 'supervised',
  turbo: 'unattended',
};

/** Translate an AutoClaw {@link TrustPreset} into the OpenClaw trust level. */
export function openclawTrust(preset: TrustPreset): string {
  return OPENCLAW_TRUST[preset] ?? OPENCLAW_TRUST.off;
}

/** OpenClaw CLI trust flag fragment. */
export function openclawTrustFlags(preset: TrustPreset): string[] {
  return ['--trust', openclawTrust(preset)];
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

/** OpenClaw CLI binary; overridable via `AUTOCLAW_OPENCLAW_BIN` for tests. */
const OPENCLAW_BIN = process.env.AUTOCLAW_OPENCLAW_BIN ?? 'openclaw';

const STDOUT_TAIL_BYTES = 4096;
const POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_CEILING_MS = 600_000;

/** Resolve the OpenClaw REST endpoint, trimming a trailing slash. */
function openclawEndpoint(): string | null {
  const raw = process.env.OPENCLAW_ENDPOINT;
  if (!raw || raw.trim() === '') {
    return null;
  }
  return raw.trim().replace(/\/+$/, '');
}

/** Auth header block, present only when `OPENCLAW_TOKEN` is configured. */
function authHeaders(): Record<string, string> {
  const token = process.env.OPENCLAW_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `openclaw --version`; resolves null if the binary is absent. */
function probeOpenclawVersion(): Promise<{ version: string } | null> {
  return new Promise((resolve) => {
    execFile(OPENCLAW_BIN, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : { version: stdout.trim() || 'unknown' });
    });
  });
}

/** Resolve the absolute path of the openclaw executable, best-effort. */
function probeOpenclawPath(): Promise<string> {
  return new Promise((resolve) => {
    const which = process.platform === 'win32' ? 'where' : 'which';
    execFile(which, [OPENCLAW_BIN], { timeout: 10_000 }, (err, stdout) => {
      resolve(err ? OPENCLAW_BIN : stdout.split(/\r?\n/)[0].trim() || OPENCLAW_BIN);
    });
  });
}

/** Map an OpenClaw CLI exit code / stderr to a normalized {@link ErrorClass}. */
function openclawExitToErrorClass(exitCode: number, stderr: string): ErrorClass {
  const lc = stderr.toLowerCase();
  if (lc.includes('auth') || lc.includes('token') || lc.includes('401')) {
    return 'auth';
  }
  if (lc.includes('trust') || lc.includes('denied') || lc.includes('not permitted')) {
    return 'tool_denied';
  }
  if (lc.includes('mcp')) {
    return 'mcp_startup';
  }
  if (exitCode === 124) {
    return 'timeout';
  }
  return 'internal';
}

/** Shape of an OpenClaw REST job-status response. */
interface OpenclawJobBody {
  job_id?: string;
  state?: string;
  exit_code?: number;
  output?: string;
  error?: string;
  error_class?: string;
  created_at?: string;
  updated_at?: string;
  prompt_preview?: string;
}

/* -------------------------------------------------------------------------- */
/*  OpenClawRunner                                                            */
/* -------------------------------------------------------------------------- */

/**
 * {@link Runner} adapter for OpenClaw — a hybrid CLI/REST agent host.
 *
 * Maintains a bidirectional map between OpenClaw job IDs and AutoClaw
 * sprint task IDs so the orchestrator can resume / cancel by either key.
 */
export class OpenClawRunner implements Runner {
  readonly id = 'openclaw';

  readonly capabilities: Capabilities = {
    resumableSessions: true,
    jsonStructuredOutput: true,
    mcpServers: true,
    browser: false,
    customAgents: true,
    toolTrustGranularity: 'categories',
  };

  /** AutoClaw sprint task id → OpenClaw job id. */
  private readonly taskToJob = new Map<string, string>();
  /** OpenClaw job id → AutoClaw sprint task id. */
  private readonly jobToTask = new Map<string, string>();

  private readonly recentErrors = new Map<ErrorClass, number>();
  private lastDispatchAt: string | undefined;

  /**
   * Record the OpenClaw ↔ AutoClaw task-id correspondence so later
   * `resume`/`cancel` calls can translate in either direction.
   */
  private linkIds(autoclawTaskId: string, openclawJobId: string): void {
    this.taskToJob.set(autoclawTaskId, openclawJobId);
    this.jobToTask.set(openclawJobId, autoclawTaskId);
  }

  /** Translate an AutoClaw sprint task id to its OpenClaw job id, if known. */
  resolveJobId(autoclawTaskId: string): string | undefined {
    return this.taskToJob.get(autoclawTaskId);
  }

  /** Translate an OpenClaw job id back to its AutoClaw sprint task id, if known. */
  resolveTaskId(openclawJobId: string): string | undefined {
    return this.jobToTask.get(openclawJobId);
  }

  /**
   * Probe whether OpenClaw is usable: REST endpoint first, then CLI.
   */
  async detect(): Promise<DetectionResult> {
    const endpoint = openclawEndpoint();
    if (endpoint !== null) {
      try {
        const res = await fetch(`${endpoint}/health`, {
          method: 'GET',
          headers: authHeaders(),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401 || res.status === 403) {
          return {
            found: false,
            reason: 'no_auth',
            hint: 'OpenClaw endpoint rejected the request (401/403). Set a valid OPENCLAW_TOKEN.',
          };
        }
        if (res.ok) {
          let version = 'unknown';
          try {
            const body = (await res.json()) as { version?: string };
            if (typeof body.version === 'string') {
              version = body.version;
            }
          } catch {
            /* non-JSON health body acceptable */
          }
          return { found: true, version, path: endpoint };
        }
      } catch {
        // Endpoint configured but unreachable — fall through to CLI probe.
      }
    }

    const probe = await probeOpenclawVersion();
    if (probe === null) {
      return {
        found: false,
        reason: 'not_installed',
        hint:
          endpoint !== null
            ? `OpenClaw endpoint ${endpoint} unreachable and \`${OPENCLAW_BIN}\` CLI not found.`
            : `OpenClaw CLI not found. Install it and ensure \`${OPENCLAW_BIN}\` is on PATH, or set OPENCLAW_ENDPOINT.`,
      };
    }
    const cliPath = await probeOpenclawPath();
    return { found: true, version: probe.version, path: cliPath };
  }

  /**
   * Submit work to OpenClaw. Uses the REST endpoint when configured,
   * otherwise `openclaw submit --manifest <file>`.
   */
  async dispatch(opts: DispatchOptions): Promise<DispatchResult> {
    const startedAt = Date.now();
    const autoclawTaskId = opts.sessionId ?? `openclaw-${crypto.randomUUID()}`;

    const endpoint = openclawEndpoint();
    if (endpoint !== null) {
      return await this.dispatchRest(endpoint, autoclawTaskId, opts, startedAt);
    }
    return await this.dispatchCli(autoclawTaskId, opts, startedAt);
  }

  /* ---- REST dispatch ----------------------------------------------------- */

  private async dispatchRest(
    endpoint: string,
    autoclawTaskId: string,
    opts: DispatchOptions,
    startedAt: number,
  ): Promise<DispatchResult> {
    let jobId: string;
    try {
      const submitRes = await fetch(`${endpoint}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          prompt: opts.prompt,
          trust: openclawTrust(opts.trust),
          working_dir: opts.workingDir,
          autoclaw_task_id: autoclawTaskId,
          agent_profile: opts.agentProfile,
          trust_allow_list: opts.trustAllowList,
          trust_deny_list: opts.trustDenyList,
          require_mcp: opts.requireMcp,
          env: opts.env,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (submitRes.status === 401 || submitRes.status === 403) {
        return this.fail(startedAt, autoclawTaskId, 'auth', submitRes.status);
      }
      if (!submitRes.ok) {
        return this.fail(startedAt, autoclawTaskId, 'internal', submitRes.status);
      }
      const body = (await submitRes.json()) as { job_id?: string; id?: string };
      const id = body.job_id ?? body.id;
      if (!id) {
        return this.fail(startedAt, autoclawTaskId, 'internal', -1);
      }
      jobId = id;
    } catch (err) {
      const cls: ErrorClass =
        err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'internal';
      return this.fail(startedAt, autoclawTaskId, cls, -1);
    }

    this.linkIds(autoclawTaskId, jobId);

    const ceiling =
      opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs * 2 : DEFAULT_POLL_CEILING_MS;
    while (Date.now() - startedAt < ceiling) {
      let body: OpenclawJobBody;
      try {
        const res = await fetch(`${endpoint}/jobs/${encodeURIComponent(jobId)}`, {
          method: 'GET',
          headers: authHeaders(),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          await delay(POLL_INTERVAL_MS);
          continue;
        }
        body = (await res.json()) as OpenclawJobBody;
      } catch {
        await delay(POLL_INTERVAL_MS);
        continue;
      }

      const state = (body.state ?? '').toLowerCase();
      if (state === 'completed' || state === 'succeeded' || state === 'done') {
        const finishedAt = new Date();
        this.lastDispatchAt = finishedAt.toISOString();
        return {
          ok: true,
          sessionId: autoclawTaskId,
          exitCode: body.exit_code ?? 0,
          finishedAt: finishedAt.toISOString(),
          durationMs: Date.now() - startedAt,
          stdoutTail: (body.output ?? '').slice(-STDOUT_TAIL_BYTES),
        };
      }
      if (state === 'failed' || state === 'error' || state === 'cancelled') {
        const errorClass = mapOpenclawErrorClass(body.error_class);
        return this.fail(
          startedAt,
          autoclawTaskId,
          errorClass,
          body.exit_code ?? -1,
          (body.error ?? body.output ?? '').slice(-STDOUT_TAIL_BYTES),
        );
      }
      await delay(POLL_INTERVAL_MS);
    }
    return this.fail(startedAt, autoclawTaskId, 'timeout', -1);
  }

  /* ---- CLI dispatch ------------------------------------------------------ */

  private async dispatchCli(
    autoclawTaskId: string,
    opts: DispatchOptions,
    startedAt: number,
  ): Promise<DispatchResult> {
    // Write a manifest file describing the job, then `openclaw submit --manifest`.
    const manifestPath = path.join(
      os.tmpdir(),
      `autoclaw-openclaw-${autoclawTaskId.replace(/[^\w.-]/g, '_')}.json`,
    );
    const manifest = {
      autoclaw_task_id: autoclawTaskId,
      prompt: opts.prompt,
      trust: openclawTrust(opts.trust),
      working_dir: opts.workingDir,
      agent_profile: opts.agentProfile,
      trust_allow_list: opts.trustAllowList,
      trust_deny_list: opts.trustDenyList,
      require_mcp: opts.requireMcp ?? false,
    };
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    } catch {
      return this.fail(startedAt, autoclawTaskId, 'internal', -1);
    }

    const args = [
      'submit',
      '--manifest',
      manifestPath,
      ...openclawTrustFlags(opts.trust),
    ];

    return await new Promise<DispatchResult>((resolve) => {
      const child = spawn(OPENCLAW_BIN, args, {
        cwd: opts.workingDir,
        env: { ...process.env, ...(opts.env ?? {}) },
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeoutMs = opts.timeoutMs;
      const killTimer =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => child.kill('SIGKILL'), timeoutMs * 2)
          : null;
      let timedOut = false;
      const softTimer =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
            }, timeoutMs)
          : null;

      const cleanupManifest = (): void => {
        try {
          fs.unlinkSync(manifestPath);
        } catch {
          /* best-effort */
        }
      };

      const finish = (exitCode: number, errorClass?: ErrorClass): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (killTimer) {
          clearTimeout(killTimer);
        }
        if (softTimer) {
          clearTimeout(softTimer);
        }
        cleanupManifest();

        // OpenClaw CLI prints the minted job id on the first stdout line as
        // `job: <id>` — capture it for the id map when present.
        const jobMatch = stdout.match(/job[:\s]+([\w-]+)/i);
        if (jobMatch) {
          this.linkIds(autoclawTaskId, jobMatch[1]);
        }

        const finishedAt = new Date();
        this.lastDispatchAt = finishedAt.toISOString();
        const ok = exitCode === 0 && errorClass === undefined;
        if (!ok && errorClass) {
          this.recentErrors.set(errorClass, (this.recentErrors.get(errorClass) ?? 0) + 1);
        }
        resolve({
          ok,
          sessionId: autoclawTaskId,
          exitCode,
          finishedAt: finishedAt.toISOString(),
          durationMs: Date.now() - startedAt,
          errorClass,
          stdoutTail: stdout.slice(-STDOUT_TAIL_BYTES),
        });
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > STDOUT_TAIL_BYTES * 4) {
          stdout = stdout.slice(-STDOUT_TAIL_BYTES * 2);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', () => finish(-1, 'internal'));
      child.on('close', (code) => {
        const exitCode = code ?? -1;
        if (timedOut) {
          finish(exitCode, 'timeout');
          return;
        }
        if (exitCode === 0) {
          finish(0);
          return;
        }
        finish(exitCode, openclawExitToErrorClass(exitCode, stderr));
      });
    });
  }

  /** Build a failed {@link DispatchResult} and record the error class. */
  private fail(
    startedAt: number,
    sessionId: string,
    errorClass: ErrorClass,
    exitCode: number,
    stdoutTail?: string,
  ): DispatchResult {
    this.recentErrors.set(errorClass, (this.recentErrors.get(errorClass) ?? 0) + 1);
    const finishedAt = new Date();
    this.lastDispatchAt = finishedAt.toISOString();
    return {
      ok: false,
      sessionId,
      exitCode,
      finishedAt: finishedAt.toISOString(),
      durationMs: Date.now() - startedAt,
      errorClass,
      stdoutTail,
    };
  }

  /** Resume an OpenClaw job, carrying the AutoClaw task id forward. */
  async resume(
    sessionId: string,
    prompt: string,
    opts?: Partial<DispatchOptions>,
  ): Promise<DispatchResult> {
    return await this.dispatch({
      prompt,
      trust: opts?.trust ?? 'auto',
      workingDir: opts?.workingDir ?? process.cwd(),
      sessionId,
      ...opts,
    });
  }

  /** List OpenClaw jobs (REST mode) or the locally-mapped jobs (CLI mode). */
  async listSessions(): Promise<SessionSummary[]> {
    const endpoint = openclawEndpoint();
    if (endpoint !== null) {
      try {
        const res = await fetch(`${endpoint}/jobs`, {
          method: 'GET',
          headers: authHeaders(),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const body = (await res.json()) as
            | { jobs?: OpenclawJobBody[] }
            | OpenclawJobBody[];
          const jobs = Array.isArray(body) ? body : (body.jobs ?? []);
          return jobs.map((j) => ({
            sessionId: this.jobToTask.get(j.job_id ?? '') ?? j.job_id ?? 'unknown',
            createdAt: j.created_at ?? new Date(0).toISOString(),
            lastActivityAt: j.updated_at,
            status: mapOpenclawState(j.state),
            promptPreview: j.prompt_preview,
          }));
        }
      } catch {
        // Fall through to local map.
      }
    }
    // CLI mode: report what the id map knows.
    return [...this.taskToJob.keys()].map((taskId) => ({
      sessionId: taskId,
      createdAt: new Date(0).toISOString(),
      status: 'idle' as const,
    }));
  }

  /** Report runner health by re-probing OpenClaw. */
  async health(): Promise<HealthReport> {
    const detection = await this.detect();
    const recentErrors = [...this.recentErrors.entries()].map(([cls, count]) => ({
      class: cls,
      count,
    }));
    return {
      ok: detection.found,
      authPresent: !(detection.found === false && detection.reason === 'no_auth'),
      cliVersion: detection.found ? detection.version : 'not_found',
      mcpServersConfigured: this.capabilities.mcpServers ? 1 : 0,
      lastDispatchAt: this.lastDispatchAt,
      recentErrors,
    };
  }

  /** Cancel an OpenClaw job, accepting either an AutoClaw task id or job id. */
  async cancel(sessionId: string): Promise<void> {
    const endpoint = openclawEndpoint();
    if (endpoint === null) {
      return;
    }
    // Accept either id form.
    const jobId = this.taskToJob.get(sessionId) ?? sessionId;
    try {
      await fetch(`${endpoint}/jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: authHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Best-effort; the orchestrator will time the job out.
    }
  }
}

/** Map a raw OpenClaw `error_class` string to a normalized {@link ErrorClass}. */
function mapOpenclawErrorClass(raw: string | undefined): ErrorClass {
  switch ((raw ?? '').toLowerCase()) {
    case 'auth':
    case 'unauthorized':
      return 'auth';
    case 'timeout':
      return 'timeout';
    case 'tool_denied':
    case 'permission_denied':
      return 'tool_denied';
    case 'mcp_startup':
    case 'mcp':
      return 'mcp_startup';
    default:
      return 'internal';
  }
}

/** Map a raw OpenClaw job state to a {@link SessionSummary} status. */
function mapOpenclawState(state: string | undefined): SessionSummary['status'] {
  switch ((state ?? '').toLowerCase()) {
    case 'completed':
    case 'succeeded':
    case 'done':
      return 'completed';
    case 'failed':
    case 'error':
    case 'cancelled':
      return 'failed';
    case 'running':
    case 'pending':
    case 'queued':
      return 'active';
    default:
      return 'idle';
  }
}

/** Convenience singleton — registered with the {@link import('./registry').RunnerRegistry}. */
export const openclawRunner = new OpenClawRunner();
