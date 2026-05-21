/**
 * claude-desktop.ts — `runner-claude-desktop` adapter (Sprint 4 / WA-2, F5).
 *
 * Drives Claude Code through the **same Claude Agent SDK seam** as
 * `claude-code.ts`, but tuned for a desktop / long-lived host:
 *
 *  - **Session continuity** — a desktop session id is *assigned* by the
 *    runner (a stable `--session-id <uuid>`), not discovered from output, so
 *    the same conversation can be resumed across a desktop restart.
 *  - **Context detection** — distinguishes the three Claude Code surfaces
 *    (Desktop app, terminal CLI, VS Code extension) so the orchestrator can
 *    pick the right resume strategy and surface it in `doctor`.
 *  - **Restart-safe resume** — `resume()` re-attaches to a known session id
 *    via `--resume`; the id is persisted to disk so a follow-up survives a
 *    full host restart.
 *
 * It reuses the {@link ClaudeHeadlessTransport} from `./claude-code` rather
 * than re-implementing the subprocess plumbing — swapping that module to the
 * real Agent SDK upgrades this runner for free.
 *
 * @see docs/rfc/runner-bridge-contract.md §5.1, §3, §7
 */

import { type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

import {
  CliHeadlessTransport,
  classifyError,
  extractSessionId,
  hasAnthropicAuth,
  isVersionSupported,
  trustToPermissionMode,
  type ClaudeHeadlessTransport,
  type ClaudeRunArgs,
  type ClaudeRunOutcome,
} from './claude-code';
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

/* -------------------------------------------------------------------------- */
/*  Host context                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Which Claude Code surface this runner is driving.
 *
 * - `desktop`       — the Claude Desktop application.
 * - `cli`           — a bare terminal `claude` invocation.
 * - `vscode`        — the Claude Code VS Code extension's embedded host.
 * - `unknown`       — could not be determined; treated like `cli`.
 */
export type ClaudeHostContext = 'desktop' | 'cli' | 'vscode' | 'unknown';

/**
 * Detect which Claude Code surface this process is running under.
 *
 * Heuristics, in priority order:
 *  1. `AUTOCLAW_CLAUDE_CONTEXT` env var — an explicit override.
 *  2. `CLAUDE_DESKTOP` / `CLAUDECODE`-style markers the desktop app sets.
 *  3. `VSCODE_PID` / `TERM_PROGRAM=vscode` — the VS Code extension host.
 *  4. Fallback: `cli`.
 *
 * @param env - the environment to inspect; defaults to `process.env`.
 * @returns the detected host context.
 */
export function detectHostContext(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeHostContext {
  const override = (env.AUTOCLAW_CLAUDE_CONTEXT ?? '').toLowerCase().trim();
  if (override === 'desktop' || override === 'cli' || override === 'vscode') {
    return override;
  }
  if (
    (env.CLAUDE_DESKTOP ?? '') !== '' ||
    (env.CLAUDE_APP ?? '') !== '' ||
    (env.CLAUDE_CODE_ENTRYPOINT ?? '').toLowerCase() === 'desktop'
  ) {
    return 'desktop';
  }
  if ((env.VSCODE_PID ?? '') !== '' || (env.TERM_PROGRAM ?? '') === 'vscode') {
    return 'vscode';
  }
  return 'cli';
}

/* -------------------------------------------------------------------------- */
/*  Session id store (restart-safe)                                           */
/* -------------------------------------------------------------------------- */

/** One persisted desktop session record. */
interface DesktopSessionRecord {
  sessionId: string;
  context: ClaudeHostContext;
  createdAt: string;
  lastActivityAt: string;
  promptPreview?: string;
}

/** Shape of the on-disk session index. */
interface DesktopSessionIndex {
  sessions: Record<string, DesktopSessionRecord>;
}

/**
 * Persists desktop session ids so a conversation can be resumed across a
 * full desktop / extension-host restart. Stored under
 * `<workingDir>/.autoclaw/runners/claude-desktop-sessions.json`.
 */
export class DesktopSessionStore {
  /** Absolute path to the index file. */
  private readonly indexPath: string;

  constructor(workingDir: string) {
    this.indexPath = path.join(
      workingDir,
      '.autoclaw',
      'runners',
      'claude-desktop-sessions.json',
    );
  }

  /** Read the index, tolerating a missing or corrupt file. */
  private async read(): Promise<DesktopSessionIndex> {
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DesktopSessionIndex>;
      if (parsed && typeof parsed === 'object' && parsed.sessions) {
        return { sessions: parsed.sessions };
      }
    } catch {
      // Missing / corrupt — start fresh.
    }
    return { sessions: {} };
  }

  /** Persist the index. Best-effort: a write failure is swallowed. */
  private async write(index: DesktopSessionIndex): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
      await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), 'utf8');
    } catch {
      // Best-effort persistence.
    }
  }

  /** Record (insert or update) a session, refreshing its activity time. */
  async upsert(record: DesktopSessionRecord): Promise<void> {
    const index = await this.read();
    const existing = index.sessions[record.sessionId];
    index.sessions[record.sessionId] = {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt,
    };
    await this.write(index);
  }

  /** Look up a persisted session by id. */
  async get(sessionId: string): Promise<DesktopSessionRecord | undefined> {
    const index = await this.read();
    return index.sessions[sessionId];
  }

  /** All persisted sessions, most-recent activity first. */
  async list(): Promise<DesktopSessionRecord[]> {
    const index = await this.read();
    return Object.values(index.sessions).sort((a, b) =>
      b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Capabilities                                                              */
/* -------------------------------------------------------------------------- */

/** Static capabilities of the Claude Desktop host (RFC §2). */
const CLAUDE_DESKTOP_CAPABILITIES: Capabilities = {
  resumableSessions: true,
  jsonStructuredOutput: true,
  mcpServers: true,
  browser: false,
  customAgents: true,
  toolTrustGranularity: 'categories',
};

/** Minimum acceptable `claude` major version. */
const MIN_MAJOR_VERSION = 1;
/** Last ~4 KB of stdout retained for debugging. */
const STDOUT_TAIL_BYTES = 4096;
/** The `claude` executable name. */
const CLAUDE_BIN = 'claude';

/* -------------------------------------------------------------------------- */
/*  Transport extension — assigns an explicit --session-id                    */
/* -------------------------------------------------------------------------- */

/**
 * Extra args understood by the desktop transport on top of {@link ClaudeRunArgs}.
 */
export interface DesktopRunArgs extends ClaudeRunArgs {
  /**
   * Explicit session id to assign with `--session-id` for a *new* session.
   * Mutually exclusive with {@link ClaudeRunArgs.resumeSessionId}.
   */
  assignSessionId?: string;
}

/**
 * Build the desktop `claude` CLI argument list.
 *
 * Differs from the base runner's `buildCliArgs` in one respect: a new
 * session is given a stable id up-front via `--session-id <uuid>` so it can
 * be resumed deterministically after a host restart, instead of waiting for
 * the host to mint one.
 */
export function buildDesktopCliArgs(args: DesktopRunArgs): string[] {
  const cli: string[] = ['--print', '--output-format', 'stream-json', '--verbose'];
  cli.push('--permission-mode', args.permissionMode);

  if (args.resumeSessionId) {
    cli.push('--resume', args.resumeSessionId);
  } else if (args.assignSessionId) {
    cli.push('--session-id', args.assignSessionId);
  }
  if (args.agentProfile) {
    cli.push('--agents', args.agentProfile);
  }
  if (args.trustDenyList && args.trustDenyList.length > 0) {
    cli.push('--disallowed-tools', args.trustDenyList.join(','));
  }
  cli.push(args.prompt);
  return cli;
}

/**
 * The seam between this runner and the Claude Desktop host. Mirrors
 * {@link ClaudeHeadlessTransport} but accepts {@link DesktopRunArgs} so an
 * explicit `--session-id` can be assigned.
 */
export interface DesktopTransport {
  /** Run a headless dispatch and resolve once the subprocess exits. */
  run(args: DesktopRunArgs): Promise<ClaudeRunOutcome>;
  /** Resolve the `claude` executable version, or `null` if unavailable. */
  version(): Promise<string | null>;
}

/**
 * Default {@link DesktopTransport}: wraps the base {@link CliHeadlessTransport}
 * but injects `--session-id` for new sessions via an args rewrite.
 *
 * The base transport builds its own CLI args internally, so to assign a
 * session id this transport spawns `claude` itself using
 * {@link buildDesktopCliArgs}. It reuses the base transport only for
 * {@link version}.
 */
export class DesktopCliTransport implements DesktopTransport {
  private readonly base = new CliHeadlessTransport();

  /** Resolve `claude --version`, or `null` when the binary is absent. */
  async version(): Promise<string | null> {
    return this.base.version();
  }

  /** Spawn the headless desktop subprocess and collect its output. */
  async run(args: DesktopRunArgs): Promise<ClaudeRunOutcome> {
    // Lazily require child_process.spawn so this file has one import site.
    const { spawn } = await import('child_process');
    const cliArgs = buildDesktopCliArgs(args);
    const softTimeout = args.timeoutMs ?? 600_000;
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
          events: parseStreamJsonLocal(stdout),
          stdout,
          stderr,
          timedOut,
          spawnError,
        });
      };

      child.on('error', (err: Error) => finish(127, err.message));
      child.on('close', (code: number | null) => {
        finish(code ?? (timedOut ? 124 : 1));
      });
    });
  }
}

