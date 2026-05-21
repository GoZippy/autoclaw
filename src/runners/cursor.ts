/**
 * `runner-cursor` — Cursor adapter for the AutoClaw runner contract.
 *
 * Drives `cursor-agent --no-interactive` as a headless subprocess. Implements
 * the {@link Runner} interface from `./types`; the orchestrator only ever
 * speaks that contract.
 *
 * @see docs/rfc/runner-bridge-contract.md §5.2 (cursor), §7 (health / exit codes)
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
const CURSOR_BIN = 'cursor-agent';

/** Max bytes of stdout retained on {@link DispatchResult.stdoutTail}. */
const STDOUT_TAIL_BYTES = 4096;

/** Default soft time cap when {@link DispatchOptions.timeoutMs} is unset. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Map a `cursor-agent` process exit code to a normalized {@link ErrorClass}.
 *
 * `cursor-agent` does not (yet) publish a stable exit-code table, so the
 * mapping is conservative: only well-known POSIX-ish conventions are
 * recognized, everything else is `internal`.
 *
 * @param exitCode - the subprocess exit code (or `null` if killed by signal).
 * @param timedOut - whether the orchestrator's soft cap was exceeded.
 */
function classifyCursorExit(exitCode: number | null, timedOut: boolean): ErrorClass | undefined {
  if (timedOut) {
    return 'timeout';
  }
  switch (exitCode) {
    case 0:
      return undefined;
    case null:
      return 'internal'; // killed by signal
    case 2:
      return 'auth'; // cursor-agent: bad/missing credentials
    case 4:
      return 'tool_denied'; // cursor-agent: an approval was refused
    default:
      return 'internal';
  }
}

/** Keep only the trailing {@link STDOUT_TAIL_BYTES} of a captured buffer. */
function tail(text: string): string {
  return text.length > STDOUT_TAIL_BYTES ? text.slice(-STDOUT_TAIL_BYTES) : text;
}

/**
 * Cursor runner. One instance is registered with the
 * {@link import('./registry').RunnerRegistry} at startup.
 */
export class CursorRunner implements Runner {
  readonly id = 'cursor';

  readonly capabilities: Capabilities = {
    resumableSessions: true,
    jsonStructuredOutput: false,
    mcpServers: true,
    browser: false,
    customAgents: false,
    toolTrustGranularity: 'categories',
  };

  /** Timestamp of the most recent dispatch, for {@link health}. */
  private lastDispatchAt: string | undefined;

  /** Rolling error tally by class, surfaced via {@link health}. */
  private readonly errorTally = new Map<ErrorClass, number>();

  /** @see Runner.detect — probes `cursor-agent --version` on `$PATH`. */
  async detect(): Promise<DetectionResult> {
    try {
      const { stdout } = await execFileAsync(CURSOR_BIN, ['--version'], {
        timeout: 10_000,
      });
      return {
        found: true,
        version: stdout.trim() || 'unknown',
        path: CURSOR_BIN,
      };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        return {
          found: false,
          reason: 'not_installed',
          hint: 'cursor-agent not found on PATH. Install the Cursor CLI from https://cursor.com.',
        };
      }
      return {
        found: false,
        reason: 'not_installed',
        hint: `cursor-agent --version failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Build the `cursor-agent` argument list for a dispatch.
   *
   * Exposed for unit tests (RFC §8.1 flag-translation tests).
   *
   * @param opts - the dispatch options.
   * @returns the argument vector passed to `spawn`.
   */
  buildArgs(opts: DispatchOptions): string[] {
    const args = ['--no-interactive', '--prompt', opts.prompt, '--workdir', opts.workingDir];
    if (opts.sessionId !== undefined) {
      // RFC §9.1: resume flag name pending verification against cursor-agent docs.
      args.push('--resume', opts.sessionId);
    }
    if (opts.agentProfile !== undefined) {
      args.push('--agent', opts.agentProfile);
    }
    // §3 trust-preset translation. Deny list is inverted against
    // `--auto-approve=all` for the `turbo` preset (see TRUST_PRESET_TABLE).
    const trust = translateTrust(this.id, opts.trust);
    args.push(...trust.flags);
    if (opts.trust === 'turbo' && opts.trustDenyList && opts.trustDenyList.length > 0) {
      args.push(`--deny=${opts.trustDenyList.join(',')}`);
    }
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
   * `cursor-agent` has no stable session-list subcommand yet (RFC §9.1);
   * returns an empty list until the host surface is verified.
   */
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  /** @see Runner.health */
  async health(): Promise<HealthReport> {
    const detection = await this.detect();
    const cliVersion = detection.found ? detection.version : 'not_installed';
    return {
      ok: detection.found,
      authPresent: detection.found,
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
   * `cursor-agent` exposes no out-of-band cancel; in-flight dispatches are
   * hard-killed by the orchestrator via its 2× timeout. This is a no-op so
   * callers can treat cancel uniformly across runners.
   */
  async cancel(_sessionId: string): Promise<void> {
    // No-op: cancellation is handled by the orchestrator's timeout kill.
  }

  /**
   * Spawn `cursor-agent`, capture output, and normalize the result.
   *
   * @param args        - the argument vector.
   * @param sessionId   - resumed session id, echoed back when present.
   * @param timeoutMs   - soft cap; the subprocess is killed at this value.
   * @param env         - extra environment variables.
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

      const child = spawn(CURSOR_BIN, args, {
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
        const errorClass = classifyCursorExit(exitCode, timedOut);
        if (errorClass !== undefined) {
          this.errorTally.set(errorClass, (this.errorTally.get(errorClass) ?? 0) + 1);
        }
        const finishedAt = new Date();
        this.lastDispatchAt = finishedAt.toISOString();
        resolve({
          ok: errorClass === undefined,
          sessionId: sessionId ?? `cursor-${startedAt}`,
          exitCode: exitCode ?? -1,
          finishedAt: finishedAt.toISOString(),
          durationMs: Date.now() - startedAt,
          errorClass,
          stdoutTail: tail(stdout || stderr),
        });
      };

      child.on('error', (err: Error) => {
        // spawn failure (ENOENT etc.) — classify as internal.
        stderr += `\n[spawn error] ${err.message}`;
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  }
}

/** Singleton runner instance for registration. */
export const cursorRunner = new CursorRunner();
