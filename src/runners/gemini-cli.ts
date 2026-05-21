/**
 * `runner-gemini-cli` — Gemini CLI adapter for the AutoClaw runner contract.
 *
 * Drives `gemini -p "<prompt>"` as a headless subprocess (Gemini CLI runs
 * non-interactively when `-p` is present or stdin is piped). Implements the
 * {@link Runner} interface from `./types`.
 *
 * Antigravity awareness (RFC §5.4): when running inside an Antigravity
 * install, MCP servers are read from `~/.gemini/antigravity/mcp_config.json`
 * and the browser sub-agent is gated by
 * `~/.gemini/antigravity/browserAllowlist.txt`. Otherwise MCP config is read
 * from `~/.gemini/settings.json`.
 *
 * @see docs/rfc/runner-bridge-contract.md §5.4 (gemini-cli), §7 (health)
 */

import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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
const GEMINI_BIN = 'gemini';

/** Max bytes of stdout retained on {@link DispatchResult.stdoutTail}. */
const STDOUT_TAIL_BYTES = 4096;

/** Default soft time cap when {@link DispatchOptions.timeoutMs} is unset. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** Antigravity-scoped MCP config path (RFC §5.4). */
const ANTIGRAVITY_MCP_CONFIG = join(homedir(), '.gemini', 'antigravity', 'mcp_config.json');

/** Antigravity browser allow-list path (RFC §5.4). */
const ANTIGRAVITY_BROWSER_ALLOWLIST = join(
  homedir(),
  '.gemini',
  'antigravity',
  'browserAllowlist.txt',
);

/** Plain (non-Antigravity) Gemini CLI settings path. */
const GEMINI_SETTINGS = join(homedir(), '.gemini', 'settings.json');

/**
 * Map a `gemini` process exit code to a normalized {@link ErrorClass}.
 *
 * @param exitCode - the subprocess exit code (or `null` if killed by signal).
 * @param timedOut - whether the orchestrator's soft cap was exceeded.
 */
function classifyGeminiExit(exitCode: number | null, timedOut: boolean): ErrorClass | undefined {
  if (timedOut) {
    return 'timeout';
  }
  switch (exitCode) {
    case 0:
      return undefined;
    case null:
      return 'internal'; // killed by signal
    case 1:
      return 'auth'; // gemini: missing GEMINI_API_KEY / not logged in
    case 2:
      return 'tool_denied'; // gemini: a tool approval was refused
    default:
      return 'internal';
  }
}

/** Keep only the trailing {@link STDOUT_TAIL_BYTES} of a captured buffer. */
function tail(text: string): string {
  return text.length > STDOUT_TAIL_BYTES ? text.slice(-STDOUT_TAIL_BYTES) : text;
}

/**
 * Count MCP servers configured for the Gemini CLI, preferring the
 * Antigravity-scoped config when present (RFC §5.4).
 *
 * @returns the number of configured MCP servers; `0` on any read/parse error.
 */
function countMcpServers(): number {
  const path = existsSync(ANTIGRAVITY_MCP_CONFIG) ? ANTIGRAVITY_MCP_CONFIG : GEMINI_SETTINGS;
  if (!existsSync(path)) {
    return 0;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return parsed.mcpServers ? Object.keys(parsed.mcpServers).length : 0;
  } catch {
    return 0;
  }
}

/**
 * Gemini CLI runner. One instance is registered with the
 * {@link import('./registry').RunnerRegistry} at startup.
 */
export class GeminiCliRunner implements Runner {
  readonly id = 'gemini-cli';

  readonly capabilities: Capabilities = {
    resumableSessions: false, // RFC §9.2: session API pending verification.
    jsonStructuredOutput: false,
    mcpServers: true,
    // The browser sub-agent only exists in Antigravity installs.
    browser: existsSync(ANTIGRAVITY_MCP_CONFIG),
    customAgents: false,
    toolTrustGranularity: 'categories',
  };

  /** Timestamp of the most recent dispatch, for {@link health}. */
  private lastDispatchAt: string | undefined;

  /** Rolling error tally by class, surfaced via {@link health}. */
  private readonly errorTally = new Map<ErrorClass, number>();

