/**
 * `runner-claude-code` — drives Claude Code as a headless subprocess.
 *
 * Implements the {@link Runner} contract (RFC §2) for the Claude Code host.
 * RFC §5.1 specifies a Claude Agent SDK headless subprocess; the
 * `@anthropic-ai/claude-agent-sdk` / `@anthropic-ai/sdk` packages are not
 * currently dependencies of this extension, so this module spawns the
 * `claude` CLI in headless print mode (`--print --output-format
 * stream-json`) via `child_process` against a thin typed interface.
 *
 * // TODO: swap to Claude Agent SDK when dependency approved — the
 * //       {@link ClaudeHeadlessTransport} indirection keeps that change
 * //       local to this file.
 *
 * @see docs/rfc/runner-bridge-contract.md §5.1, §3, §7
 */

import { spawn, execFile, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { translateTrust } from './registry';
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
/*  Trust preset → Claude Code permissionMode                                 */
/* -------------------------------------------------------------------------- */

/**
 * Claude Code's permission modes (`--permission-mode` flag / SDK option).
 *
 * - `default`           — every tool call prompts (maps to trust `off`).
 * - `acceptEdits`       — file edits auto-approved, other mutations prompt
 *                         (maps to trust `auto`).
 * - `bypassPermissions` — all tools auto-approved (maps to trust `turbo`).
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/** RFC §3 trust-preset → Claude Code `permissionMode` mapping. */
const PERMISSION_MODE_BY_PRESET: Readonly<Record<TrustPreset, ClaudePermissionMode>> = {
  off: 'default',
  auto: 'acceptEdits',
  turbo: 'bypassPermissions',
};

/**
 * Translate an AutoClaw {@link TrustPreset} into a Claude Code
 * `permissionMode`.
 *
 * The {@link translateTrust} table in `./registry` is the authoritative
 * RFC §3 source; this function reuses it (the `claude-code` row stores its
 * values as `permissionMode: <mode>` descriptor strings) and falls back to
 * the local {@link PERMISSION_MODE_BY_PRESET} map if the table row is
 * missing or shaped unexpectedly.
 *
 * @param preset - the requested trust preset.
 * @returns the equivalent Claude Code permission mode.
 */
export function trustToPermissionMode(preset: TrustPreset): ClaudePermissionMode {
  const translation = translateTrust('claude-code', preset);
  for (const flag of translation.flags) {
    const match = /^permissionMode:\s*(default|acceptEdits|bypassPermissions)$/.exec(flag);
    if (match) {
      return match[1] as ClaudePermissionMode;
    }
  }
  return PERMISSION_MODE_BY_PRESET[preset];
}

/* -------------------------------------------------------------------------- */
/*  Thin typed transport interface (SDK seam)                                 */
/* -------------------------------------------------------------------------- */

/** A single structured event observed during a headless run. */
export interface ClaudeStreamEvent {
  /** Event type, e.g. `"system"`, `"assistant"`, `"tool_use"`, `"result"`. */
  type: string;
  /** Session id carried on the `system` init event, when present. */
  session_id?: string;
  /** Final result subtype on a `result` event (`"success"` | `"error_*"`). */
  subtype?: string;
  /** Final response text on a `result` event. */
  result?: string;
  /** Whether the run ended in an error (on a `result` event). */
  is_error?: boolean;
  /** Token usage reported by the host, when present. */
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Arbitrary additional fields the host emits — kept for forward-compat. */
  [key: string]: unknown;
}

/** Outcome of a headless run, as collected by the transport. */
export interface ClaudeRunOutcome {
  /** Process exit code (or a synthetic non-zero value on spawn failure). */
  exitCode: number;
  /** Parsed structured events, in arrival order. */
  events: ClaudeStreamEvent[];
  /** Raw stdout (used as a fallback when JSON parsing yields nothing). */
  stdout: string;
  /** Raw stderr — surfaced in `stdoutTail` / error diagnosis. */
  stderr: string;
  /** Set when the run was killed by the soft-timeout watchdog. */
  timedOut: boolean;
  /** Set when the subprocess could not be spawned at all. */
  spawnError?: string;
}

/**
 * The seam between this runner and the Claude Code host. The CLI-based
 * implementation lives in {@link CliHeadlessTransport}; swapping to the
 * Claude Agent SDK means providing an alternative implementation without
 * touching {@link ClaudeCodeRunner}.
 */
export interface ClaudeHeadlessTransport {
  /** Run a headless dispatch and resolve once the subprocess exits. */
  run(args: ClaudeRunArgs): Promise<ClaudeRunOutcome>;
  /** Resolve the `claude` executable version, or `null` if unavailable. */
  version(): Promise<string | null>;
}

/** Inputs to a single {@link ClaudeHeadlessTransport.run}. */
export interface ClaudeRunArgs {
  /** The prompt — the initial (or follow-up) user message. */
  prompt: string;
  /** Absolute working directory for the subprocess. */
  workingDir: string;
  /** Permission mode translated from the trust preset. */
  permissionMode: ClaudePermissionMode;
  /** Session id to resume via `--resume`, when continuing a thread. */
  resumeSessionId?: string;
  /** Extra environment variables appended to the subprocess env. */
  env?: Record<string, string>;
  /** Soft timeout in ms; the watchdog hard-kills past 2× this value. */
  timeoutMs?: number;
  /** Tool categories to deny (passed via `--disallowed-tools`). */
  trustDenyList?: string[];
  /** Custom agent profile name (`--agents` / SDK option). */
  agentProfile?: string;
  /** Registers the spawned child so {@link ClaudeCodeRunner.cancel} can kill it. */
  onSpawn?: (child: ChildProcess) => void;
}

/* -------------------------------------------------------------------------- */
/*  CLI-backed transport (default)                                            */
/* -------------------------------------------------------------------------- */

/** Default soft timeout when a dispatch does not request one (10 min). */
const DEFAULT_TIMEOUT_MS = 600_000;

/** The `claude` executable name; resolved from `$PATH`. */
const CLAUDE_BIN = 'claude';

/**
 * {@link ClaudeHeadlessTransport} implementation that spawns the `claude`
 * CLI in headless print mode and parses its `stream-json` output.
 *
 * // TODO: swap to Claude Agent SDK when dependency approved.
 */
export class CliHeadlessTransport implements ClaudeHeadlessTransport {
  /** Resolve `claude --version`, or `null` when the binary is absent. */
  async version(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      execFile(
        CLAUDE_BIN,
        ['--version'],
        { timeout: 10_000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          resolve(stdout.trim() || 'unknown');
        },
      );
    });
  }

  /** Spawn the headless subprocess and collect its structured output. */
  async run(args: ClaudeRunArgs): Promise<ClaudeRunOutcome> {
    const cliArgs = buildCliArgs(args);
    const softTimeout = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const hardTimeout = softTimeout * 2;

    return new Promise<ClaudeRunOutcome>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(CLAUDE_BIN, cliArgs, {
          cwd: args.workingDir,
          env: { ...process.env, ...(args.env ?? {}) },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        resolve({
          exitCode: 127,
          events: [],
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      args.onSpawn?.(child);

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const watchdog = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, hardTimeout);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const finish = (exitCode: number, spawnError?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(watchdog);
        resolve({
          exitCode,
          events: parseStreamJson(stdout),
          stdout,
          stderr,
          timedOut,
          spawnError,
        });
      };

      child.on('error', (err: Error) => {
        finish(127, err.message);
      });
      child.on('close', (code: number | null) => {
        finish(code ?? (timedOut ? 124 : 1));
      });
    });
  }
}

