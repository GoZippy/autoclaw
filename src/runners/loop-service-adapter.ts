/**
 * loop-service-adapter.ts — generic `LoopServiceAdapter` (Sprint 4 / WA-2, F4).
 *
 * A {@link Runner} adapter over an arbitrary HTTP "loop service": any
 * long-lived endpoint that accepts a prompt, runs an autonomous agent loop,
 * and exposes a poll-able status. Unlike CLI runners it is configured
 * entirely by data — endpoint, auth scheme, and the dispatch/poll path
 * shape — so a single class can drive AutoGPT, a homemade BabyAGI loop, or
 * any other HTTP agent runtime without a bespoke adapter.
 *
 * Config comes from a {@link LoopServiceConfig}; the `loop_services[]` array
 * in `config.yaml` is an array of these (see {@link parseLoopServicesConfig}).
 *
 * Heartbeat: loop services that are alive write a heartbeat JSON into
 * `.autoclaw/orchestrator/comms/heartbeats/` on every successful detect and
 * dispatch poll, so the orchestrator's fleet view sees them like any agent.
 *
 * Uses the Node 18+ global `fetch`; no third-party HTTP client.
 *
 * @see docs/rfc/runner-bridge-contract.md §2, §3, §7
 */

import { promises as fs } from 'fs';
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
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Auth scheme for a loop service. `tokenEnv` names an environment variable
 * holding the secret; the adapter never stores the secret itself.
 */
export interface LoopServiceAuth {
  /** Auth style. `none` sends no auth header. */
  kind: 'none' | 'bearer' | 'header';
  /** Environment variable holding the token / secret. */
  tokenEnv?: string;
  /** Header name for `kind: 'header'` (e.g. `X-API-Key`). Defaults to `Authorization`. */
  headerName?: string;
}

/**
 * The poll/dispatch path shape of a loop service. All paths are appended to
 * {@link LoopServiceConfig.endpoint}; `{id}` in a path is substituted with
 * the dispatch id returned by the dispatch endpoint.
 */
export interface LoopServiceRoutes {
  /** Health-check path. Default `/health`. */
  health?: string;
  /** Dispatch (submit-prompt) path. Default `/run`. */
  dispatch?: string;
  /** Status-poll path; must contain `{id}`. Default `/run/{id}`. */
  status?: string;
  /** Cancel path; must contain `{id}`. Default `/run/{id}` (DELETE). */
  cancel?: string;
  /** List-sessions path. Default `/runs`. */
  list?: string;
}

/**
 * One configurable loop service. A `loop_services[]` config entry
 * deserializes into this shape.
 */
export interface LoopServiceConfig {
  /** Stable runner id, e.g. `"autogpt"`, `"my-babyagi"`. */
  id: string;
  /** Base URL, trailing slash trimmed at use. */
  endpoint: string;
  /** Auth scheme. Defaults to `{ kind: 'none' }`. */
  auth?: LoopServiceAuth;
  /** Path overrides; sensible defaults used when omitted. */
  routes?: LoopServiceRoutes;
  /** Status-poll interval in ms. Default 2000. */
  pollIntervalMs?: number;
  /** Capability advertisement; conservative defaults used when omitted. */
  capabilities?: Partial<Capabilities>;
  /**
   * JSON field name on the dispatch response carrying the new id.
   * Default `id`.
   */
  idField?: string;
}

/** Conservative capability default for a generic HTTP loop service. */
const DEFAULT_CAPABILITIES: Capabilities = {
  resumableSessions: true,
  jsonStructuredOutput: true,
  mcpServers: false,
  browser: false,
  customAgents: false,
  toolTrustGranularity: 'all-or-nothing',
};

/** Default poll interval and poll ceiling. */
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_CEILING_MS = 600_000;
const STDOUT_TAIL_BYTES = 4096;

/**
 * Loop services are commonly trusted at the service level, not per-tool, so
 * the AutoClaw preset maps onto a coarse `autonomy` string in the body.
 */
export const LOOP_SERVICE_AUTONOMY: Readonly<Record<TrustPreset, string>> = {
  off: 'manual',
  auto: 'assisted',
  turbo: 'autonomous',
};

/** Translate an AutoClaw {@link TrustPreset} into the loop-service autonomy value. */
export function loopServiceAutonomy(preset: TrustPreset): string {
  return LOOP_SERVICE_AUTONOMY[preset] ?? LOOP_SERVICE_AUTONOMY.off;
}

