/**
 * Runner / Bridge contract types.
 *
 * Implements the type surface of `docs/rfc/runner-bridge-contract.md`
 * (§2 Runner interface, §3 Trust presets, §4 Scope declaration,
 * §7 Health and exit codes).
 *
 * A **Runner** is anything that takes a prompt and turns it into work
 * without a human-typed chat message. Per-vendor adapters (claude-code,
 * cursor, kiro, gemini-cli) implement the {@link Runner} interface; the
 * orchestrator only ever speaks this contract.
 *
 * This module is the keystone for Workstream B — it contains types only,
 * no runtime logic, so downstream tasks can branch off it without churn.
 *
 * @see docs/rfc/runner-bridge-contract.md
 */

/* -------------------------------------------------------------------------- */
/*  §3 Trust presets                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Named trust level, borrowed from Antigravity's terminal execution policy.
 *
 * - `off`   — every tool call requires human approval. CI-unfriendly,
 *             demo-friendly.
 * - `auto`  — read-only tools auto-approved (read, grep, ls, list-sessions);
 *             mutations prompt.
 * - `turbo` — everything auto-approved except items on {@link DispatchOptions.trustDenyList}.
 *             CI-friendly.
 *
 * The preset is stored on `agents/<agent>/scope.json`; the runner
 * translates it to host-specific flags at dispatch time (see §3 table,
 * exported as `TRUST_PRESET_TABLE` in `./registry`).
 */
export type TrustPreset = 'off' | 'auto' | 'turbo';

/* -------------------------------------------------------------------------- */
/*  §7 Health and exit codes                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Host-specific failure modes normalized into a small enum (RFC §7).
 *
 * - `mcp_startup` — Kiro exit code 3, or the equivalent on other hosts.
 * - `auth`        — missing/invalid API key, expired token.
 * - `timeout`     — soft cap exceeded; the orchestrator may retry or escalate.
 * - `tool_denied` — trust preset blocked a needed tool; user action required.
 * - `internal`    — runner subprocess crash, panic, or unparseable output.
 */
export type ErrorClass = 'mcp_startup' | 'auth' | 'timeout' | 'tool_denied' | 'internal';

/* -------------------------------------------------------------------------- */
/*  §2 Runner interface — supporting types                                    */
/* -------------------------------------------------------------------------- */

/**
 * Static description of what a runner's host can do. Used by the registry
 * to pick a suitable runner and by the orchestrator to downgrade requests
 * a host cannot satisfy.
 */
export interface Capabilities {
  /** Host exposes stable session IDs that can be resumed. */
  resumableSessions: boolean;
  /** Host can emit machine-readable structured output (tool-call events). */
  jsonStructuredOutput: boolean;
  /** Host can launch and consume MCP servers. */
  mcpServers: boolean;
  /** Host exposes a browser sub-agent. */
  browser: boolean;
  /** Host supports custom/named agent profiles. */
  customAgents: boolean;
  /**
   * Granularity at which the host can grant or deny tool trust.
   *
   * - `all-or-nothing` — a single global approval switch.
   * - `categories`     — named tool categories (read, grep, search, …).
   * - `fine-grained`   — per-tool, per-invocation control.
   */
  toolTrustGranularity: 'all-or-nothing' | 'categories' | 'fine-grained';
}

/**
 * Result of {@link Runner.detect} — whether the runner is usable on this
 * machine. The orchestrator calls `detect()` once at startup and again on
 * `autoclaw doctor`; runners that are not found enter the registry as
 * disabled with {@link DetectionResultNotFound.hint} surfaced to the user.
 */
export type DetectionResult = DetectionResultFound | DetectionResultNotFound;

/** {@link DetectionResult} variant — the runner's host is installed and usable. */
export interface DetectionResultFound {
  found: true;
  /** Reported CLI/SDK version string. */
  version: string;
  /** Absolute path to the host executable that was detected. */
  path: string;
}

/** {@link DetectionResult} variant — the runner's host is missing or unusable. */
export interface DetectionResultNotFound {
  found: false;
  /** Why the runner could not be used. */
  reason: 'not_installed' | 'no_auth' | 'version_too_old';
  /** Human-readable remediation hint, surfaced by `autoclaw doctor`. */
  hint: string;
}

/**
 * Reference to an artifact a dispatch produced (file, diff, log, …).
 *
 * Kept intentionally small: the orchestrator stores the reference, not
 * the payload, and resolves `path` relative to {@link DispatchOptions.workingDir}.
 */
