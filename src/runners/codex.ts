/**
 * codex.ts — `runner-codex` adapter (Sprint 2 / WA-4 task F1).
 *
 * Drives OpenAI Codex CLI as a headless AutoClaw runner. Codex exposes a
 * non-interactive "quiet" mode (`codex -q '<prompt>'`) that prints the
 * agent's work to stdout and exits — exactly the shape the {@link Runner}
 * contract needs.
 *
 * - `detect()` — runs `codex --version` and checks `OPENAI_API_KEY`.
 * - `dispatch()` — spawns `codex -q '<prompt>'` with trust-derived flags.
 * - trust → codex flags via the local {@link CODEX_TRUST_FLAGS} table.
 *
 * NO direct LLM calls from this module — Codex itself is the LLM host;
 * this adapter only spawns and supervises the subprocess.
 *
 * @see docs/rfc/runner-bridge-contract.md §2, §3, §7
 */

import { spawn, execFile } from 'child_process';
import * as crypto from 'crypto';
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
  TrustPreset,
} from './types';

/* -------------------------------------------------------------------------- */
/*  Trust translation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Codex CLI flags per trust preset.
 *
 * Codex exposes `--approval-mode` (a.k.a. `-a`):
 * - `suggest`    — prompts for every action (maps to AutoClaw `off`).
 * - `auto-edit`  — auto-applies edits, prompts for shell commands (`auto`).
 * - `full-auto`  — runs everything unattended (`turbo`).
 */
export const CODEX_TRUST_FLAGS: Readonly<Record<TrustPreset, readonly string[]>> = {
  off: ['--approval-mode', 'suggest'],
  auto: ['--approval-mode', 'auto-edit'],
  turbo: ['--approval-mode', 'full-auto'],
};

/**
 * Translate an AutoClaw {@link TrustPreset} into Codex CLI flags.
 *
 * @param preset - the requested trust preset.
 * @returns the literal argv fragment to pass to `codex`.
 */