/** Local `stream-json` parser — one JSON object per line, non-JSON skipped. */
function parseStreamJsonLocal(stdout: string): ClaudeRunOutcome['events'] {
  const events: ClaudeRunOutcome['events'] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || (line[0] !== '{' && line[0] !== '[')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { type?: unknown }).type === 'string'
        ) {
          events.push(item as ClaudeRunOutcome['events'][number]);
        }
      }
    } catch {
      // Not a JSON line — skip.
    }
  }
  return events;
}

/* -------------------------------------------------------------------------- */
/*  Runner implementation                                                     */
/* -------------------------------------------------------------------------- */

/** One slot in the bounded recent-error ring. */
interface ErrorRecord {
  class: ErrorClass;
}

/**
 * `runner-claude-desktop` — Claude Code on a desktop host with session
 * continuity.
 *
 * Construct with the default {@link DesktopCliTransport}, or inject an
 * alternative (an Agent-SDK transport, or a mock for tests).
 */
export class ClaudeDesktopRunner implements Runner {
  readonly id = 'claude-desktop';
  readonly capabilities: Capabilities = CLAUDE_DESKTOP_CAPABILITIES;

  /** Detected host context (desktop / cli / vscode). */
  readonly hostContext: ClaudeHostContext;

  private readonly transport: DesktopTransport;
  /** In-flight subprocesses keyed by session id, for {@link cancel}. */
  private readonly inFlight = new Map<string, ChildProcess>();
  /** Bounded recent-error ring (most recent first). */
  private readonly recentErrors: ErrorRecord[] = [];
  private lastDispatchAt: string | undefined;