export interface ArtifactRef {
  /** Artifact kind, e.g. `"file"`, `"diff"`, `"log"`, `"patch"`. */
  kind: string;
  /** Path to the artifact (absolute, or relative to the working dir). */
  path: string;
  /** Optional human-readable label. */
  description?: string;
  /** Optional content hash for idempotency / dedupe. */
  sha256?: string;
}

/**
 * Short summary of a runner session, returned by {@link Runner.listSessions}.
 */
export interface SessionSummary {
  /** Stable, host-provided session identifier. */
  sessionId: string;
  /** ISO timestamp the session was created. */
  createdAt: string;
  /** ISO timestamp of the most recent activity, if known. */
  lastActivityAt?: string;
  /** Coarse session state. */
  status: 'active' | 'idle' | 'completed' | 'failed';
  /** First line / truncated text of the session's initiating prompt. */
  promptPreview?: string;
}

/**
 * Per-runner health snapshot returned by {@link Runner.health} (RFC §7).
 * `autoclaw doctor` surfaces this for each registered runner.
 */
export interface HealthReport {
  /** Overall health: false if auth is missing or recent errors are severe. */
  ok: boolean;
  /** Whether a usable API key / credential is present. */
  authPresent: boolean;
  /** Detected CLI/SDK version string. */
  cliVersion: string;
  /** Number of MCP servers configured for this runner's host. */
  mcpServersConfigured: number;
  /** ISO timestamp of the most recent dispatch, if any. */
  lastDispatchAt?: string;
  /** Recent error counts grouped by {@link ErrorClass}. */
  recentErrors: { class: ErrorClass; count: number }[];
}

/* -------------------------------------------------------------------------- */
/*  §4 Scope declaration                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Declares what an agent is allowed to touch. Persisted at
 * `agents/<agent>/scope.json` (RFC §4).
 *
 * Runners enforce what their host supports (tool trust, path scope where
 * available); the orchestrator enforces the remainder via post-dispatch
 * audit. Violations are reported on the bus as `scope_violation` messages
 * and gate the agent's future dispatches.
 */
export interface ScopeDeclaration {
  /** Trust preset applied to this agent's dispatches. */
  trust: TrustPreset;
  /** Tool categories explicitly allowed (host-specific category names). */
  trustAllowList?: string[];
  /** Tool categories explicitly denied; takes precedence over the allow list. */
  trustDenyList?: string[];
  /** Glob patterns the agent may write to, e.g. `["src/**", "test/**"]`. */
  pathScope?: string[];
  /** Glob patterns of branch names the agent may operate on. */
  branchScope?: string[];
  /** Whether the agent may use a browser sub-agent. */
  browserAllowed?: boolean;
  /** Hard token budget per dispatch; the orchestrator audits against it. */
  maxTokensPerDispatch?: number;
  /** Soft wall-clock budget per dispatch in milliseconds. */
  maxWallClockMs?: number;
}

/* -------------------------------------------------------------------------- */
/*  §2 Runner interface — dispatch I/O                                        */
/* -------------------------------------------------------------------------- */

/**
 * Everything a runner needs to turn a prompt into work (RFC §2).
 */
/**
 * What KIND of dispatch this is (fabric layer). `code` is the default coding
 * prompt; `execution` is a callable task agent (a runner) that returns a
 * structured result rather than file edits; `review` asks an agent (e.g. an
 * auditor) to assess submitted work. Absent ⇒ `code` (back-compatible).
 */
export type DispatchTaskType = 'code' | 'execution' | 'review';

export interface DispatchOptions {
  /** The prompt to execute. For a resumed session this is the follow-up. */
  prompt: string;
  /** The kind of dispatch — coding prompt vs callable execution vs review. Defaults to `code`. */
  taskType?: DispatchTaskType;
  /** Resume an existing thread when set; otherwise a new session is created. */
  sessionId?: string;
  /** Trust preset for this dispatch. */
  trust: TrustPreset;
  /** Tool categories to auto-approve, by host-specific category name. */
  trustAllowList?: string[];
  /** Tool categories to always deny. */
  trustDenyList?: string[];
  /** Custom agent profile name (e.g. Kiro `--agent <name>`). */
  agentProfile?: string;
  /** Fail-fast if configured MCP servers do not start. */
  requireMcp?: boolean;
  /** Absolute path of the working directory for the runner subprocess. */
  workingDir: string;
  /** Extra environment variables appended to the runner subprocess env. */
  env?: Record<string, string>;
  /** Soft time cap; the orchestrator hard-kills past 2× this value. */
  timeoutMs?: number;
  /** Scope declaration for the dispatching agent (RFC §4). */
  scope?: ScopeDeclaration;
}

