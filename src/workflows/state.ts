/**
 * state.ts — Workflow run state, the minimal local DSL contract, and the
 * JSONL run ledger for the WL-1 headless runner.
 *
 * ── WL-0 INTEGRATION SEAM (read this before editing) ────────────────────────
 * WL-1 (this milestone) is the headless runner. It depends on the WL-0
 * foundation types that are owned by a CONCURRENT agent (codex,
 * claim WL-0-foundation):
 *
 *   - src/diagnostics/failureTypes.ts   → WorkflowFailureType + helpers (WL-0.1)
 *   - src/workflows/types.ts            → WorkflowDefinition/Node/Edge (WL-0.2)
 *   - src/workflows/validate.ts         → graph validator               (WL-0.3)
 *   - src/workflows/runLedger.ts        → JSONL ledger                   (WL-0.4)
 *
 * To avoid a shared master-working-tree COMPILE RACE (importing files that a
 * peer is still writing breaks `tsc -p ./` for everyone), WL-1 ships a
 * SELF-CONTAINED local contract here: a minimal, forward-compatible subset of
 * the same shapes, using the same schema strings and field names WL-0 will
 * export. When WL-0 lands, the swap is mechanical:
 *
 *   1. Replace the `WorkflowFailureType` union below with a re-export from
 *      `../diagnostics`.
 *   2. Replace `WorkflowDefinition/WorkflowNode/WorkflowEdge` with re-exports
 *      from `./types`.
 *   3. Replace `appendRunEvent`/`readRun` here with `./runLedger`.
 *
 * Every local type below is intentionally a STRUCTURAL subset so a WL-0 value
 * assigns to it without change. Unknown future fields are preserved.
 * ────────────────────────────────────────────────────────────────────────────
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FailureType } from '../diagnostics/failureTypes';

// ===========================================================================
// Failure taxonomy (local shim of WL-0.1 — keep in sync with diagnostics)
// ===========================================================================

/**
 * Shared diagnostic taxonomy for workflow loops, gates, and context packs.
 * Mirrors the list in `docs/specs/recursive-workflow-lab/requirements.md` §E
 * and the research synthesis. Superseded by `src/diagnostics/failureTypes.ts`.
 */
// Single source of truth: the WL-0 diagnostics taxonomy. `WorkflowFailureType`
// is an alias so existing WL-1 imports from './state' keep working, and the
// helpers are re-exported from diagnostics rather than redefined here.
export type WorkflowFailureType = FailureType;
export {
  isRetryableFailure,
  isEscalationCandidate,
  isHumanRequired,
  normalizeFailureType,
} from '../diagnostics/failureTypes';

// ===========================================================================
// Minimal local DSL contract (local shim of WL-0.2 — keep field names stable)
// ===========================================================================

export type WorkflowNodeType =
  | 'input' | 'context' | 'router' | 'agent' | 'tool' | 'gate'
  | 'loop' | 'artifact' | 'human' | 'control';

export interface WorkflowPort {
  id: string;
  type?: string;
}

export interface WorkflowCondition {
  /** When set, the edge only activates if the upstream node failed. */
  onFailure?: boolean;
  /** When set, the edge only activates if the upstream node succeeded. */
  onSuccess?: boolean;
  /** Optional explicit failure-type match for failure-routing edges. */
  failureType?: WorkflowFailureType;
}

export interface RetryPolicy {
  maxAttempts?: number;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  /** Sub-type discriminator, e.g. 'mock', 'shell', 'test', 'fix-loop'. */
  kind: string;
  label?: string;
  config: Record<string, unknown>;
  ports?: { inputs?: WorkflowPort[]; outputs?: WorkflowPort[] };
  retry?: RetryPolicy;
  timeoutSeconds?: number;
  /** Unknown future fields are preserved on round-trip. */
  [k: string]: unknown;
}

export interface WorkflowEdge {
  id: string;
  from: { node: string; port?: string };
  to: { node: string; port?: string };
  condition?: WorkflowCondition;
  [k: string]: unknown;
}