/**
 * Build the `claude` CLI argument list for a headless run.
 *
 * Headless mode = `--print` (non-interactive) with
 * `--output-format stream-json` so tool-call events are machine-readable.
 *
 * @param args - the run inputs.
 * @returns the ordered CLI argument list.
 */
export function buildCliArgs(args: ClaudeRunArgs): string[] {
  const cli: string[] = ['--print', '--output-format', 'stream-json', '--verbose'];

  cli.push('--permission-mode', args.permissionMode);

  if (args.resumeSessionId) {
    cli.push('--resume', args.resumeSessionId);
  }
  if (args.agentProfile) {
    cli.push('--agents', args.agentProfile);
  }
  if (args.trustDenyList && args.trustDenyList.length > 0) {
    cli.push('--disallowed-tools', args.trustDenyList.join(','));
  }

  // Prompt is the final positional argument — the initial user message.
  cli.push(args.prompt);
  return cli;
}

/**
 * Parse a Claude CLI `stream-json` stdout blob into structured events.
 *
 * `stream-json` emits one JSON object per line; non-JSON lines (banners,
 * warnings) are skipped rather than failing the parse.
 *
 * @param stdout - raw subprocess stdout.
 * @returns the parsed events, in arrival order.
 */
export function parseStreamJson(stdout: string): ClaudeStreamEvent[] {
  const events: ClaudeStreamEvent[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || (line[0] !== '{' && line[0] !== '[')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isStreamEvent(item)) {
            events.push(item);
          }
        }
      } else if (isStreamEvent(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Not a JSON line — skip.
    }
  }
  return events;
}