  constructor(
    transport: DesktopTransport = new DesktopCliTransport(),
    hostContext: ClaudeHostContext = detectHostContext(),
  ) {
    this.transport = transport;
    this.hostContext = hostContext;
  }

  /* ----------------------------------------------------------------------- */
  /*  detect()                                                               */
  /* ----------------------------------------------------------------------- */

  /**
   * Probe whether Claude Desktop is usable: `claude --version` resolves and
   * an Anthropic credential is present. The detected host context is folded
   * into the version string so `doctor` shows it.
   */
  async detect(): Promise<DetectionResult> {
    const version = await this.transport.version();
    if (version === null) {
      return {
        found: false,
        reason: 'not_installed',
        hint: 'Claude Code not found on PATH. Install the desktop app or CLI so `claude --version` works.',
      };
    }
    if (!isVersionSupported(version)) {
      return {
        found: false,
        reason: 'version_too_old',
        hint: `Claude Code ${version} is too old; v${MIN_MAJOR_VERSION}.x or newer is required.`,
      };
    }
    if (!hasAnthropicAuth()) {
      return {
        found: false,
        reason: 'no_auth',
        hint: 'No Anthropic credential found. Set ANTHROPIC_API_KEY or run `claude login`.',
      };
    }
    return {
      found: true,
      version: `${version} [context=${this.hostContext}]`,
      path: CLAUDE_BIN,
    };
  }

  /* ----------------------------------------------------------------------- */
  /*  dispatch()                                                             */
  /* ----------------------------------------------------------------------- */

