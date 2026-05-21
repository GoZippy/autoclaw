/**
 * `runner-kiro` — Kiro CLI 2.0 adapter for the AutoClaw runner contract.
 *
 * Drives `kiro-cli chat --no-interactive` as a headless subprocess. Implements
 * the {@link Runner} interface from `./types`.
 *
 * Notable host quirks (RFC §5.3):
 * - Exit code 3 → `errorClass: "mcp_startup"`.
 * - `KIRO_API_KEY` must be present in the subprocess env.
 * - No GA machine-readable JSON output (Kiro issue #5423); the response text
 *   is parsed out of `stdoutTail` in the interim.
 *
 * @see docs/rfc/runner-bridge-contract.md §5.3 (kiro), §7 (health / exit codes)
 */

import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

import type {
  Capabilities,
  DetectionResult,
  DispatchOptions,
  DispatchResult,
  ErrorClass,
  HealthReport,
  Runner,
  SessionSummary,
} from './types';
import { translateTrust } from './registry';

const execFileAsync = promisify(execFile);

/** Host executable name. Resolved from `$PATH`. */
const KIRO_BIN = 'kiro-cli';

/** Env var the Kiro CLI requires for authentication. */
const KIRO_API_KEY_ENV = 'KIRO_API_KEY';

/** Max bytes of stdout retained on {@link DispatchResult.stdoutTail}. */
const STDOUT_TAIL_BYTES = 4096;

/** Default soft time cap when {@link DispatchOptions.timeoutMs} is unset. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** Kiro CLI exit code that signals MCP servers failed to start (RFC §5.3). */
const KIRO_EXIT_MCP_STARTUP = 3;

/**
 * Map a `kiro-cli` process exit code to a normalized {@link ErrorClass}.
 *
 * @param exitCode - the subprocess exit code (or `null` if killed by signal).
 * @param timedOut - whether the orchestrator's soft cap was exceeded.
 */
function classifyKiroExit(exitCode: number | null, timedOut: boolean): ErrorClass | undefined {
  if (timedOut) {
    return 'timeout';
  }
  switch (exitCode) {
    case 0:
      return undefined;
    case null:
      return 'internal'; // killed by signal
    case 1:
      return 'auth'; // kiro-cli: bad/missing KIRO_API_KEY or expired token
    case KIRO_EXIT_MCP_STARTUP:
      return 'mcp_startup'; // RFC §5.3
    case 4:
      return 'tool_denied'; // kiro-cli: trust preset blocked a needed tool
    default:
      return 'internal';
  }
}

/** Keep only the trailing {@link STDOUT_TAIL_BYTES} of a captured buffer. */
function tail(text: string): string {
  return text.length > STDOUT_TAIL_BYTES ? text.slice(-STDOUT_TAIL_BYTES) : text;
}

/**
 * Kiro runner. One instance is registered with the
 * {@link import('./registry').RunnerRegistry} at startup.
 */
export class KiroRunner implements Runner {
  readonly id = 'kiro';

  readonly capabilities: Capabilities = {
    resumableSessions: true,
    // JSON output is roadmap, not GA (Kiro #5423) — we parse text for now.
    jsonStructuredOutput: false,
    mcpServers: true,
    browser: false,
    customAgents: true,
    toolTrustGranularity: 'categories',
  };

  /** Timestamp of the most recent dispatch, for {@link health}. */
  private lastDispatchAt: string | undefined;

  /** Rolling error tally by class, surfaced via {@link health}. */
  private readonly errorTally = new Map<ErrorClass, number>();