export function codexTrustFlags(preset: TrustPreset): string[] {
  return [...(CODEX_TRUST_FLAGS[preset] ?? CODEX_TRUST_FLAGS.off)];
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Codex host executable; overridable via `AUTOCLAW_CODEX_BIN` for tests. */
const CODEX_BIN = process.env.AUTOCLAW_CODEX_BIN ?? 'codex';

/** Keep the last ~4 KB of stdout, per RFC §2 `stdoutTail`. */
const STDOUT_TAIL_BYTES = 4096;

/**
 * Injectable dependencies for {@link CodexRunner}.
 *
 * All fields are optional — omitting them (or constructing with no args) gives
 * the real `child_process` functions and the module-level `CODEX_BIN` value
 * (which already honors `AUTOCLAW_CODEX_BIN`), so the singleton `codexRunner`
 * and the `RunnerRegistry` are completely unaffected.
 */
export interface CodexRunnerOptions {
  /** Override the binary name/path. Defaults to {@link CODEX_BIN}. */
  bin?: string;
  /** Override `execFile`. Defaults to the real `child_process.execFile`. */
  execFileFn?: typeof execFile;
  /** Override `spawn`. Defaults to the real `child_process.spawn`. */
  spawnFn?: typeof spawn;
}

/** Map a Codex subprocess exit code to a normalized {@link ErrorClass}. */
function codexExitToErrorClass(exitCode: number, stderr: string): ErrorClass {
  const lc = stderr.toLowerCase();
  if (lc.includes('api key') || lc.includes('unauthorized') || lc.includes('401')) {
    return 'auth';
  }
  if (lc.includes('permission') || lc.includes('denied') || lc.includes('not approved')) {
    return 'tool_denied';
  }
  // Codex uses 124 for timeouts (GNU `timeout` convention) when wrapped.
  if (exitCode === 124) {
    return 'timeout';
  }
  return 'internal';
}

/* -------------------------------------------------------------------------- */
/*  CodexRunner                                                               */
/* -------------------------------------------------------------------------- */

/**
 * {@link Runner} adapter for the OpenAI Codex CLI.
 *
 * Codex does not (yet) expose stable resumable session IDs over the CLI,
 * so {@link CodexRunner.resume} re-dispatches with the prior prompt as
 * context and {@link CodexRunner.listSessions} returns an empty list.
 */
export class CodexRunner implements Runner {
  readonly id = 'codex';

  readonly capabilities: Capabilities = {
    resumableSessions: false,
    jsonStructuredOutput: false,
    mcpServers: false,
    browser: false,
    customAgents: false,
    toolTrustGranularity: 'categories',
  };

  /** Recent dispatch outcomes, for {@link health}. */
  private readonly recentErrors = new Map<ErrorClass, number>();
  private lastDispatchAt: string | undefined;

  private readonly bin: string;
  private readonly execFileFn: typeof execFile;
  private readonly spawnFn: typeof spawn;

  constructor(opts: CodexRunnerOptions = {}) {
    this.bin = opts.bin ?? CODEX_BIN;
    this.execFileFn = opts.execFileFn ?? execFile;
    this.spawnFn = opts.spawnFn ?? spawn;
  }

  /** Run `<bin> --version`; resolves null if the binary is absent. */
  private probeVersion(): Promise<{ version: string } | null> {
    const execFileAsync = promisify(this.execFileFn);
    return execFileAsync(this.bin, ['--version'], { timeout: 10_000 })
      .then(({ stdout }) => ({ version: stdout.trim() || 'unknown' }))
      .catch(() => null);
  }

  /** Resolve the absolute path of the codex executable, best-effort. */
  private probeCodexPath(): Promise<string> {
    const execFileAsync = promisify(this.execFileFn);
    const which = process.platform === 'win32' ? 'where' : 'which';
    return execFileAsync(which, [this.bin], { timeout: 10_000 })
      .then(({ stdout }) => stdout.split(/\r?\n/)[0].trim() || this.bin)
      .catch(() => this.bin);
  }

  /**
   * Probe whether Codex is installed and authenticated on this machine.
   */
  async detect(): Promise<DetectionResult> {
    const probe = await this.probeVersion();
    if (probe === null) {
      return {
        found: false,
        reason: 'not_installed',
        hint: `Codex CLI not found. Install it (e.g. \`npm i -g @openai/codex\`) and ensure \`${this.bin}\` is on PATH.`,
      };
    }
    if (!process.env.OPENAI_API_KEY) {
      return {
        found: false,
        reason: 'no_auth',
        hint: 'OPENAI_API_KEY is not set. Export it before starting the fleet.',
      };
    }
    const path = await this.probeCodexPath();
    return { found: true, version: probe.version, path };
  }

  /**
   * Run a prompt as work via `codex -q '<prompt>'`.
   *
   * Codex's quiet mode is non-interactive: it executes the prompt to
   * completion and exits. A fresh session id is minted per dispatch
   * because the CLI has no resumable-session surface.
   */
  async dispatch(opts: DispatchOptions): Promise<DispatchResult> {
    const startedAt = Date.now();
    const sessionId = opts.sessionId ?? `codex-${crypto.randomUUID()}`;

    const args = ['-q', ...codexTrustFlags(opts.trust), opts.prompt];

    return await new Promise<DispatchResult>((resolve) => {
      const child = this.spawnFn(this.bin, args, {
        cwd: opts.workingDir,
        env: { ...process.env, ...(opts.env ?? {}) },
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      // Soft timeout: orchestrator hard-kills past 2× per RFC §2.
      const timeoutMs = opts.timeoutMs;
      const killTimer =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              child.kill('SIGKILL');
            }, timeoutMs * 2)
          : null;
      let timedOut = false;
      const softTimer =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
            }, timeoutMs)
          : null;

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
        const finishedAt = new Date();
        this.lastDispatchAt = finishedAt.toISOString();
        const ok = exitCode === 0 && errorClass === undefined;
        if (!ok && errorClass) {
          this.recentErrors.set(errorClass, (this.recentErrors.get(errorClass) ?? 0) + 1);
        }
        resolve({
          ok,
          sessionId,
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

      child.on('error', () => {
        finish(-1, 'internal');
      });

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
        finish(exitCode, codexExitToErrorClass(exitCode, stderr));
      });
    });
  }

  /**
   * Resume a session. Codex has no CLI resume surface, so this dispatches
   * a fresh subprocess carrying `sessionId` forward for ledger continuity.
   */
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

  /** Codex CLI exposes no session listing; returns an empty list. */
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  /** Report runner health (auth, version, recent errors). */
  async health(): Promise<HealthReport> {
    const probe = await this.probeVersion();
    const authPresent = Boolean(process.env.OPENAI_API_KEY);
    const recentErrors = [...this.recentErrors.entries()].map(([cls, count]) => ({
      class: cls,
      count,
    }));
    return {
      ok: probe !== null && authPresent,
      authPresent,
      cliVersion: probe?.version ?? 'not_found',
      mcpServersConfigured: 0,
      lastDispatchAt: this.lastDispatchAt,
      recentErrors,
    };
  }

  /** Codex has no out-of-band cancel; in-flight subprocesses are killed by dispatch's timer. */
  async cancel(_sessionId: string): Promise<void> {
    // No-op: the Codex CLI provides no remote cancellation surface.
    // dispatch() owns subprocess lifecycle and enforces the timeout kill.
    return;
  }
}

/** Convenience singleton — registered with the {@link import('./registry').RunnerRegistry}. */
export const codexRunner = new CodexRunner();