export interface WorkflowDefinition {
  schema?: string; // 'autoclaw.workflow.v1'
  id: string;
  name?: string;
  description?: string;
  variables?: Record<string, unknown>;
  policies?: Record<string, unknown>;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  layout?: Record<string, { x: number; y: number }>;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export const WORKFLOW_SCHEMA = 'autoclaw.workflow.v1';
export const RUN_EVENT_SCHEMA = 'autoclaw.workflowRunEvent.v1';

// ===========================================================================
// Run events (local shim of WL-0.4 — schema string matches requirements §Run Event)
// ===========================================================================

export type WorkflowRunEventKind =
  | 'queued' | 'started' | 'completed' | 'failed' | 'skipped'
  | 'retrying' | 'escalated' | 'halted' | 'human_required';

export interface WorkflowRunEventModel {
  provider: string;
  model: string;
  locality: 'local' | 'lan' | 'cloud';
  selectionReason?: string;
}

export interface WorkflowRunEvent {
  schema: typeof RUN_EVENT_SCHEMA;
  runId: string;
  nodeId: string;
  event: WorkflowRunEventKind;
  timestamp: string;
  durationMs?: number;
  model?: WorkflowRunEventModel;
  /** Cost-oriented row: NEVER contains prompt/response content (privacy). */
  tokens?: { input?: number; output?: number; costCents?: number };
  failureType?: WorkflowFailureType;
  /** Loop iteration index when emitted from inside a loop body. */
  iteration?: number;
  artifacts?: string[];
  summary?: string;
}

// ===========================================================================
// Per-node and per-run state
// ===========================================================================

export type NodeStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface NodeRunState {
  nodeId: string;
  status: NodeStatus;
  failureType?: WorkflowFailureType;
  /** Opaque structured output passed downstream along edges. */
  output?: unknown;
  startedAt?: string;
  endedAt?: string;
  attempts?: number;
}

/**
 * Typed terminal reasons for a workflow run or a bounded loop. Drawn from the
 * design-review-addendum §B "loop stop reasons".
 */
export type RunStopReason =
  | 'success_gate_passed'
  | 'completed'
  | 'max_iterations'
  | 'max_depth'
  | 'max_cost'
  | 'max_wall_time'
  | 'no_progress'
  | 'same_failure_repeated'
  | 'policy_denied'
  | 'human_required'
  | 'halt_requested'
  | 'resource_unavailable'
  | 'node_failed'
  | 'validation_error';

export type RunStatus = 'completed' | 'failed' | 'halted' | 'human_required';

export interface RunResult {
  runId: string;
  workflowId: string;
  status: RunStatus;
  stopReason: RunStopReason;
  /** The failure type that terminated the run, when status !== 'completed'. */
  failureType?: WorkflowFailureType;
  nodeStates: Record<string, NodeRunState>;
  events: WorkflowRunEvent[];
  /** Total estimated cost in cents across the run (mock providers = 0). */
  costCents: number;
  /** Directory the JSONL ledger + run.json were written to. */
  ledgerDir: string;
  startedAt: string;
  endedAt: string;
}

/**
 * Mutable run state threaded through node execution. The runner owns one of
 * these per run; node executors read/write outputs and append events.
 */
export class RunState {
  readonly runId: string;
  readonly workflowId: string;
  readonly startedAt: string;
  readonly nodeStates: Record<string, NodeRunState> = {};
  readonly events: WorkflowRunEvent[] = [];
  costCents = 0;
  halted = false;
  humanRequired = false;
  /** Set by a loop/terminal node to surface a precise stop reason. */
  terminalStopReason?: RunStopReason;

  private readonly ledger: WorkflowRunLedger | null;

  constructor(opts: {
    runId: string;
    workflowId: string;
    startedAt: string;
    ledger?: WorkflowRunLedger | null;
  }) {
    this.runId = opts.runId;
    this.workflowId = opts.workflowId;
    this.startedAt = opts.startedAt;
    this.ledger = opts.ledger ?? null;
  }

  setNode(nodeId: string, patch: Partial<NodeRunState>): NodeRunState {
    const prev = this.nodeStates[nodeId] ?? { nodeId, status: 'pending' as NodeStatus };
    const next = { ...prev, ...patch, nodeId };
    this.nodeStates[nodeId] = next;
    return next;
  }

  /** Append an event to the in-memory log AND the persistent JSONL ledger. */
  emit(ev: Omit<WorkflowRunEvent, 'schema' | 'runId'>): WorkflowRunEvent {
    const full: WorkflowRunEvent = {
      schema: RUN_EVENT_SCHEMA,
      runId: this.runId,
      ...ev,
    };
    if (typeof full.tokens?.costCents === 'number') {
      this.costCents += full.tokens.costCents;
    }
    this.events.push(full);
    if (this.ledger) { this.ledger.append(full); }
    return full;
  }

  ledgerDir(): string {
    return this.ledger ? this.ledger.dir : '';
  }
}

// ===========================================================================
// JSONL run ledger (local shim of WL-0.4 src/workflows/runLedger.ts)
// ===========================================================================

/**
 * Append-only JSONL ledger under
 * `.autoclaw/workflows/runs/<runId>/events.jsonl` plus a `run.json` summary.
 * No prompt/response content is ever written — only cost/decision rows.
 *
 * Superseded by WL-0.4 `src/workflows/runLedger.ts` (same on-disk layout).
 */
export class WorkflowRunLedger {
  readonly dir: string;
  private readonly eventsPath: string;
  private readonly runPath: string;