/**
 * Parse a `loop_services` value (the `loop_services[]` array from
 * `config.yaml`, already deserialized into a JS value) into validated
 * {@link LoopServiceConfig} entries. Malformed entries are dropped rather
 * than throwing, so one bad row never breaks the whole fleet.
 *
 * @param raw - the deserialized `loop_services` value, expected to be an array.
 * @returns the well-formed loop-service configs.
 */
export function parseLoopServicesConfig(raw: unknown): LoopServiceConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: LoopServiceConfig[] = [];
  for (const entry of raw) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { id?: unknown }).id !== 'string' ||
      typeof (entry as { endpoint?: unknown }).endpoint !== 'string'
    ) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    out.push({
      id: e.id as string,
      endpoint: e.endpoint as string,
      auth: isPlainObject(e.auth) ? (e.auth as unknown as LoopServiceAuth) : undefined,
      routes: isPlainObject(e.routes)
        ? (e.routes as unknown as LoopServiceRoutes)
        : undefined,
      pollIntervalMs:
        typeof e.pollIntervalMs === 'number' ? e.pollIntervalMs : undefined,
      capabilities: isPlainObject(e.capabilities)
        ? (e.capabilities as Partial<Capabilities>)
        : undefined,
      idField: typeof e.idField === 'string' ? e.idField : undefined,
    });
  }
  return out;
}