/**
 * Outcome of a {@link Runner.dispatch} or {@link Runner.resume} call (RFC §2).
 */
export interface DispatchResult {
  /** Whether the dispatch completed successfully. */
  ok: boolean;
  /** Session ID — newly created, or echoed back when resuming. */
  sessionId: string;
  /** Process exit code from the runner subprocess. */
  exitCode: number;
  /** ISO timestamp the dispatch finished. */
  finishedAt: string;
  /** Wall-clock duration of the dispatch in milliseconds. */
  durationMs: number;
  /** Token usage for this dispatch, when the host reports it. */
  tokens?: { input: number; output: number };
  /** Artifacts produced during this dispatch. */
  artifacts?: ArtifactRef[];
  /** "because:" — what the agent decided and why. */
  rationale?: string;
  /** Normalized failure class; absent on success (RFC §7). */
  errorClass?: ErrorClass;
  /** Last ~4 KB of subprocess stdout, for debugging. */
  stdoutTail?: string;
}

/* -------------------------------------------------------------------------- */
/*  §2 Runner interface                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The common contract every per-vendor adapter implements (RFC §2).
 *
 * Implementations live in sibling modules (`./claude-code`, `./cursor`,
 * `./kiro`, `./gemini-cli`) and are registered with the
 * {@link import('./registry').RunnerRegistry}.
 */
export interface Runner {
  /** Stable runner id, e.g. `"claude-code"`, `"cursor"`, `"kiro"`, `"gemini-cli"`. */
  readonly id: string;
  /** Static description of what this runner's host can do. */
  readonly capabilities: Capabilities;

  /** Probe whether this runner is usable on the current machine. */
  detect(): Promise<DetectionResult>;
  /** Run a prompt as work, creating a new session (or resuming if `sessionId` set). */
  dispatch(opts: DispatchOptions): Promise<DispatchResult>;
  /** Resume an existing session with a follow-up prompt. */
  resume(
    sessionId: string,
    prompt: string,
    opts?: Partial<DispatchOptions>,
  ): Promise<DispatchResult>;
  /** List sessions known to this runner's host. */
  listSessions(): Promise<SessionSummary[]>;
  /** Report runner health (auth, version, MCP, recent errors). */
  health(): Promise<HealthReport>;
  /** Cancel an in-flight session. */
  cancel(sessionId: string): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*  Registry support types                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A runner together with the registry's view of whether it is usable.
 *
 * Disabled entries keep the {@link DetectionResultNotFound} so `doctor`
 * can surface the remediation hint.
 */
export interface RegisteredRunner {
  /** The runner instance. */
  runner: Runner;
  /** `true` once {@link DetectionResultFound}; `false` until detection runs. */
  enabled: boolean;
  /** The most recent detection result, or `null` if `detect()` has not run. */
  detection: DetectionResult | null;
}

/**
 * Inputs to {@link import('./registry').RunnerRegistry.getPreferred} that
 * drive the §5.5 preference order.
 */
export interface PreferenceOptions {
  /** Runner the user explicitly invoked, e.g. `/team --runner kiro`. Highest priority. */
  explicitRunnerId?: string;
  /** Runner id matching the workspace's primary chat host. Second priority. */
  workspacePrimaryHostId?: string;
  /**
   * Configurable tiebreaker order (`autoclaw.runner.preferenceOrder`).
   * Defaults to `["explicit", "workspace", "cost", "latency"]`.
   */
  preferenceOrder?: PreferenceCriterion[];
  /** Per-runner cost ledger: rolled-up tokens/$ — lower is cheaper. */
  costByRunnerId?: Record<string, number>;
  /** Per-runner recent p50 dispatch latency in milliseconds — lower is faster. */
  p50LatencyMsByRunnerId?: Record<string, number>;
  /**
   * Per-runner earned reputation in [0,1] (HR-3 `reputationScore`) — HIGHER is
   * preferred. Optional and additive: when absent the `reputation` criterion is
   * a no-op and the preference order is unchanged.
   */
  reputationByRunnerId?: Record<string, number>;
}

/**
 * One ranking criterion used by the registry's preference order (RFC §5.5).
 * `reputation` (HR-3) prefers the highest-reputation runner; it only decides
 * when {@link PreferenceOptions.reputationByRunnerId} is supplied.
 */
export type PreferenceCriterion = 'explicit' | 'workspace' | 'cost' | 'latency' | 'reputation';