  constructor(workspaceRoot: string, runId: string) {
    this.dir = path.join(workspaceRoot, '.autoclaw', 'workflows', 'runs', runId);
    this.eventsPath = path.join(this.dir, 'events.jsonl');
    this.runPath = path.join(this.dir, 'run.json');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  append(ev: WorkflowRunEvent): void {
    fs.appendFileSync(this.eventsPath, JSON.stringify(ev) + '\n', 'utf8');
  }

  writeRunMeta(meta: Record<string, unknown>): void {
    fs.writeFileSync(this.runPath, JSON.stringify(meta, null, 2), 'utf8');
  }
}

// ===========================================================================
// Node-execution seams (mockable provider interfaces — WL-1 requirement 4 & 6)
// ===========================================================================

/** Result of running a deterministic command (test, compile, shell tool). */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when the command was killed for exceeding its timeout. */
  timedOut?: boolean;
}

/**
 * Injectable command runner. Production wires this to child_process; tests and
 * the default safe runner supply a deterministic stub. The runner NEVER shells
 * out unless an explicit CommandRunner is provided (WL-1 requirement 6).
 */
export type CommandRunner = (
  command: string,
  opts?: { cwd?: string; timeoutSeconds?: number }
) => Promise<CommandResult>;

/** A model completion request. Carries intent for routing, not raw secrets. */
export interface ModelRequest {
  intent?: string;
  prompt: string;
  /** Routing profile hint: cheap | balanced | quality | local-only | ... */
  profile?: string;
  /** Iteration index, so the seam can escalate on later loop passes. */
  iteration?: number;
}

export interface ModelResponse {
  text: string;
  provider: string;
  model: string;
  locality: 'local' | 'lan' | 'cloud';
  selectionReason?: string;
  tokens?: { input?: number; output?: number; costCents?: number };
}

/**
 * Placeholder model provider seam. Concrete implementations will route to
 * Ollama, LM Studio, ZippyMesh, AutoClaw peer servers, or premium cloud
 * models (WL-2). The default provider is a deterministic mock that NEVER
 * calls an external or paid model (WL-1 requirement 4 & 6).
 */
export interface ModelProvider {
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/** Dependencies injected into the runner; all default to safe/mock values. */
export interface RunnerDeps {
  workspaceRoot: string;
  /** Returns an ISO timestamp; injectable for deterministic tests. */
  now: () => string;
  /** Generates a run id; injectable for deterministic tests. */
  newRunId: () => string;
  /** Command runner for tool/gate nodes. Defaults to a stub that refuses. */
  commandRunner: CommandRunner;
  /** Model provider for agent/model nodes. Defaults to a mock. */
  modelProvider: ModelProvider;
  /** When false, no JSONL ledger is written (used by dry-run / unit tests). */
  persistLedger: boolean;
  /** Cooperative HALT signal checked before each node and loop iteration. */
  shouldHalt?: () => boolean;
}

/** Context handed to every node executor. */
export interface NodeContext {
  node: WorkflowNode;
  run: RunState;
  deps: RunnerDeps;
  /** Outputs of upstream nodes, keyed by node id. */
  upstream: Record<string, unknown>;
  /** Loop iteration index when executing inside a loop body (else undefined). */
  iteration?: number;
}

/** What a node executor returns to the runner. */
export interface NodeExecResult {
  status: Extract<NodeStatus, 'completed' | 'failed' | 'skipped'>;
  output?: unknown;
  failureType?: WorkflowFailureType;
  /** Cost incurred by this node, folded into the run total. */
  costCents?: number;
  /** Model decision metadata to attach to the run event, if any. */
  model?: WorkflowRunEventModel;
  /** Short, content-free summary for the run event. */
  summary?: string;
}

/**
 * Default model provider: deterministic, offline, zero-cost. Returns a stable
 * stub completion and reports as a local provider. Replace via RunnerDeps to
 * route to real providers.
 */
export const defaultMockModelProvider: ModelProvider = {
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const iter = req.iteration ?? 0;
    return {
      text: `mock-completion(intent=${req.intent ?? 'none'},iteration=${iter})`,
      provider: 'mock',
      model: iter >= 1 ? 'mock-strong' : 'mock-fast',
      locality: 'local',
      selectionReason: iter >= 1
        ? 'escalated to stronger local mock after prior failure'
        : 'cheapest eligible local mock',
      tokens: { input: 0, output: 0, costCents: 0 },
    };
  },
};

/**
 * Default command runner: refuses to execute. Tool/gate nodes that need a real
 * command must be given an explicit CommandRunner via RunnerDeps. This keeps
 * the runner safe-by-default (no surprise shell execution).
 */
export const refusingCommandRunner: CommandRunner = async () => ({
  exitCode: 127,
  stdout: '',
  stderr: 'no CommandRunner configured: tool/gate command execution is disabled',
  durationMs: 0,
});

/**
 * Read a run's events back from its JSONL ledger. Corrupt lines are skipped
 * with a console warning rather than throwing (WL-0.4 acceptance criterion).
 */
export function readRunEvents(workspaceRoot: string, runId: string): WorkflowRunEvent[] {
  const p = path.join(workspaceRoot, '.autoclaw', 'workflows', 'runs', runId, 'events.jsonl');
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const out: WorkflowRunEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    try {
      out.push(JSON.parse(trimmed) as WorkflowRunEvent);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[workflow] skipping corrupt ledger line in run ${runId}`);
    }
  }
  return out;
}