  /** Whether this runner is operating inside an Antigravity install. */
  get isAntigravity(): boolean {
    return existsSync(ANTIGRAVITY_MCP_CONFIG);
  }

  /** @see Runner.detect — probes `gemini --version` on `$PATH`. */
  async detect(): Promise<DetectionResult> {
    try {
      const { stdout } = await execFileAsync(GEMINI_BIN, ['--version'], { timeout: 10_000 });
      return {
        found: true,
        version: stdout.trim() || 'unknown',
        path: GEMINI_BIN,
      };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        return {
          found: false,
          reason: 'not_installed',
          hint: 'gemini not found on PATH. Install the Gemini CLI: npm i -g @google/gemini-cli.',
        };
      }
      return {
        found: false,
        reason: 'not_installed',
        hint: `gemini --version failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Whether a browser sub-agent may be used for the given working directory.
   *
   * Honors the Antigravity browser allow-list (RFC §5.4): if the allow-list
   * file exists, the working dir must match one of its non-comment lines.
   * Outside Antigravity the browser is unavailable, so this returns `false`.
   *
   * @param workingDir - the dispatch working directory.
   */
  browserAllowedFor(workingDir: string): boolean {
    if (!this.isAntigravity) {
      return false;
    }
    if (!existsSync(ANTIGRAVITY_BROWSER_ALLOWLIST)) {
      return false;
    }
    try {
      const entries = readFileSync(ANTIGRAVITY_BROWSER_ALLOWLIST, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
      return entries.some((entry) => workingDir.startsWith(entry));
    } catch {
      return false;
    }
  }

  /**
   * Build the `gemini` argument list for a dispatch.
   *
   * Exposed for unit tests (RFC §8.1 flag-translation tests).
   *
   * @param opts - the dispatch options.
   * @returns the argument vector passed to `spawn`.
   */
  buildArgs(opts: DispatchOptions): string[] {
    // `-p` makes the CLI non-interactive (RFC §5.4).
    const args = ['-p', opts.prompt];
    // §3 trust-preset translation: off → default, auto → --yolo=read,grep,
    // turbo → --yolo (see TRUST_PRESET_TABLE).
    const trust = translateTrust(this.id, opts.trust);
    args.push(...trust.flags);
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
    // RFC §9.2: Gemini CLI has no verified session-resume API; the follow-up
    // is dispatched as a fresh session and the requested id is echoed back so
    // the orchestrator's session ledger stays coherent.
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
   * Gemini CLI has no verified session-list surface (RFC §9.2); returns an
   * empty list until the host API is pinned.
   */
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  /** @see Runner.health */
  async health(): Promise<HealthReport> {
    const detection = await this.detect();
    return {
      ok: detection.found,
      authPresent: detection.found,
      cliVersion: detection.found ? detection.version : 'not_installed',
      mcpServersConfigured: countMcpServers(),
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
   * Gemini CLI exposes no out-of-band cancel; in-flight dispatches are
   * hard-killed by the orchestrator via its 2× timeout. No-op so callers can
   * treat cancel uniformly across runners.
   */
  async cancel(_sessionId: string): Promise<void> {
    // No-op: cancellation is handled by the orchestrator's timeout kill.
  }

  /**
   * Spawn `gemini`, capture output, and normalize the result.
   *
   * @param args        - the argument vector.
   * @param sessionId   - resumed session id, echoed back when present.
   * @param timeoutMs   - soft cap; the subprocess is killed at this value.
   * @param env         - extra environment variables.
   * @param workingDir  - subprocess cwd; Gemini CLI uses cwd as its workdir.
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

      const child = spawn(GEMINI_BIN, args, {
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
        const errorClass = classifyGeminiExit(exitCode, timedOut);
        if (errorClass !== undefined) {
          this.errorTally.set(errorClass, (this.errorTally.get(errorClass) ?? 0) + 1);
        }
        const finishedAt = new Date();
        this.lastDispatchAt = finishedAt.toISOString();
        resolve({
          ok: errorClass === undefined,
          sessionId: sessionId ?? `gemini-${startedAt}`,
          exitCode: exitCode ?? -1,
          finishedAt: finishedAt.toISOString(),
          durationMs: Date.now() - startedAt,
          errorClass,
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
export const geminiCliRunner = new GeminiCliRunner();