  /**
   * Run a prompt as work. A new session is assigned a stable id up-front
   * (`--session-id`) and recorded in the {@link DesktopSessionStore} so it
   * survives a desktop restart; a request that carries `sessionId` resumes
   * that thread instead.
   */
  async dispatch(opts: DispatchOptions): Promise<DispatchResult> {
    const startedAt = Date.now();
    const permissionMode = trustToPermissionMode(opts.trust);

    const resuming = typeof opts.sessionId === 'string' && opts.sessionId.length > 0;
    // For a brand-new session, mint the id ourselves for restart-safe resume.
    const assignedId = resuming ? undefined : crypto.randomUUID();
    const trackingKey = opts.sessionId ?? assignedId ?? `pending-${startedAt}`;

    let outcome: ClaudeRunOutcome;
    try {
      outcome = await this.transport.run({
        prompt: opts.prompt,
        workingDir: opts.workingDir,
        permissionMode,
        resumeSessionId: resuming ? opts.sessionId : undefined,
        assignSessionId: assignedId,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
        trustDenyList: opts.trustDenyList,
        agentProfile: opts.agentProfile,
        onSpawn: (child) => {
          this.inFlight.set(trackingKey, child);
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return this.failure(opts.sessionId ?? trackingKey, 'internal', startedAt, message);
    } finally {
      this.inFlight.delete(trackingKey);
    }

    const result = this.toDispatchResult(opts, outcome, startedAt, assignedId);
    await this.persistSession(opts, result);
    return result;
  }

  /* ----------------------------------------------------------------------- */
  /*  resume()                                                               */
  /* ----------------------------------------------------------------------- */

  /**
   * Resume a desktop session by id. The session id is looked up in the
   * {@link DesktopSessionStore} first so a resume works even after a full
   * desktop / extension-host restart wiped the host's in-memory state.
   */
  async resume(
    sessionId: string,
    prompt: string,
    opts?: Partial<DispatchOptions>,
  ): Promise<DispatchResult> {
    const workingDir = opts?.workingDir ?? process.cwd();
    // Best-effort: confirm the session is known on disk. A missing record is
    // not fatal — the host may still hold the thread — but it is logged via
    // the activity refresh below once the dispatch lands.
    await new DesktopSessionStore(workingDir).get(sessionId);

    return this.dispatch({
      prompt,
      sessionId,
      trust: opts?.trust ?? 'auto',
      trustAllowList: opts?.trustAllowList,
      trustDenyList: opts?.trustDenyList,
      agentProfile: opts?.agentProfile,
      requireMcp: opts?.requireMcp,
      workingDir,
      env: opts?.env,
      timeoutMs: opts?.timeoutMs,
      scope: opts?.scope,
    });
  }

  /* ----------------------------------------------------------------------- */
  /*  listSessions()                                                         */
  /* ----------------------------------------------------------------------- */

  /**
   * List desktop sessions. Merges the runner's restart-safe store (rooted at
   * the current working directory) with the host's on-disk transcript store
   * under `~/.claude/projects/`.
   */
  async listSessions(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const seen = new Set<string>();

    // 1. The runner's own restart-safe store.
    try {
      const store = new DesktopSessionStore(process.cwd());
      for (const rec of await store.list()) {
        seen.add(rec.sessionId);
        summaries.push({
          sessionId: rec.sessionId,
          createdAt: rec.createdAt,
          lastActivityAt: rec.lastActivityAt,
          status: 'idle',
          promptPreview: rec.promptPreview,
        });
      }
    } catch {
      // Store unreadable — fall through to the host transcript store.
    }

    // 2. The host's transcript store.
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
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
        if (seen.has(sessionId)) {
          continue;
        }
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
      cliVersion:
        version !== null ? `${version} [context=${this.hostContext}]` : 'not_installed',
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

  /**
   * Convert a transport outcome into a {@link DispatchResult}. The session id
   * is resolved with desktop priority: the host-reported id (from the
   * `system` event) wins, then the id this runner assigned, then any resumed
   * id — so a restart-safe id is always present.
   */
  private toDispatchResult(
    opts: DispatchOptions,
    outcome: ClaudeRunOutcome,
    startedAt: number,
    assignedId: string | undefined,
  ): DispatchResult {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAt;
    this.lastDispatchAt = finishedAt;

    const sessionId =
      extractSessionId(outcome.events) ?? assignedId ?? opts.sessionId ?? '';
    const resultEvent = outcome.events.find((e) => e.type === 'result');
    const stdoutTail = tail(outcome.stdout || outcome.stderr, STDOUT_TAIL_BYTES);

    if (outcome.spawnError !== undefined) {
      this.recordError('internal');
      return {
        ok: false,
        sessionId,
        exitCode: outcome.exitCode,
        finishedAt,
        durationMs,
        errorClass: 'internal',
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
        rationale:
          typeof resultEvent?.result === 'string' ? resultEvent.result : undefined,
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
      rationale:
        typeof resultEvent?.result === 'string' ? resultEvent.result : undefined,
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
   * Persist the session id to the {@link DesktopSessionStore} so a follow-up
   * survives a host restart. Best-effort — never masks the dispatch outcome.
   */
  private async persistSession(
    opts: DispatchOptions,
    result: DispatchResult,
  ): Promise<void> {
    if (result.sessionId === '') {
      return;
    }
    try {
      const store = new DesktopSessionStore(opts.workingDir);
      const now = new Date().toISOString();
      await store.upsert({
        sessionId: result.sessionId,
        context: this.hostContext,
        createdAt: now,
        lastActivityAt: now,
        promptPreview: opts.prompt.split(/\r?\n/)[0]?.slice(0, 120),
      });
    } catch {
      // Best-effort persistence.
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Free helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Pull token usage off a `result` event, normalized to the contract shape. */
function extractTokens(
  resultEvent: ClaudeRunOutcome['events'][number] | undefined,
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

/** Convenience singleton — registered with the {@link import('./registry').RunnerRegistry}. */
export const claudeDesktopRunner = new ClaudeDesktopRunner();