/** Narrowing guard for an arbitrary parsed value to {@link ClaudeStreamEvent}. */
function isStreamEvent(value: unknown): value is ClaudeStreamEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/* -------------------------------------------------------------------------- */
/*  Runner implementation                                                     */
/* -------------------------------------------------------------------------- */

/** Static capabilities of the Claude Code host (RFC §2). */
const CLAUDE_CODE_CAPABILITIES: Capabilities = {
  resumableSessions: true,
  jsonStructuredOutput: true,
  mcpServers: true,
  browser: false,
  customAgents: true,
  toolTrustGranularity: 'categories',
};

/** Minimum acceptable `claude` CLI major version. */
const MIN_MAJOR_VERSION = 1;

/** Last ~4 KB of stdout is retained for debugging (RFC §2 `stdoutTail`). */
const STDOUT_TAIL_BYTES = 4096;

/** One slot in the runner's bounded recent-error ring. */
interface ErrorRecord {
  class: ErrorClass;
}

/**
 * The Claude Code runner.
 *
 * Construct with the default {@link CliHeadlessTransport}, or inject an
 * alternative transport (e.g. an SDK-backed one, or a mock for tests).
 */
export class ClaudeCodeRunner implements Runner {
  readonly id = 'claude-code';
  readonly capabilities: Capabilities = CLAUDE_CODE_CAPABILITIES;

  private readonly transport: ClaudeHeadlessTransport;
  /** In-flight subprocesses keyed by session id, for {@link cancel}. */
  private readonly inFlight = new Map<string, ChildProcess>();
  /** Bounded recent-error ring (most recent first), surfaced by {@link health}. */
  private readonly recentErrors: ErrorRecord[] = [];
  /** ISO timestamp of the most recent dispatch, for {@link health}. */
  private lastDispatchAt: string | undefined;

  constructor(transport: ClaudeHeadlessTransport = new CliHeadlessTransport()) {
    this.transport = transport;
  }

  /* ----------------------------------------------------------------------- */
  /*  detect()                                                               */
  /* ----------------------------------------------------------------------- */

  /**
   * Probe whether Claude Code is usable: `claude --version` resolves from
   * `$PATH` and an Anthropic credential is present (env or keychain).
   */
  async detect(): Promise<DetectionResult> {
    const version = await this.transport.version();
    if (version === null) {
      return {
        found: false,
        reason: 'not_installed',
        hint: 'Claude Code CLI not found on PATH. Install it and ensure `claude --version` works.',
      };
    }

    if (!isVersionSupported(version)) {
      return {
        found: false,
        reason: 'version_too_old',
        hint: `Claude Code CLI ${version} is too old; v${MIN_MAJOR_VERSION}.x or newer is required.`,
      };
    }

    if (!hasAnthropicAuth()) {
      return {
        found: false,
        reason: 'no_auth',
        hint: 'No Anthropic credential found. Set ANTHROPIC_API_KEY or run `claude login` to populate the keychain.',
      };
    }

    return { found: true, version, path: CLAUDE_BIN };
  }