  /** @see Runner.detect — probes `kiro-cli --version` and `$KIRO_API_KEY`. */
  async detect(): Promise<DetectionResult> {
    let version: string;
    try {
      const { stdout } = await execFileAsync(KIRO_BIN, ['--version'], { timeout: 10_000 });
      version = stdout.trim() || 'unknown';
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        return {
          found: false,
          reason: 'not_installed',
          hint: 'kiro-cli not found on PATH. Install Kiro CLI 2.0 (Kiro Pro+ subscription required).',
        };
      }
      return {
        found: false,
        reason: 'not_installed',
        hint: `kiro-cli --version failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!process.env[KIRO_API_KEY_ENV]) {
      return {
        found: false,
        reason: 'no_auth',
        hint: `${KIRO_API_KEY_ENV} is not set. Provide a workspace-scoped Kiro API key.`,
      };
    }
    return { found: true, version, path: KIRO_BIN };
  }

  /**
   * Build the `kiro-cli chat` argument list for a dispatch.
   *
   * Exposed for unit tests (RFC §8.1 flag-translation tests).
   *
   * @param opts - the dispatch options.
   * @returns the argument vector passed to `spawn`.
   */
  buildArgs(opts: DispatchOptions): string[] {
    const args = ['chat', '--no-interactive'];
    // §3 trust-preset translation: off → no flag, auto → --trust-tools=…,
    // turbo → --trust-all-tools (see TRUST_PRESET_TABLE).
    const trust = translateTrust(this.id, opts.trust);
    args.push(...trust.flags);
    if (opts.requireMcp === true) {
      args.push('--require-mcp-startup');
    }
    if (opts.agentProfile !== undefined) {
      args.push('--agent', opts.agentProfile);
    }
    if (opts.sessionId !== undefined) {
      args.push('--resume-id', opts.sessionId);
    }
    // Positional prompt always last.
    args.push(opts.prompt);
    return args;
  }

  /** @see Runner.dispatch */
  async dispatch(opts: DispatchOptions): Promise<DispatchResult> {
    return this.run(this.buildArgs(opts), opts.sessionId, opts.timeoutMs, opts.env, opts.workingDir);
  }

  /** @see Runner.resume */
  async resume(
    sessionId: string,
    prompt: string,
    opts?: Partial<DispatchOptions>,
  ): Promise<DispatchResult> {
    const merged: DispatchOptions = {
      prompt,
      sessionId,
      trust: opts?.trust ?? 'auto',
      trustAllowList: opts?.trustAllowList,
      trustDenyList: opts?.trustDenyList,
      agentProfile: opts?.agentProfile,
      requireMcp: opts?.requireMcp,
      workingDir: opts?.workingDir ?? process.cwd(),
      env: opts?.env,
      timeoutMs: opts?.timeoutMs,
      scope: opts?.scope,
    };
    return this.dispatch(merged);
  }

  /**
   * @see Runner.listSessions
   *
   * Shells out to `kiro-cli chat --list-sessions` (RFC §5.3) and parses the
   * line-oriented output. The host has no JSON mode yet (#5423), so this is
   * best-effort: each non-empty line is treated as a session id.
   */
  async listSessions(): Promise<SessionSummary[]> {
    try {
      const { stdout } = await execFileAsync(KIRO_BIN, ['chat', '--list-sessions'], {
        timeout: 15_000,
        env: { ...process.env },
      });
      const now = new Date().toISOString();
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => ({
          sessionId: line.split(/\s+/)[0],
          createdAt: now,
          status: 'idle' as const,
          promptPreview: line,
        }));
    } catch {
      return [];
    }
  }

  /** @see Runner.health */
  async health(): Promise<HealthReport> {
    const detection = await this.detect();
    const authPresent = Boolean(process.env[KIRO_API_KEY_ENV]);
    let cliVersion = 'not_installed';
    if (detection.found) {
      cliVersion = detection.version;
    } else if (detection.reason === 'no_auth') {
      cliVersion = 'installed';
    }
    return {
      ok: detection.found,
      authPresent,
      cliVersion,
      mcpServersConfigured: 0,
      lastDispatchAt: this.lastDispatchAt,
      recentErrors: [...this.errorTally.entries()].map(([cls, count]) => ({
        class: cls,
        count,
      })),
    };
  }

  /**
   * @see Runner.cancel
   *
   * Best-effort: deletes the host session via `kiro-cli chat
   * --delete-session <id>` (RFC §5.3). Failures are swallowed so callers can
   * treat cancel uniformly across runners.
   */
  async cancel(sessionId: string): Promise<void> {
    try {
      await execFileAsync(KIRO_BIN, ['chat', '--delete-session', sessionId], {
        timeout: 15_000,
        env: { ...process.env },
      });
    } catch {
      // No-op: orchestrator's timeout kill is the hard guarantee.
    }
  }

  /**
   * Spawn `kiro-cli`, capture output, and normalize the result.
   *
   * @param args        - the argument vector.
   * @param sessionId   - resumed session id, echoed back when present.
   * @param timeoutMs   - soft cap; the subprocess is killed at this value.
   * @param env         - extra environment variables (merged over process env).
   * @param workingDir  - subprocess cwd.
   */
  private run(
    args: string[],
    sessionId: string | undefined,
    timeoutMs: number | undefined,
    env: Record<string, string> | undefined,
    workingDir: string,
  ): Promise<DispatchResult> {
    const startedAt = Date.now();
    const cap = timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<DispatchResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(KIRO_BIN, args, {
        cwd: workingDir,
        env: { ...process.env, ...env },
      });

      const killer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, cap);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const finish = (exitCode: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(killer);
        const errorClass = classifyKiroExit(exitCode, timedOut);
        if (errorClass !== undefined) {
          this.errorTally.set(errorClass, (this.errorTally.get(errorClass) ?? 0) + 1);
        }
        const finishedAt = new Date();
        this.lastDispatchAt = finishedAt.toISOString();
        resolve({
          ok: errorClass === undefined,
          sessionId: sessionId ?? `kiro-${startedAt}`,
          exitCode: exitCode ?? -1,
          finishedAt: finishedAt.toISOString(),
          durationMs: Date.now() - startedAt,
          errorClass,
          // RFC §5.3: no GA JSON output — the response text is in stdout.
          stdoutTail: tail(stdout || stderr),
        });
      };

      child.on('error', (err: Error) => {
        stderr += `\n[spawn error] ${err.message}`;
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  }
}

/** Singleton runner instance for registration. */
export const kiroRunner = new KiroRunner();