/** Build a {@link LoopServiceAdapter} for each entry in a `loop_services` config. */
export function loopServiceRunnersFromConfig(raw: unknown): LoopServiceAdapter[] {
  return parseLoopServicesConfig(raw).map((cfg) => new LoopServiceAdapter(cfg));
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Whether a value is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sleep helper for the status-poll loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Return the last `maxBytes` characters of `text`. */
function tail(text: string, maxBytes: number): string {
  return text.length <= maxBytes ? text : text.slice(text.length - maxBytes);
}

/** Shape of a loop-service status-poll response (all fields optional). */
interface LoopStatusBody {
  id?: string;
  state?: string;
  status?: string;
  exit_code?: number;
  output?: string;
  result?: string;
  error?: string;
  error_class?: string;
  tokens?: { input?: number; output?: number };
  created_at?: string;
  updated_at?: string;
  prompt_preview?: string;
}

/** Map a loop-service `error_class`/`state` onto a normalized {@link ErrorClass}. */
export function loopServiceErrorClass(body: LoopStatusBody): ErrorClass {
  const ec = (body.error_class ?? '').toLowerCase();
  if (ec === 'auth' || ec === 'unauthorized') {
    return 'auth';
  }
  if (ec === 'timeout') {
    return 'timeout';
  }
  if (ec === 'tool_denied' || ec === 'permission_denied') {
    return 'tool_denied';
  }
  if (ec === 'mcp_startup' || ec === 'mcp') {
    return 'mcp_startup';
  }
  return 'internal';
}

/** Coarse classification of a loop-service state string. */
type TerminalState = 'ok' | 'failed' | 'pending';

/** Classify a raw loop-service state string into a coarse terminal state. */
export function classifyLoopState(state: string | undefined): TerminalState {
  switch ((state ?? '').toLowerCase()) {
    case 'completed':
    case 'succeeded':
    case 'success':
    case 'done':
    case 'finished':
      return 'ok';
    case 'failed':
    case 'error':
    case 'errored':
    case 'cancelled':
    case 'canceled':
      return 'failed';
    default:
      return 'pending';
  }
}

/** Map a raw loop-service state string to a {@link SessionSummary} status. */
function mapSessionStatus(state: string | undefined): SessionSummary['status'] {
  switch (classifyLoopState(state)) {
    case 'ok':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return (state ?? '').toLowerCase() === 'idle' ? 'idle' : 'active';
  }
}

/* -------------------------------------------------------------------------- */
/*  LoopServiceAdapter                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Generic {@link Runner} adapter over a configurable HTTP loop service.
 *
 * One instance drives exactly one loop service; construct it from a
 * {@link LoopServiceConfig}. AutoGPT-specific behavior lives in the
 * `autogpt.ts` subclass.
 */
export class LoopServiceAdapter implements Runner {
  readonly id: string;
  readonly capabilities: Capabilities;

  /** The service config this adapter drives. */
  protected readonly config: LoopServiceConfig;

  private readonly recentErrors = new Map<ErrorClass, number>();
  private lastDispatchAt: string | undefined;
  /** Absolute path to the heartbeats directory, when a working dir is known. */
  private heartbeatRoot: string | undefined;

  constructor(config: LoopServiceConfig) {
    this.config = config;
    this.id = config.id;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...(config.capabilities ?? {}) };
  }

  /* ----------------------------------------------------------------------- */
  /*  Route + auth resolution                                                */
  /* ----------------------------------------------------------------------- */

  /** Base endpoint with any trailing slashes trimmed. */
  protected baseEndpoint(): string {
    return this.config.endpoint.trim().replace(/\/+$/, '');
  }

  /** Resolve a route path against the configured overrides + defaults. */
  protected route(name: keyof LoopServiceRoutes): string {
    const defaults: Required<LoopServiceRoutes> = {
      health: '/health',
      dispatch: '/run',
      status: '/run/{id}',
      cancel: '/run/{id}',
      list: '/runs',
    };
    const configured = this.config.routes?.[name];
    const pathPart = configured ?? defaults[name];
    return `${this.baseEndpoint()}${pathPart.startsWith('/') ? '' : '/'}${pathPart}`;
  }

  /** Substitute `{id}` in a resolved route URL. */
  protected withId(url: string, id: string): string {
    return url.replace('{id}', encodeURIComponent(id));
  }

  /**
   * Build the auth headers for the configured scheme. Returns an empty
   * object when auth is `none` or the named env var is unset.
   */
  protected authHeaders(): Record<string, string> {
    const auth = this.config.auth;
    if (!auth || auth.kind === 'none') {
      return {};
    }
    const token = auth.tokenEnv ? process.env[auth.tokenEnv] : undefined;
    if (!token || token.trim() === '') {
      return {};
    }
    if (auth.kind === 'bearer') {
      return { Authorization: `Bearer ${token.trim()}` };
    }
    // kind === 'header'
    return { [auth.headerName ?? 'Authorization']: token.trim() };
  }

  /** Whether the configured auth scheme expects a token that is actually present. */
  protected authConfigured(): boolean {
    const auth = this.config.auth;
    if (!auth || auth.kind === 'none') {
      return true;
    }
    const token = auth.tokenEnv ? process.env[auth.tokenEnv] : undefined;
    return Boolean(token && token.trim() !== '');
  }

  /* ----------------------------------------------------------------------- */
  /*  detect()                                                               */
  /* ----------------------------------------------------------------------- */

  /** Probe the loop service with an HTTP health check. */
  async detect(): Promise<DetectionResult> {
    if (this.baseEndpoint() === '') {
      return {
        found: false,
        reason: 'not_installed',
        hint: `Loop service "${this.id}" has no endpoint configured.`,
      };
    }
    if (!this.authConfigured()) {
      return {
        found: false,
        reason: 'no_auth',
        hint: `Loop service "${this.id}" needs ${this.config.auth?.tokenEnv} set.`,
      };
    }

    let res: Response;
    try {
      res = await fetch(this.route('health'), {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return {
        found: false,
        reason: 'not_installed',
        hint: `Loop service "${this.id}" health check failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        found: false,
        reason: 'no_auth',
        hint: `Loop service "${this.id}" rejected the request (HTTP ${res.status}).`,
      };
    }
    if (!res.ok) {
      return {
        found: false,
        reason: 'not_installed',
        hint: `Loop service "${this.id}" health endpoint returned HTTP ${res.status}.`,
      };
    }

    let version = 'unknown';
    try {
      const body = (await res.json()) as { version?: string };
      if (typeof body.version === 'string') {
        version = body.version;
      }
    } catch {
      // Non-JSON health body is acceptable.
    }

    await this.writeHeartbeat('idle');
    return { found: true, version, path: this.baseEndpoint() };
  }

  /* ----------------------------------------------------------------------- */
  /*  dispatch()                                                             */
  /* ----------------------------------------------------------------------- */

  /**
   * Submit a prompt to the loop service and poll its status route until it
   * reaches a terminal state.
   */
  async dispatch(opts: DispatchOptions): Promise<DispatchResult> {
    const startedAt = Date.now();
    this.rememberHeartbeatRoot(opts.workingDir);

    if (this.baseEndpoint() === '') {
      return this.fail(startedAt, opts.sessionId, 'internal', -1);
    }
    if (!this.authConfigured()) {
      return this.fail(startedAt, opts.sessionId, 'auth', -1);
    }

    // ---- Submit ------------------------------------------------------------
    let dispatchId: string;
    try {
      const submitRes = await fetch(this.route('dispatch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify(this.buildDispatchBody(opts)),
        signal: AbortSignal.timeout(30_000),
      });
      if (submitRes.status === 401 || submitRes.status === 403) {
        return this.fail(startedAt, opts.sessionId, 'auth', submitRes.status);
      }
      if (!submitRes.ok) {
        return this.fail(startedAt, opts.sessionId, 'internal', submitRes.status);
      }
      const submitBody = (await submitRes.json()) as Record<string, unknown>;
      const idField = this.config.idField ?? 'id';
      const id = submitBody[idField];
      if (typeof id !== 'string' && typeof id !== 'number') {
        return this.fail(startedAt, opts.sessionId, 'internal', -1);
      }
      dispatchId = String(id);
    } catch (err) {
      const cls: ErrorClass =
        err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'internal';
      return this.fail(startedAt, opts.sessionId, cls, -1);
    }

    await this.writeHeartbeat('busy', dispatchId);

    // ---- Poll --------------------------------------------------------------
    const ceiling =
      opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs * 2 : DEFAULT_POLL_CEILING_MS;
    const interval = this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const statusUrl = this.withId(this.route('status'), dispatchId);

    while (Date.now() - startedAt < ceiling) {
      let body: LoopStatusBody;
      try {
        const res = await fetch(statusUrl, {
          method: 'GET',
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          await delay(interval);
          continue;
        }
        body = (await res.json()) as LoopStatusBody;
      } catch {
        await delay(interval);
        continue;
      }

      await this.writeHeartbeat('busy', dispatchId);
      const terminal = classifyLoopState(body.state ?? body.status);
      if (terminal === 'ok') {
        await this.writeHeartbeat('idle', dispatchId);
        return this.finishOk(startedAt, dispatchId, body);
      }
      if (terminal === 'failed') {
        await this.writeHeartbeat('idle', dispatchId);
        return this.finishFailed(startedAt, dispatchId, body);
      }
      await delay(interval);
    }

    await this.writeHeartbeat('idle', dispatchId);
    return this.fail(startedAt, dispatchId, 'timeout', -1);
  }

  /**
   * Build the JSON body of the dispatch (submit) request. Subclasses (e.g.
   * AutoGPT) override this to match a vendor-specific request schema.
   */
  protected buildDispatchBody(opts: DispatchOptions): Record<string, unknown> {
    return {
      prompt: opts.prompt,
      autonomy: loopServiceAutonomy(opts.trust),
      session_id: opts.sessionId,
      working_dir: opts.workingDir,
      agent_profile: opts.agentProfile,
      trust_allow_list: opts.trustAllowList,
      trust_deny_list: opts.trustDenyList,
      env: opts.env,
    };
  }

  /* ----------------------------------------------------------------------- */
  /*  resume()                                                               */
  /* ----------------------------------------------------------------------- */

  /** Resume an existing loop-service run by carrying its id forward. */
  async resume(
    sessionId: string,
    prompt: string,
    opts?: Partial<DispatchOptions>,
  ): Promise<DispatchResult> {
    return this.dispatch({
      prompt,
      trust: opts?.trust ?? 'auto',
      workingDir: opts?.workingDir ?? process.cwd(),
      ...opts,
      sessionId,
    });
  }

  /* ----------------------------------------------------------------------- */
  /*  listSessions()                                                         */
  /* ----------------------------------------------------------------------- */

  /** List runs known to the loop service via its list route. */
  async listSessions(): Promise<SessionSummary[]> {
    if (this.baseEndpoint() === '') {
      return [];
    }
    try {
      const res = await fetch(this.route('list'), {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return [];
      }
      const body = (await res.json()) as
        | { runs?: LoopStatusBody[]; tasks?: LoopStatusBody[] }
        | LoopStatusBody[];
      const runs = Array.isArray(body) ? body : (body.runs ?? body.tasks ?? []);
      return runs.map((r) => ({
        sessionId: r.id ?? 'unknown',
        createdAt: r.created_at ?? new Date(0).toISOString(),
        lastActivityAt: r.updated_at,
        status: mapSessionStatus(r.state ?? r.status),
        promptPreview: r.prompt_preview,
      }));
    } catch {
      return [];
    }
  }

  /* ----------------------------------------------------------------------- */
  /*  health()                                                               */
  /* ----------------------------------------------------------------------- */

  /** Report runner health by re-probing the loop service endpoint. */
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

  /* ----------------------------------------------------------------------- */
  /*  cancel()                                                               */
  /* ----------------------------------------------------------------------- */

  /** Cancel an in-flight run via the loop service's cancel route (DELETE). */
  async cancel(sessionId: string): Promise<void> {
    if (this.baseEndpoint() === '') {
      return;
    }
    try {
      await fetch(this.withId(this.route('cancel'), sessionId), {
        method: 'DELETE',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Cancellation is best-effort.
    }
  }

  /* ----------------------------------------------------------------------- */
  /*  Result builders                                                        */
  /* ----------------------------------------------------------------------- */

  /** Build a successful {@link DispatchResult} from a terminal status body. */
  private finishOk(
    startedAt: number,
    dispatchId: string,
    body: LoopStatusBody,
  ): DispatchResult {
    const finishedAt = new Date().toISOString();
    this.lastDispatchAt = finishedAt;
    return {
      ok: true,
      sessionId: body.id ?? dispatchId,
      exitCode: body.exit_code ?? 0,
      finishedAt,
      durationMs: Date.now() - startedAt,
      tokens:
        body.tokens && typeof body.tokens.input === 'number'
          ? { input: body.tokens.input ?? 0, output: body.tokens.output ?? 0 }
          : undefined,
      rationale: typeof body.result === 'string' ? body.result : undefined,
      stdoutTail: tail(body.output ?? body.result ?? '', STDOUT_TAIL_BYTES),
    };
  }

  /** Build a failed {@link DispatchResult} from a terminal status body. */
  private finishFailed(
    startedAt: number,
    dispatchId: string,
    body: LoopStatusBody,
  ): DispatchResult {
    const errorClass = loopServiceErrorClass(body);
    this.recordError(errorClass);
    const finishedAt = new Date().toISOString();
    this.lastDispatchAt = finishedAt;
    return {
      ok: false,
      sessionId: body.id ?? dispatchId,
      exitCode: body.exit_code ?? -1,
      finishedAt,
      durationMs: Date.now() - startedAt,
      errorClass,
      stdoutTail: tail(body.error ?? body.output ?? '', STDOUT_TAIL_BYTES),
    };
  }

  /** Build a failed {@link DispatchResult} for a pre/in-poll transport error. */
  protected fail(
    startedAt: number,
    sessionId: string | undefined,
    errorClass: ErrorClass,
    exitCode: number,
  ): DispatchResult {
    this.recordError(errorClass);
    const finishedAt = new Date().toISOString();
    this.lastDispatchAt = finishedAt;
    return {
      ok: false,
      sessionId: sessionId ?? `${this.id}-${Date.now()}`,
      exitCode,
      finishedAt,
      durationMs: Date.now() - startedAt,
      errorClass,
    };
  }

  /** Append an error to the recent-error tally surfaced by {@link health}. */
  private recordError(cls: ErrorClass): void {
    this.recentErrors.set(cls, (this.recentErrors.get(cls) ?? 0) + 1);
  }

  /* ----------------------------------------------------------------------- */
  /*  Heartbeats                                                             */
  /* ----------------------------------------------------------------------- */

  /**
   * Remember which workspace's heartbeats directory to write to. The
   * orchestrator passes the workspace as {@link DispatchOptions.workingDir};
   * once known it is retained for all later heartbeats.
   */
  private rememberHeartbeatRoot(workingDir: string): void {
    if (workingDir && this.heartbeatRoot === undefined) {
      this.heartbeatRoot = path.join(
        workingDir,
        '.autoclaw',
        'orchestrator',
        'comms',
        'heartbeats',
      );
    }
  }

  /**
   * Write a heartbeat JSON for this loop service into
   * `.autoclaw/orchestrator/comms/heartbeats/<id>.json`. Best-effort: a
   * write failure never affects the dispatch outcome. No-op until a working
   * directory has been observed via {@link dispatch}.
   */
  protected async writeHeartbeat(
    status: 'idle' | 'busy',
    sessionId?: string,
  ): Promise<void> {
    const root = this.heartbeatRoot;
    if (root === undefined) {
      return;
    }
    try {
      await fs.mkdir(root, { recursive: true });
      const payload = {
        agent: this.id,
        kind: 'loop_service',
        status,
        sessionId: sessionId ?? null,
        endpoint: this.baseEndpoint(),
        ts: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(root, `${this.id}.json`),
        JSON.stringify(payload, null, 2),
        'utf8',
      );
    } catch {
      // Best-effort heartbeat — never let it fail a dispatch.
    }
  }
}