  /* ----------------------------------------------------------------------- */
  /*  dispatch()                                                             */
  /* ----------------------------------------------------------------------- */

  /**
   * Run a prompt as work via a Claude Code headless subprocess. The final
   * result is serialized to `dispatch-result.json` next to the outbox
   * (`<workingDir>/.autoclaw/outbox/`).
   */
  async dispatch(opts: DispatchOptions): Promise<DispatchResult> {
    const startedAt = Date.now();
    const permissionMode = trustToPermissionMode(opts.trust);

    let outcome: ClaudeRunOutcome;
    let trackedSessionId: string | undefined = opts.sessionId;
    try {
      outcome = await this.transport.run({
        prompt: opts.prompt,
        workingDir: opts.workingDir,
        permissionMode,
        resumeSessionId: opts.sessionId,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
        trustDenyList: opts.trustDenyList,
        agentProfile: opts.agentProfile,
        onSpawn: (child) => {
          // Register under the provided session id when resuming; the
          // freshly created session id is not known until the `system`
          // event arrives, so a new dispatch is tracked under a temporary
          // key that `cancel` can still match on a best-effort basis.
          const key = opts.sessionId ?? `pending-${startedAt}`;
          trackedSessionId = key;
          this.inFlight.set(key, child);
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return this.failure(opts.sessionId ?? '', 'internal', startedAt, message);
    } finally {
      if (trackedSessionId !== undefined) {
        this.inFlight.delete(trackedSessionId);
      }
    }

    const result = this.toDispatchResult(opts, outcome, startedAt);

    // Re-key the in-flight map onto the real session id if one was learned.
    if (trackedSessionId !== undefined && trackedSessionId !== result.sessionId) {
      this.inFlight.delete(trackedSessionId);
    }

    await this.persistResult(opts.workingDir, result, outcome);
    return result;
  }

  /* ----------------------------------------------------------------------- */
  /*  resume()                                                               */
  /* ----------------------------------------------------------------------- */

  /**
   * Resume an existing Claude Code session with a follow-up prompt
   * (`claude --resume <sessionId>`).
   */
  async resume(
    sessionId: string,
    prompt: string,
    opts?: Partial<DispatchOptions>,
  ): Promise<DispatchResult> {
    return this.dispatch({
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
    });
  }

  /* ----------------------------------------------------------------------- */
  /*  listSessions()                                                         */
  /* ----------------------------------------------------------------------- */

  /**
   * List Claude Code sessions known on this machine, read from the
   * `~/.claude/projects/` session store.
   *
   * The CLI has no machine-readable `--list-sessions` output yet, so this
   * enumerates the on-disk session transcripts directly. Returns an empty
   * list when no store is present.
   */
  async listSessions(): Promise<SessionSummary[]> {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const summaries: SessionSummary[] = [];
    let projectDirs: string[];
    try {
      projectDirs = await fs.readdir(projectsDir);
    } catch {
      return summaries;
    }

    for (const project of projectDirs) {
      const projectPath = path.join(projectsDir, project);
      let files: string[];
      try {
        files = await fs.readdir(projectPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) {
          continue;
        }
        const sessionId = file.slice(0, -'.jsonl'.length);
        try {
          const stat = await fs.stat(path.join(projectPath, file));
          summaries.push({
            sessionId,
            createdAt: stat.birthtime.toISOString(),
            lastActivityAt: stat.mtime.toISOString(),
            status: 'idle',
          });
        } catch {
          // Unreadable transcript — skip.
        }
      }
    }
    return summaries;
  }

  /* ----------------------------------------------------------------------- */
  /*  health()                                                               */
  /* ----------------------------------------------------------------------- */

  /** Report runner health (auth, version, MCP, recent errors) — RFC §7. */
  async health(): Promise<HealthReport> {
    const version = await this.transport.version();
    const authPresent = hasAnthropicAuth();
    const mcpServersConfigured = await countMcpServers();

    const errorCounts = new Map<ErrorClass, number>();
    for (const rec of this.recentErrors) {
      errorCounts.set(rec.class, (errorCounts.get(rec.class) ?? 0) + 1);
    }
    const recentErrors = [...errorCounts.entries()].map(([cls, count]) => ({
      class: cls,
      count,
    }));

    return {
      ok: version !== null && authPresent,
      authPresent,
      cliVersion: version ?? 'not_installed',
      mcpServersConfigured,
      lastDispatchAt: this.lastDispatchAt,
      recentErrors,
    };
  }

  /* ----------------------------------------------------------------------- */
  /*  cancel()                                                               */
  /* ----------------------------------------------------------------------- */

  /** Cancel an in-flight session by killing its subprocess. */
  async cancel(sessionId: string): Promise<void> {
    const child = this.inFlight.get(sessionId);
    if (child) {
      child.kill('SIGTERM');
      this.inFlight.delete(sessionId);
    }
  }

  /* ----------------------------------------------------------------------- */
  /*  internals                                                              */
  /* ----------------------------------------------------------------------- */

  /** Convert a raw transport outcome into a {@link DispatchResult}. */
  private toDispatchResult(
    opts: DispatchOptions,
    outcome: ClaudeRunOutcome,
    startedAt: number,
  ): DispatchResult {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAt;
    this.lastDispatchAt = finishedAt;

    const sessionId = extractSessionId(outcome.events) ?? opts.sessionId ?? '';
    const resultEvent = outcome.events.find((e) => e.type === 'result');
    const stdoutTail = tail(outcome.stdout || outcome.stderr, STDOUT_TAIL_BYTES);

    if (outcome.spawnError !== undefined) {
      const errorClass: ErrorClass = 'internal';
      this.recordError(errorClass);
      return {
        ok: false,
        sessionId,
        exitCode: outcome.exitCode,
        finishedAt,
        durationMs,
        errorClass,
        stdoutTail: tail(outcome.spawnError, STDOUT_TAIL_BYTES),
      };
    }

    if (outcome.timedOut) {
      this.recordError('timeout');
      return {
        ok: false,
        sessionId,
        exitCode: outcome.exitCode,
        finishedAt,
        durationMs,
        errorClass: 'timeout',
        stdoutTail,
      };
    }

    const isError =
      outcome.exitCode !== 0 ||
      resultEvent?.is_error === true ||
      (typeof resultEvent?.subtype === 'string' && resultEvent.subtype !== 'success');

    if (isError) {
      const errorClass = classifyError(outcome);
      this.recordError(errorClass);
      return {
        ok: false,
        sessionId,
        exitCode: outcome.exitCode,
        finishedAt,
        durationMs,
        tokens: extractTokens(resultEvent),
        errorClass,
        rationale: typeof resultEvent?.result === 'string' ? resultEvent.result : undefined,
        stdoutTail,
      };
    }

    return {
      ok: true,
      sessionId,
      exitCode: outcome.exitCode,
      finishedAt,
      durationMs,
      tokens: extractTokens(resultEvent),
      rationale: typeof resultEvent?.result === 'string' ? resultEvent.result : undefined,
      stdoutTail,
    };
  }

  /** Append an error to the bounded recent-error ring (cap 50). */
  private recordError(cls: ErrorClass): void {
    this.recentErrors.unshift({ class: cls });
    if (this.recentErrors.length > 50) {
      this.recentErrors.length = 50;
    }
  }

  /** Build a {@link DispatchResult} for a pre-dispatch failure. */
  private failure(
    sessionId: string,
    errorClass: ErrorClass,
    startedAt: number,
    message: string,
  ): DispatchResult {
    this.recordError(errorClass);
    const finishedAt = new Date().toISOString();
    this.lastDispatchAt = finishedAt;
    return {
      ok: false,
      sessionId,
      exitCode: 1,
      finishedAt,
      durationMs: Date.now() - startedAt,
      errorClass,
      stdoutTail: tail(message, STDOUT_TAIL_BYTES),
    };
  }

  /**
   * Serialize the final result to `dispatch-result.json` next to the
   * outbox (`<workingDir>/.autoclaw/outbox/`). Best-effort: a write
   * failure is swallowed so it never masks the dispatch outcome.
   */
  private async persistResult(
    workingDir: string,
    result: DispatchResult,
    outcome: ClaudeRunOutcome,
  ): Promise<void> {
    try {
      const outboxDir = path.join(workingDir, '.autoclaw', 'outbox');
      await fs.mkdir(outboxDir, { recursive: true });
      const payload = {
        runner: this.id,
        result,
        events: outcome.events,
      };
      await fs.writeFile(
        path.join(outboxDir, 'dispatch-result.json'),
        JSON.stringify(payload, null, 2),
        'utf8',
      );
    } catch {
      // Best-effort persistence — never let it fail the dispatch.
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Free helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Whether an Anthropic credential is present (env var or keychain file). */
export function hasAnthropicAuth(): boolean {
  if (
    typeof process.env.ANTHROPIC_API_KEY === 'string' &&
    process.env.ANTHROPIC_API_KEY.trim().length > 0
  ) {
    return true;
  }
  if (
    typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === 'string' &&
    process.env.CLAUDE_CODE_OAUTH_TOKEN.trim().length > 0
  ) {
    return true;
  }
  // Keychain presence: `claude login` writes credentials under ~/.claude.
  try {
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    // eslint-disable-next-line no-sync
    require('fs').accessSync(credsPath);
    return true;
  } catch {
    return false;
  }
}

/** Whether a `claude --version` string meets the minimum supported major. */
export function isVersionSupported(version: string): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    // Unparseable version string — accept rather than block on a format change.
    return true;
  }
  return Number(match[1]) >= MIN_MAJOR_VERSION;
}

/** Pull the session id off the `system` init event, if present. */
export function extractSessionId(events: ClaudeStreamEvent[]): string | undefined {
  for (const event of events) {
    if (typeof event.session_id === 'string' && event.session_id.length > 0) {
      return event.session_id;
    }
  }
  return undefined;
}

/** Pull token usage off a `result` event, normalized to the contract shape. */
function extractTokens(
  resultEvent: ClaudeStreamEvent | undefined,
): { input: number; output: number } | undefined {
  const usage = resultEvent?.usage;
  if (!usage) {
    return undefined;
  }
  return {
    input: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    output: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
  };
}

/**
 * Map a failed run onto a normalized {@link ErrorClass} (RFC §7).
 *
 * Heuristics over exit code, the `result` event subtype, and stderr text.
 */
export function classifyError(outcome: ClaudeRunOutcome): ErrorClass {
  const haystack = `${outcome.stderr}\n${outcome.stdout}`.toLowerCase();
  const resultEvent = outcome.events.find((e) => e.type === 'result');
  const subtype = typeof resultEvent?.subtype === 'string' ? resultEvent.subtype : '';

  if (
    /api[_ -]?key|unauthorized|authentication|invalid x-api-key|401|please run .claude login/.test(
      haystack,
    )
  ) {
    return 'auth';
  }
  if (/mcp|model context protocol/.test(haystack) && /fail|error|could not start/.test(haystack)) {
    return 'mcp_startup';
  }
  if (
    subtype.includes('permission') ||
    /permission denied|tool .* denied|not allowed to use/.test(haystack)
  ) {
    return 'tool_denied';
  }
  if (outcome.timedOut || /timed out|timeout/.test(haystack)) {
    return 'timeout';
  }
  return 'internal';
}

/** Count MCP servers configured in user + workspace `settings.json`. */
async function countMcpServers(): Promise<number> {
  const candidates = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(process.cwd(), '.claude', 'settings.json'),
  ];
  let total = 0;
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        total += Object.keys(parsed.mcpServers).length;
      }
    } catch {
      // Missing or unparseable settings file — contributes 0.
    }
  }
  return total;
}

/** Return the last `maxBytes` characters of `text`. */
function tail(text: string, maxBytes: number): string {
  return text.length <= maxBytes ? text : text.slice(text.length - maxBytes);
}
